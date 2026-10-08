"""Declared dataset mapping between the Fabric-style app (Rayfin copy) and the DuckLake/dbt layers.

Authority rule (docs/fabric-apps/GOLD-MAPPING.md): DuckLake/dbt Gold is the analytical truth. The app's
operational store (SQLite, the Fabric SQL database stand-in) and its Bronze mirror are copies with their
own provenance; nothing here makes them authoritative for retail Gold, and nothing writes into Gold
except `dbt build` of the app's own model.

Three declared flows:
  APP_TO_BRONZE      app entity -> contoso.bronze.sfapp_* (mirror worker, every column copied as is
                     plus `_mirrored_at`). Used by mirror.py; an undeclared entity is refused.
  BRONZE_TO_APP_GOLD contoso.gold.forecast_vs_actual column lineage (dbt, read only for the app).
  RETAIL_GOLD_TO_APP optional retail Gold -> app reads. None is wired today (`enabled=False`);
                     Actual rows are the synthetic seed in store.py, not retail Gold.
There is no app -> retail Gold writeback.
"""
from __future__ import annotations

from dataclasses import dataclass

BRONZE_SCHEMA = "bronze"
BRONZE_PREFIX = "sfapp_"
GOLD_MODEL = "forecast_vs_actual"
MIRROR_COLUMN = "_mirrored_at"

AUTHORITY = {
    "analytical_truth": "contoso.gold.* built by dbt from DuckLake",
    "app_copy": "operational store (SQLite) and contoso.bronze.sfapp_* mirror",
    "authoritative": False,
    "note": "App rows are a copy with their own provenance; they never replace retail Gold.",
}

# Entity name -> Bronze table name (without schema). Must match bronze_table() in mirror.py.
APP_TO_BRONZE: dict[str, str] = {
    "Department": "sfapp_departments",
    "Forecast": "sfapp_forecasts",
    "Actual": "sfapp_actuals",
}


@dataclass(frozen=True)
class ColumnLineage:
    gold_column: str
    sources: tuple[str, ...]  # "bronze_table.column"; empty for computed columns
    transform: str


BRONZE_TO_APP_GOLD: tuple[ColumnLineage, ...] = (
    ColumnLineage("month", ("sfapp_forecasts.month",), "group key"),
    ColumnLineage("department_code", ("sfapp_departments.code",), "join on sfapp_forecasts.department_id = id"),
    ColumnLineage("department_name", ("sfapp_departments.name",), "join on sfapp_forecasts.department_id = id"),
    ColumnLineage("forecast_amount", ("sfapp_forecasts.amount",), "sum per department and month, decimal(18,2)"),
    ColumnLineage("actual_amount", ("sfapp_actuals.amount",), "sum per department and month, left join, decimal(18,2)"),
    ColumnLineage("variance", ("sfapp_actuals.amount", "sfapp_forecasts.amount"), "actual_amount - forecast_amount"),
    ColumnLineage("variance_pct", ("sfapp_actuals.amount", "sfapp_forecasts.amount"), "variance / forecast_amount, null when forecast is 0 or actual missing"),
    ColumnLineage("last_editor", ("sfapp_forecasts.updated_by",), "max over non-seed editors"),
    ColumnLineage("forecast_mirrored_at", ("sfapp_forecasts._mirrored_at",), "max mirror time (row provenance)"),
    ColumnLineage("built_at", (), "current_timestamp at dbt build (Gold provenance)"),
)


@dataclass(frozen=True)
class OptionalGoldRead:
    gold_model: str
    gold_column: str
    app_entity: str
    app_field: str
    transform: str
    enabled: bool = False


# Candidate retail Gold -> app reads, declared so the boundary is visible and testable. Disabled: wiring
# one needs a product decision (how retail channels/countries map to app departments) and would still
# land as a labelled copy, never as an edit of Gold.
RETAIL_GOLD_TO_APP: tuple[OptionalGoldRead, ...] = (
    OptionalGoldRead("monthly_sales", "order_month", "Actual", "month", "strftime(order_month, '%Y-%m')"),
    OptionalGoldRead("monthly_sales", "revenue", "Actual", "amount", "sum per month for the department's channel/countries (undecided)"),
)


def bronze_table_for(entity_name: str) -> str:
    try:
        return APP_TO_BRONZE[entity_name]
    except KeyError as exc:
        raise ValueError(f"Entity {entity_name} has no declared Bronze mapping (see fabric_apps/mapping.py)") from exc


def describe() -> dict:
    """JSON-friendly view of the declared mapping, for status output and docs checks."""
    return {
        "authority": AUTHORITY,
        "app_to_bronze": {
            name: {"table": f"contoso.{BRONZE_SCHEMA}.{table}", "columns": "all model columns + " + MIRROR_COLUMN}
            for name, table in APP_TO_BRONZE.items()
        },
        "app_gold": {
            "table": f"contoso.gold.{GOLD_MODEL}",
            "lineage": [
                {"column": item.gold_column, "sources": list(item.sources), "transform": item.transform}
                for item in BRONZE_TO_APP_GOLD
            ],
        },
        "retail_gold_to_app": [
            {
                "gold": f"contoso.gold.{item.gold_model}.{item.gold_column}",
                "app": f"{item.app_entity}.{item.app_field}",
                "transform": item.transform,
                "enabled": item.enabled,
            }
            for item in RETAIL_GOLD_TO_APP
        ],
        "writeback_to_gold": None,
    }
