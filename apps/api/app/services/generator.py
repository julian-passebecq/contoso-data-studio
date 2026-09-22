from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import duckdb

from app.config import Settings


SCENARIO_CONFIG = {
    "retail-baseline": {
        "name": "Retail baseline",
        "description": "Stable multi-country retail sales.",
        "focus": "Baseline revenue, margin, channel and country KPIs.",
    },
    "online-migration": {
        "name": "Online migration",
        "description": "Online share jumps from roughly 22% to 68% in year two.",
        "focus": "Channel mix, online growth and store cannibalization.",
    },
    "margin-pressure": {
        "name": "Margin pressure",
        "description": "Year-two discounting and cost inflation compress margin.",
        "focus": "Gross margin, discount impact and category profitability.",
    },
    "logistics-delays": {
        "name": "Logistics delays",
        "description": "Online fulfilment develops materially longer delivery delays.",
        "focus": "Fulfilment time, p90 delivery days and channel service levels.",
    },
    "currency-exposure": {
        "name": "Currency exposure",
        "description": "Exchange rates become more volatile across five currencies.",
        "focus": "Local vs normalized revenue and FX exposure by country.",
    },
}

SCENARIOS = [
    {"id": scenario_id, **config, "status": "ready"}
    for scenario_id, config in SCENARIO_CONFIG.items()
]


