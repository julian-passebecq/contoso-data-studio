# DataPass React consumer traces

Source commit: `61353848b4e7e129e03ea8aedfc2794a17667de3`. Machine-readable twin: `traces.json`. Verify with `python -I docs/datapass-react/check_traces.py`.

Status: RESOLVED = every hop read in code. PARTIAL = chain verified but a hop depends on runtime input (listed as UNRESOLVED).

## charts-kpi-revenue (RESOLVED)
Charts KPIs: Revenue card and monthly revenue chart (Gold monthly_sales.revenue)

| Layer | Location | Symbol | Note |
|---|---|---|---|
| react | `apps/web/src/pages/ChartsPage.tsx:278-287` | `contoso.gold.monthly_sales` | Default (retail-baseline) branch posts two literal SQL strings to /api/query |
| react | `apps/web/src/api.ts:13-19` | `postJson` | POST JSON helper wrapping fetch |
| http | `apps/web/src/pages/ChartsPage.tsx:279-279` | `"/api/query"` | POST /api/query body {sql,limit} |
| api | `apps/api/app/main.py:375-388` | `def query` | FastAPI route POST /api/query -> ducklake.query |
| service | `apps/api/app/services/ducklake.py:305-329` | `def query` | Read-only validation, executes statement on DuckLake read-only connection |
| react | `apps/web/src/pages/ChartsPage.tsx:289-293` | `label:"Revenue"` | rows[0][0] (round(sum(revenue),2)) becomes the Revenue KPI card |
| sql | `apps/web/src/pages/ChartsPage.tsx:280-280` | `sum(revenue)` | select round(sum(revenue),2) revenue ... from contoso.gold.monthly_sales |
| dbt | `dbt/models/gold/monthly_sales.sql:8-8` | `as revenue` | revenue = round(sum(net_revenue),2) grouped by scenario, order_month, channel |
| dbt | `dbt/models/gold/monthly_sales.sql:12-12` | `ref('stg_sales')` | Gold reads Silver |
| dbt | `dbt/models/silver/stg_sales.sql:20-20` | `as net_revenue` | net_revenue = cast(net_revenue as decimal(18,2)) |
| dbt | `dbt/models/silver/stg_sales.sql:23-23` | `source('bronze','sales')` | Silver reads Bronze contoso.bronze.sales |
| service | `apps/api/app/services/ducklake.py:138-147` | `def load_parquet_to_bronze` | Bronze table created from run parquet via read_parquet |
| service | `apps/api/app/services/generator.py:650-650` | `AS net_revenue` | Parquet net_revenue = round(net_revenue_local*exchange_rate_to_usd,2) |
| gold | `dbt/models/gold/monthly_sales.sql:8-8` | `revenue` | FIELD contoso.gold.monthly_sales.revenue |

## query-page (PARTIAL)
Query page: run user SQL

| Layer | Location | Symbol | Note |
|---|---|---|---|
| react | `apps/web/src/pages/QueryPage.tsx:66-70` | `"/api/query"` | run() posts the editor SQL with limit 500 |
| react | `apps/web/src/api.ts:13-19` | `postJson` | POST JSON helper wrapping fetch |
| api | `apps/api/app/main.py:375-388` | `def query` | POST /api/query |
| service | `apps/api/app/services/ducklake.py:305-329` | `def query` | Allows one select/with/show/describe/explain statement; FORBIDDEN_SQL rejects mutation |

UNRESOLVED:
- SQL text is user input (editor state, or ProjectPreset.query from apps/web/src/projects.ts via ProjectsPage): table and column targets cannot be resolved statically. Preset queries in projects.ts are literal and can each be traced separately.
- Result columns are only known at run time from cursor.description.

## lakehouse-catalog (RESOLVED)
Lakehouse catalog: bronze/silver/gold table list

| Layer | Location | Symbol | Note |
|---|---|---|---|
| react | `apps/web/src/pages/LakehousePage.tsx:40-45` | `"/api/lakehouse/catalog"` | load() fetches catalog with snapshots, quality, project state |
| react | `apps/web/src/api.ts:9-11` | `getJson` | GET helper |
| api | `apps/api/app/main.py:192-197` | `def catalog` | GET /api/lakehouse/catalog -> {tables} |
| service | `apps/api/app/services/ducklake.py:153-171` | `def catalog` | Reads the DuckLake SQLite metadata catalog, schemas bronze/silver/gold |
| sql | `apps/api/app/services/ducklake.py:156-165` | `FROM ducklake_table` | Metadata SQL; table names come from the catalog at run time |

