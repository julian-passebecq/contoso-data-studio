"""Local operational store for the Sales Forecasting app (stand-in for the Fabric SQL database).

LOCAL ADAPTER, NOT RAYFIN API. The method names follow the Rayfin 1.36.2 client documented in
@microsoft/rayfin-guide (data/graphql.md): select/where/orderBy/first/execute, findById,
create, update(filter, patch). Every call runs the entity's @authenticated policies for the
calling fake user before touching a row.
"""
from __future__ import annotations

import random
import re
import sqlite3
import threading
import time
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

from app.services.fabric_apps.model import AppModel, Entity
from app.services.fabric_apps.policy import LocalUser, PolicyDenied, can, require

EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
NAMESPACE = uuid.UUID("6f1c2a52-3f7e-4f0e-9d7a-5a1e2c0f4b11")
MONTHS = [f"2026-{m:02d}" for m in range(1, 13)]
ACTUAL_MONTHS = MONTHS[:9]

# Synthetic fake users (no Entra ID). Emails use the reserved .test TLD.
USERS: tuple[LocalUser, ...] = (
    LocalUser("u-ana", "Ana Lund (Finance, Nordics)", "ana.finance@contoso.test", "finance", "NORD"),
    LocalUser("u-ben", "Ben Costa (Finance, Southern Europe)", "ben.finance@contoso.test", "finance", "SOUTH"),
    LocalUser("u-cleo", "Cleo Martin (Finance, Online)", "cleo.finance@contoso.test", "finance", "ONLINE"),
    LocalUser("u-eva", "Eva Novak (Executive)", "eva.exec@contoso.test", "executive", None),
)

DEPARTMENTS = (
    ("NORD", "Nordic Retail", "ana.finance@contoso.test", 410_000),
    ("SOUTH", "Southern Europe", "ben.finance@contoso.test", 520_000),
    ("ONLINE", "Online Sales", "cleo.finance@contoso.test", 365_000),
)


class ValidationError(ValueError):
    pass


class NotFound(LookupError):
    pass


def _quote(identifier: str) -> str:
    # Identifiers come from model.json and are validated in load_model.
    return '"' + identifier.replace('"', '""') + '"'


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def stable_id(*parts: str) -> str:
    return str(uuid.uuid5(NAMESPACE, "/".join(parts)))


def user_by_id(user_id: str | None) -> LocalUser:
    for user in USERS:
        if user.id == user_id:
            return user
    raise PolicyDenied("Unknown local user. Send X-Local-User with one of /users.")


