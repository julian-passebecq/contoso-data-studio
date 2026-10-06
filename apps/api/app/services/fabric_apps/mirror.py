"""Mirror the operational store into DuckLake Bronze (stand-in for Fabric SQL DB -> OneLake mirroring).

LOCAL ADAPTER. Fabric mirrors the SQL database into OneLake Delta tables continuously; here a
worker thread copies changed rows into `contoso.bronze.sfapp_*`:
  - on change: every write calls notify(), the worker wakes at once;
  - on a timer: it also polls every `interval` seconds to catch writes made by other processes.
Each mirror batch is one DuckLake transaction, hence one snapshot (the local "Delta version").
After a batch the worker checks the row is visible through the read-only SQL endpoint, then
rebuilds the dbt Gold model `forecast_vs_actual`, and stamps each stage on the change.
"""
from __future__ import annotations

import os
import re
import subprocess
import threading
import time
import uuid
from contextlib import contextmanager
from typing import Any

import duckdb

from app.config import Settings
from app.services.catalog_lock import catalog_lock
from app.services.ducklake import DuckLakeService
from app.services.fabric_apps.model import Entity
from app.services.fabric_apps.store import OperationalStore, now_iso

BRONZE_PREFIX = "sfapp_"
GOLD_MODEL = "forecast_vs_actual"
COMMIT_AUTHOR = "fabric-app-mirror"


def bronze_table(entity: Entity) -> str:
    return f"{BRONZE_PREFIX}{entity.table.lower()}"


