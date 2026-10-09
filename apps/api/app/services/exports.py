"""Portable Gold result exports as ``datapass.artifact`` v1 bundles for MosaicStudio and other consumers.

A bundle is written to ``<workspace>/exports/<export-id>/``:

- ``<artifact-id>.json``         bounded, validated datapass.artifact (<= 1 MB, 10 000 rows, 40 columns)
- ``<artifact-id>.full.parquet`` every row of the Gold table at export time (bulk-data reference)
- ``manifest.json``              datapass.artifact-manifest (sha256 per artifact; written by the vendored writer)
- ``contoso-export.json``        contoso.result-export v1: lineage, source hashes, units, bulk-data reference

The artifact is a *view* of an already computed Gold table. Exporting never runs dbt, the generator or any
model; it refuses to export a table whose latest dbt run did not succeed, so the export always references a
successful run.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import subprocess
import sys
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

from app.config import Settings
from app.services.catalog_lock import catalog_lock

_VENDOR = Path(__file__).resolve().parents[4] / "vendor" / "datapass-artifact"
if str(_VENDOR) not in sys.path:
    sys.path.insert(0, str(_VENDOR))
import datapass_artifact as dpa  # noqa: E402  (vendored, pinned: vendor/datapass-artifact/PROVENANCE.json)

EXPORT_FORMAT = "contoso.result-export"
EXPORT_VERSION = 1
PROJECT = "contoso_data_studio"
_MART = re.compile(r"^[a-z][a-z0-9_]{0,62}$")
_EXPORT_ID = re.compile(r"^[a-z][a-z0-9-]{0,79}$")
EXPORT_FILES = {"manifest.json", "contoso-export.json"}

# Declared units for Gold columns. Monetary values are USD-normalized in Silver (net_revenue, total_cost).
UNITS: dict[str, str] = {
    "revenue": "USD",
    "cost": "USD",
    "gross_margin": "USD",
    "revenue_usd": "USD",
    "gross_margin_usd": "USD",
    "revenue_local": "local currency",
    "avg_exchange_rate_to_usd": "USD per local unit",
    "avg_discount_rate": "ratio",
    "gross_margin_rate": "ratio",
    "revenue_share": "ratio",
    "over_7_day_rate": "ratio",
    "avg_delivery_days": "days",
    "p90_delivery_days": "days",
    "units": "units",
    "sales_lines": "lines",
    "over_7_day_deliveries": "lines",
}

# Default chart per mart: (chart kind, x column, y column). Only used when both columns are exported.
CHARTS: dict[str, tuple[str, str, str]] = {
    "monthly_sales": ("bar", "order_month", "revenue"),
    "channel_performance": ("bar", "channel", "revenue_share"),
    "delivery_metrics": ("bar", "order_month", "avg_delivery_days"),
    "currency_exposure": ("bar", "currency", "revenue_usd"),
    "product_performance": ("bar", "category", "revenue"),
    "store_performance": ("bar", "store_country", "revenue"),
}


class ExportError(ValueError):
    pass


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _cell(value: Any) -> Any:
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, Decimal):
        value = float(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, int):
        return value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value)


def _instant(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _artifact_id(text: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", text).strip("-")
    slug = slug if slug[:1].isalpha() and slug[:1].islower() else f"c-{slug}"
    return slug[:80]


class ExportService:
    def __init__(self, settings: Settings, generator: Any, ducklake: Any, dbt: Any):
        self.settings, self.generator, self.ducklake, self.dbt = settings, generator, ducklake, dbt

    @property
    def root(self) -> Path:
        return self.settings.workspace / "exports"

    # ----- lineage inputs --------------------------------------------------------------
    def _run_results(self) -> dict[str, Any]:
        path = self.settings.dbt_target_path / "run_results.json"
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise ExportError("No dbt run found for this workspace. Run dbt build in Transform first.") from exc

    def _manifest_node(self, mart: str) -> dict[str, Any]:
        try:
            manifest = json.loads((self.settings.dbt_target_path / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return manifest.get("nodes", {}).get(f"model.{PROJECT}.{mart}", {})

    def _successful_model_run(self, mart: str) -> dict[str, Any]:
        payload = self._run_results()
        unique_id = f"model.{PROJECT}.{mart}"
        for result in payload.get("results", []):
            if result.get("unique_id") == unique_id:
                if result.get("status") != "success":
                    raise ExportError(
                        f"The latest dbt run of {mart} ended with status '{result.get('status')}'. "
                        "Fix the model and rerun dbt build before exporting."
                    )
                metadata = payload.get("metadata", {})
                return {
                    "invocation_id": metadata.get("invocation_id"),
                    "generated_at": metadata.get("generated_at"),
                    "dbt_version": metadata.get("dbt_version"),
                    "status": result.get("status"),
                }
        raise ExportError(f"The latest dbt run did not build {mart}. Run dbt build in Transform first.")

    @staticmethod
    def _source_commit(root: Path) -> str | None:
        try:
            completed = subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True, timeout=10, check=False
            )
        except (OSError, subprocess.SubprocessError):
            return None
        value = completed.stdout.strip()
        return value if completed.returncode == 0 and re.fullmatch(r"[0-9a-f]{40}", value) else None

    # ----- export ----------------------------------------------------------------------
    def gold_tables(self) -> list[str]:
        return [str(row["name"]) for row in self.ducklake.catalog() if row["schema"] == "gold"]

    def export(self, mart: str, columns: list[str] | None = None, max_rows: int = 5_000) -> dict[str, Any]:
        if not _MART.match(mart) or mart not in self.gold_tables():
            raise ExportError(f"Unknown Gold table: {mart}")
        if not 1 <= max_rows <= dpa.MAX_ROWS:
            raise ExportError(f"max_rows must be between 1 and {dpa.MAX_ROWS}")
        run = self._successful_model_run(mart)
        active = self.generator.active_run()
        if not active:
            raise ExportError("No active generator run in this workspace. Open a project or generate data first.")
        detail = self.generator.get_run(str(active["run_id"]))
        loaded_at, built_at = _instant(active.get("active_loaded_at") or active.get("loaded_at")), _instant(run.get("generated_at"))
        if loaded_at is None or built_at is None or built_at < loaded_at:
            raise ExportError(
                "Gold is older than the active generator run (Bronze was reloaded after the last dbt build). "
                "Run dbt build in Transform before exporting."
            )

        stamp = datetime.now(timezone.utc).strftime("%Y%m%dt%H%M%Sz")
        export_id = f"{mart.replace('_', '-')}-{stamp}"
        out_dir = self.root / export_id
        if out_dir.exists():
            raise ExportError("An export with this id already exists; retry in a second.")
        out_dir.mkdir(parents=True)
        artifact_id = _artifact_id(f"contoso-{mart.replace('_', '-')}")
        full_parquet = out_dir / f"{artifact_id}.full.parquet"

        with catalog_lock(self.settings.catalog_path), self.ducklake.connection(read_only=True) as con:
            described = con.execute(f"DESCRIBE contoso.gold.{mart}").fetchall()
            all_columns = [str(row[0]) for row in described]
            selected = columns or all_columns
            unknown = [name for name in selected if name not in all_columns]
            if unknown:
                raise ExportError(f"Unknown column(s) for {mart}: {', '.join(unknown)}")
            if len(selected) > dpa.MAX_COLUMNS - 1:
                raise ExportError(f"At most {dpa.MAX_COLUMNS - 1} columns can be exported")
            quoted = ", ".join('"' + name.replace('"', '""') + '"' for name in selected)
            order = ", ".join(str(i + 1) for i in range(len(selected)))
            total = int(con.execute(f"SELECT count(*) FROM contoso.gold.{mart}").fetchone()[0])
            cursor = con.execute(f"SELECT {quoted} FROM contoso.gold.{mart} ORDER BY {order} LIMIT {max_rows}")
            fetched = cursor.fetchall()
            target = str(full_parquet).replace("'", "''")
            con.execute(f"COPY (SELECT * FROM contoso.gold.{mart} ORDER BY ALL) TO '{target}' (FORMAT parquet)")
            snapshots = con.execute("SELECT max(snapshot_id) FROM contoso.snapshots()").fetchone()
        snapshot_id = int(snapshots[0]) if snapshots and snapshots[0] is not None else None

        rows = []
        for index, values in enumerate(fetched, start=1):
            row = {"row": f"r{index:05d}"}
            row.update({name: _cell(value) for name, value in zip(selected, values)})
            rows.append(row)
        truncated = total > len(rows)
        if not rows:
            raise ExportError(f"contoso.gold.{mart} is empty; there is nothing to export.")

        cols = [{"id": "row", "label": "Row (export order)", "type": "string"}]
        for name in selected:
            types = {dpa._cell_type(row[name]) for row in rows} - {None}
            column_type = types.pop() if len(types) == 1 else "string"
            if column_type == "string":
                for row in rows:
                    if row[name] is not None and not isinstance(row[name], str):
                        row[name] = str(row[name])
            column: dict[str, Any] = {"id": _artifact_id(name) if not dpa._ID.match(name) else name,
                                      "label": name.replace("_", " "), "type": column_type}
            if name in UNITS:
                column["unit"] = UNITS[name]
            if any(row[name] is None for row in rows):
                column["nullable"] = True
            cols.append(column)
        # Column ids must be valid artifact ids; keep the Gold name as the label when they differ.
        renamed = {name: col["id"] for name, col in zip(selected, cols[1:])}
        rows = [{"row": row["row"], **{renamed[name]: row[name] for name in selected}} for row in rows]

        representations: list[dict[str, Any]] = [{"id": "table", "title": "Gold rows", "kind": "table"}]
        chart = CHARTS.get(mart)
        by_id = {col["id"]: col for col in cols}
        if chart and chart[1] in renamed and chart[2] in renamed and by_id[renamed[chart[2]]]["type"] == "number":
            representation = {"id": "chart", "title": f"{chart[2].replace('_', ' ')} by {chart[1].replace('_', ' ')}",
                              "kind": "chart", "chart": chart[0], "x": renamed[chart[1]], "y": renamed[chart[2]]}
            if chart[2] in UNITS:
                representation["unit"] = UNITS[chart[2]][:30]
            representations.append(representation)
        representations.append({"id": "json", "title": "JSON", "kind": "json"})

        files = detail.get("files") if isinstance(detail.get("files"), dict) else {}
        file_hashes = {name: info["sha256"] for name, info in files.items()
                       if isinstance(info, dict) and isinstance(info.get("sha256"), str) and info["sha256"]}
        node = self._manifest_node(mart)
        model_path = node.get("original_file_path") or f"models/gold/{mart}.sql"
        model_file = self.settings.dbt_path / model_path
        model_lines = len(model_file.read_text(encoding="utf-8").splitlines()) if model_file.is_file() else 0
        inputs: list[dict[str, Any]] = [
            {"id": "scenario", "label": "Scenario", "value": str(detail.get("scenario"))},
            {"id": "seed", "label": "Generator seed", "value": int(detail.get("seed", 0))},
            {"id": "scale", "label": "Generated sales lines", "value": int(detail.get("scale", 0)), "unit": "lines"},
            {"id": "generatorRunId", "label": "Generator run", "value": str(detail.get("run_id"))},
            {"id": "generatorSha256", "label": "Generator source sha256", "value": str(detail.get("generator_sha256") or "unknown")},
            {"id": "ducklakeSnapshot", "label": "DuckLake snapshot at export", "value": snapshot_id if snapshot_id is not None else "unknown"},
            {"id": "dbtInvocation", "label": "dbt invocation (successful)", "value": str(run["invocation_id"])},
            {"id": "dbtModelChecksum", "label": "dbt model checksum", "value": str((node.get("checksum") or {}).get("checksum") or "unknown")},
        ]
        if model_lines:
            inputs[-1]["evidence"] = [{"path": f"dbt/{Path(model_path).as_posix()}", "start": 1, "end": model_lines,
                                       "label": f"dbt model {mart}"}]
        for name in sorted(file_hashes)[:12]:
            inputs.append({"id": _artifact_id(f"bronze-{name}-sha256"), "label": f"Staging {name}.parquet sha256",
                           "value": str(file_hashes[name])})
        run_id = _artifact_id(f"run-{detail.get('run_id')}")
        bounded = "all" if not truncated else f"first {len(rows)} of"
        artifact = dpa.to_artifact(
            rows,
            id=artifact_id,
            title=f"Contoso Gold {mart} ({detail.get('scenario')}, synthetic)"[:160],
            source=(
                f"SYNTHETIC retail data from the Contoso Data Studio generator (scenario {detail.get('scenario')}, "
                f"seed {detail.get('seed')}, {detail.get('scale')} lines), transformed by dbt model gold.{mart} "
                f"in DuckLake. Rows: {bounded} {total}, ordered by all columns. Full table: {full_parquet.name}. "
                "Not real business data."
            ),
            columns=cols,
            row_key="row",
            representations=representations,
            provenance="synthetic",
            run_id=run_id,
            producer={"kind": "service", "name": "Contoso Data Studio ExportService (apps/api/app/services/exports.py)"},
            inputs=inputs,
            out_dir=out_dir,
        )
        artifact_path = out_dir / f"{artifact_id}.json"
        dpa.write_manifest(out_dir)

        bundle = {
            "format": EXPORT_FORMAT,
            "version": EXPORT_VERSION,
            "export_id": export_id,
            "exported_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "workspace_id": self.settings.workspace_id,
            "source_commit": self._source_commit(self.settings.project_root),
            "data_label": "SYNTHETIC",
            "artifact": {
                "file": artifact_path.name,
                "sha256": _sha256(artifact_path),
                "bytes": artifact_path.stat().st_size,
                "contract": "datapass.artifact/1",
                "contract_vendor": "vendor/datapass-artifact/PROVENANCE.json",
                "rows": len(rows),
                "total_rows": total,
                "truncated": truncated,
            },
            "bulk_data": {
                "file": full_parquet.name,
                "sha256": _sha256(full_parquet),
                "bytes": full_parquet.stat().st_size,
                "rows": total,
                "format": "parquet",
            },
            "columns": [
                {"gold": name, "artifact": renamed[name], "unit": UNITS.get(name)} for name in selected
            ],
            "lineage": {
                "gold_table": f"contoso.gold.{mart}",
                "dbt_model": node.get("unique_id") or f"model.{PROJECT}.{mart}",
                "dbt_model_path": f"dbt/{Path(model_path).as_posix()}",
                "dbt_depends_on": (node.get("depends_on") or {}).get("nodes", []),
                "dbt_run": run,
                "ducklake_snapshot_id": snapshot_id,
                "generator_run": {
                    "run_id": detail.get("run_id"),
                    "scenario": detail.get("scenario"),
                    "seed": detail.get("seed"),
                    "scale": detail.get("scale"),
                    "generator_sha256": detail.get("generator_sha256"),
                    "file_sha256": file_hashes,
                },
            },
            "recomputation": "none: the artifact is a bounded view of the already built Gold table",
        }
        (out_dir / "contoso-export.json").write_text(json.dumps(bundle, indent=2) + "\n", encoding="utf-8")
        return {**bundle, "path": str(out_dir), "artifact_id": artifact["id"]}

    # ----- listing / download ----------------------------------------------------------
    def list(self) -> list[dict[str, Any]]:
        if not self.root.exists():
            return []
        items = []
        for path in sorted(self.root.iterdir(), reverse=True):
            receipt = path / "contoso-export.json"
            if path.is_dir() and receipt.is_file():
                try:
                    items.append(json.loads(receipt.read_text(encoding="utf-8")))
                except (OSError, ValueError):
                    continue
        return sorted(items, key=lambda item: str(item.get("exported_at") or ""), reverse=True)

    def file(self, export_id: str, name: str) -> Path:
        if not _EXPORT_ID.match(export_id) or Path(name).name != name:
            raise ExportError("Invalid export path")
        folder = (self.root / export_id).resolve()
        target = (folder / name).resolve()
        if folder.parent != self.root.resolve() or target.parent != folder or not target.is_file():
            raise ExportError("Export file not found")
        if not (name in EXPORT_FILES or name.endswith(".json") or name.endswith(".parquet")):
            raise ExportError("Export file not found")
        return target
