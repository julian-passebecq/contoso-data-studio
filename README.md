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
- React + Fluent UI shell for Projects, Generate, Lakehouse, Transform, Query, Explore, Charts and Canvas

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
3. **Lakehouse** → confirm the five Bronze tables.
4. **Transform** → run `dbt build`.
5. **Lakehouse** → confirm Silver/Gold models.
6. **Query** → query `contoso.gold.monthly_sales`.
7. **Charts** → inspect Gold KPIs and validate/open the dbt Charts board.

See `docs/architecture.md`.

## Themes and recorded product tour (prototype)

- **Theme**: the header *Theme* setting switches between *Default* (unchanged light workbench) and *Fabric-like* (Fluent 2 dark tokens with our own slate/teal palette; no third-party branding). `?theme=fabric` or `?theme=default` in the URL sets and remembers it.
- **Motion**: page and guided-step transitions, skeleton loading states and KPI count-up. All motion is disabled under `prefers-reduced-motion`.
- **Recorded tour**: with the API and web dev server running,

  ```bash
  npm --prefix apps/web install --no-save playwright@1.56.1 ffmpeg-static
  node tools/record_tour.mjs --base http://127.0.0.1:5173 --theme fabric
  ```

  The tour opens Retail Sales 101, shows KPIs, runs the SQL step, inspects lineage and finishes the guide, with a synthetic cursor and lower-third captions. Frames are captured on a virtual clock at 30 fps / 1280x720 (`qa/video/frames/`, ignored), encoded to `qa/video/contoso-tour.mp4` (ignored) when ffmpeg is found (`--ffmpeg <path>`, `$FFMPEG_PATH`/`$FFMPEG`, PATH, or the `ffmpeg-static` package). Stills and `metadata.json` in `qa/video/` are committed. Route changes are filmed only once the new route has settled (`<html data-route-ready>` + no API request in flight), so only the content area slides in and two pages are never superimposed; camera zooms move the content area only (header and rail stay); scale and pan are solved from the focus group's bounding boxes at capture time so the whole group stays inside a safe frame above the lower-third caption, and a group that cannot be zoomed whole (e.g. the three KPI cards) is not zoomed. The run fails (`metadata.json` → `checks`) when a transition shows more than 10 consecutive frames of large frame-to-frame change (a long blend) when any frame shows two route titles or a title over another route's content, or when a zoom frame leaves a focus element outside the visible area (safe frame at the zoom keyframe) or cuts a group element at an edge (`checks.camera_clipping`). If the dev proxy must reach a non-default API port, start Vite with `CONTOSO_API_URL=http://127.0.0.1:<port>`.
