# Contoso Data Studio

Local-first synthetic retail data lab built around **Parquet + DuckDB + DuckLake + dbt**.

```text
Generate -> Bronze (DuckLake) -> dbt Silver -> dbt Gold -> SQL / KPI / Charts
```

## v0 foundation

- deterministic `retail-baseline` generator
- Parquet output
- local DuckLake bootstrap with Bronze / Silver / Gold schemas
- FastAPI catalog and read-only SQL API
- dbt-duckdb Silver/Gold starter models
- dbt Charts starter board
- React + Fluent UI shell planned around Generate, Lakehouse, Transform, Query, Explore, Charts, Canvas

## Scope

In: local synthetic business scenarios, Parquet/JSON/CSV/XLSX inspection, DuckDB SQL, DuckLake, dbt, dbt Charts, lineage.

Out of v1: DAX execution, Power BI emulation, Spark, Fabric, Databricks, Airflow.

## Local layout

```text
workspace/
  contoso.ducklake
  contoso.ducklake.files/
  staging/<run-id>/*.parquet
dbt/
charts/
apps/api/
apps/web/
```

See `docs/architecture.md`.
