"""Optional retail Gold -> app read (RETAIL_GOLD_TO_APP in mapping.py, GOLD-MAPPING.md section 3).

Reads retail Gold through the read-only SQL path, pinned to one DuckLake snapshot, and folds it into the
app's departments with mapping.RETAIL_DEPARTMENTS. The result is a labelled copy (`kind: "copy"`,
`authoritative: false`): retail Gold stays the analytical truth, nothing is written to Gold, and the app's
own Actual rows (the synthetic seed) are not replaced.
"""
from __future__ import annotations

from typing import Any

from app.services.ducklake import DuckLakeService
from app.services.fabric_apps import mapping
from app.services.fabric_apps.store import now_iso

MAX_ROWS = 20_000


def _literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def department_case(departments: dict[str, mapping.RetailSlice] | None = None) -> str:
    """SQL CASE that turns (channel, store_country) into an app department code, NULL when unmapped."""
    departments = mapping.RETAIL_DEPARTMENTS if departments is None else departments
    branches = []
    for code, item in departments.items():
        condition = f"channel = {_literal(item.channel)}"
        if item.countries:
            condition += f" AND store_country IN ({', '.join(_literal(c) for c in item.countries)})"
        branches.append(f"WHEN {condition} THEN {_literal(code)}")
    return "CASE " + " ".join(branches) + " END"


def retail_actuals_sql(snapshot_id: int, departments: dict[str, mapping.RetailSlice] | None = None) -> str:
    relation = f"contoso.gold.{mapping.RETAIL_GOLD_MODEL} AT (VERSION => {int(snapshot_id)})"
    return (
        f"WITH sliced AS (SELECT scenario, order_month, channel, store_country, sales_lines, revenue, "
        f"{department_case(departments)} AS department_code FROM {relation}) "
        "SELECT scenario, department_code, channel, store_country, strftime(order_month, '%Y-%m') AS month, "
        "CAST(sum(revenue) AS DECIMAL(18,2)) AS amount, sum(sales_lines) AS sales_lines "
        "FROM sliced GROUP BY ALL ORDER BY scenario, month, department_code, channel, store_country"
    )


def _provenance(snapshot_id: int | None, read_at: str) -> dict[str, Any]:
    return {
        "kind": "copy",
        "authoritative": False,
        "authority": mapping.AUTHORITY["analytical_truth"],
        "source": f"contoso.gold.{mapping.RETAIL_GOLD_MODEL}",
        "snapshot_id": snapshot_id,
        "read_at": read_at,
        "departments": mapping.describe()["retail_departments"],
        "flag": mapping.RETAIL_GOLD_TO_APP_ENV,
    }


def read_retail_actuals(ducklake: DuckLakeService) -> dict[str, Any]:
    """Monthly retail actuals per app department, as a non-authoritative copy with its provenance."""
    read_at = now_iso()
    if not (mapping.retail_gold_to_app_enabled() and all(item.enabled for item in mapping.RETAIL_GOLD_TO_APP)):
        return {"enabled": False, "ready": False, "items": [], "unmapped": [], "provenance": _provenance(None, read_at)}
    try:
        present = any(
            row["schema"] == "gold" and row["name"] == mapping.RETAIL_GOLD_MODEL for row in ducklake.catalog()
        )
        snapshots = ducklake.snapshots(1) if present else []
        if not snapshots:
            raise LookupError(f"contoso.gold.{mapping.RETAIL_GOLD_MODEL} is not built yet (run dbt build)")
        snapshot_id = int(snapshots[0]["snapshot_id"])
        columns, rows, _ = ducklake.query(retail_actuals_sql(snapshot_id), MAX_ROWS)
    except Exception as exc:  # missing Gold fails visibly, no invented rows
        return {
            "enabled": True, "ready": False, "items": [], "unmapped": [], "error": str(exc),
            "provenance": _provenance(None, read_at),
        }

    totals: dict[tuple[str, str, str], dict[str, Any]] = {}
    unmapped: dict[tuple[str, str], dict[str, Any]] = {}
    for row in (dict(zip(columns, values)) for values in rows):
        if row["department_code"] is None:
            key = (row["channel"], row["store_country"])
            entry = unmapped.setdefault(key, {"channel": key[0], "store_country": key[1], "amount": 0.0, "sales_lines": 0})
        else:
            key = (row["scenario"], row["department_code"], row["month"])
            entry = totals.setdefault(
                key, {"scenario": key[0], "department_code": key[1], "month": key[2], "amount": 0.0, "sales_lines": 0}
            )
        entry["amount"] = round(entry["amount"] + float(row["amount"]), 2)
        entry["sales_lines"] += int(row["sales_lines"])
    stamp = {"gold_table": f"contoso.gold.{mapping.RETAIL_GOLD_MODEL}", "snapshot_id": snapshot_id, "read_at": read_at}
    return {
        "enabled": True,
        "ready": True,
        "items": [{**item, "_provenance": stamp} for item in totals.values()],
        "unmapped": list(unmapped.values()),
        "provenance": _provenance(snapshot_id, read_at),
    }
