from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import duckdb

from app.config import Settings


SUPPORTED_EXTENSIONS = {
    ".parquet": "Parquet",
    ".json": "JSON",
    ".jsonl": "JSON Lines",
    ".ndjson": "NDJSON",
    ".csv": "CSV",
    ".xlsx": "Excel",
}


class ExplorerService:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.imports_path = settings.workspace / "imports"
        self.imports_path.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _quote(value: str | Path) -> str:
        return str(value).replace("'", "''")

    @staticmethod
    def _normalize(value: Any) -> Any:
        if hasattr(value, "isoformat"):
            return value.isoformat()
        if isinstance(value, (bytes, bytearray)):
            return value.hex()
        if isinstance(value, dict):
            return {str(k): ExplorerService._normalize(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [ExplorerService._normalize(v) for v in value]
        return value

    def _resolve(self, relative_path: str) -> Path:
        workspace = self.settings.workspace.resolve()
        candidate = (workspace / relative_path).resolve()
        if not candidate.is_relative_to(workspace):
            raise ValueError("Path must stay inside the Contoso workspace")
        if not candidate.exists() or not candidate.is_file():
            raise ValueError("File does not exist")
        if candidate.suffix.lower() not in SUPPORTED_EXTENSIONS:
            raise ValueError(f"Unsupported file type: {candidate.suffix}")
        return candidate

    def import_file(self, filename: str, payload: bytes) -> dict[str, Any]:
        safe_name = Path(filename).name
        suffix = Path(safe_name).suffix.lower()
        if not safe_name or safe_name in {".", ".."}:
            raise ValueError("A valid filename is required")
        if suffix not in SUPPORTED_EXTENSIONS:
            raise ValueError(
                "Unsupported file type. Use Parquet, JSON, JSONL, NDJSON, CSV, or XLSX."
            )
        if not payload:
            raise ValueError("Uploaded file is empty")
        if len(payload) > 100 * 1024 * 1024:
            raise ValueError("Uploaded file exceeds the 100 MB local import limit")

        destination = self.imports_path / safe_name
        if destination.exists():
            stem = destination.stem
            suffix_text = destination.suffix
            index = 2
            while destination.exists():
                destination = self.imports_path / f"{stem}-{index}{suffix_text}"
                index += 1

        destination.write_bytes(payload)
        workspace = self.settings.workspace.resolve()
        stat = destination.stat()
        return {
            "path": destination.resolve().relative_to(workspace).as_posix(),
            "name": destination.name,
            "format": SUPPORTED_EXTENSIONS[suffix],
            "size_bytes": stat.st_size,
            "modified_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        }

    def list_files(self) -> list[dict[str, Any]]:
        roots = [self.settings.staging_path, self.imports_path]
        files: list[dict[str, Any]] = []
        workspace = self.settings.workspace.resolve()
        for root in roots:
            if not root.exists():
                continue
            for path in root.rglob("*"):
                if not path.is_file() or path.suffix.lower() not in SUPPORTED_EXTENSIONS:
                    continue
                stat = path.stat()
                files.append({
                    "path": path.resolve().relative_to(workspace).as_posix(),
                    "name": path.name,
                    "format": SUPPORTED_EXTENSIONS[path.suffix.lower()],
                    "size_bytes": stat.st_size,
                    "modified_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                })
        return sorted(files, key=lambda item: item["modified_at"], reverse=True)

    def _source_sql(self, path: Path) -> str:
        quoted = self._quote(path)
        suffix = path.suffix.lower()
        if suffix == ".parquet":
            return f"read_parquet('{quoted}')"
        if suffix == ".csv":
            return f"read_csv_auto('{quoted}')"
        if suffix in {".json", ".jsonl", ".ndjson"}:
            return f"read_json_auto('{quoted}')"
        if suffix == ".xlsx":
            return f"read_xlsx('{quoted}')"
        raise ValueError(f"Unsupported file type: {suffix}")

    def _connect(self, needs_excel: bool = False) -> duckdb.DuckDBPyConnection:
        con = duckdb.connect(":memory:")
        if needs_excel:
            try:
                con.execute("LOAD excel")
            except duckdb.Error:
                con.execute("INSTALL excel")
                con.execute("LOAD excel")
        return con

    def inspect(self, relative_path: str, limit: int = 200) -> dict[str, Any]:
        path = self._resolve(relative_path)
        source = self._source_sql(path)
        con = self._connect(path.suffix.lower() == ".xlsx")
        try:
            description = con.execute(f"DESCRIBE SELECT * FROM {source}").fetchall()
            schema = [{"name": row[0], "type": row[1], "nullable": row[2]} for row in description]

            cursor = con.execute(f"SELECT * FROM {source} LIMIT {int(limit)}")
            columns = [entry[0] for entry in cursor.description or []]
            rows = [
                [self._normalize(value) for value in row]
                for row in cursor.fetchall()
            ]

            count = con.execute(f"SELECT count(*) FROM {source}").fetchone()[0]
            metadata: dict[str, Any] = {
                "format": SUPPORTED_EXTENSIONS[path.suffix.lower()],
                "size_bytes": path.stat().st_size,
                "row_count": count,
            }

            if path.suffix.lower() == ".parquet":
                row = con.execute(
                    f"""SELECT created_by, num_rows, num_row_groups, format_version,
                               file_size_bytes, footer_size
                        FROM parquet_file_metadata('{self._quote(path)}')"""
                ).fetchone()
                metadata.update({
                    "created_by": row[0],
                    "num_rows": row[1],
                    "num_row_groups": row[2],
                    "format_version": row[3],
                    "file_size_bytes": row[4],
                    "footer_size": row[5],
                })
                metadata["columns"] = [
                    {
                        "name": r[0],
                        "type": r[1],
                        "compression": r[2],
                        "min": r[3],
                        "max": r[4],
                        "null_count": r[5],
                    }
                    for r in con.execute(
                        f"""SELECT path_in_schema, any_value(type), any_value(compression),
                                   min(stats_min), max(stats_max), sum(stats_null_count)
                            FROM parquet_metadata('{self._quote(path)}')
                            GROUP BY path_in_schema
                            ORDER BY path_in_schema"""
                    ).fetchall()
                ]

            return {
                "path": relative_path,
                "source_sql": source,
                "schema": schema,
                "columns": columns,
                "rows": rows,
                "preview_count": len(rows),
                "metadata": metadata,
            }
        finally:
            con.close()