class MirrorService:
    def __init__(
        self,
        settings: Settings,
        store: OperationalStore,
        ducklake: DuckLakeService,
        dbt_executable: str | None,
        interval: float | None = None,
        gold_auto: bool | None = None,
    ):
        self.settings = settings
        self.store = store
        self.ducklake = ducklake
        self.dbt_executable = dbt_executable
        self.interval = interval if interval is not None else float(os.getenv("CONTOSO_FABRIC_MIRROR_INTERVAL", "5"))
        if gold_auto is None:
            gold_auto = os.getenv("CONTOSO_FABRIC_GOLD_AUTO", "1") not in {"0", "false", "no"}
        self.gold_auto = gold_auto and dbt_executable is not None
        self._event = threading.Event()
        self._run_lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self.last_error: str | None = None
        self.last_gold: dict[str, Any] | None = None
        self._bronze_ready = False  # set after the first successful batch; skips catalog lookups
        self._con: duckdb.DuckDBPyConnection | None = None
        self._snapshot_cache: tuple[int, list[dict[str, Any]]] | None = None

    # ----- worker ---------------------------------------------------------------------
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="fabric-app-mirror", daemon=True)
        self._thread.start()
        self.notify()

    def stop(self) -> None:
        self._stop.set()
        self._event.set()
        if self._thread:
            self._thread.join(timeout=10)
        with self._run_lock:
            self.close_connection()

    def notify(self) -> None:
        self._event.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            self._event.wait(timeout=self.interval)
            self._event.clear()
            if self._stop.is_set():
                return
            try:
                self.run_once()
                self.last_error = None
            except Exception as exc:  # keep the worker alive; surface the error in /mirror/status
                self.last_error = f"{type(exc).__name__}: {exc}"

    # ----- one batch ------------------------------------------------------------------
    def run_once(self, gold: bool | None = None) -> dict[str, Any] | None:
        with self._run_lock:
            result = self._mirror()
            if result is None:
                return None
            self._check_endpoint(result["seqs"])
            touched = result["entities"]
            if (self.gold_auto if gold is None else gold) and touched & {"Forecast", "Actual", "*"}:
                self.refresh_gold(result["seqs"])
            return result

    def _mirror(self) -> dict[str, Any] | None:
        changes = self.store.changes_after(self.store.last_mirrored_seq())
        if not changes:
            return None
        entities = list(self.store.model.entities.values())
        full = any(c["op"] == "reset" for c in changes)
        if not full and not self._bronze_ready:
            self.ducklake.bootstrap()
            existing = {row["name"] for row in self.ducklake.catalog() if row["schema"] == "bronze"}
            full = any(bronze_table(e) not in existing for e in entities)
        elif full:
            self.ducklake.bootstrap()
        seqs = [int(c["seq"]) for c in changes]
        mirrored_iso = now_iso()
        with catalog_lock(self.settings.catalog_path), self._lake() as con:
            try:
                con.execute("BEGIN TRANSACTION")
                try:
                    for entity in entities:
                        target = f"contoso.bronze.{bronze_table(entity)}"
                        select = self._select_list(entity, mirrored_iso)
                        if full:
                            con.execute(f'CREATE OR REPLACE TABLE {target} AS SELECT {select} FROM fabric_opdb."{entity.table}"')
                            continue
                        ids = sorted({c["row_id"] for c in changes if c["entity"] == entity.name and c["row_id"]})
                        ids = [i for i in ids if _is_uuid(i)]
                        if not ids:
                            continue
                        marks = ", ".join("?" for _ in ids)
                        con.execute(f"DELETE FROM {target} WHERE id IN ({marks})", ids)
                        con.execute(
                            f'INSERT INTO {target} SELECT {select} FROM fabric_opdb."{entity.table}" WHERE id IN ({marks})',
                            ids,
                        )
                    try:
                        con.execute(
                            "CALL contoso.set_commit_message(?, ?)",
                            [COMMIT_AUTHOR, f"mirror seq {seqs[0]}..{seqs[-1]}" + (" (full)" if full else "")],
                        )
                    except Exception:
                        pass  # older DuckLake builds have no commit messages; the snapshot still exists
                    con.execute("COMMIT")
                except Exception:
                    con.execute("ROLLBACK")
                    raise
                mirrored_ns = time.time_ns()
                snapshot_id = con.execute("SELECT max(snapshot_id) FROM contoso.snapshots()").fetchone()[0]
            except Exception:
                self.close_connection()  # reconnect on the next batch
                raise
        self._bronze_ready = True
        mirrored_at = now_iso()
        self.store.record_mirror(seqs, mirrored_at, mirrored_ns, int(snapshot_id) if snapshot_id is not None else None)
        return {
            "seqs": seqs,
            "full": full,
            "snapshot_id": snapshot_id,
            "mirrored_at": mirrored_at,
            "entities": {c["entity"] for c in changes},
        }

    def _worker_connection(self) -> duckdb.DuckDBPyConnection:
        """A long-lived DuckDB connection for the mirror worker, with the operational store attached.

        Opening DuckDB and loading extensions costs 0.5-2 s on Windows; a real mirror is a resident
        replication process, so the connection stays open and only DuckLake is attached per batch.
        """
        if self._con is None:
            con = duckdb.connect(":memory:")
            try:
                DuckLakeService._load_extensions(con)
                source = str(self.store.path).replace("'", "''")
                con.execute(f"ATTACH '{source}' AS fabric_opdb (TYPE sqlite, READ_ONLY)")
            except Exception:
                con.close()
                raise
            self._con = con
        return self._con

    @contextmanager
    def _lake(self):
        """Attach DuckLake only for the batch: an attached catalog keeps SQLite locks that block dbt."""
        con = self._worker_connection()
        catalog = str(self.settings.catalog_path).replace("'", "''")
        data = str(self.settings.data_path).replace("'", "''")
        con.execute(f"ATTACH 'ducklake:sqlite:{catalog}' AS contoso (DATA_PATH '{data}')")
        try:
            yield con
        finally:
            con.execute("DETACH contoso")

    def close_connection(self) -> None:
        if self._con is not None:
            try:
                self._con.close()
            finally:
                self._con = None

    @staticmethod
    def _select_list(entity: Entity, mirrored_iso: str) -> str:
        parts = [f'CAST("{c.name}" AS {c.duckdb_type}) AS "{c.name}"' for c in entity.columns]
        parts.append(f"TIMESTAMPTZ '{mirrored_iso}' AS _mirrored_at")
        return ", ".join(parts)

    def _check_endpoint(self, seqs: list[int]) -> None:
        """Read back through the read-only SQL workbench path, like querying the SQL analytics endpoint."""
        forecast = self.store.model.entity("Forecast")
        self.ducklake.query(f"SELECT count(*) FROM contoso.bronze.{bronze_table(forecast)}", 1)
        self.store.record_stage(seqs, endpoint_at=now_iso())

    # ----- Gold -----------------------------------------------------------------------
    def refresh_gold(self, seqs: list[int] | None = None) -> dict[str, Any]:
        if not self.dbt_executable:
            raise RuntimeError('dbt is not installed. Install the API with: pip install -e "apps/api[dbt]"')
        args = [
            self.dbt_executable,
            "build",
            "--project-dir", str(self.settings.dbt_path),
            "--profiles-dir", str(self.settings.dbt_path),
            "--select", GOLD_MODEL,
            "--vars", '{"fabric_apps_enabled": true}',
            # Keep the Transform page's own run_results/manifest untouched.
            "--target-path", "target/fabric-apps",
            "--log-path", "logs/fabric-apps",
            "--no-use-colors",
        ]
        # Same absolute catalog/data paths as the API, so dbt attaches the very same DuckLake.
        env = {
            **os.environ,
            "CONTOSO_DUCKLAKE_CATALOG": str(self.settings.catalog_path),
            "CONTOSO_DUCKLAKE_DATA_PATH": str(self.settings.data_path),
        }
        started = time.perf_counter()
        with catalog_lock(self.settings.catalog_path):
            completed = subprocess.run(
                args, cwd=self.settings.dbt_path, env=env, capture_output=True, text=True, timeout=300, check=False
            )
        ok = completed.returncode == 0
        snapshot = None
        if ok:
            snapshots = self.ducklake.snapshots(1)
            snapshot = int(snapshots[0]["snapshot_id"]) if snapshots else None
        output = "\n".join(part for part in (completed.stdout, completed.stderr) if part)
        self.last_gold = {
            "ok": ok,
            "at": now_iso(),
            "seconds": round(time.perf_counter() - started, 2),
            "snapshot_id": snapshot,
            "output_tail": output[-3000:] if not ok else "",
        }
        if seqs:
            self.store.record_stage(seqs, gold_at=self.last_gold["at"], gold_ok=1 if ok else 0, gold_snapshot_id=snapshot)
        return self.last_gold

    # ----- history ----------------------------------------------------------------------
    def snapshots(self, limit: int = 20) -> list[dict[str, Any]]:
        # Cached until a new mirror batch lands: the status panel polls, DuckLake opens are not free.
        key = self.store.last_mirrored_seq()
        if self._snapshot_cache is None or self._snapshot_cache[0] != key:
            rows = self.ducklake.snapshots(200)
            mine = [
                row for row in rows
                if row.get("author") == COMMIT_AUTHOR or BRONZE_PREFIX in str(row.get("changes") or "")
            ]
            self._snapshot_cache = (key, mine)
        return self._snapshot_cache[1][:limit]

    def row_history(self, forecast_id: str, limit: int = 8) -> list[dict[str, Any]]:
        """Value of one Forecast row at each mirror snapshot (DuckLake time travel, like Delta versions)."""
        if not _is_uuid(forecast_id):
            raise ValueError("forecast id must be a uuid")
        forecast = self.store.model.entity("Forecast")
        table = f"contoso.bronze.{bronze_table(forecast)}"
        snaps = self.snapshots(limit)
        if not snaps:
            return []
        # One read-only statement (one connection) over every version.
        sql = " UNION ALL ".join(
            f"SELECT {int(s['snapshot_id'])} AS snapshot_id, amount, updated_by FROM {table} "
            f"AT (VERSION => {int(s['snapshot_id'])}) WHERE id = '{forecast_id}'"
            for s in snaps
        )
        try:
            _, rows, _ = self.ducklake.query(sql, len(snaps))
        except Exception:
            rows = []  # e.g. a version older than the table; show the versions without values
        found = {int(row[0]): row for row in rows}
        return [
            {
                "snapshot_id": int(s["snapshot_id"]),
                "snapshot_time": s["snapshot_time"],
                "commit_message": s.get("commit_message"),
                "amount": found[int(s["snapshot_id"])][1] if int(s["snapshot_id"]) in found else None,
                "updated_by": found[int(s["snapshot_id"])][2] if int(s["snapshot_id"]) in found else None,
            }
            for s in snaps
        ]


_UUID = re.compile(r"^[0-9a-fA-F-]{36}$")


def _is_uuid(value: str) -> bool:
    if not _UUID.match(value or ""):
        return False
    try:
        uuid.UUID(value)
        return True
    except ValueError:
        return False
