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
