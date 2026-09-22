from __future__ import annotations
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator
import duckdb
from app.config import Settings

class DuckLakeService:
    def __init__(self, settings: Settings):
        self.settings = settings

    @staticmethod
    def _quote(path: Path) -> str:
        return str(path).replace("'", "''")

    @contextmanager
    def connection(self) -> Iterator[duckdb.DuckDBPyConnection]:
        con = duckdb.connect(":memory:")
        try:
            con.execute("INSTALL ducklake")
            con.execute("LOAD ducklake")
            con.execute(
                f"ATTACH 'ducklake:{self._quote(self.settings.catalog_path)}' AS contoso "
                f"(DATA_PATH '{self._quote(self.settings.data_path)}')"
            )
            yield con
        finally:
            con.close()

    def bootstrap(self) -> None:
        self.settings.data_path.mkdir(parents=True, exist_ok=True)
        with self.connection() as con:
            for schema in ("bronze", "silver", "gold"):
                con.execute(f"CREATE SCHEMA IF NOT EXISTS contoso.{schema}")

    def load_parquet_to_bronze(self, files: dict[str, Path]) -> None:
        self.bootstrap()
        with self.connection() as con:
            for table, path in files.items():
                con.execute(
                    f"CREATE OR REPLACE TABLE contoso.bronze.{table} AS "
                    f"SELECT * FROM read_parquet('{self._quote(path)}')"
                )

    def catalog(self) -> list[dict[str, object]]:
        self.bootstrap()
        with self.connection() as con:
            rows = con.execute("""
                SELECT table_schema, table_name, table_type
                FROM contoso.information_schema.tables
                WHERE table_schema IN ('bronze','silver','gold')
                ORDER BY table_schema, table_name
            """).fetchall()
        return [{"schema": s, "name": n, "type": t} for s, n, t in rows]

    def query(self, sql: str, limit: int):
        statement = sql.strip().rstrip(";")
        first = statement.lstrip().split(None, 1)[0].lower() if statement else ""
        if first not in {"select", "with", "show", "describe", "explain", "pragma"}:
            raise ValueError("Only read-only SQL is accepted")
        with self.connection() as con:
            cur = con.execute(statement)
            columns = [d[0] for d in cur.description or []]
            rows = cur.fetchmany(limit + 1)
        truncated = len(rows) > limit
        rows = rows[:limit]
        normalized = [[v.isoformat() if hasattr(v, "isoformat") else v for v in row] for row in rows]
        return columns, normalized, truncated
