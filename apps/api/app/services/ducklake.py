from __future__ import annotations

import re
import sqlite3
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
    def _quote_identifier(value: str) -> str:
        return '"' + value.replace('"', '""') + '"'

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
        attached = False
        try:
            self._load_extensions(con)
            options = ["READ_ONLY"] if read_only else [
                f"DATA_PATH '{self._quote(self.settings.data_path)}'"
            ]
            con.execute(
                f"ATTACH 'ducklake:sqlite:{self._quote(self.settings.catalog_path)}' AS contoso "
                f"({', '.join(options)})"
            )
            attached = True
            yield con
        finally:
            if attached:
                con.execute("DETACH contoso")
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
        with sqlite3.connect(self.settings.catalog_path) as metadata:
            rows = metadata.execute(
                """
                SELECT s.schema_name, t.table_name
                FROM ducklake_table AS t
                JOIN ducklake_schema AS s ON s.schema_id = t.schema_id
                WHERE t.end_snapshot IS NULL
                  AND s.end_snapshot IS NULL
                  AND s.schema_name IN ('bronze', 'silver', 'gold')
                ORDER BY s.schema_name, t.table_name
                """
            ).fetchall()

        return [
            {"schema": schema, "name": name, "type": "BASE TABLE"}
            for schema, name in rows
        ]

    def snapshots(self, limit: int = 50) -> list[dict[str, Any]]:
        self.bootstrap()
        with self.connection(read_only=True) as con:
            rows = con.execute(
                """
                SELECT snapshot_id, snapshot_time, schema_version, changes,
                       author, commit_message
                FROM contoso.snapshots()
                ORDER BY snapshot_id DESC
                LIMIT ?
                """,
                [max(1, min(limit, 200))],
            ).fetchall()

        return [
            {
                "snapshot_id": row[0],
                "snapshot_time": self._normalize(row[1]),
                "schema_version": row[2],
                "changes": self._normalize(row[3]),
                "author": row[4],
                "commit_message": row[5],
            }
            for row in rows
        ]

    def preview_at_snapshot(
        self,
        schema: str,
        table: str,
        snapshot_id: int,
        limit: int = 100,
    ) -> tuple[list[str], list[list[Any]], bool]:
        if schema not in {"bronze", "silver", "gold"}:
            raise ValueError("Schema must be bronze, silver, or gold")
        if snapshot_id < 0:
            raise ValueError("Snapshot id must be non-negative")

        available = {
            (str(item["schema"]), str(item["name"]))
            for item in self.catalog()
        }
        if (schema, table) not in available:
            raise ValueError(f"Unknown current table: {schema}.{table}")

        schema_sql = self._quote_identifier(schema)
        table_sql = self._quote_identifier(table)
        fetch_limit = max(1, min(limit, 2_000))
        statement = (
            f"SELECT * FROM contoso.{schema_sql}.{table_sql} "
            f"AT (VERSION => {int(snapshot_id)})"
        )

        with self.connection(read_only=True) as con:
            cur = con.execute(statement)
            columns = [entry[0] for entry in cur.description or []]
            rows = cur.fetchmany(fetch_limit + 1)

        truncated = len(rows) > fetch_limit
        normalized = [
            [self._normalize(value) for value in row]
            for row in rows[:fetch_limit]
        ]
        return columns, normalized, truncated

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
