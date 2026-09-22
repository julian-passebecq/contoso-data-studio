from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any

from app.config import Settings


class ChartsService:
    def __init__(self, settings: Settings):
        self.settings = settings

    @property
    def executable(self) -> str | None:
        return shutil.which("dct")

    def _board_path(self, board: str) -> Path:
        root = self.settings.charts_path.resolve()
        path = (root / board).resolve()
        if not path.is_relative_to(root):
            raise ValueError("Board path must stay inside charts/")
        if not path.exists() or not path.is_file():
            raise ValueError("Board does not exist")
        if path.suffix.lower() not in {".yml", ".yaml"}:
            raise ValueError("Board must be YAML")
        return path

    def status(self) -> dict[str, Any]:
        boards = []
        if self.settings.charts_path.exists():
            for path in sorted(self.settings.charts_path.rglob("*.y*ml")):
                boards.append(path.relative_to(self.settings.charts_path).as_posix())

        version = None
        executable = self.executable
        if executable:
            completed = subprocess.run(
                [executable, "--version"],
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
            version = (completed.stdout or completed.stderr).strip() or None

        return {
            "available": executable is not None,
            "version": version,
            "boards": boards,
        }

    def validate(self, board: str) -> dict[str, Any]:
        executable = self.executable
        if not executable:
            raise RuntimeError(
                "dbt Charts is not on PATH. Install it in an isolated tool environment "
                "with: uv tool install dbt-charts --with dbt-duckdb==1.11.0"
            )

        path = self._board_path(board)
        completed = subprocess.run(
            [
                executable,
                "validate",
                str(path),
                "--project-dir",
                str(self.settings.project_root),
                "--dbt-project-dir",
                str(self.settings.dbt_path),
            ],
            cwd=self.settings.project_root,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        output = "\n".join(
            part for part in (completed.stdout, completed.stderr) if part
        )
        return {
            "board": path.relative_to(self.settings.project_root).as_posix(),
            "ok": completed.returncode == 0,
            "exit_code": completed.returncode,
            "output": output[-30_000:],
        }