class OperationalStore:
    def __init__(self, path: Path, model: AppModel):
        self.path = path
        self.model = model
        self._write_lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)
        fresh = not path.exists()
        self._ensure_schema()
        if fresh or self._count("Department") == 0:
            self.reset(actor="seed")

    # ----- connection and schema -------------------------------------------------
    def connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(self.path, timeout=30)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys = ON")
        return con

    def _ensure_schema(self) -> None:
        with closing(self.connect()) as con, con:
            con.execute("PRAGMA journal_mode = WAL")
            for entity in self.model.entities.values():
                con.execute(self.ddl(entity))
            con.execute(
                """CREATE TABLE IF NOT EXISTS _rayfin_changes (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    entity TEXT NOT NULL, row_id TEXT, op TEXT NOT NULL,
                    committed_at TEXT NOT NULL, committed_ns INTEGER NOT NULL,
                    actor TEXT NOT NULL, summary TEXT)"""
            )
            con.execute(
                """CREATE TABLE IF NOT EXISTS _rayfin_mirror (
                    seq INTEGER PRIMARY KEY,
                    mirrored_at TEXT NOT NULL, latency_ms REAL NOT NULL, snapshot_id INTEGER,
                    endpoint_at TEXT, gold_at TEXT, gold_snapshot_id INTEGER, gold_ok INTEGER)"""
            )

    def ddl(self, entity: Entity) -> str:
        parts = []
        for column in entity.columns:
            line = f'"{column.name}" {column.sqlite_type}'
            if column.primary_key:
                line += " PRIMARY KEY"
            if not column.nullable:
                line += " NOT NULL"
            if column.unique and not column.primary_key:
                line += " UNIQUE"
            if column.references:
                target = self.model.entity(column.references["entity"])
                line += f' REFERENCES "{target.table}"("{column.references["field"]}")'
            parts.append(line)
        return f'CREATE TABLE IF NOT EXISTS "{entity.table}" ({", ".join(parts)})'

    def _count(self, entity_name: str) -> int:
        entity = self.model.entity(entity_name)
        with closing(self.connect()) as con:
            return int(con.execute(f'SELECT count(*) FROM "{entity.table}"').fetchone()[0])

    # ----- seed -------------------------------------------------------------------
    def reset(self, actor: str = "reset") -> None:
        """Rebuild deterministic synthetic data. Mirrors as one 'reset' change."""
        rng = random.Random(20261006)
        department = self.model.entity("Department")
        forecast = self.model.entity("Forecast")
        actual = self.model.entity("Actual")
        with self._write_lock, closing(self.connect()) as con, con:
            for entity in (forecast, actual, department):
                con.execute(f'DELETE FROM "{entity.table}"')
            for code, name, owner, base in DEPARTMENTS:
                dept_id = stable_id("department", code)
                con.execute(
                    f'INSERT INTO "{department.table}" (id, code, name, finance_owner_email) VALUES (?,?,?,?)',
                    (dept_id, code, name, owner),
                )
                for index, month in enumerate(MONTHS):
                    season = 1 + 0.18 * (1 if index in (10, 11) else 0) - 0.06 * (1 if index in (0, 1) else 0)
                    planned = float(round(base * season * (1 + 0.012 * index)))
                    con.execute(
                        f'INSERT INTO "{forecast.table}" (id, department_id, month, amount, note, owner_email, updated_by, updated_at) '
                        "VALUES (?,?,?,?,?,?,?,?)",
                        (stable_id("forecast", code, month), dept_id, month, planned, None, owner, "seed", "2026-01-01T00:00:00.000+00:00"),
                    )
                    if month in ACTUAL_MONTHS:
                        booked = float(round(planned * rng.uniform(0.86, 1.12)))
                        con.execute(
                            f'INSERT INTO "{actual.table}" (id, department_id, month, amount, owner_email) VALUES (?,?,?,?,?)',
                            (stable_id("actual", code, month), dept_id, month, booked, owner),
                        )
            self._log(con, "*", None, "reset", actor, "synthetic seed")

    # ----- change log ---------------------------------------------------------------
    def _log(self, con: sqlite3.Connection, entity: str, row_id: str | None, op: str, actor: str, summary: str) -> int:
        cursor = con.execute(
            "INSERT INTO _rayfin_changes (entity, row_id, op, committed_at, committed_ns, actor, summary) VALUES (?,?,?,?,?,?,?)",
            (entity, row_id, op, now_iso(), time.time_ns(), actor, summary),
        )
        return int(cursor.lastrowid)

    def changes_after(self, seq: int) -> list[dict[str, Any]]:
        with closing(self.connect()) as con:
            return [dict(row) for row in con.execute("SELECT * FROM _rayfin_changes WHERE seq > ? ORDER BY seq", (seq,))]

    def last_mirrored_seq(self) -> int:
        with closing(self.connect()) as con:
            value = con.execute("SELECT max(seq) FROM _rayfin_mirror").fetchone()[0]
        return int(value or 0)

    def record_mirror(self, seqs: Iterable[int], mirrored_at: str, mirrored_ns: int, snapshot_id: int | None) -> None:
        with closing(self.connect()) as con, con:
            for seq in seqs:
                committed_ns = con.execute("SELECT committed_ns FROM _rayfin_changes WHERE seq=?", (seq,)).fetchone()[0]
                con.execute(
                    "INSERT OR REPLACE INTO _rayfin_mirror (seq, mirrored_at, latency_ms, snapshot_id) VALUES (?,?,?,?)",
                    (seq, mirrored_at, round((mirrored_ns - committed_ns) / 1e6, 2), snapshot_id),
                )

    def record_stage(self, seqs: Iterable[int], **values: Any) -> None:
        allowed = {"endpoint_at", "gold_at", "gold_snapshot_id", "gold_ok"}
        assignments = [(k, v) for k, v in values.items() if k in allowed]
        if not assignments:
            return
        with closing(self.connect()) as con, con:
            for seq in seqs:
                con.execute(
                    f"UPDATE _rayfin_mirror SET {', '.join(f'{k}=?' for k, _ in assignments)} WHERE seq=?",
                    (*[v for _, v in assignments], seq),
                )

    def trace(self, seq: int | None = None) -> dict[str, Any] | None:
        with closing(self.connect()) as con:
            if seq is None:
                row = con.execute("SELECT * FROM _rayfin_changes WHERE op != 'reset' ORDER BY seq DESC LIMIT 1").fetchone()
            else:
                row = con.execute("SELECT * FROM _rayfin_changes WHERE seq=?", (seq,)).fetchone()
            if row is None:
                return None
            mirror = con.execute("SELECT * FROM _rayfin_mirror WHERE seq=?", (row["seq"],)).fetchone()
        return {"change": dict(row), "mirror": dict(mirror) if mirror else None}

    def latency_stats(self, limit: int = 50) -> dict[str, Any]:
        with closing(self.connect()) as con:
            rows = [
                dict(row)
                for row in con.execute(
                    "SELECT c.seq, c.entity, c.op, c.actor, c.committed_at, m.mirrored_at, m.latency_ms, m.snapshot_id, "
                    "m.endpoint_at, m.gold_at, m.gold_snapshot_id, m.gold_ok "
                    "FROM _rayfin_changes c LEFT JOIN _rayfin_mirror m ON m.seq = c.seq ORDER BY c.seq DESC LIMIT ?",
                    (limit,),
                )
            ]
        latencies = sorted(r["latency_ms"] for r in rows if r["latency_ms"] is not None and r["op"] != "reset")
        stats = None
        if latencies:
            stats = {
                "count": len(latencies),
                "last_ms": next(r["latency_ms"] for r in rows if r["latency_ms"] is not None and r["op"] != "reset"),
                "p50_ms": latencies[len(latencies) // 2],
                "max_ms": latencies[-1],
            }
        pending = sum(1 for r in rows if r["mirrored_at"] is None)
        return {"stats": stats, "pending": pending, "recent": rows}

    # ----- reads --------------------------------------------------------------------
    def _rows(self, con: sqlite3.Connection, entity: Entity, where: Mapping[str, Any] | None) -> list[dict[str, Any]]:
        clauses, params = [], []
        for field, condition in (where or {}).items():
            if field not in entity.column_names:
                raise ValidationError(f"Unknown field in where: {field}")
            if isinstance(condition, Mapping):
                if set(condition) != {"eq"}:
                    raise ValidationError("The local adapter supports only { field: { eq: value } } filters")
                value = condition["eq"]
            else:
                value = condition
            clauses.append(f'"{field}" = ?')
            params.append(value)
        sql = f'SELECT * FROM "{entity.table}"' + (f" WHERE {' AND '.join(clauses)}" if clauses else "")
        return [dict(row) for row in con.execute(sql, params)]

    def query(
        self,
        entity_name: str,
        user: LocalUser,
        select: list[str] | None = None,
        where: Mapping[str, Any] | None = None,
        order_by: Mapping[str, str] | None = None,
        first: int = 100,
    ) -> list[dict[str, Any]]:
        entity = self.model.entity(entity_name)
        require(entity, user, "read")
        with closing(self.connect()) as con:
            rows = [row for row in self._rows(con, entity, where) if can(entity, user, "read", row)]
            for field, direction in reversed(list((order_by or {}).items())):
                if field not in entity.column_names:
                    raise ValidationError(f"Unknown orderBy field: {field}")
                rows.sort(key=lambda r: (r[field] is None, r[field]), reverse=str(direction).lower() == "desc")
            limit = len(rows) if first == -1 else max(0, min(first, 100_000))
            rows = rows[:limit]
            return [self._project(con, entity, user, row, select) for row in rows]

    def _project(self, con, entity: Entity, user: LocalUser, row: dict[str, Any], select: list[str] | None) -> dict[str, Any]:
        if not select:
            return dict(row)
        out: dict[str, Any] = {}
        related_cache: dict[str, dict[str, Any] | None] = {}
        for path in select:
            if "." not in path:
                if path not in entity.column_names:
                    raise ValidationError(f"Unknown field in select: {path}")
                out[path] = row[path]
                continue
            relation, field = path.split(".", 1)
            column = entity.relationships.get(relation)
            if column is None:
                raise ValidationError(f"Unknown relationship in select: {relation}")
            target = self.model.entity(column.references["entity"])
            if relation not in related_cache:
                found = con.execute(f'SELECT * FROM "{target.table}" WHERE id=?', (row[column.name],)).fetchone()
                related = dict(found) if found else None
                related_cache[relation] = related if related and can(target, user, "read", related) else None
            related = related_cache[relation]
            if field not in target.column_names:
                raise ValidationError(f"Unknown field in select: {path}")
            out.setdefault(relation, {})
            if related is not None:
                out[relation][field] = related[field]
            out[path] = related[field] if related is not None else None
        return out

    def find_by_id(self, entity_name: str, user: LocalUser, row_id: str) -> dict[str, Any]:
        rows = self.query(entity_name, user, where={"id": {"eq": row_id}}, first=1)
        if not rows:
            raise NotFound(f"{entity_name} {row_id} not found or not visible")
        return rows[0]

    # ----- writes -------------------------------------------------------------------
    def _normalize_input(self, entity: Entity, data: Mapping[str, Any]) -> dict[str, Any]:
        values: dict[str, Any] = {}
        for key, value in data.items():
            if key in entity.relationships:
                # Rayfin shorthand: { department: { id } } becomes department_id.
                if not isinstance(value, Mapping) or "id" not in value:
                    raise ValidationError(f"{key} must be an object with an id")
                values[entity.relationships[key].name] = value["id"]
            elif key in entity.column_names:
                values[key] = value
            else:
                raise ValidationError(f"Unknown field: {key}")
        return values

    def _validate(self, con: sqlite3.Connection, entity: Entity, row: dict[str, Any]) -> None:
        for column in entity.columns:
            value = row.get(column.name)
            if value is None or value == "":
                if not column.nullable:
                    raise ValidationError(f"{column.name} is required")
                row[column.name] = None
                continue
            if column.sqlite_type == "REAL":
                if isinstance(value, bool):
                    raise ValidationError(f"{column.name} must be a number")
                try:
                    number = float(value)
                except (TypeError, ValueError) as exc:
                    raise ValidationError(f"{column.name} must be a number") from exc
                if number != number or number in (float("inf"), float("-inf")):
                    raise ValidationError(f"{column.name} must be a finite number")
                if column.min is not None and number < column.min:
                    raise ValidationError(f"{column.name} must be at least {column.min:g}")
                if column.max is not None and number > column.max:
                    raise ValidationError(f"{column.name} must be at most {column.max:g}")
                row[column.name] = round(number, 2)
                continue
            if not isinstance(value, str):
                raise ValidationError(f"{column.name} must be text")
            if column.max is not None and len(value) > column.max:
                raise ValidationError(f"{column.name} is longer than {int(column.max)} characters")
            if column.min is not None and len(value) < column.min:
                raise ValidationError(f"{column.name} is shorter than {int(column.min)} characters")
            if column.regex and not re.search(column.regex, value):
                raise ValidationError(f"{column.name} has an invalid format")
            if column.format == "email" and not EMAIL.match(value):
                raise ValidationError(f"{column.name} must be an email address")
            if column.format == "uuid":
                try:
                    uuid.UUID(value)
                except ValueError as exc:
                    raise ValidationError(f"{column.name} must be a uuid") from exc
            if column.references:
                target = self.model.entity(column.references["entity"])
                if con.execute(f'SELECT 1 FROM "{target.table}" WHERE id=?', (value,)).fetchone() is None:
                    raise ValidationError(f"{column.name} references a missing {target.name}")
        # LOCAL INTEGRITY CHECK (not Rayfin): owner_email must be the department's finance owner,
        # because the row policy relies on this denormalised column.
        if "owner_email" in entity.column_names and "department_id" in entity.column_names:
            department = self.model.entity("Department")
            owner = con.execute(
                f'SELECT finance_owner_email FROM "{department.table}" WHERE id=?', (row["department_id"],)
            ).fetchone()
            if owner is None or owner[0] != row["owner_email"]:
                raise ValidationError("owner_email must match the department's finance owner")

    def create(self, entity_name: str, user: LocalUser, data: Mapping[str, Any]) -> dict[str, Any]:
        entity = self.model.entity(entity_name)
        require(entity, user, "create")
        row = {column.name: None for column in entity.columns}
        row.update(self._normalize_input(entity, data))
        row["id"] = row.get("id") or str(uuid.uuid4())
        with self._write_lock, closing(self.connect()) as con, con:
            self._validate(con, entity, row)
            require(entity, user, "create", row)
            names = [column.name for column in entity.columns]
            try:
                con.execute(
                    f'INSERT INTO "{entity.table}" ({", ".join(_quote(n) for n in names)}) '
                    f"VALUES ({', '.join('?' for _ in names)})",
                    [row[n] for n in names],
                )
            except sqlite3.IntegrityError as exc:
                raise ValidationError(f"Constraint violation: {exc}") from exc
            seq = self._log(con, entity.name, row["id"], "create", user.email, self._summary(entity, row))
        return {**row, "_seq": seq}

    def update(self, entity_name: str, user: LocalUser, key: Mapping[str, Any], patch: Mapping[str, Any]) -> dict[str, Any]:
        entity = self.model.entity(entity_name)
        require(entity, user, "update")
        if set(key) != {"id"}:
            raise ValidationError("The local adapter updates by { id } only")
        changes = self._normalize_input(entity, patch)
        if "id" in changes and changes["id"] != key["id"]:
            raise ValidationError("id cannot change")
        with self._write_lock, closing(self.connect()) as con, con:
            found = con.execute(f'SELECT * FROM "{entity.table}" WHERE id=?', (key["id"],)).fetchone()
            if found is None:
                raise NotFound(f"{entity.name} {key['id']} not found")
            current = dict(found)
            if not can(entity, user, "read", current):
                raise NotFound(f"{entity.name} {key['id']} not found")
            require(entity, user, "update", current)
            merged = {**current, **changes}
            self._validate(con, entity, merged)
            # Policy is checked on the new image too, so a row cannot be moved out of the user's scope.
            require(entity, user, "update", merged)
            assignments = [name for name in changes if name != "id"]
            if assignments:
                con.execute(
                    f'UPDATE "{entity.table}" SET {", ".join(_quote(n) + "=?" for n in assignments)} WHERE id=?',
                    [merged[n] for n in assignments] + [key["id"]],
                )
            seq = self._log(con, entity.name, key["id"], "update", user.email, self._summary(entity, merged))
        return {**merged, "_seq": seq}

    @staticmethod
    def _summary(entity: Entity, row: Mapping[str, Any]) -> str:
        bits = [f"{k}={row[k]}" for k in ("month", "amount") if k in row and row[k] is not None]
        return f"{entity.name} " + " ".join(bits)
