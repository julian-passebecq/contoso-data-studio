"""Named local workspaces: one DuckLake catalog, staging area, imports and dbt target per workspace.

The legacy ``workspace/`` folder is adopted in place as the ``default`` workspace, so upgrading never
moves or rewrites existing user data. Named workspaces live under ``Settings.home``. Backups are zip
files written beside them; a restore always creates a new workspace and never overwrites one.
"""
from __future__ import annotations

import json
import re
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from app import config
from app.config import DEFAULT_WORKSPACE_ID, Settings
from app.services.catalog_lock import catalog_lock

_SLUG = re.compile(r"^[a-z][a-z0-9-]{1,39}$")
POINTER = "active-workspace.json"
META = "workspace.json"
BACKUP_FORMAT = "contoso.workspace-backup"
# Rebuildable or transient content is not worth a backup.
_SKIP_DIRS = {"dbt-logs", "__pycache__"}
MAX_BACKUP_BYTES = 4 * 1024 * 1024 * 1024
MAX_BACKUP_MEMBERS = 50_000


class WorkspaceError(ValueError):
    pass


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")[:40].strip("-")
    if slug and not slug[0].isalpha():
        slug = f"w-{slug}"[:40]
    return slug


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class WorkspaceRegistry:
    def __init__(self, base: Settings | None = None):
        self.base = base or Settings.default()
        self.home = self.base.home
        self.backups = self.home / "_backups"

    # ----- discovery -------------------------------------------------------------------
    def _named_dir(self, workspace_id: str) -> Path:
        if not _SLUG.match(workspace_id) or workspace_id == DEFAULT_WORKSPACE_ID:
            raise WorkspaceError(f"Invalid workspace id: {workspace_id}")
        path = (self.home / workspace_id).resolve()
        if path.parent != self.home.resolve():
            raise WorkspaceError("Workspace must stay inside the workspaces folder")
        return path

    def settings_for(self, workspace_id: str) -> Settings:
        if workspace_id == DEFAULT_WORKSPACE_ID:
            return Settings.default()
        path = self._named_dir(workspace_id)
        if not (path / META).is_file():
            raise WorkspaceError(f"Unknown workspace: {workspace_id}")
        return Settings.named(workspace_id, path)

    def _meta(self, settings: Settings) -> dict[str, Any]:
        if settings.is_default:
            return {"id": DEFAULT_WORKSPACE_ID, "name": "Default workspace", "created_at": None}
        try:
            return json.loads((settings.workspace / META).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"id": settings.workspace_id, "name": settings.workspace_id, "created_at": None}

    def describe(self, settings: Settings) -> dict[str, Any]:
        meta = self._meta(settings)
        active_run: dict[str, Any] = {}
        try:
            marker = json.loads((settings.workspace / "active_run.json").read_text(encoding="utf-8"))
            run_id = str(marker.get("run_id") or "")
            if run_id and PurePosixPath(run_id).name == run_id:
                manifest = json.loads((settings.staging_path / run_id / "manifest.json").read_text(encoding="utf-8"))
                active_run = {"run_id": run_id, "scenario": manifest.get("scenario")}
        except (OSError, ValueError, AttributeError):
            active_run = {}
        return {
            "id": settings.workspace_id,
            "name": meta.get("name") or settings.workspace_id,
            "created_at": meta.get("created_at"),
            "restored_from": meta.get("restored_from"),
            "path": str(settings.workspace),
            "catalog_exists": settings.catalog_path.is_file(),
            "active_scenario": (active_run or {}).get("scenario"),
            "active_run_id": (active_run or {}).get("run_id"),
        }

    def list(self) -> dict[str, Any]:
        items = [Settings.default()]
        for path in sorted(self.home.iterdir()) if self.home.exists() else []:
            if path.is_dir() and _SLUG.match(path.name) and (path / META).is_file():
                items.append(Settings.named(path.name, path))
        active = self.active_id()
        return {
            "active": active,
            "home": str(self.home),
            "workspaces": [{**self.describe(item), "active": item.workspace_id == active} for item in items],
        }

    # ----- activation ------------------------------------------------------------------
    def active_id(self) -> str:
        current = config._active
        if current is not None:
            return current.workspace_id
        return DEFAULT_WORKSPACE_ID

    def remembered_id(self) -> str:
        try:
            value = json.loads((self.home / POINTER).read_text(encoding="utf-8")).get("id")
        except (OSError, ValueError, AttributeError):
            return DEFAULT_WORKSPACE_ID
        try:
            self.settings_for(str(value))
        except WorkspaceError:
            return DEFAULT_WORKSPACE_ID
        return str(value)

    def activate(self, workspace_id: str, remember: bool = True) -> Settings:
        settings = self.settings_for(workspace_id)
        config.set_active(None if settings.is_default else settings)
        if remember:
            (self.home / POINTER).write_text(json.dumps({"id": workspace_id, "at": _now()}), encoding="utf-8")
        return settings

    def create(self, name: str) -> Settings:
        name = (name or "").strip()
        if not name or len(name) > 80:
            raise WorkspaceError("Workspace name must be 1-80 characters")
        slug = slugify(name)
        if not _SLUG.match(slug) or slug == DEFAULT_WORKSPACE_ID:
            raise WorkspaceError("Workspace name must contain letters (it becomes a folder name)")
        path = self._named_dir(slug)
        if path.exists():
            raise WorkspaceError(f"Workspace already exists: {slug}")
        path.mkdir(parents=True)
        (path / META).write_text(
            json.dumps({"id": slug, "name": name, "created_at": _now(), "format": "contoso.workspace", "version": 1}, indent=2),
            encoding="utf-8",
        )
        return Settings.named(slug, path)

    # ----- backup / restore ------------------------------------------------------------
    def backup(self, workspace_id: str) -> dict[str, Any]:
        settings = self.settings_for(workspace_id)
        self.backups.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        target = self.backups / f"{workspace_id}-{stamp}.zip"
        members: list[tuple[Path, str]] = []
        roots = {settings.workspace.resolve()}
        # The default workspace may keep its catalog elsewhere (CI env vars); include it explicitly.
        extra = [(settings.catalog_path, "catalog/contoso.ducklake.sqlite"), (settings.data_path, "catalog/contoso.ducklake.files")]
        for root in roots:
            for path in sorted(root.rglob("*")):
                rel = path.relative_to(root)
                if not path.is_file() or rel.parts[0] in _SKIP_DIRS:
                    continue
                if path.resolve() == settings.catalog_path.resolve() or settings.data_path.resolve() in path.resolve().parents:
                    continue
                members.append((path, "workspace/" + rel.as_posix()))
        catalog, data = extra
        if catalog[0].is_file():
            members.append(catalog)
        if data[0].is_dir():
            for path in sorted(data[0].rglob("*")):
                if path.is_file():
                    members.append((path, data[1] + "/" + path.relative_to(data[0]).as_posix()))
        manifest = {
            "format": BACKUP_FORMAT,
            "version": 1,
            "workspace": self.describe(settings),
            "created_at": _now(),
            "files": len(members),
        }
        # Hold the catalog lock so neither the API nor dbt writes the catalog while it is copied.
        with catalog_lock(settings.catalog_path):
            with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("backup.json", json.dumps(manifest, indent=2))
                for path, arcname in members:
                    archive.write(path, arcname)
        return {"backup": target.name, "path": str(target), "bytes": target.stat().st_size, "files": len(members)}

    def list_backups(self) -> list[dict[str, Any]]:
        if not self.backups.exists():
            return []
        return [
            {"backup": path.name, "bytes": path.stat().st_size,
             "modified_at": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")}
            for path in sorted(self.backups.glob("*.zip"), reverse=True)
        ]

    def restore(self, backup: str, name: str) -> Settings:
        if Path(backup).name != backup or not backup.endswith(".zip"):
            raise WorkspaceError("Invalid backup name")
        source = self.backups / backup
        if not source.is_file():
            raise WorkspaceError(f"Backup not found: {backup}")
        with zipfile.ZipFile(source) as archive:
            try:
                manifest = json.loads(archive.read("backup.json"))
            except (KeyError, ValueError) as exc:
                raise WorkspaceError("Not a Contoso workspace backup") from exc
            if manifest.get("format") != BACKUP_FORMAT or manifest.get("version") != 1:
                raise WorkspaceError("Unsupported backup format")
            infos = archive.infolist()
            if len(infos) > MAX_BACKUP_MEMBERS or sum(i.file_size for i in infos) > MAX_BACKUP_BYTES:
                raise WorkspaceError("Backup is too large to restore")
            plan: list[tuple[zipfile.ZipInfo, PurePosixPath]] = []
            for info in infos:
                if info.is_dir() or info.filename == "backup.json":
                    continue
                member = PurePosixPath(info.filename)
                if member.is_absolute() or ".." in member.parts or "\\" in info.filename or ":" in info.filename:
                    raise WorkspaceError(f"Unsafe path in backup: {info.filename}")
                if member.parts[0] not in {"workspace", "catalog"} or len(member.parts) < 2:
                    raise WorkspaceError(f"Unexpected entry in backup: {info.filename}")
                plan.append((info, member))
            settings = self.create(name)
            root = settings.workspace.resolve()
            try:
                for info, member in plan:
                    if member.parts[0] == "catalog":
                        relative = PurePosixPath(*member.parts[1:])
                    else:
                        relative = PurePosixPath(*member.parts[1:])
                        if relative.name == META and len(relative.parts) == 1:
                            continue  # keep the new workspace identity
                    destination = (root / Path(*relative.parts)).resolve()
                    if root not in destination.parents:
                        raise WorkspaceError(f"Unsafe path in backup: {info.filename}")
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(info) as reader, destination.open("wb") as writer:
                        shutil.copyfileobj(reader, writer)
            except Exception:
                shutil.rmtree(root, ignore_errors=True)
                raise
        meta_path = root / META
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["restored_from"] = {"backup": backup, "workspace": manifest.get("workspace", {}).get("id")}
        meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
        return settings
