# Contoso Data Studio

Local-first synthetic retail data lab built around **Parquet + DuckDB + DuckLake + dbt**.

```text
Generate -> Inspect -> Bronze (DuckLake) -> dbt Silver -> dbt Gold -> SQL / KPI / Charts
```

## Current foundation

- deterministic `retail-baseline` generator
- Parquet staging
- local DuckLake catalog with SQLite metadata + managed Parquet data and Bronze / Silver / Gold schemas
- unified Parquet / JSON / CSV / XLSX Explorer
- Parquet file metadata and column statistics through DuckDB
- read-only DuckDB SQL workbench
- dbt-duckdb 1.11 Transform runtime with build/test feedback
- starter Silver and Gold models with dbt data tests
- dbt Charts 0.8 project + validated Executive Sales board
- Gold KPI preview and dbt Charts validation status in the Charts tab
- React + Fluent UI shell for Generate, Lakehouse, Transform, Query, Explore, Charts and Canvas

## Scope

In: local synthetic business scenarios, Parquet/JSON/CSV/XLSX inspection, DuckDB SQL, DuckLake, dbt, dbt Charts, lineage.

Out of v1: DAX execution, Power BI emulation, Spark, Fabric, Databricks, Airflow.

## Local layout

```text
workspace/
  contoso.ducklake.sqlite
  contoso.ducklake.files/
  staging/<run-id>/*.parquet
  imports/
dbt/
charts/
dbt_charts.yml
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

The first DuckLake/Excel use may install DuckDB extensions into DuckDB's local extension cache. DuckLake uses a SQLite metadata catalog so the API and dbt can safely reconnect as separate local clients.

### Web

In another terminal:

```bash
cd apps/web
npm install
npm run dev
```

Open the Vite address (normally `http://localhost:5173`).

### dbt Charts (isolated tool)

Keep dbt Charts separate from the API virtual environment:

```bash
uv tool install dbt-charts --with dbt-duckdb==1.11.0
dct validate charts/executive-sales.yml --project-dir . --dbt-project-dir dbt
dct serve --project-dir . --dbt-project-dir dbt
```

The app detects `dct` on PATH and exposes board validation in **Charts**. The live dbt Charts renderer remains the official `dct serve` UI rather than being reimplemented inside Contoso Data Studio.

## First end-to-end flow

1. **Generate** → create the Retail Baseline dataset.
2. **Explore** → inspect generated Parquet, schema and statistics.
3. **Lakehouse** → confirm the four Bronze tables.
4. **Transform** → run `dbt build`.
5. **Lakehouse** → confirm Silver/Gold models.
6. **Query** → query `contoso.gold.monthly_sales`.
7. **Charts** → inspect Gold KPIs and validate/open the dbt Charts board.

See `docs/architecture.md`.
