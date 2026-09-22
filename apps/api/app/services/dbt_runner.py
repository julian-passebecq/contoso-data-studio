from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

from app.config import Settings


ALLOWED_COMMANDS = {"build", "run", "test", "parse"}


class DbtService:
    def __init__(self, settings: Settings):
        self.settings = settings

    @property
    def executable(self) -> str | None:
        return shutil.which("dbt")

    def _models(self) -> list[dict[str, str]]:
        models_root = self.settings.dbt_path / "models"
        if not models_root.exists():
            return []
        models: list[dict[str, str]] = []
        for path in sorted(models_root.rglob("*.sql")):
            relative = path.relative_to(self.settings.dbt_path)
            layer = path.parent.name
            models.append({
                "name": path.stem,
                "path": relative.as_posix(),
                "layer": layer,
            })
        return models

    def _read_manifest(self) -> dict[str, Any] | None:
        path = self.settings.dbt_path / "target" / "manifest.json"
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    @staticmethod
    def _layer_for_dependency(
        dependency_id: str,
        manifest: dict[str, Any],
    ) -> tuple[str, str]:
        node = manifest.get("nodes", {}).get(dependency_id)
        if node:
            name = str(node.get("name") or dependency_id)
            path = str(node.get("original_file_path") or "")
            parts = Path(path).parts
            for layer in ("bronze", "silver", "gold"):
                if layer in parts:
                    return layer, name
            return str(node.get("schema") or "model"), name

        source = manifest.get("sources", {}).get(dependency_id)
        if source:
            return "bronze", str(source.get("name") or dependency_id)

        return "unknown", dependency_id

    def quality(self) -> dict[str, Any]:
        run_results_path = self.settings.dbt_path / "target" / "run_results.json"
        manifest = self._read_manifest()
        if not run_results_path.exists() or manifest is None:
            return {
                "generated_at": None,
                "summary": {"total": 0, "pass": 0, "fail": 0, "warn": 0, "error": 0, "skip": 0},
                "by_layer": {},
                "tests": [],
            }

        try:
            run_payload = json.loads(run_results_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {
                "generated_at": None,
                "summary": {"total": 0, "pass": 0, "fail": 0, "warn": 0, "error": 0, "skip": 0},
                "by_layer": {},
                "tests": [],
            }

        tests: list[dict[str, Any]] = []
        summary = {"total": 0, "pass": 0, "fail": 0, "warn": 0, "error": 0, "skip": 0}
        by_layer: dict[str, dict[str, int]] = {}

        for result in run_payload.get("results", []):
            unique_id = str(result.get("unique_id") or "")
            if not unique_id.startswith("test."):
                continue

            node = manifest.get("nodes", {}).get(unique_id, {})
            dependencies = node.get("depends_on", {}).get("nodes", [])
            dependency_id = next(
                (
                    item for item in dependencies
                    if str(item).startswith(("model.", "source."))
                ),
                dependencies[0] if dependencies else "",
            )
            layer, model_name = self._layer_for_dependency(str(dependency_id), manifest)
            raw_status = str(result.get("status") or "error").lower()
            status = {
                "success": "pass",
                "passed": "pass",
                "skipped": "skip",
            }.get(raw_status, raw_status)
            if status not in {"pass", "fail", "warn", "error", "skip"}:
                status = "error"

            summary["total"] += 1
            summary[status] += 1
            layer_summary = by_layer.setdefault(
                layer,
                {"total": 0, "pass": 0, "fail": 0, "warn": 0, "error": 0, "skip": 0},
            )
            layer_summary["total"] += 1
            layer_summary[status] += 1

            metadata = node.get("test_metadata") or {}
            tests.append({
                "unique_id": unique_id,
                "name": str(node.get("name") or unique_id),
                "test_type": str(metadata.get("name") or "test"),
                "column_name": node.get("column_name"),
                "layer": layer,
                "model": model_name,
                "status": status,
                "failures": result.get("failures"),
                "execution_time": result.get("execution_time"),
                "message": result.get("message"),
            })

        tests.sort(key=lambda item: (
            0 if item["status"] in {"fail", "error", "warn"} else 1,
            str(item["layer"]),
            str(item["model"]),
            str(item["name"]),
        ))

        return {
            "generated_at": run_payload.get("metadata", {}).get("generated_at"),
            "summary": summary,
            "by_layer": by_layer,
            "tests": tests,
        }

    def _read_run_results(self) -> dict[str, Any] | None:
        path = self.settings.dbt_path / "target" / "run_results.json"
        if not path.exists():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

        results = []
        for item in payload.get("results", []):
            node = item.get("unique_id", "")
            results.append({
                "unique_id": node,
                "status": item.get("status"),
                "execution_time": item.get("execution_time"),
                "message": item.get("message"),
            })
        return {
            "elapsed_time": payload.get("elapsed_time"),
            "generated_at": payload.get("metadata", {}).get("generated_at"),
            "results": results,
        }

    def status(self) -> dict[str, Any]:
        return {
            "available": self.executable is not None,
            "executable": self.executable,
            "project_dir": str(self.settings.dbt_path),
            "models": self._models(),
            "latest_run": self._read_run_results(),
            "quality": self.quality(),
        }

    def run(self, command: str) -> dict[str, Any]:
        if command not in ALLOWED_COMMANDS:
            raise ValueError(f"Unsupported dbt command: {command}")
        executable = self.executable
        if not executable:
            raise RuntimeError(
                'dbt is not installed. Install the API with: pip install -e "apps/api[dbt]"'
            )

        args = [
            executable,
            command,
            "--project-dir",
            str(self.settings.dbt_path),
            "--profiles-dir",
            str(self.settings.dbt_path),
            "--no-use-colors",
        ]
        completed = subprocess.run(
            args,
            cwd=self.settings.dbt_path,
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
        )
        combined = "\n".join(part for part in (completed.stdout, completed.stderr) if part)
        return {
            "command": command,
            "exit_code": completed.returncode,
            "ok": completed.returncode == 0,
            "output": combined[-50_000:],
            "run_results": self._read_run_results(),
        }
