# DataPass React consumer traces

Source commit: `5773a8f07624d6a919278a43ed7afa75e9c00068`. Machine-readable twin: `traces.json`. Verify with `python -I docs/datapass-react/check_traces.py`.

Status: RESOLVED = every hop read in code. PARTIAL = chain verified but a hop depends on runtime input (listed as UNRESOLVED).

## charts-kpi-revenue (RESOLVED)
Charts KPIs: Revenue card and monthly revenue chart (Gold monthly_sales.revenue)

| Layer | Location | Symbol | Note |
|---|---|---|---|
| react | `apps/web/src/pages/ChartsPage.tsx:280-289` | `contoso.gold.monthly_sales` | Default (retail-baseline) branch posts two literal SQL strings to /api/query |
| react | `apps/web/src/api.ts:32-38` | `postJson` | POST JSON helper wrapping fetch |
| http | `apps/web/src/pages/ChartsPage.tsx:280-280` | `"/api/query"` | POST /api/query body {sql,limit} |
| api | `apps/api/app/main.py:449-462` | `def query` | FastAPI route POST /api/query -> ducklake.query |
| service | `apps/api/app/services/ducklake.py:305-329` | `def query` | Read-only validation, executes statement on DuckLake read-only connection |
| react | `apps/web/src/pages/ChartsPage.tsx:291-295` | `label:"Revenue"` | rows[0][0] (round(sum(revenue),2)) becomes the Revenue KPI card |
| sql | `apps/web/src/pages/ChartsPage.tsx:281-281` | `sum(revenue)` | select round(sum(revenue),2) revenue ... from contoso.gold.monthly_sales |
| dbt | `dbt/models/gold/monthly_sales.sql:8-8` | `as revenue` | revenue = round(sum(net_revenue),2) grouped by scenario, order_month, channel |
| dbt | `dbt/models/gold/monthly_sales.sql:12-12` | `ref('stg_sales')` | Gold reads Silver |
| dbt | `dbt/models/silver/stg_sales.sql:20-20` | `as net_revenue` | net_revenue = cast(net_revenue as decimal(18,2)) |
| dbt | `dbt/models/silver/stg_sales.sql:23-23` | `source('bronze','sales')` | Silver reads Bronze contoso.bronze.sales |
| service | `apps/api/app/services/ducklake.py:138-147` | `def load_parquet_to_bronze` | Bronze table created from run parquet via read_parquet |
| service | `apps/api/app/services/generator.py:655-655` | `AS net_revenue` | Parquet net_revenue = round(net_revenue_local*exchange_rate_to_usd,2) |
| gold | `dbt/models/gold/monthly_sales.sql:8-8` | `revenue` | FIELD contoso.gold.monthly_sales.revenue |

## query-page (PARTIAL)
Query page: run user SQL

| Layer | Location | Symbol | Note |
|---|---|---|---|
| react | `apps/web/src/pages/QueryPage.tsx:66-70` | `"/api/query"` | run() posts the editor SQL with limit 500 |
| react | `apps/web/src/api.ts:32-38` | `postJson` | POST JSON helper wrapping fetch |
| api | `apps/api/app/main.py:449-462` | `def query` | POST /api/query |
| service | `apps/api/app/services/ducklake.py:305-329` | `def query` | Allows one select/with/show/describe/explain statement; FORBIDDEN_SQL rejects mutation |

UNRESOLVED:
- SQL text is user input (editor state, or ProjectPreset.query from apps/web/src/projects.ts via ProjectsPage): table and column targets cannot be resolved statically. Preset queries in projects.ts are literal and can each be traced separately.
- Result columns are only known at run time from cursor.description.

## lakehouse-catalog (RESOLVED)
Lakehouse catalog: bronze/silver/gold table list

| Layer | Location | Symbol | Note |
|---|---|---|---|
| react | `apps/web/src/pages/LakehousePage.tsx:40-45` | `"/api/lakehouse/catalog"` | load() fetches catalog with snapshots, quality, project state |
| react | `apps/web/src/api.ts:28-30` | `getJson` | GET helper |
| api | `apps/api/app/main.py:266-271` | `def catalog` | GET /api/lakehouse/catalog -> {tables} |
| service | `apps/api/app/services/ducklake.py:153-171` | `def catalog` | Reads the DuckLake SQLite metadata catalog, schemas bronze/silver/gold |
| sql | `apps/api/app/services/ducklake.py:156-165` | `FROM ducklake_table` | Metadata SQL; table names come from the catalog at run time |

