# Contoso Data Studio

Local-first synthetic retail data lab built around **Parquet + DuckDB + DuckLake + dbt**.

```text
Generate -> Inspect -> Bronze (DuckLake) -> dbt Silver -> dbt Gold -> SQL / KPI / Charts
```

## Current foundation

- deterministic `retail-baseline` generator
- Parquet staging
- local DuckLake catalog with Bronze / Silver / Gold schemas
- unified Parquet / JSON / CSV / XLSX Explorer
- Parquet file metadata and column statistics through DuckDB
- read-only DuckDB SQL workbench
- dbt-duckdb 1.11 Transform runtime with build/test feedback
- starter Silver and Gold models with dbt data tests
- starter dbt Charts board
- React + Fluent UI shell for Generate, Lakehouse, Transform, Query, Explore, Charts and Canvas

## Scope

In: local synthetic business scenarios, Parquet/JSON/CSV/XLSX inspection, DuckDB SQL, DuckLake, dbt, dbt Charts, lineage.

Out of v1: DAX execution, Power BI emulation, Spark, Fabric, Databricks, Airflow.

## Local layout

```text
workspace/
  contoso.ducklake
  contoso.ducklake.files/
  staging/<run-id>/*.parquet
  imports/
dbt/
charts/
apps/api/
apps/web/
```

## Run locally

Python 3.11+ and Node.js are expected.

### API + dbt

From the repository root:

```bash
python -m venv .venv
# Windows PowerShell: .venv\Scripts\Activate.ps1
# macOS/Linux: source .venv/bin/activate
pip install -e "apps/api[dbt]"
uvicorn app.main:app --app-dir apps/api --reload
```

The first DuckLake/Excel use may install DuckDB extensions into DuckDB's local extension cache.

### Web

In another terminal:

```bash
cd apps/web
npm install
npm run dev
```

Open the Vite address (normally `http://localhost:5173`).

## First end-to-end flow

1. **Generate** → create the Retail Baseline dataset.
2. **Explore** → inspect generated Parquet, schema and statistics.
3. **Lakehouse** → confirm the four Bronze tables.
4. **Transform** → run `dbt build`.
5. **Lakehouse** → confirm Silver/Gold models.
6. **Query** → query `contoso.gold.monthly_sales`.

See `docs/architecture.md`.
