"""Load the Rayfin model compiled offline by apps/fabric-app-lab (rayfin/generated/model.json)."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

MODEL_RELATIVE_PATH = Path("apps/fabric-app-lab/rayfin/generated/model.json")


@dataclass(frozen=True)
class Column:
    name: str
    db_type: str
    nullable: bool
    primary_key: bool
    unique: bool
    format: str | None
    references: dict[str, str] | None
    min: float | None
    max: float | None
    regex: str | None

    @property
    def sqlite_type(self) -> str:
        upper = self.db_type.upper()
        if upper.startswith("DECIMAL") or upper.startswith("NUMERIC") or upper in {"FLOAT", "REAL"}:
            return "REAL"
        if upper in {"INT", "BIGINT", "SMALLINT", "BIT"}:
            return "INTEGER"
        return "TEXT"

    @property
    def duckdb_type(self) -> str:
        upper = self.db_type.upper()
        if upper.startswith("DECIMAL"):
            return upper
        if upper in {"INT", "BIGINT", "SMALLINT"}:
            return "BIGINT"
        if upper == "BIT":
            return "BOOLEAN"
        return "VARCHAR"


@dataclass(frozen=True)
class RoleDeclaration:
    role: str
    actions: tuple[str, ...]
    policy: dict[str, Any] | None
    policy_text: str | None


@dataclass(frozen=True)
class Entity:
    name: str
    table: str
    columns: tuple[Column, ...]
    roles: tuple[RoleDeclaration, ...]
    column_names: frozenset[str] = field(default_factory=frozenset)

    @property
    def plural(self) -> str:
        """Learn-article style accessor name, e.g. `forecasts` for `client.data.forecasts`."""
        return self.table.lower()

    def column(self, name: str) -> Column | None:
        return next((column for column in self.columns if column.name == name), None)

    @property
    def relationships(self) -> dict[str, Column]:
        """`department` -> its `department_id` column (Rayfin `{prop}_id` convention)."""
        return {
            column.name[: -len("_id")]: column
            for column in self.columns
            if column.references and column.name.endswith("_id")
        }


@dataclass(frozen=True)
class AppModel:
    entities: dict[str, Entity]
    source: Path

    def entity(self, name: str) -> Entity:
        """Accept `Forecast` (package-doc style) or `forecasts` (Learn-article style)."""
        if name in self.entities:
            return self.entities[name]
        for entity in self.entities.values():
            if entity.plural == name.lower():
                return entity
        raise ValueError(f"Unknown entity: {name}")

    def summary(self) -> list[dict[str, Any]]:
        return [
            {
                "name": entity.name,
                "table": entity.table,
                "plural": entity.plural,
                "columns": [
                    {"name": c.name, "db_type": c.db_type, "nullable": c.nullable, "references": c.references}
                    for c in entity.columns
                ],
                "roles": [
                    {"role": r.role, "actions": list(r.actions), "policy": r.policy_text}
                    for r in entity.roles
                ],
            }
            for entity in self.entities.values()
        ]


def load_model(project_root: Path) -> AppModel:
    path = project_root / MODEL_RELATIVE_PATH
    payload = json.loads(path.read_text(encoding="utf-8"))
    entities: dict[str, Entity] = {}
    for raw in payload["entities"]:
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", raw["table"]):
            raise ValueError(f"Unsafe table name in model: {raw['table']}")
        columns = []
        for col in raw["columns"]:
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", col["name"]):
                raise ValueError(f"Unsafe column name in model: {col['name']}")
            columns.append(
                Column(
                    name=col["name"],
                    db_type=col["db_type"],
                    nullable=bool(col["nullable"]),
                    primary_key=bool(col["primary_key"]),
                    unique=bool(col["unique"]),
                    format=col.get("format"),
                    references=col.get("references"),
                    min=col.get("min"),
                    max=col.get("max"),
                    regex=col.get("regex"),
                )
            )
        roles = tuple(
            RoleDeclaration(
                role=r["role"],
                actions=tuple(r["actions"]),
                policy=r.get("policy"),
                policy_text=r.get("policy_text"),
            )
            for r in raw["roles"]
        )
        entities[raw["name"]] = Entity(
            name=raw["name"],
            table=raw["table"],
            columns=tuple(columns),
            roles=roles,
            column_names=frozenset(c.name for c in columns),
        )
    return AppModel(entities=entities, source=path)