class GeneratorService:
    def __init__(self, settings: Settings):
        self.settings = settings

    @staticmethod
    def _sql_path(path: Path) -> str:
        return path.as_posix().replace("'", "''")

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def _run_directory(self, run_id: str) -> Path:
        if not run_id or run_id in {".", ".."} or Path(run_id).name != run_id:
            raise ValueError("Invalid run id")
        staging = self.settings.staging_path.resolve()
        directory = (staging / run_id).resolve()
        if not directory.is_relative_to(staging):
            raise ValueError("Run must stay inside workspace/staging")
        return directory

    def _load_manifest(self, run_id: str) -> dict[str, object]:
        manifest_path = self._run_directory(run_id) / "manifest.json"
        if not manifest_path.exists() or not manifest_path.is_file():
            raise ValueError(f"Run manifest not found: {run_id}")
        try:
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"Invalid run manifest: {run_id}") from exc
        manifest_run_id = str(payload.get("run_id") or run_id)
        if manifest_run_id != run_id:
            raise ValueError("Run manifest id does not match its directory")
        return payload

    def run_files(
        self,
        run_id: str,
        verify_hashes: bool = False,
    ) -> dict[str, Path]:
        directory = self._run_directory(run_id)
        payload = self._load_manifest(run_id)
        declared = payload.get("files")
        if not isinstance(declared, dict):
            raise ValueError("Run manifest does not contain files")

        expected = ("customer", "product", "store", "currency_exchange", "sales")
        missing = set(expected) - set(map(str, declared.keys()))
        if missing:
            raise ValueError(f"Run is missing files: {', '.join(sorted(missing))}")

        hashes = payload.get("file_sha256")
        tracked_hashes = hashes if isinstance(hashes, dict) else {}

        resolved: dict[str, Path] = {}
        for name in expected:
            raw = declared.get(name)
            if not isinstance(raw, str) or not raw:
                raise ValueError(f"Invalid file entry for {name}")
            candidate = Path(raw)
            if not candidate.is_absolute():
                candidate = directory / candidate
            candidate = candidate.resolve()
            if not candidate.is_relative_to(directory):
                raise ValueError(f"Run file must stay inside its run directory: {name}")
            if not candidate.exists() or not candidate.is_file():
                raise ValueError(f"Run file does not exist: {name}")
            if candidate.suffix.lower() != ".parquet":
                raise ValueError(f"Run file must be Parquet: {name}")
            expected_hash = tracked_hashes.get(name)
            if verify_hashes and isinstance(expected_hash, str) and expected_hash:
                actual_hash = self._sha256(candidate)
                if actual_hash != expected_hash:
                    raise ValueError(f"Run file hash mismatch: {name}")
            resolved[name] = candidate
        return resolved

    def _active_marker(self) -> dict[str, object] | None:
        if not self.active_run_path.exists():
            return None
        try:
            payload = json.loads(self.active_run_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return payload if isinstance(payload, dict) else None

    def _active_run_id_only(self) -> str | None:
        payload = self._active_marker()
        run_id = payload.get("run_id") if payload else None
        return str(run_id) if isinstance(run_id, str) and run_id else None

    def _active_snapshot_id_only(self, run_id: str) -> int | None:
        payload = self._active_marker()
        if not payload or payload.get("run_id") != run_id:
            return None
        value = payload.get("snapshot_id")
        return int(value) if isinstance(value, int) else None

    def get_run(self, run_id: str) -> dict[str, object]:
        payload = self._load_manifest(run_id)
        files = self.run_files(run_id)
        directory = self._run_directory(run_id)
        payload_hashes = payload.get("file_sha256")
        hashes = payload_hashes if isinstance(payload_hashes, dict) else {}
        public_files = {
            name: {
                "name": path.name,
                "path": path.relative_to(self.settings.workspace.resolve()).as_posix(),
                "size_bytes": path.stat().st_size,
                "sha256": hashes.get(name) if isinstance(hashes.get(name), str) else None,
            }
            for name, path in sorted(files.items())
        }
        return {
            "run_id": run_id,
            "scenario": payload.get("scenario"),
            "scenario_name": payload.get("scenario_name"),
            "business_focus": payload.get("business_focus"),
            "created_at": payload.get("created_at"),
            "seed": payload.get("seed"),
            "scale": payload.get("scale"),
            "row_counts": payload.get("row_counts") or {},
            "bronze_loaded_at": payload.get("bronze_loaded_at"),
            "last_snapshot_id": payload.get("last_snapshot_id"),
            "load_history": payload.get("load_history") if isinstance(payload.get("load_history"), list) else [],
            "is_active": (
                self.active_run_path.exists()
                and self._active_run_id_only() == run_id
            ),
            "active_snapshot_id": self._active_snapshot_id_only(run_id),
            "integrity_tracked": all(
                isinstance(hashes.get(name), str) and bool(hashes.get(name))
                for name in ("customer", "product", "store", "currency_exchange", "sales")
            ),
            "files": public_files,
            "run_path": directory.relative_to(self.settings.workspace.resolve()).as_posix(),
        }

    def verify_run(self, run_id: str) -> dict[str, object]:
        payload = self._load_manifest(run_id)
        files = self.run_files(run_id, verify_hashes=False)
        hashes = payload.get("file_sha256")
        tracked = hashes if isinstance(hashes, dict) else {}

        results: dict[str, dict[str, object]] = {}
        tracked_count = 0
        valid_count = 0
        for name, path in files.items():
            expected = tracked.get(name)
            if not isinstance(expected, str) or not expected:
                results[name] = {
                    "tracked": False,
                    "valid": None,
                    "expected_sha256": None,
                    "actual_sha256": None,
                }
                continue

            tracked_count += 1
            actual = self._sha256(path)
            valid = actual == expected
            if valid:
                valid_count += 1
            results[name] = {
                "tracked": True,
                "valid": valid,
                "expected_sha256": expected,
                "actual_sha256": actual,
            }

        return {
            "run_id": run_id,
            "tracked_files": tracked_count,
            "valid_files": valid_count,
            "all_tracked": tracked_count == len(files),
            "all_valid": tracked_count == len(files) and valid_count == tracked_count,
            "files": results,
        }

    def compare_runs(self, base_run_id: str, target_run_id: str) -> dict[str, object]:
        if base_run_id == target_run_id:
            raise ValueError("Choose two different runs")

        base = self.get_run(base_run_id)
        target = self.get_run(target_run_id)

        parameter_fields = ("scenario", "seed", "scale")
        parameter_changes = {
            field: {"base": base.get(field), "target": target.get(field)}
            for field in parameter_fields
            if base.get(field) != target.get(field)
        }

        base_counts = base.get("row_counts")
        target_counts = target.get("row_counts")
        base_rows = base_counts if isinstance(base_counts, dict) else {}
        target_rows = target_counts if isinstance(target_counts, dict) else {}
        row_keys = sorted(set(map(str, base_rows)) | set(map(str, target_rows)))
        row_count_changes = {
            name: {
                "base": base_rows.get(name),
                "target": target_rows.get(name),
                "delta": (
                    int(target_rows.get(name, 0)) - int(base_rows.get(name, 0))
                    if isinstance(base_rows.get(name, 0), int)
                    and isinstance(target_rows.get(name, 0), int)
                    else None
                ),
            }
            for name in row_keys
            if base_rows.get(name) != target_rows.get(name)
        }

        base_files = base.get("files")
        target_files = target.get("files")
        base_file_map = base_files if isinstance(base_files, dict) else {}
        target_file_map = target_files if isinstance(target_files, dict) else {}
        file_names = sorted(set(map(str, base_file_map)) | set(map(str, target_file_map)))
        file_comparison: dict[str, dict[str, object]] = {}
        all_hashes_available = True
        exact_files_equal = True

        for name in file_names:
            base_info = base_file_map.get(name)
            target_info = target_file_map.get(name)
            base_dict = base_info if isinstance(base_info, dict) else {}
            target_dict = target_info if isinstance(target_info, dict) else {}
            base_hash = base_dict.get("sha256")
            target_hash = target_dict.get("sha256")
            hashes_available = (
                isinstance(base_hash, str) and bool(base_hash)
                and isinstance(target_hash, str) and bool(target_hash)
            )
            same_hash = bool(hashes_available and base_hash == target_hash)
            all_hashes_available = all_hashes_available and hashes_available
            exact_files_equal = exact_files_equal and same_hash
            file_comparison[name] = {
                "same_hash": same_hash if hashes_available else None,
                "base_sha256": base_hash if isinstance(base_hash, str) else None,
                "target_sha256": target_hash if isinstance(target_hash, str) else None,
                "base_size_bytes": base_dict.get("size_bytes"),
                "target_size_bytes": target_dict.get("size_bytes"),
            }

        return {
            "base_run_id": base_run_id,
            "target_run_id": target_run_id,
            "same_parameters": not parameter_changes,
            "parameter_changes": parameter_changes,
            "row_count_changes": row_count_changes,
            "all_hashes_available": all_hashes_available,
            "exact_files_equal": exact_files_equal if all_hashes_available else None,
            "files": file_comparison,
            "base_snapshot_id": base.get("last_snapshot_id"),
            "target_snapshot_id": target.get("last_snapshot_id"),
        }

    @property
    def active_run_path(self) -> Path:
        return self.settings.workspace / "active_run.json"

    def active_run(self) -> dict[str, object] | None:
        payload = self._active_marker()
        run_id = payload.get("run_id") if payload else None
        if not isinstance(run_id, str) or not run_id:
            return None
        try:
            detail = self.get_run(run_id)
        except ValueError:
            return None
        return {
            **detail,
            "active_loaded_at": payload.get("loaded_at") if payload else None,
            "active_snapshot_id": payload.get("snapshot_id") if payload else None,
        }

    def list_runs(self, limit: int = 20) -> list[dict[str, object]]:
        if not self.settings.staging_path.exists():
            return []

        active = self.active_run()
        active_run_id = str(active["run_id"]) if active else None
        active_snapshot_id = active.get("active_snapshot_id") if active else None

        runs: list[dict[str, object]] = []
        for manifest_path in self.settings.staging_path.glob("*/manifest.json"):
            run_id = manifest_path.parent.name
            try:
                payload = self._load_manifest(run_id)
            except ValueError:
                continue

            row_counts = payload.get("row_counts")
            if not isinstance(row_counts, dict):
                row_counts = {}
            runs.append({
                "run_id": run_id,
                "scenario": payload.get("scenario"),
                "scenario_name": payload.get("scenario_name"),
                "created_at": payload.get("created_at"),
                "seed": payload.get("seed"),
                "scale": payload.get("scale"),
                "sales_rows": row_counts.get("sales"),
                "bronze_loaded_at": payload.get("bronze_loaded_at"),
                "last_snapshot_id": payload.get("last_snapshot_id"),
                "load_count": len(payload.get("load_history")) if isinstance(payload.get("load_history"), list) else 0,
                "is_active": run_id == active_run_id,
                "active_snapshot_id": active_snapshot_id if run_id == active_run_id else None,
            })

        runs.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
        return runs[:max(1, min(limit, 100))]

    def mark_bronze_loaded(
        self,
        run_id: str,
        snapshot_id: int | None = None,
    ) -> dict[str, object]:
        payload = self._load_manifest(run_id)
        manifest_path = self._run_directory(run_id) / "manifest.json"
        loaded_at = datetime.now(timezone.utc).isoformat()
        payload["bronze_loaded_at"] = loaded_at
        payload["last_snapshot_id"] = snapshot_id
        history = payload.get("load_history")
        load_history = history if isinstance(history, list) else []
        load_history.append({
            "loaded_at": loaded_at,
            "snapshot_id": snapshot_id,
        })
        payload["load_history"] = load_history
        manifest_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        self.active_run_path.write_text(
            json.dumps(
                {
                    "run_id": run_id,
                    "loaded_at": loaded_at,
                    "snapshot_id": snapshot_id,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        return payload

    def generate(self, scenario: str, scale: int, seed: int) -> dict[str, object]:
        if scenario not in SCENARIO_CONFIG:
            raise ValueError(f"Unknown scenario: {scenario!r}")

        config = SCENARIO_CONFIG[scenario]
        run_id = f"{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-{uuid4().hex[:8]}"
        output = self.settings.staging_path / run_id
        output.mkdir(parents=True, exist_ok=False)

        customers = max(100, min(25_000, scale // 5))
        products = max(50, min(2_000, scale // 20))
        stores = 20

        files = {
            name: output / f"{name}.parquet"
            for name in ("customer", "product", "store", "currency_exchange", "sales")
        }
        file_sql = {name: self._sql_path(path) for name, path in files.items()}

        if scenario == "online-migration":
            channel_expr = (
                f"CASE WHEN ((sales_key*29+{seed})%100) < "
                "CASE WHEN order_date < DATE '2025-01-01' THEN 22 ELSE 68 END "
                "THEN 'Online' ELSE 'Store' END"
            )
        else:
            channel_expr = (
                f"CASE WHEN ((sales_key*29+{seed})%100) < 38 "
                "THEN 'Online' ELSE 'Store' END"
            )

        if scenario == "margin-pressure":
            discount_expr = (
                f"CASE WHEN order_date >= DATE '2025-01-01' "
                f"THEN 0.12 + (((sales_key*31+{seed})%19)::DOUBLE/100) "
                f"ELSE (((sales_key*31+{seed})%12)::DOUBLE/100) END"
            )
            cost_multiplier_expr = (
                "CASE WHEN order_date >= DATE '2025-01-01' THEN 1.20 ELSE 1.00 END"
            )
        else:
            discount_expr = f"(((sales_key*31+{seed})%20)::DOUBLE/100)"
            cost_multiplier_expr = "1.00"

        if scenario == "logistics-delays":
            delivery_expr = (
                f"CASE WHEN channel='Online' THEN 5+((sales_key*17+{seed})%16) "
                f"ELSE 1+((sales_key*13+{seed})%8) END"
            )
        else:
            delivery_expr = f"1+((sales_key*17+{seed})%6)"

        if scenario == "currency-exposure":
            fx_expr = (
                f"base_rate * (0.92 + (((month_index*7+{seed})%17)::DOUBLE/100))"
            )
        else:
            fx_expr = (
                f"base_rate * (0.98 + (((month_index*7+{seed})%5)::DOUBLE/100))"
            )

        con = duckdb.connect(":memory:")
        try:
            con.execute(
                f"""COPY (
                    SELECT
                      i::INTEGER AS customer_key,
                      'Customer ' || i AS customer_name,
                      ['Norway','Switzerland','France','Germany','United Kingdom'][1+(i%5)] AS country,
                      ['Consumer','Small Business','Corporate','Enterprise'][1+(i%4)] AS segment
                    FROM range(1,{customers + 1}) t(i)
                ) TO '{file_sql["customer"]}' (FORMAT PARQUET, COMPRESSION ZSTD)"""
            )

            con.execute(
                f"""COPY (
                    SELECT
                      i::INTEGER AS product_key,
                      'Product ' || i AS product_name,
                      ['Audio','Computers','Cameras','Phones','TV and Video','Accessories'][1+(i%6)] AS category,
                      (12+((i*17+{seed})%340))::DECIMAL(12,2) AS unit_price,
                      (7+((i*11+{seed})%180))::DECIMAL(12,2) AS unit_cost
                    FROM range(1,{products + 1}) t(i)
                ) TO '{file_sql["product"]}' (FORMAT PARQUET, COMPRESSION ZSTD)"""
            )

            con.execute(
                f"""COPY (
                    SELECT
                      i::INTEGER AS store_key,
                      'Store ' || i AS store_name,
                      ['Norway','Switzerland','France','Germany','United Kingdom'][1+(i%5)] AS country,
                      ['NOK','CHF','EUR','EUR','GBP'][1+(i%5)] AS currency
                    FROM range(1,{stores + 1}) t(i)
                ) TO '{file_sql["store"]}' (FORMAT PARQUET, COMPRESSION ZSTD)"""
            )

            con.execute(
                f"""COPY (
                    WITH months AS (
                      SELECT
                        i::INTEGER AS month_index,
                        CAST(DATE '2024-01-01' + i * INTERVAL '1 month' AS DATE) AS rate_month
                      FROM range(0,24) t(i)
                    ),
                    currencies(currency, base_rate) AS (
                      VALUES
                        ('NOK', 0.095::DOUBLE),
                        ('CHF', 1.150::DOUBLE),
                        ('EUR', 1.080::DOUBLE),
                        ('GBP', 1.270::DOUBLE),
                        ('USD', 1.000::DOUBLE)
                    )
                    SELECT
                      rate_month,
                      currency,
                      round({fx_expr}, 6) AS exchange_rate_to_usd
                    FROM months
                    CROSS JOIN currencies
                ) TO '{file_sql["currency_exchange"]}' (FORMAT PARQUET, COMPRESSION ZSTD)"""
            )

            con.execute(
                f"""COPY (
                    WITH base AS (
                      SELECT
                        i::BIGINT AS sales_key,
                        1+((i*37+{seed})%{customers}) AS customer_key,
                        1+((i*19+{seed})%{products}) AS product_key,
                        1+((i*7+{seed})%{stores}) AS store_key,
                        DATE '2024-01-01' + (((i*13+{seed})%730)::INTEGER) AS order_date,
                        1+((i*5+{seed})%5) AS quantity
                      FROM range(1,{scale + 1}) t(i)
                    ),
                    behavior AS (
                      SELECT
                        *,
                        {channel_expr} AS channel,
                        {discount_expr} AS discount_rate
                      FROM base
                    ),
                    operational AS (
                      SELECT
                        *,
                        ({delivery_expr})::INTEGER AS delivery_days,
                        ({cost_multiplier_expr})::DOUBLE AS cost_multiplier
                      FROM behavior
                    ),
                    priced AS (
                      SELECT
                        o.*,
                        p.unit_price,
                        round(p.unit_cost * o.cost_multiplier, 2) AS unit_cost,
                        s.country AS store_country,
                        s.currency,
                        fx.exchange_rate_to_usd,
                        round(o.quantity*p.unit_price*(1-o.discount_rate), 2) AS net_revenue_local,
                        round(o.quantity*p.unit_cost*o.cost_multiplier, 2) AS total_cost_local
                      FROM operational o
                      JOIN read_parquet('{file_sql["product"]}') p USING(product_key)
                      JOIN read_parquet('{file_sql["store"]}') s USING(store_key)
                      JOIN read_parquet('{file_sql["currency_exchange"]}') fx
                        ON fx.currency=s.currency
                       AND fx.rate_month=CAST(date_trunc('month', o.order_date) AS DATE)
                    )
                    SELECT
                      '{scenario}' AS scenario,
                      sales_key,
                      customer_key,
                      product_key,
                      store_key,
                      order_date,
                      order_date + delivery_days AS delivery_date,
                      delivery_days,
                      quantity,
                      channel,
                      discount_rate,
                      unit_price,
                      unit_cost,
                      store_country,
                      currency,
                      exchange_rate_to_usd,
                      net_revenue_local,
                      total_cost_local,
                      round(net_revenue_local*exchange_rate_to_usd, 2) AS net_revenue,
                      round(total_cost_local*exchange_rate_to_usd, 2) AS total_cost
                    FROM priced
                ) TO '{file_sql["sales"]}' (FORMAT PARQUET, COMPRESSION ZSTD)"""
            )
        finally:
            con.close()

        file_sha256 = {
            name: self._sha256(path)
            for name, path in files.items()
        }

        manifest = {
            "run_id": run_id,
            "scenario": scenario,
            "scenario_name": config["name"],
            "business_focus": config["focus"],
            "seed": seed,
            "scale": scale,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "files": {key: str(value) for key, value in files.items()},
            "file_sha256": file_sha256,
            "row_counts": {
                "customer": customers,
                "product": products,
                "store": stores,
                "currency_exchange": 120,
                "sales": scale,
            },
        }
        (output / "manifest.json").write_text(
            json.dumps(manifest, indent=2),
            encoding="utf-8",
        )
        return manifest