UNRESOLVED:
- Names of returned tables are catalog data, not statically known; dbt/models/gold/*.sql and silver/stg_sales.sql define the expected ones.

## transform-dbt-build (PARTIAL)
Transform page: dbt build

| Layer | Location | Symbol | Note |
|---|---|---|---|
| react | `apps/web/src/pages/TransformPage.tsx:118-127` | `/api/dbt/${command}` | execute('build'|'test', selector?) posts to /api/dbt/{command}[?selector=] |
| react | `apps/web/src/api.ts:32-38` | `postJson` | POST JSON helper wrapping fetch |
| api | `apps/api/app/main.py:400-414` | `def dbt_run` | POST /api/dbt/{command} |
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
| react | `apps/web/src/pages/ProjectsPage.tsx:121-127` | `prepareProject` | Button handler calls onOpenProject |
| react | `apps/web/src/App.tsx:88-98` | `/api/projects/${project.scenario}/open` | openProject posts to the open route |
| react | `apps/web/src/api.ts:32-38` | `postJson` | POST JSON helper wrapping fetch |
| api | `apps/api/app/main.py:127-136` | `def open_project` | POST /api/projects/{scenario}/open |
| service | `apps/api/app/services/projects.py:42-51` | `def open` | Lock, catalog lock, then _open |
| service | `apps/api/app/services/projects.py:70-70` | `self.generator.generate` | Generates parquet for scenario |
| service | `apps/api/app/services/projects.py:81-81` | `load_parquet_to_bronze` | Loads parquet into bronze |
| service | `apps/api/app/services/ducklake.py:138-147` | `def load_parquet_to_bronze` | CREATE OR REPLACE TABLE contoso.bronze.{table} |
| service | `apps/api/app/services/projects.py:84-84` | `self.dbt.run("build")` | dbt build to produce Silver/Gold |
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

## charts-export-mosaic (RESOLVED)
Charts export for Mosaic: Gold mart artifact (monthly_sales.revenue, unit USD)

| Layer | Location | Symbol | Note |
|---|---|---|---|
| react | `apps/web/src/components/ExportPanel.tsx:49-54` | `"/api/exports/artifact"` | exportNow() posts {mart}; mart is chosen from gold_tables returned by GET /api/exports |
| react | `apps/web/src/api.ts:32-38` | `postJson` | POST JSON helper wrapping fetch |
| api | `apps/api/app/main.py:470-475` | `def export_artifact` | POST /api/exports/artifact -> exports.export(mart, columns, max_rows) |
| service | `apps/api/app/main.py:38-38` | `ExportService(settings` | exports service bound per workspace in _bind |
| service | `apps/api/app/services/exports.py:162-165` | `def export` | Mart must match _MART and be in gold_tables() (catalog gold schema) |
| sql | `apps/api/app/services/exports.py:183-183` | `DESCRIBE contoso.gold.` | DESCRIBE the Gold mart for column names and types |
| sql | `apps/api/app/services/exports.py:193-194` | `SELECT count(*) FROM contoso.gold.` | Row count then bounded SELECT of columns ORDER BY |
| sql | `apps/api/app/services/exports.py:197-197` | `COPY (SELECT * FROM contoso.gold.` | COPY mart to parquet artifact |
| service | `apps/api/app/services/exports.py:42-44` | `"revenue": "USD"` | UNITS declares unit USD for the revenue column |
| service | `apps/api/app/services/exports.py:220-221` | `column["unit"] = UNITS[name]` | Unit attached to exported column |
| dbt | `dbt/models/gold/monthly_sales.sql:8-8` | `as revenue` | revenue = round(sum(net_revenue),2) |
| dbt | `dbt/models/silver/stg_sales.sql:20-20` | `as net_revenue` | net_revenue is USD-normalised in Silver |
| gold | `dbt/models/gold/monthly_sales.sql:8-8` | `revenue` | FIELD contoso.gold.monthly_sales.revenue, unit USD |

## workspace-switch (RESOLVED)
Workspace switch: activate a named workspace

| Layer | Location | Symbol | Note |
|---|---|---|---|
| react | `apps/web/src/components/WorkspaceSwitcher.tsx:79-85` | `/api/workspaces/${encodeURIComponent(id)}/activate` | activate(id) posts then reloads the page |
| react | `apps/web/src/api.ts:32-38` | `postJson` | POST JSON helper wrapping fetch |
| api | `apps/api/app/main.py:100-102` | `def activate_workspace` | POST /api/workspaces/{workspace_id}/activate -> _switch |
| service | `apps/api/app/main.py:79-97` | `def _switch` | Takes switch lock and catalog lock, then _bind(workspaces.activate(...)) |
| service | `apps/api/app/main.py:27-38` | `def _bind` | Recreates every workspace-scoped service from the new Settings |
| service | `apps/api/app/services/workspaces.py:129-134` | `def activate` | settings_for(id), config.set_active, writes pointer file |
| service | `apps/api/app/config.py:67-74` | `def catalog_path` | Settings.catalog_path = workspace/contoso.ducklake.sqlite (or CONTOSO_DUCKLAKE_CATALOG for the default workspace) |

## End-to-end field
`contoso.gold.monthly_sales.revenue` = `round(sum(net_revenue),2)` over `stg_sales`. `net_revenue` there is a decimal(18,2) cast of `contoso.bronze.sales.net_revenue`, which the generator writes as `round(net_revenue_local*exchange_rate_to_usd,2)`.
