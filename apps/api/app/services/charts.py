from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any

import yaml

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

    def board(self, board: str) -> dict[str, Any]:
        path = self._board_path(board)
        try:
            payload = yaml.safe_load(path.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError) as exc:
            raise ValueError("Board YAML could not be read") from exc
        if not isinstance(payload, dict):
            raise ValueError("Board YAML must contain an object at the root")

        queries: list[dict[str, Any]] = []
        raw_queries = payload.get("queries")
        if isinstance(raw_queries, dict):
            for name, spec in raw_queries.items():
                sql = None
                if isinstance(spec, str):
                    sql = spec
                elif isinstance(spec, dict) and isinstance(spec.get("sql"), str):
                    sql = spec["sql"]
                queries.append({
                    "name": str(name),
                    "sql": sql,
                })

        charts: list[dict[str, Any]] = []
        raw_charts = payload.get("charts")
        if isinstance(raw_charts, dict):
            for name, spec in raw_charts.items():
                chart = spec if isinstance(spec, dict) else {}
                charts.append({
                    "name": str(name),
                    "label": chart.get("label"),
                    "title": chart.get("title"),
                    "type": chart.get("type"),
                    "query": chart.get("query"),
                    "x": chart.get("x"),
                    "y": chart.get("y"),
                    "color": chart.get("color"),
                    "value": chart.get("value"),
                })

        return {
            "board": path.relative_to(self.settings.charts_path).as_posix(),
            "title": payload.get("title"),
            "notes": payload.get("notes"),
            "source": payload.get("source"),
            "queries": queries,
            "charts": charts,
            "rows": payload.get("rows") if isinstance(payload.get("rows"), list) else [],
        }

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
