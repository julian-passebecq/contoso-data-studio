from __future__ import annotations
import json
from datetime import datetime, timezone
from uuid import uuid4
import duckdb
from app.config import Settings

SCENARIOS = [
    {"id":"retail-baseline","name":"Retail baseline","description":"Stable multi-country retail sales.","status":"ready"},
    {"id":"online-migration","name":"Online migration","description":"Increasing online share over time.","status":"planned"},
    {"id":"margin-pressure","name":"Margin pressure","description":"Discounting and cost inflation.","status":"planned"},
    {"id":"logistics-delays","name":"Logistics delays","description":"Fulfilment delays by region/channel.","status":"planned"},
    {"id":"currency-exposure","name":"Currency exposure","description":"Multi-currency exchange-rate effects.","status":"planned"},
]

class GeneratorService:
    def __init__(self, settings: Settings):
        self.settings = settings

    def generate(self, scenario: str, scale: int, seed: int) -> dict[str, object]:
        if scenario != "retail-baseline":
            raise ValueError(f"Scenario {scenario!r} is not implemented yet")
        run_id = f"{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-{uuid4().hex[:8]}"
        output = self.settings.staging_path / run_id
        output.mkdir(parents=True, exist_ok=False)
        customers, products, stores = max(100, min(25000, scale // 5)), max(50, min(2000, scale // 20)), 20
        files = {name: output / f"{name}.parquet" for name in ("customer","product","store","sales")}
        con = duckdb.connect(":memory:")
        try:
            con.execute(f"""COPY (
              SELECT i::INTEGER customer_key, 'Customer '||i customer_name,
              ['Norway','Switzerland','France','Germany','United Kingdom'][1+(i%5)] country,
              ['Consumer','Small Business','Corporate','Enterprise'][1+(i%4)] segment
              FROM range(1,{customers+1}) t(i)
            ) TO '{files["customer"].as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)""")
            con.execute(f"""COPY (
              SELECT i::INTEGER product_key, 'Product '||i product_name,
              ['Audio','Computers','Cameras','Phones','TV and Video','Accessories'][1+(i%6)] category,
              (12+((i*17+{seed})%340))::DECIMAL(12,2) unit_price,
              (7+((i*11+{seed})%180))::DECIMAL(12,2) unit_cost
              FROM range(1,{products+1}) t(i)
            ) TO '{files["product"].as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)""")
            con.execute(f"""COPY (
              SELECT i::INTEGER store_key, 'Store '||i store_name,
              ['Norway','Switzerland','France','Germany','United Kingdom'][1+(i%5)] country
              FROM range(1,{stores+1}) t(i)
            ) TO '{files["store"].as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)""")
            con.execute(f"""COPY (
              WITH b AS (
                SELECT i::BIGINT sales_key,
                  1+((i*37+{seed})%{customers}) customer_key,
                  1+((i*19+{seed})%{products}) product_key,
                  1+((i*7+{seed})%{stores}) store_key,
                  DATE '2024-01-01' + (((i*13+{seed})%730)::INTEGER) order_date,
                  1+((i*5+{seed})%5) quantity,
                  CASE WHEN ((i*29+{seed})%100)<38 THEN 'Online' ELSE 'Store' END channel,
                  ((i*31+{seed})%20)::DOUBLE/100 discount_rate
                FROM range(1,{scale+1}) t(i)
              )
              SELECT b.*, p.unit_price, p.unit_cost,
                round(b.quantity*p.unit_price*(1-b.discount_rate),2) net_revenue,
                round(b.quantity*p.unit_cost,2) total_cost
              FROM b JOIN read_parquet('{files["product"].as_posix()}') p USING(product_key)
            ) TO '{files["sales"].as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)""")
        finally:
            con.close()
        manifest = {"run_id":run_id,"scenario":scenario,"seed":seed,"scale":scale,
                    "created_at":datetime.now(timezone.utc).isoformat(),
                    "files":{k:str(v) for k,v in files.items()},
                    "row_counts":{"customer":customers,"product":products,"store":stores,"sales":scale}}
        (output/"manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        return manifest
