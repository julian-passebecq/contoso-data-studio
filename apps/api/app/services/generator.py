from __future__ import annotations

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

        manifest = {
            "run_id": run_id,
            "scenario": scenario,
            "scenario_name": config["name"],
            "business_focus": config["focus"],
            "seed": seed,
            "scale": scale,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "files": {key: str(value) for key, value in files.items()},
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
