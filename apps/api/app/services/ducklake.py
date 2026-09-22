from __future__ import annotations

import re
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import duckdb

from app.config import Settings


FORBIDDEN_SQL = re.compile(
    r"\b(insert|update|delete|create|drop|alter|copy|attach|detach|install|load|call|export|import|truncate|replace|merge)\b",
    re.IGNORECASE,
)


class DuckLakeService:
    def __init__(self, settings: Settings):
        self.settings = settings

    @staticmethod
    def _quote(path: Path) -> str:
        return str(path).replace("'", "''")

    @staticmethod
    def _normalize(value: Any) -> Any:
        if hasattr(value, "isoformat"):
            return value.isoformat()
        if isinstance(value, (bytes, bytearray)):
            return value.hex()
        if isinstance(value, dict):
            return {str(k): DuckLakeService._normalize(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [DuckLakeService._normalize(v) for v in value]
        return value

    @staticmethod
    def _load_extensions(con: duckdb.DuckDBPyConnection) -> None:
        for extension in ("ducklake", "sqlite"):
            try:
                con.execute(f"LOAD {extension}")
            except duckdb.Error:
                con.execute(f"INSTALL {extension}")
                con.execute(f"LOAD {extension}")

    @contextmanager
    def connection(self, read_only: bool = False) -> Iterator[duckdb.DuckDBPyConnection]:
        con = duckdb.connect(":memory:")
        try:
            self._load_extensions(con)
            options = ["READ_ONLY"] if read_only else [
                f"DATA_PATH '{self._quote(self.settings.data_path)}'"
            ]
            con.execute(
                f"ATTACH 'ducklake:sqlite:{self._quote(self.settings.catalog_path)}' AS contoso "
                f"({', '.join(options)})"
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
            rows = con.execute("SHOW ALL TABLES").fetchall()

        tables = [
            {"schema": row[1], "name": row[2], "type": "BASE TABLE"}
            for row in rows
            if row[0] == "contoso" and row[1] in {"bronze", "silver", "gold"}
        ]
        return sorted(tables, key=lambda item: (str(item["schema"]), str(item["name"])))

    def query(self, sql: str, limit: int):
        statement = sql.strip()
        if statement.endswith(";"):
            statement = statement[:-1].rstrip()
        if not statement:
            raise ValueError("SQL is empty")
        if ";" in statement:
            raise ValueError("Only one SQL statement can be executed at a time")

        first = statement.lstrip().split(None, 1)[0].lower()
        if first not in {"select", "with", "show", "describe", "explain"}:
            raise ValueError("Only read-only SQL is accepted")
        if FORBIDDEN_SQL.search(statement):
            raise ValueError("Mutating or administrative SQL is not allowed in the Query workbench")

        with self.connection(read_only=True) as con:
            cur = con.execute(statement)
            columns = [d[0] for d in cur.description or []]
            rows = cur.fetchmany(limit + 1)

        truncated = len(rows) > limit
        rows = rows[:limit]
        normalized = [[self._normalize(v) for v in row] for row in rows]
        return columns, normalized, truncated
