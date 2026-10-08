from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_WORKSPACE_ID = "default"

# Set by WorkspaceRegistry.activate(); every Settings.load() then resolves the active workspace.
_active: "Settings | None" = None


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class Settings:
    workspace: Path
    workspace_id: str = DEFAULT_WORKSPACE_ID

    @classmethod
    def load(cls) -> "Settings":
        if _active is not None:
            return _active
        return cls.default()

    @classmethod
    def default(cls) -> "Settings":
        """The legacy single workspace (``workspace/`` or ``CONTOSO_WORKSPACE``), kept in place on upgrade."""
        configured = os.getenv("CONTOSO_WORKSPACE")
        workspace = (
            Path(configured).expanduser().resolve()
            if configured
            else _repo_root() / "workspace"
        )
        workspace.mkdir(parents=True, exist_ok=True)
        return cls(workspace=workspace)

    @classmethod
    def named(cls, workspace_id: str, workspace: Path) -> "Settings":
        workspace.mkdir(parents=True, exist_ok=True)
        return cls(workspace=workspace.resolve(), workspace_id=workspace_id)

    @property
    def is_default(self) -> bool:
        return self.workspace_id == DEFAULT_WORKSPACE_ID

    @property
    def project_root(self) -> Path:
        configured = os.getenv("CONTOSO_PROJECT_ROOT")
        if configured:
            return Path(configured).expanduser().resolve()
        return _repo_root()

    @property
    def home(self) -> Path:
        """Folder holding named workspaces, backups and the active-workspace pointer."""
        configured = os.getenv("CONTOSO_HOME")
        if configured:
            path = Path(configured).expanduser().resolve()
        else:
            path = Settings.default().workspace.parent / "workspaces"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def catalog_path(self) -> Path:
        configured = os.getenv("CONTOSO_DUCKLAKE_CATALOG")
        if configured and self.is_default:
            path = Path(configured).expanduser().resolve()
            path.parent.mkdir(parents=True, exist_ok=True)
            return path
        return self.workspace / "contoso.ducklake.sqlite"

    @property
    def data_path(self) -> Path:
        configured = os.getenv("CONTOSO_DUCKLAKE_DATA_PATH")
        if configured and self.is_default:
            path = Path(configured).expanduser().resolve()
            path.mkdir(parents=True, exist_ok=True)
            return path
        return self.workspace / "contoso.ducklake.files"

    @property
    def staging_path(self) -> Path:
        return self.workspace / "staging"

    @property
    def dbt_path(self) -> Path:
        return self.project_root / "dbt"

    @property
    def dbt_target_path(self) -> Path:
        """dbt artifacts (manifest, run_results) belong to the workspace whose catalog they describe."""
        if self.is_default:
            return self.dbt_path / "target"
        return self.workspace / "dbt-target"

    @property
    def charts_path(self) -> Path:
        return self.project_root / "charts"

    def dbt_env(self) -> dict[str, str]:
        """Environment for dbt / dct subprocesses: always the absolute paths of this workspace."""
        return {
            **os.environ,
            "CONTOSO_DUCKLAKE_CATALOG": str(self.catalog_path),
            "CONTOSO_DUCKLAKE_DATA_PATH": str(self.data_path),
            "DBT_TARGET_PATH": str(self.dbt_target_path),
            "DBT_LOG_PATH": str(self.dbt_target_path.parent / "dbt-logs")
            if not self.is_default
            else str(self.dbt_path / "logs"),
        }


def set_active(settings: "Settings | None") -> None:
    global _active
    _active = settings