UNRESOLVED:
- Names of returned tables are catalog data, not statically known; dbt/models/gold/*.sql and silver/stg_sales.sql define the expected ones.

## transform-dbt-build (PARTIAL)
Transform page: dbt build

| Layer | Location | Symbol | Note |
|---|---|---|---|
| react | `apps/web/src/pages/TransformPage.tsx:118-127` | `/api/dbt/${command}` | execute('build'|'test', selector?) posts to /api/dbt/{command}[?selector=] |
| react | `apps/web/src/api.ts:13-19` | `postJson` | POST JSON helper wrapping fetch |
| api | `apps/api/app/main.py:326-340` | `def dbt_run` | POST /api/dbt/{command} |
| service | `apps/api/app/services/dbt_runner.py:407-456` | `def run` | Runs dbt CLI subprocess with --project-dir dbt/, returns run_results |
| service | `apps/api/app/services/dbt_runner.py:13-13` | `ALLOWED_COMMANDS` | build|run|test|parse |
| dbt | `dbt/models/silver/stg_sales.sql:1-23` | `source(` | Silver model built from bronze.sales |
| dbt | `dbt/models/gold/monthly_sales.sql:1-12` | `ref('stg_sales')` | Gold models built from Silver |

UNRESOLVED:
- URL is a template literal with dynamic `command` and optional `selector`; static analysis resolves it to /api/dbt/{command} only (callers pass 'build' or 'test').
- Models actually built depend on _foil_active() (runtime workspace state) and the selector; foil and fabric_apps model sets are not traced here.

## projects-open (RESOLVED)
Projects open: open a project scenario

| Layer | Location | Symbol | Note |
|---|---|---|---|
| react | `apps/web/src/pages/ProjectsPage.tsx:120-126` | `prepareProject` | Button handler calls onOpenProject |
| react | `apps/web/src/App.tsx:74-84` | `/api/projects/${project.scenario}/open` | openProject posts to the open route |
| react | `apps/web/src/api.ts:13-19` | `postJson` | POST JSON helper wrapping fetch |
| api | `apps/api/app/main.py:53-62` | `def open_project` | POST /api/projects/{scenario}/open |
| service | `apps/api/app/services/projects.py:37-46` | `def open` | Lock, catalog lock, then _open |
| service | `apps/api/app/services/projects.py:65-65` | `self.generator.generate` | Generates parquet for scenario |
| service | `apps/api/app/services/projects.py:76-76` | `load_parquet_to_bronze` | Loads parquet into bronze |
| service | `apps/api/app/services/ducklake.py:138-147` | `def load_parquet_to_bronze` | CREATE OR REPLACE TABLE contoso.bronze.{table} |
| service | `apps/api/app/services/projects.py:79-79` | `self.dbt.run("build")` | dbt build to produce Silver/Gold |
| service | `apps/api/app/services/dbt_runner.py:407-456` | `def run` | dbt subprocess |
| dbt | `dbt/models/gold/monthly_sales.sql:1-12` | `date_trunc` | Gold output of the build |

## apps-architecture-concept (RESOLVED)
Apps / Architecture: concept spec load and download

| Layer | Location | Symbol | Note |
|---|---|---|---|
| react | `apps/web/src/fabricApps/conceptViewer.ts:5-6` | `CONCEPT_URL` | Constant URL /api/fabric-apps/concept and ?download=true |
| react | `apps/web/src/fabricApps/ConceptPanel.tsx:34-34` | `fetch(CONCEPT_URL)` | Panel fetches the concept document |
| api | `apps/api/app/routers/fabric_apps.py:26-34` | `def concept` | GET /api/fabric-apps/concept (download flag sets Content-Disposition) |
| service | `apps/api/app/routers/fabric_apps.py:32-32` | `load_model` | Model loaded from project_root model.json |
| service | `apps/api/app/services/fabric_apps/concept.py:180-181` | `def concept_bytes` | Canonical JSON serialisation of build_concept(model) |

UNRESOLVED:
- Concept content comes from the compiled model file (data); no SQL or Gold field is involved.
- Viewer iframe URL /vendor/concept-viewer/concept-viewer.html is served by vite.config.ts, not traced.

## End-to-end field
`contoso.gold.monthly_sales.revenue` = `round(sum(net_revenue),2)` over `stg_sales`. `net_revenue` there is a decimal(18,2) cast of `contoso.bronze.sales.net_revenue`, which the generator writes as `round(net_revenue_local*exchange_rate_to_usd,2)`.
