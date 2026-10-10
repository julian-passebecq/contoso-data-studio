# DataPass React consumer traces

Source commit: `f2d0c759b2362b94db0cd73c3a9d901ed4aed9f0` (origin/main the line numbers are checked against). Machine-readable twin: `traces.json`. Verify with `python -I docs/datapass-react/check_traces.py` (add `--head` to read files from git HEAD).

Confidence (DataPass React analyzer vocabulary), on every step:

- **verified**: Hop read in code and literal (fixed string, fixed call, fixed column).
- **inferred**: Hop depends on a runtime branch or a template, but every candidate is enumerated from code.
- **unresolved**: Hop target depends on runtime data or user input that code does not enumerate.

Status: RESOLVED when every step is verified or inferred; PARTIAL when at least one step is unresolved (each such edge is also listed under 'unresolved'). Data notes (catalog contents, file contents) are listed under UNRESOLVED/notes but do not change a hop's confidence.

## Summary

| Trace | Status | verified | inferred | unresolved |
|---|---|---|---|---|
| charts-kpi-revenue | RESOLVED | 12 | 2 | 0 |
| query-page | RESOLVED | 4 | 0 | 0 |
| &nbsp;&nbsp;query-page/preset/retail-baseline | RESOLVED | 17 | 3 | 0 |
| &nbsp;&nbsp;query-page/preset/online-migration | RESOLVED | 16 | 5 | 0 |
| &nbsp;&nbsp;query-page/preset/margin-pressure | RESOLVED | 16 | 6 | 0 |
| &nbsp;&nbsp;query-page/preset/logistics-delays | RESOLVED | 15 | 6 | 0 |
| &nbsp;&nbsp;query-page/preset/currency-exposure | RESOLVED | 17 | 5 | 0 |
| &nbsp;&nbsp;query-page/preset/foil-energy-risk | RESOLVED | 15 | 5 | 0 |
| &nbsp;&nbsp;query-page/preset/foil-investment | RESOLVED | 14 | 6 | 0 |
| &nbsp;&nbsp;query-page/preset/foil-sensitivity | RESOLVED | 14 | 5 | 0 |
| &nbsp;&nbsp;query-page/free-sql | PARTIAL | 3 | 2 | 3 |
| lakehouse-catalog | RESOLVED | 5 | 0 | 0 |
| transform-dbt-build | RESOLVED | 11 | 7 | 0 |
| &nbsp;&nbsp;transform-dbt-build/branch-retail | RESOLVED | 11 | 1 | 0 |
| &nbsp;&nbsp;transform-dbt-build/branch-foil | RESOLVED | 8 | 2 | 0 |
| &nbsp;&nbsp;transform-dbt-build/branch-selector | RESOLVED | 1 | 4 | 0 |
| projects-open | RESOLVED | 8 | 3 | 0 |
| apps-architecture-concept | RESOLVED | 5 | 0 | 0 |
| charts-export-mosaic | RESOLVED | 9 | 4 | 0 |
| workspace-switch | RESOLVED | 6 | 1 | 0 |
| **total** | | 207 | 67 | 3 |

## charts-kpi-revenue (RESOLVED)
Charts KPIs: Revenue card and monthly revenue chart (Gold monthly_sales.revenue)

| Layer | Location | Symbol | Confidence | Note |
|---|---|---|---|---|
| react | `apps/web/src/pages/ChartsPage.tsx:286-295` | `contoso.gold.monthly_sales` | inferred | Default (retail-baseline) branch posts two literal SQL strings to /api/query (Reached only when the active scenario falls through the scenario-specific branches of loadDashboard (candidates: the scenario ids in projects.ts); SQL itself is literal.) |
| react | `apps/web/src/api.ts:32-38` | `postJson` | verified | POST JSON helper wrapping fetch |
| http | `apps/web/src/pages/ChartsPage.tsx:286-286` | `"/api/query"` | verified | POST /api/query body {sql,limit} |
| api | `apps/api/app/main.py:502-515` | `def query` | verified | FastAPI route POST /api/query -> ducklake.query |
| service | `apps/api/app/services/ducklake.py:305-329` | `def query` | verified | Read-only validation, executes statement on DuckLake read-only connection |
| react | `apps/web/src/pages/ChartsPage.tsx:297-301` | `label:"Revenue"` | verified | rows[0][0] (round(sum(revenue),2)) becomes the Revenue KPI card |
| sql | `apps/web/src/pages/ChartsPage.tsx:287-287` | `sum(revenue)` | verified | select round(sum(revenue),2) revenue ... from contoso.gold.monthly_sales |
| dbt | `dbt/models/gold/monthly_sales.sql:8-8` | `as revenue` | verified | revenue = round(sum(net_revenue),2) grouped by scenario, order_month, channel |
| dbt | `dbt/models/gold/monthly_sales.sql:12-12` | `ref('stg_sales')` | verified | Gold reads Silver |
| dbt | `dbt/models/silver/stg_sales.sql:20-20` | `as net_revenue` | verified | net_revenue = cast(net_revenue as decimal(18,2)) |
| dbt | `dbt/models/silver/stg_sales.sql:23-23` | `source('bronze','sales')` | verified | Silver reads Bronze contoso.bronze.sales |
| service | `apps/api/app/services/ducklake.py:138-147` | `def load_parquet_to_bronze` | inferred | Bronze table created from run parquet via read_parquet (Table name is the f-string key of run_files(): one of customer/product/store/currency_exchange/sales for retail runs.) |
| service | `apps/api/app/services/generator.py:655-655` | `AS net_revenue` | verified | Parquet net_revenue = round(net_revenue_local*exchange_rate_to_usd,2) |
| gold | `dbt/models/gold/monthly_sales.sql:8-8` | `revenue` | verified | FIELD contoso.gold.monthly_sales.revenue |

## query-page (RESOLVED)
Query page: run SQL (8 preset sub-traces + free SQL)

| Layer | Location | Symbol | Confidence | Note |
|---|---|---|---|---|
| react | `apps/web/src/pages/QueryPage.tsx:66-70` | `"/api/query"` | verified | run() posts the editor SQL with limit 500 |
| react | `apps/web/src/api.ts:32-38` | `postJson` | verified | POST JSON helper wrapping fetch |
| api | `apps/api/app/main.py:502-515` | `def query` | verified | POST /api/query |
| service | `apps/api/app/services/ducklake.py:305-329` | `def query` | verified | Allows one select/with/show/describe/explain statement; FORBIDDEN_SQL rejects mutation |

UNRESOLVED / notes:
- Free user SQL is traced separately as sub-trace query-page/free-sql (PARTIAL, unresolved edges listed there).

### query-page/preset/retail-baseline (RESOLVED)
Preset 'Retail Sales 101': country revenue and gross margin (gold.store_performance)

Gold fields: `contoso.gold.store_performance.store_country`, `contoso.gold.store_performance.revenue`, `contoso.gold.store_performance.gross_margin`

| Layer | Location | Symbol | Confidence | Note |
|---|---|---|---|---|
| react | `apps/web/src/projects.ts:18-25` | `from contoso.gold.store_performance` | verified | ProjectPreset 'retail-baseline'.query is a literal SQL string |
| react | `apps/web/src/pages/ProjectsPage.tsx:258-258` | `onOpenProject(selected,"Query",selected.query)` | inferred | 'Open this query' opens the project then the Query page with this SQL (The preset is selected by the user among the PROJECTS entries; this step is the same code for each enumerated candidate.) |
| react | `apps/web/src/App.tsx:101-101` | `setQuerySeed(sql ?? project.query)` | inferred | openProject(project,'Query',sql) seeds the editor with the preset query (The preset is selected by the user among the PROJECTS entries; this step is the same code for each enumerated candidate.) |
| react | `apps/web/src/App.tsx:142-142` | `initialSql={querySeed}` | verified | Query page receives the seed |
| react | `apps/web/src/pages/QueryPage.tsx:53-53` | `setSql(initialSql)` | verified | Editor state takes the seed |
| react | `apps/web/src/pages/QueryPage.tsx:70-70` | `"/api/query"` | verified | run() posts {sql,limit:500} |
| react | `apps/web/src/api.ts:32-38` | `postJson` | verified | POST JSON helper wrapping fetch |
| api | `apps/api/app/main.py:502-515` | `def query` | verified | POST /api/query -> ducklake.query |
| service | `apps/api/app/services/ducklake.py:305-329` | `def query` | verified | Read-only validation, executes on the DuckLake read-only connection |
| sql | `apps/web/src/projects.ts:19-22` | `store_country as country` | verified | Columns country, revenue, gross_margin, margin_rate (margin_rate computed in the preset) |
| dbt | `dbt/models/gold/store_performance.sql:5-5` | `s.store_country` | verified | store_country passed through from Silver |
| dbt | `dbt/models/gold/store_performance.sql:9-9` | `as revenue` | verified | revenue = round(sum(net_revenue),2) |
| dbt | `dbt/models/gold/store_performance.sql:10-10` | `as gross_margin` | verified | gross_margin = round(sum(gross_margin),2) |
| dbt | `dbt/models/gold/store_performance.sql:13-14` | `ref('stg_sales')` | verified | Gold reads Silver and joins source bronze.store |
| dbt | `dbt/models/silver/stg_sales.sql:10-10` | `store_country` | verified | Silver store_country |
| dbt | `dbt/models/silver/stg_sales.sql:20-22` | `as gross_margin` | verified | net_revenue cast; gross_margin = net_revenue - total_cost |
| dbt | `dbt/models/silver/stg_sales.sql:23-23` | `source('bronze','sales')` | verified | Silver reads Bronze contoso.bronze.sales |
| service | `apps/api/app/services/ducklake.py:143-147` | `CREATE OR REPLACE TABLE contoso.bronze.{table}` | inferred | Bronze tables created from the run parquet files (f-string on the run_files() keys: customer/product/store/currency_exchange/sales.) |
| service | `apps/api/app/services/generator.py:624-624` | `s.country AS store_country` | verified | Generator: store_country from the store parquet |
| service | `apps/api/app/services/generator.py:655-656` | `AS net_revenue` | verified | net_revenue and total_cost in USD |

### query-page/preset/online-migration (RESOLVED)
Preset 'Online Channel Shift': channel mix per year (gold.channel_performance)

Gold fields: `contoso.gold.channel_performance.order_year`, `contoso.gold.channel_performance.channel`, `contoso.gold.channel_performance.revenue`, `contoso.gold.channel_performance.revenue_share`, `contoso.gold.channel_performance.gross_margin`

| Layer | Location | Symbol | Confidence | Note |
|---|---|---|---|---|
| react | `apps/web/src/projects.ts:34-41` | `from contoso.gold.channel_performance` | verified | ProjectPreset 'online-migration'.query is a literal SQL string |
| react | `apps/web/src/pages/ProjectsPage.tsx:258-258` | `onOpenProject(selected,"Query",selected.query)` | inferred | 'Open this query' opens the project then the Query page with this SQL (The preset is selected by the user among the PROJECTS entries; this step is the same code for each enumerated candidate.) |
| react | `apps/web/src/App.tsx:101-101` | `setQuerySeed(sql ?? project.query)` | inferred | openProject(project,'Query',sql) seeds the editor with the preset query (The preset is selected by the user among the PROJECTS entries; this step is the same code for each enumerated candidate.) |
| react | `apps/web/src/App.tsx:142-142` | `initialSql={querySeed}` | verified | Query page receives the seed |
| react | `apps/web/src/pages/QueryPage.tsx:53-53` | `setSql(initialSql)` | verified | Editor state takes the seed |
| react | `apps/web/src/pages/QueryPage.tsx:70-70` | `"/api/query"` | verified | run() posts {sql,limit:500} |
| react | `apps/web/src/api.ts:32-38` | `postJson` | verified | POST JSON helper wrapping fetch |
| api | `apps/api/app/main.py:502-515` | `def query` | verified | POST /api/query -> ducklake.query |
| service | `apps/api/app/services/ducklake.py:305-329` | `def query` | verified | Read-only validation, executes on the DuckLake read-only connection |
| sql | `apps/web/src/projects.ts:35-39` | `revenue_share` | verified | Columns order_year, channel, revenue, revenue_share, gross_margin |
| dbt | `dbt/models/gold/channel_performance.sql:4-5` | `as order_year` | verified | order_year = year(order_date); channel |
| dbt | `dbt/models/gold/channel_performance.sql:9-10` | `as revenue` | verified | revenue and gross_margin per scenario/year/channel |
| dbt | `dbt/models/gold/channel_performance.sql:24-27` | `as revenue_share` | verified | revenue_share = revenue / yearly total |
| dbt | `dbt/models/gold/channel_performance.sql:11-11` | `ref('stg_sales')` | verified | Gold reads Silver |
| dbt | `dbt/models/silver/stg_sales.sql:12-12` | `channel` | verified | Silver channel |
| dbt | `dbt/models/silver/stg_sales.sql:20-22` | `as gross_margin` | verified | net_revenue, total_cost, gross_margin |
| dbt | `dbt/models/silver/stg_sales.sql:23-23` | `source('bronze','sales')` | verified | Silver reads Bronze contoso.bronze.sales |
| service | `apps/api/app/services/ducklake.py:143-147` | `CREATE OR REPLACE TABLE contoso.bronze.{table}` | inferred | Bronze tables created from the run parquet files (f-string on the run_files() keys: customer/product/store/currency_exchange/sales.) |
| service | `apps/api/app/services/generator.py:490-500` | `if scenario == "online-migration":` | inferred | channel_expr: online share 22% -> 68% in year two for this scenario, 38% otherwise (Runtime branch on the active scenario; each branch is enumerated in code.) |
| service | `apps/api/app/services/generator.py:608-608` | `{channel_expr} AS channel` | inferred | channel column of the sales parquet (Runtime branch on the active scenario; each branch is enumerated in code.) |
| service | `apps/api/app/services/generator.py:655-656` | `AS net_revenue` | verified | net_revenue and total_cost in USD |

### query-page/preset/margin-pressure (RESOLVED)
Preset 'Margin Crisis': yearly margin rate vs discount (gold.monthly_sales)

Gold fields: `contoso.gold.monthly_sales.order_month`, `contoso.gold.monthly_sales.avg_discount_rate`, `contoso.gold.monthly_sales.revenue`, `contoso.gold.monthly_sales.gross_margin`

| Layer | Location | Symbol | Confidence | Note |
|---|---|---|---|---|
| react | `apps/web/src/projects.ts:50-57` | `from contoso.gold.monthly_sales` | verified | ProjectPreset 'margin-pressure'.query is a literal SQL string |
| react | `apps/web/src/pages/ProjectsPage.tsx:258-258` | `onOpenProject(selected,"Query",selected.query)` | inferred | 'Open this query' opens the project then the Query page with this SQL (The preset is selected by the user among the PROJECTS entries; this step is the same code for each enumerated candidate.) |
| react | `apps/web/src/App.tsx:101-101` | `setQuerySeed(sql ?? project.query)` | inferred | openProject(project,'Query',sql) seeds the editor with the preset query (The preset is selected by the user among the PROJECTS entries; this step is the same code for each enumerated candidate.) |
| react | `apps/web/src/App.tsx:142-142` | `initialSql={querySeed}` | verified | Query page receives the seed |
| react | `apps/web/src/pages/QueryPage.tsx:53-53` | `setSql(initialSql)` | verified | Editor state takes the seed |
| react | `apps/web/src/pages/QueryPage.tsx:70-70` | `"/api/query"` | verified | run() posts {sql,limit:500} |
| react | `apps/web/src/api.ts:32-38` | `postJson` | verified | POST JSON helper wrapping fetch |
| api | `apps/api/app/main.py:502-515` | `def query` | verified | POST /api/query -> ducklake.query |
| service | `apps/api/app/services/ducklake.py:305-329` | `def query` | verified | Read-only validation, executes on the DuckLake read-only connection |
| sql | `apps/web/src/projects.ts:51-54` | `avg(avg_discount_rate)` | verified | Columns year, margin_rate, avg_discount_rate, revenue |
| dbt | `dbt/models/gold/monthly_sales.sql:3-3` | `as order_month` | verified | order_month = month of order_date |
| dbt | `dbt/models/gold/monthly_sales.sql:7-8` | `as avg_discount_rate` | verified | avg_discount_rate and revenue |
| dbt | `dbt/models/gold/monthly_sales.sql:10-10` | `as gross_margin` | verified | gross_margin |
| dbt | `dbt/models/gold/monthly_sales.sql:12-12` | `ref('stg_sales')` | verified | Gold reads Silver |
| dbt | `dbt/models/silver/stg_sales.sql:16-16` | `discount_rate` | verified | Silver discount_rate |
| dbt | `dbt/models/silver/stg_sales.sql:20-22` | `as gross_margin` | verified | net_revenue, total_cost, gross_margin |
| dbt | `dbt/models/silver/stg_sales.sql:23-23` | `source('bronze','sales')` | verified | Silver reads Bronze contoso.bronze.sales |
| service | `apps/api/app/services/ducklake.py:143-147` | `CREATE OR REPLACE TABLE contoso.bronze.{table}` | inferred | Bronze tables created from the run parquet files (f-string on the run_files() keys: customer/product/store/currency_exchange/sales.) |
| service | `apps/api/app/services/generator.py:502-513` | `if scenario == "margin-pressure":` | inferred | discount_expr and cost_multiplier_expr: heavier discount and +20% cost in year two for this scenario (Runtime branch on the active scenario; each branch is enumerated in code.) |
| service | `apps/api/app/services/generator.py:609-609` | `{discount_expr} AS discount_rate` | inferred | discount_rate column (Runtime branch on the active scenario; each branch is enumerated in code.) |
| service | `apps/api/app/services/generator.py:623-623` | `o.cost_multiplier` | inferred | unit_cost scaled by the cost multiplier (Runtime branch on the active scenario; each branch is enumerated in code.) |
| service | `apps/api/app/services/generator.py:655-656` | `AS total_cost` | verified | net_revenue and total_cost in USD |

### query-page/preset/logistics-delays (RESOLVED)
Preset 'Logistics SLA Investigation': delivery days per channel (gold.delivery_metrics)

Gold fields: `contoso.gold.delivery_metrics.channel`, `contoso.gold.delivery_metrics.avg_delivery_days`, `contoso.gold.delivery_metrics.p90_delivery_days`, `contoso.gold.delivery_metrics.over_7_day_rate`

| Layer | Location | Symbol | Confidence | Note |
|---|---|---|---|---|
| react | `apps/web/src/projects.ts:66-73` | `from contoso.gold.delivery_metrics` | verified | ProjectPreset 'logistics-delays'.query is a literal SQL string |
| react | `apps/web/src/pages/ProjectsPage.tsx:258-258` | `onOpenProject(selected,"Query",selected.query)` | inferred | 'Open this query' opens the project then the Query page with this SQL (The preset is selected by the user among the PROJECTS entries; this step is the same code for each enumerated candidate.) |
| react | `apps/web/src/App.tsx:101-101` | `setQuerySeed(sql ?? project.query)` | inferred | openProject(project,'Query',sql) seeds the editor with the preset query (The preset is selected by the user among the PROJECTS entries; this step is the same code for each enumerated candidate.) |
| react | `apps/web/src/App.tsx:142-142` | `initialSql={querySeed}` | verified | Query page receives the seed |
| react | `apps/web/src/pages/QueryPage.tsx:53-53` | `setSql(initialSql)` | verified | Editor state takes the seed |
| react | `apps/web/src/pages/QueryPage.tsx:70-70` | `"/api/query"` | verified | run() posts {sql,limit:500} |
| react | `apps/web/src/api.ts:32-38` | `postJson` | verified | POST JSON helper wrapping fetch |
| api | `apps/api/app/main.py:502-515` | `def query` | verified | POST /api/query -> ducklake.query |
| service | `apps/api/app/services/ducklake.py:305-329` | `def query` | verified | Read-only validation, executes on the DuckLake read-only connection |
| sql | `apps/web/src/projects.ts:67-70` | `avg(p90_delivery_days)` | verified | Columns channel, avg_delivery_days, p90_delivery_days, over_7_day_rate |
| dbt | `dbt/models/gold/delivery_metrics.sql:4-4` | `channel` | verified | channel |
| dbt | `dbt/models/gold/delivery_metrics.sql:6-7` | `as p90_delivery_days` | verified | avg_delivery_days and quantile_cont(delivery_days,0.90) |
| dbt | `dbt/models/gold/delivery_metrics.sql:9-12` | `as over_7_day_rate` | verified | share of lines with delivery_days > 7 |
| dbt | `dbt/models/gold/delivery_metrics.sql:13-13` | `ref('stg_sales')` | verified | Gold reads Silver |
| dbt | `dbt/models/silver/stg_sales.sql:6-6` | `delivery_days` | verified | Silver delivery_days |
| dbt | `dbt/models/silver/stg_sales.sql:12-12` | `channel` | verified | Silver channel |
| dbt | `dbt/models/silver/stg_sales.sql:23-23` | `source('bronze','sales')` | verified | Silver reads Bronze contoso.bronze.sales |
| service | `apps/api/app/services/ducklake.py:143-147` | `CREATE OR REPLACE TABLE contoso.bronze.{table}` | inferred | Bronze tables created from the run parquet files (f-string on the run_files() keys: customer/product/store/currency_exchange/sales.) |
| service | `apps/api/app/services/generator.py:515-521` | `if scenario == "logistics-delays":` | inferred | delivery_expr: Online 5-20 days for this scenario, 1-6 days otherwise (Runtime branch on the active scenario; each branch is enumerated in code.) |
| service | `apps/api/app/services/generator.py:615-615` | `AS delivery_days` | inferred | delivery_days column (Runtime branch on the active scenario; each branch is enumerated in code.) |
| service | `apps/api/app/services/generator.py:608-608` | `{channel_expr} AS channel` | inferred | channel column (Runtime branch on the active scenario; each branch is enumerated in code.) |

### query-page/preset/currency-exposure (RESOLVED)
Preset 'FX Exposure': exchange-rate spread per currency (gold.currency_exposure)

Gold fields: `contoso.gold.currency_exposure.currency`, `contoso.gold.currency_exposure.avg_exchange_rate_to_usd`, `contoso.gold.currency_exposure.revenue_usd`

| Layer | Location | Symbol | Confidence | Note |
|---|---|---|---|---|
| react | `apps/web/src/projects.ts:82-90` | `from contoso.gold.currency_exposure` | verified | ProjectPreset 'currency-exposure'.query is a literal SQL string |
| react | `apps/web/src/pages/ProjectsPage.tsx:258-258` | `onOpenProject(selected,"Query",selected.query)` | inferred | 'Open this query' opens the project then the Query page with this SQL (The preset is selected by the user among the PROJECTS entries; this step is the same code for each enumerated candidate.) |
| react | `apps/web/src/App.tsx:101-101` | `setQuerySeed(sql ?? project.query)` | inferred | openProject(project,'Query',sql) seeds the editor with the preset query (The preset is selected by the user among the PROJECTS entries; this step is the same code for each enumerated candidate.) |
| react | `apps/web/src/App.tsx:142-142` | `initialSql={querySeed}` | verified | Query page receives the seed |
| react | `apps/web/src/pages/QueryPage.tsx:53-53` | `setSql(initialSql)` | verified | Editor state takes the seed |
| react | `apps/web/src/pages/QueryPage.tsx:70-70` | `"/api/query"` | verified | run() posts {sql,limit:500} |
| react | `apps/web/src/api.ts:32-38` | `postJson` | verified | POST JSON helper wrapping fetch |
| api | `apps/api/app/main.py:502-515` | `def query` | verified | POST /api/query -> ducklake.query |
| service | `apps/api/app/services/ducklake.py:305-329` | `def query` | verified | Read-only validation, executes on the DuckLake read-only connection |
| sql | `apps/web/src/projects.ts:83-87` | `sum(revenue_usd)` | verified | Columns currency, min_rate, max_rate, rate_spread, revenue_usd |
| dbt | `dbt/models/gold/currency_exposure.sql:5-6` | `as avg_exchange_rate_to_usd` | verified | currency and monthly average rate |
| dbt | `dbt/models/gold/currency_exposure.sql:8-8` | `as revenue_usd` | verified | revenue_usd = round(sum(net_revenue),2) |
| dbt | `dbt/models/gold/currency_exposure.sql:10-10` | `ref('stg_sales')` | verified | Gold reads Silver |
| dbt | `dbt/models/silver/stg_sales.sql:11-11` | `currency` | verified | Silver currency |
| dbt | `dbt/models/silver/stg_sales.sql:17-17` | `exchange_rate_to_usd` | verified | Silver exchange_rate_to_usd |
| dbt | `dbt/models/silver/stg_sales.sql:20-20` | `as net_revenue` | verified | net_revenue (USD) |
| dbt | `dbt/models/silver/stg_sales.sql:23-23` | `source('bronze','sales')` | verified | Silver reads Bronze contoso.bronze.sales |
| service | `apps/api/app/services/ducklake.py:143-147` | `CREATE OR REPLACE TABLE contoso.bronze.{table}` | inferred | Bronze tables created from the run parquet files (f-string on the run_files() keys: customer/product/store/currency_exchange/sales.) |
| service | `apps/api/app/services/generator.py:523-530` | `if scenario == "currency-exposure":` | inferred | fx_expr: wider monthly rate band for this scenario (Runtime branch on the active scenario; each branch is enumerated in code.) |
| service | `apps/api/app/services/generator.py:587-587` | `AS exchange_rate_to_usd` | inferred | currency_exchange parquet rate (Runtime branch on the active scenario; each branch is enumerated in code.) |
| service | `apps/api/app/services/generator.py:625-626` | `fx.exchange_rate_to_usd` | verified | sales gets store currency and the monthly rate |
| service | `apps/api/app/services/generator.py:655-655` | `AS net_revenue` | verified | net_revenue = net_revenue_local * exchange_rate_to_usd |

### query-page/preset/foil-energy-risk (RESOLVED)
Preset 'FOIL AEP & P50/P90' (gold.foil_energy_risk)

Gold fields: `contoso.gold.foil_energy_risk.draw_count`, `contoso.gold.foil_energy_risk.aep_p50_mwh`, `contoso.gold.foil_energy_risk.aep_p90_mwh`, `contoso.gold.foil_energy_risk.aep_p10_mwh`

| Layer | Location | Symbol | Confidence | Note |
|---|---|---|---|---|
| react | `apps/web/src/projects.ts:97-97` | `contoso.gold.foil_energy_risk` | verified | ProjectPreset 'foil-energy-risk'.query is a literal SQL string |
| react | `apps/web/src/pages/ProjectsPage.tsx:258-258` | `onOpenProject(selected,"Query",selected.query)` | inferred | Open this query (The preset is selected by the user among the PROJECTS entries; this step is the same code for each enumerated candidate.) |
| react | `apps/web/src/App.tsx:101-101` | `setQuerySeed(sql ?? project.query)` | inferred | openProject(project,'Query',sql) seeds the editor with the preset query (The preset is selected by the user among the PROJECTS entries; this step is the same code for each enumerated candidate.) |
| react | `apps/web/src/App.tsx:142-142` | `initialSql={querySeed}` | verified | Query page receives the seed |
| react | `apps/web/src/pages/QueryPage.tsx:53-53` | `setSql(initialSql)` | verified | Editor state takes the seed |
| react | `apps/web/src/pages/QueryPage.tsx:70-70` | `"/api/query"` | verified | run() posts {sql,limit:500} |
| react | `apps/web/src/api.ts:32-38` | `postJson` | verified | POST JSON helper wrapping fetch |
| api | `apps/api/app/main.py:502-515` | `def query` | verified | POST /api/query -> ducklake.query |
| service | `apps/api/app/services/ducklake.py:305-329` | `def query` | verified | Read-only validation, executes on the DuckLake read-only connection |
| dbt | `dbt/models/foil/gold/foil_energy_risk.sql:2-6` | `as aep_p90_mwh` | verified | draw_count, aep_p50 (0.5), aep_p90 (0.1 quantile), aep_p10 (0.9 quantile) |
| dbt | `dbt/models/foil/gold/foil_energy_risk.sql:13-14` | `ref('foil_experiment_metrics')` | verified | monte_carlo samples only |
| dbt | `dbt/models/foil/gold/foil_experiment_metrics.sql:3-3` | `aep_year1_mwh` | verified | aep_year1_mwh passed through |
| dbt | `dbt/models/foil/gold/foil_experiment_metrics.sql:9-9` | `ref('foil_cashflows')` | verified | metrics read Silver cashflows |
| dbt | `dbt/models/foil/silver/foil_cashflows.sql:10-10` | `ref('foil_experiments')` | verified | cashflows read Silver experiments |
| dbt | `dbt/models/foil/silver/foil_experiments.sql:3-6` | `source('foil', 'foil_trials')` | verified | monte_carlo arm from bronze.foil_trials |
| service | `apps/api/app/services/foil.py:45-45` | `'aep_year1_mwh'` | verified | trial aep_year1_mwh from reference AEP x resource x availability |
| dbt | `dbt/models/foil/sources.yml:3-7` | `var('foil_enabled', false)` | inferred | foil sources (schema bronze) exist only when the runner passes foil_enabled (Runtime branch on the active scenario; each branch is enumerated in code.) |
| service | `apps/api/app/services/ducklake.py:143-147` | `CREATE OR REPLACE TABLE contoso.bronze.{table}` | inferred | Bronze tables from FOIL_FILES parquet (f-string on FOIL_FILES keys.) |
| service | `apps/api/app/services/foil.py:14-14` | `FOIL_FILES` | verified | foil_cases, foil_trials, foil_sensitivity |
| service | `apps/api/app/services/generator.py:465-466` | `generate_foil` | inferred | Generator takes the FOIL branch for foil-* scenarios (Runtime branch on the active scenario; each branch is enumerated in code.) |

### query-page/preset/foil-investment (RESOLVED)
Preset 'FOIL LCOE & Investment' (gold.foil_project_summary)

Gold fields: `contoso.gold.foil_project_summary.capex_eur`, `contoso.gold.foil_project_summary.opex_eur_year`, `contoso.gold.foil_project_summary.lcoe_eur_mwh`, `contoso.gold.foil_project_summary.npv_eur`, `contoso.gold.foil_project_summary.break_even_price_eur_mwh`, `contoso.gold.foil_project_summary.positive_npv_probability`

| Layer | Location | Symbol | Confidence | Note |
|---|---|---|---|---|
| react | `apps/web/src/projects.ts:104-104` | `contoso.gold.foil_project_summary` | verified | ProjectPreset 'foil-investment'.query is a literal SQL string |
| react | `apps/web/src/pages/ProjectsPage.tsx:258-258` | `onOpenProject(selected,"Query",selected.query)` | inferred | Open this query (The preset is selected by the user among the PROJECTS entries; this step is the same code for each enumerated candidate.) |
| react | `apps/web/src/App.tsx:101-101` | `setQuerySeed(sql ?? project.query)` | inferred | openProject(project,'Query',sql) seeds the editor with the preset query (The preset is selected by the user among the PROJECTS entries; this step is the same code for each enumerated candidate.) |
| react | `apps/web/src/App.tsx:142-142` | `initialSql={querySeed}` | verified | Query page receives the seed |
| react | `apps/web/src/pages/QueryPage.tsx:53-53` | `setSql(initialSql)` | verified | Editor state takes the seed |
| react | `apps/web/src/pages/QueryPage.tsx:70-70` | `"/api/query"` | verified | run() posts {sql,limit:500} |
| react | `apps/web/src/api.ts:32-38` | `postJson` | verified | POST JSON helper wrapping fetch |
| api | `apps/api/app/main.py:502-515` | `def query` | verified | POST /api/query -> ducklake.query |
| service | `apps/api/app/services/ducklake.py:305-329` | `def query` | verified | Read-only validation, executes on the DuckLake read-only connection |
| dbt | `dbt/models/foil/gold/foil_project_summary.sql:3-5` | `as break_even_price_eur_mwh` | verified | capex, opex, npv, lcoe and break_even = lcoe from reference experiments |
| dbt | `dbt/models/foil/gold/foil_project_summary.sql:7-7` | `r.positive_npv_probability` | verified | positive_npv_probability from foil_energy_risk |
| dbt | `dbt/models/foil/gold/foil_project_summary.sql:10-13` | `ref('foil_experiment_metrics')` | verified | reads metrics (reference), energy risk and source foil_cases |
| dbt | `dbt/models/foil/gold/foil_experiment_metrics.sql:7-8` | `as lcoe_eur_mwh` | verified | npv_eur and lcoe_eur_mwh as discounted sums |
| dbt | `dbt/models/foil/silver/foil_cashflows.sql:13-15` | `as net_cashflow_eur` | verified | annual revenue, cost and net cashflow |
| dbt | `dbt/models/foil/silver/foil_experiments.sql:8-10` | `source('foil', 'foil_cases')` | verified | reference arm from bronze.foil_cases |
| service | `apps/api/app/services/foil.py:31-36` | `1.3 if stress` | inferred | foil-investment stresses CAPEX x1.3 and OPEX x1.2 (scenario branch) (Runtime branch on the active scenario; each branch is enumerated in code.) |
| dbt | `dbt/models/foil/sources.yml:3-7` | `var('foil_enabled', false)` | inferred | foil sources (schema bronze) exist only when the runner passes foil_enabled (Runtime branch on the active scenario; each branch is enumerated in code.) |
| service | `apps/api/app/services/ducklake.py:143-147` | `CREATE OR REPLACE TABLE contoso.bronze.{table}` | inferred | Bronze tables from FOIL_FILES parquet (f-string on FOIL_FILES keys.) |
| service | `apps/api/app/services/foil.py:14-14` | `FOIL_FILES` | verified | foil_cases, foil_trials, foil_sensitivity |
| service | `apps/api/app/services/generator.py:465-466` | `generate_foil` | inferred | Generator takes the FOIL branch for foil-* scenarios (Runtime branch on the active scenario; each branch is enumerated in code.) |

### query-page/preset/foil-sensitivity (RESOLVED)
Preset 'FOIL Sensitivity Lab' (gold.foil_sensitivity)

Gold fields: `contoso.gold.foil_sensitivity.driver`, `contoso.gold.foil_sensitivity.relative_change`, `contoso.gold.foil_sensitivity.npv_eur`, `contoso.gold.foil_sensitivity.npv_delta_eur`, `contoso.gold.foil_sensitivity.lcoe_delta_eur_mwh`

| Layer | Location | Symbol | Confidence | Note |
|---|---|---|---|---|
| react | `apps/web/src/projects.ts:111-111` | `contoso.gold.foil_sensitivity` | verified | ProjectPreset 'foil-sensitivity'.query, filtered on case_id FOIL-WIND-A-N-R0 |
| react | `apps/web/src/pages/ProjectsPage.tsx:258-258` | `onOpenProject(selected,"Query",selected.query)` | inferred | Open this query (The preset is selected by the user among the PROJECTS entries; this step is the same code for each enumerated candidate.) |
| react | `apps/web/src/App.tsx:101-101` | `setQuerySeed(sql ?? project.query)` | inferred | openProject(project,'Query',sql) seeds the editor with the preset query (The preset is selected by the user among the PROJECTS entries; this step is the same code for each enumerated candidate.) |
| react | `apps/web/src/App.tsx:142-142` | `initialSql={querySeed}` | verified | Query page receives the seed |
| react | `apps/web/src/pages/QueryPage.tsx:53-53` | `setSql(initialSql)` | verified | Editor state takes the seed |
| react | `apps/web/src/pages/QueryPage.tsx:70-70` | `"/api/query"` | verified | run() posts {sql,limit:500} |
| react | `apps/web/src/api.ts:32-38` | `postJson` | verified | POST JSON helper wrapping fetch |
| api | `apps/api/app/main.py:502-515` | `def query` | verified | POST /api/query -> ducklake.query |
| service | `apps/api/app/services/ducklake.py:305-329` | `def query` | verified | Read-only validation, executes on the DuckLake read-only connection |
| dbt | `dbt/models/foil/gold/foil_sensitivity.sql:2-4` | `as npv_delta_eur` | verified | driver, relative_change, npv_delta and lcoe_delta vs the reference experiment |
| dbt | `dbt/models/foil/gold/foil_sensitivity.sql:5-7` | `ref('foil_experiment_metrics')` | verified | sensitivity rows joined to reference rows |
| dbt | `dbt/models/foil/silver/foil_cashflows.sql:10-10` | `ref('foil_experiments')` | verified | cashflows read Silver experiments |
| dbt | `dbt/models/foil/silver/foil_experiments.sql:12-15` | `source('foil', 'foil_sensitivity')` | verified | sensitivity arm from bronze.foil_sensitivity |
| service | `apps/api/app/services/foil.py:51-59` | `for driver in` | verified | five drivers x {-0.2, 0, +0.2} per case |
| data | `data/foil/reference_cases.json:44-44` | `FOIL-WIND-A-N-R0` | verified | case_id literal of the preset filter exists in the committed reference cases |
| dbt | `dbt/models/foil/sources.yml:3-7` | `var('foil_enabled', false)` | inferred | foil sources (schema bronze) exist only when the runner passes foil_enabled (Runtime branch on the active scenario; each branch is enumerated in code.) |
| service | `apps/api/app/services/ducklake.py:143-147` | `CREATE OR REPLACE TABLE contoso.bronze.{table}` | inferred | Bronze tables from FOIL_FILES parquet (f-string on FOIL_FILES keys.) |
| service | `apps/api/app/services/foil.py:14-14` | `FOIL_FILES` | verified | foil_cases, foil_trials, foil_sensitivity |
| service | `apps/api/app/services/generator.py:465-466` | `generate_foil` | inferred | Generator takes the FOIL branch for foil-* scenarios (Runtime branch on the active scenario; each branch is enumerated in code.) |

### query-page/free-sql (PARTIAL)
Free SQL typed or edited in the Query editor

| Layer | Location | Symbol | Confidence | Note |
|---|---|---|---|---|
| react | `apps/web/src/pages/QueryPage.tsx:137-137` | `setSql(event.target.value)` | unresolved | Editor text is user input |
| react | `apps/web/src/pages/QueryPage.tsx:122-122` | `setSql(example.sql)` | inferred | Example buttons: EXAMPLES or FOIL_EXAMPLES literals (Candidates are the literal EXAMPLES / FOIL_EXAMPLES in QueryPage.tsx:12-31.) |
| react | `apps/web/src/pages/QueryPage.tsx:94-94` | `from contoso.${table.schema}.${table.name}` | inferred | Catalog click seeds select * from a catalog table (schema is bronze/silver/gold; names are catalog tables produced by the generator and the dbt models.) |
| react | `apps/web/src/pages/QueryPage.tsx:169-169` | `setSql(item.sql)` | unresolved | History entries replay earlier SQL from localStorage |
| react | `apps/web/src/pages/QueryPage.tsx:70-70` | `"/api/query"` | verified | run() posts {sql,limit:500} |
| api | `apps/api/app/main.py:502-515` | `def query` | verified | POST /api/query |
| service | `apps/api/app/services/ducklake.py:315-319` | `FORBIDDEN_SQL` | verified | Only one read-only statement; mutation rejected |
| service | `apps/api/app/services/ducklake.py:323-323` | `cur.description` | unresolved | Result columns known only at run time |

UNRESOLVED / notes:
- UNRESOLVED edge QueryPage.tsx:137: free SQL typed by the user; target tables and columns cannot be resolved statically (the server policy at ducklake.py:315-319 bounds it to one read-only statement).
- UNRESOLVED edge QueryPage.tsx:169: query history replays SQL from browser storage (earlier user input).
- UNRESOLVED edge ducklake.py:323: result columns come from cursor.description at run time.

## lakehouse-catalog (RESOLVED)
Lakehouse catalog: bronze/silver/gold table list

| Layer | Location | Symbol | Confidence | Note |
|---|---|---|---|---|
| react | `apps/web/src/pages/LakehousePage.tsx:40-45` | `"/api/lakehouse/catalog"` | verified | load() fetches catalog with snapshots, quality, project state |
| react | `apps/web/src/api.ts:28-30` | `getJson` | verified | GET helper |
| api | `apps/api/app/main.py:319-324` | `def catalog` | verified | GET /api/lakehouse/catalog -> {tables} |
| service | `apps/api/app/services/ducklake.py:153-171` | `def catalog` | verified | Reads the DuckLake SQLite metadata catalog, schemas bronze/silver/gold |
| sql | `apps/api/app/services/ducklake.py:156-165` | `FROM ducklake_table` | verified | Metadata SQL; table names come from the catalog at run time |

UNRESOLVED / notes:
- Names of returned tables are catalog data, not statically known; dbt/models/gold/*.sql and silver/stg_sales.sql define the expected ones.

## transform-dbt-build (RESOLVED)
Transform page: dbt build/test (callers, route, runner branch, models built)

| Layer | Location | Symbol | Confidence | Note |
|---|---|---|---|---|
| react | `apps/web/src/pages/TransformPage.tsx:237-237` | `execute("test")` | verified | Test button: whole project |
| react | `apps/web/src/pages/TransformPage.tsx:238-238` | `execute("build")` | verified | Build button: whole project |
| react | `apps/web/src/pages/TransformPage.tsx:299-299` | `execute("test",nodeDetail.name)` | inferred | Test model button: selector = selected node name (nodeDetail.name comes from GET /api/dbt/node (manifest); the server accepts it only if it equals one model of _models().) |
| react | `apps/web/src/pages/TransformPage.tsx:305-305` | `execute("build",nodeDetail.name)` | inferred | Build model button: selector = selected node name (nodeDetail.name comes from GET /api/dbt/node (manifest); the server accepts it only if it equals one model of _models().) |
| react | `apps/web/src/pages/TransformPage.tsx:118-123` | `/api/dbt/${command}${suffix}` | inferred | Template URL: command in {build,test}, optional ?selector= (command is typed "build"/"test" and the two callers pass literals; selector candidates are the model names (see branch-selector).) |
| react | `apps/web/src/api.ts:32-38` | `postJson` | verified | POST JSON helper wrapping fetch |
| api | `apps/api/app/main.py:452-452` | `@app.post("/api/dbt/{command}")` | verified | FastAPI route POST /api/dbt/{command} |
| api | `apps/api/app/main.py:453-458` | `dbt.run(command, selector)` | verified | selector query param 1..200 chars; ValueError -> 400, RuntimeError -> 409 |
| service | `apps/api/app/services/dbt_runner.py:407-409` | `def run` | verified | Takes the catalog lock then _run |
| service | `apps/api/app/services/dbt_runner.py:411-413` | `ALLOWED_COMMANDS` | verified | command must be build/run/test/parse |
| service | `apps/api/app/services/dbt_runner.py:13-13` | `ALLOWED_COMMANDS` | verified | build/run/test/parse |
| service | `apps/api/app/services/dbt_runner.py:420-428` | `"--project-dir"` | verified | dbt <command> --project-dir dbt --profiles-dir dbt |
| service | `apps/api/app/services/dbt_runner.py:24-27` | `def _foil_active` | inferred | Branch flag: active generator run scenario starts with foil- (Runtime workspace state; two outcomes (FOIL scenario or retail scenario), both enumerated.) |
| service | `apps/api/app/services/dbt_runner.py:430-433` | `path:models/foil` | inferred | FOIL branch: --vars foil_enabled, --select path:models/foil when no selector (Taken only when _foil_active() is true.) |
| service | `apps/api/app/services/dbt_runner.py:434-438` | `_validate_model_selector` | inferred | Selector branch: --select <model> (Taken only when a selector is given; candidates enumerated by _models().) |
| service | `apps/api/app/services/dbt_runner.py:394-405` | `def _validate_model_selector` | verified | Selector must equal exactly one model name of _models() |
| service | `apps/api/app/services/dbt_runner.py:29-45` | `def _models` | inferred | Model list = *.sql under dbt/models, foil folder only in the FOIL branch (Filter depends on _foil_active(); both model lists are enumerated in the sub-traces.) |
| service | `apps/api/app/services/dbt_runner.py:440-448` | `subprocess.run(` | verified | dbt subprocess, timeout 300 s |

### transform-dbt-build/branch-retail (RESOLVED)
Retail branch (_foil_active() false, no selector): models built

Models built: `silver.stg_sales`, `gold.channel_performance`, `gold.currency_exposure`, `gold.delivery_metrics`, `gold.monthly_sales`, `gold.monthly_sales_by_country`, `gold.product_performance`, `gold.store_performance`

| Layer | Location | Symbol | Confidence | Note |
|---|---|---|---|---|
| service | `apps/api/app/services/dbt_runner.py:430-430` | `if self._foil_active():` | inferred | Condition false: no --vars, no --select, dbt builds every enabled model (Runtime branch on the active run scenario; this sub-trace is the non-FOIL outcome.) |
| dbt | `dbt/dbt_project.yml:9-14` | `+schema: gold` | verified | silver and gold folders materialize as tables in schemas silver and gold |
| dbt | `dbt/models/silver/stg_sales.sql:23-23` | `source('bronze','sales')` | verified | silver.stg_sales |
| dbt | `dbt/models/gold/channel_performance.sql:11-11` | `ref('stg_sales')` | verified | gold.channel_performance |
| dbt | `dbt/models/gold/currency_exposure.sql:10-10` | `ref('stg_sales')` | verified | gold.currency_exposure |
| dbt | `dbt/models/gold/delivery_metrics.sql:13-13` | `ref('stg_sales')` | verified | gold.delivery_metrics |
| dbt | `dbt/models/gold/monthly_sales.sql:12-12` | `ref('stg_sales')` | verified | gold.monthly_sales |
| dbt | `dbt/models/gold/monthly_sales_by_country.sql:8-8` | `ref('stg_sales')` | verified | gold.monthly_sales_by_country |
| dbt | `dbt/models/gold/product_performance.sql:11-12` | `ref('stg_sales')` | verified | gold.product_performance (joins bronze.product) |
| dbt | `dbt/models/gold/store_performance.sql:13-14` | `ref('stg_sales')` | verified | gold.store_performance (joins bronze.store) |
| dbt | `dbt/models/foil/gold/foil_energy_risk.sql:1-1` | `var('foil_enabled', false)` | verified | FOIL models disabled (var default false) |
| dbt | `dbt/models/fabric_apps/gold/schema.yml:7-7` | `var('fabric_apps_enabled', false)` | verified | fabric_apps forecast_vs_actual disabled; only the Fabric mirror (fabric_apps/mirror.py) enables it |

### transform-dbt-build/branch-foil (RESOLVED)
FOIL branch (_foil_active() true, no selector): models built

Models built: `silver.foil_experiments`, `silver.foil_cashflows`, `gold.foil_experiment_metrics`, `gold.foil_energy_risk`, `gold.foil_project_summary`, `gold.foil_sensitivity`, `gold.foil_cashflow_schedule`

Retail Silver/Gold models are not rebuilt in this branch (path selector); they keep their last materialization.

| Layer | Location | Symbol | Confidence | Note |
|---|---|---|---|---|
| service | `apps/api/app/services/dbt_runner.py:431-431` | `foil_enabled` | inferred | --vars {"foil_enabled": true} (Runtime branch on the active run scenario; this sub-trace is the FOIL outcome.) |
| service | `apps/api/app/services/dbt_runner.py:432-433` | `--select` | inferred | --select path:models/foil (not for parse, not with a selector) (Runtime branch on the active run scenario; this sub-trace is the FOIL outcome.) |
| dbt | `dbt/models/foil/sources.yml:3-7` | `var('foil_enabled', false)` | verified | foil sources enabled by the var |
| dbt | `dbt/models/foil/silver/foil_experiments.sql:6-6` | `source('foil', 'foil_trials')` | verified | silver.foil_experiments |
| dbt | `dbt/models/foil/silver/foil_cashflows.sql:10-10` | `ref('foil_experiments')` | verified | silver.foil_cashflows |
| dbt | `dbt/models/foil/gold/foil_experiment_metrics.sql:9-9` | `ref('foil_cashflows')` | verified | gold.foil_experiment_metrics |
| dbt | `dbt/models/foil/gold/foil_energy_risk.sql:13-13` | `ref('foil_experiment_metrics')` | verified | gold.foil_energy_risk |
| dbt | `dbt/models/foil/gold/foil_project_summary.sql:10-12` | `ref('foil_energy_risk')` | verified | gold.foil_project_summary |
| dbt | `dbt/models/foil/gold/foil_sensitivity.sql:5-6` | `ref('foil_experiment_metrics')` | verified | gold.foil_sensitivity |
| dbt | `dbt/models/foil/gold/foil_cashflow_schedule.sql:5-5` | `ref('foil_cashflows')` | verified | gold.foil_cashflow_schedule |

### transform-dbt-build/branch-selector (RESOLVED)
Selector branch (Build model / Test model): one model

Models built: `one of the models listed in branch-retail or branch-foil (plus fabric_apps.forecast_vs_actual, which is accepted by the validator in the retail branch but stays disabled without fabric_apps_enabled, so dbt selects nothing)`

| Layer | Location | Symbol | Confidence | Note |
|---|---|---|---|---|
| react | `apps/web/src/pages/TransformPage.tsx:299-305` | `nodeDetail.name` | inferred | Selected DAG node name (Selector is a runtime value restricted to the model names enumerated by _models() for the active branch.) |
| service | `apps/api/app/services/dbt_runner.py:164-164` | `_layer_for_dependency` | inferred | node_detail name comes from the dbt manifest (Selector is a runtime value restricted to the model names enumerated by _models() for the active branch.) |
| service | `apps/api/app/services/dbt_runner.py:434-438` | `args.extend(["--select", selected_model])` | inferred | --select <model> for build/run/test; parse rejects a selector (Selector is a runtime value restricted to the model names enumerated by _models() for the active branch.) |
| service | `apps/api/app/services/dbt_runner.py:398-404` | `Unknown dbt model selector` | verified | Exactly one model of _models() must match, else HTTP 400 |
| service | `apps/api/app/services/dbt_runner.py:37-38` | `("foil" in relative.parts) != foil_active` | inferred | Candidates: retail models (incl. fabric_apps) or foil models, by branch (Selector is a runtime value restricted to the model names enumerated by _models() for the active branch.) |

## projects-open (RESOLVED)
Projects open: open a project scenario

| Layer | Location | Symbol | Confidence | Note |
|---|---|---|---|---|
| react | `apps/web/src/pages/ProjectsPage.tsx:121-127` | `prepareProject` | verified | Button handler calls onOpenProject |
| react | `apps/web/src/App.tsx:88-98` | `/api/projects/${project.scenario}/open` | inferred | openProject posts to the open route (Template URL; project.scenario is one of the PROJECTS entries in apps/web/src/projects.ts, so the route POST /api/projects/{scenario}/open is unique.) |
| react | `apps/web/src/api.ts:32-38` | `postJson` | verified | POST JSON helper wrapping fetch |
| api | `apps/api/app/main.py:180-189` | `def open_project` | verified | POST /api/projects/{scenario}/open |
| service | `apps/api/app/services/projects.py:42-51` | `def open` | verified | Lock, catalog lock, then _open |
| service | `apps/api/app/services/projects.py:70-70` | `self.generator.generate` | verified | Generates parquet for scenario |
| service | `apps/api/app/services/projects.py:81-81` | `load_parquet_to_bronze` | verified | Loads parquet into bronze |
| service | `apps/api/app/services/ducklake.py:138-147` | `def load_parquet_to_bronze` | inferred | CREATE OR REPLACE TABLE contoso.bronze.{table} (Table name is the f-string key of run_files(): retail tables or FOIL_FILES depending on the scenario.) |
| service | `apps/api/app/services/projects.py:84-84` | `self.dbt.run("build")` | verified | dbt build to produce Silver/Gold |
| service | `apps/api/app/services/dbt_runner.py:407-456` | `def run` | verified | dbt subprocess |
| dbt | `dbt/models/gold/monthly_sales.sql:1-12` | `date_trunc` | inferred | Gold output of the build (Gold output depends on the dbt runner branch (_foil_active): retail Gold models or gold.foil_* (see transform-dbt-build).) |

## apps-architecture-concept (RESOLVED)
Apps / Architecture: concept spec load and download

| Layer | Location | Symbol | Confidence | Note |
|---|---|---|---|---|
| react | `apps/web/src/fabricApps/conceptViewer.ts:5-6` | `CONCEPT_URL` | verified | Constant URL /api/fabric-apps/concept and ?download=true |
| react | `apps/web/src/fabricApps/ConceptPanel.tsx:34-34` | `fetch(CONCEPT_URL)` | verified | Panel fetches the concept document |
| api | `apps/api/app/routers/fabric_apps.py:26-34` | `def concept` | verified | GET /api/fabric-apps/concept (download flag sets Content-Disposition) |
| service | `apps/api/app/routers/fabric_apps.py:32-32` | `load_model` | verified | Model loaded from project_root model.json |
| service | `apps/api/app/services/fabric_apps/concept.py:180-181` | `def concept_bytes` | verified | Canonical JSON serialisation of build_concept(model) |

UNRESOLVED / notes:
- Concept content comes from the compiled model file (data); no SQL or Gold field is involved.
- Viewer iframe URL /vendor/concept-viewer/concept-viewer.html is served by vite.config.ts, not traced.

## charts-export-mosaic (RESOLVED)
Charts export for Mosaic: Gold mart artifact (monthly_sales.revenue, unit USD)

| Layer | Location | Symbol | Confidence | Note |
|---|---|---|---|---|
| react | `apps/web/src/components/ExportPanel.tsx:49-54` | `"/api/exports/artifact"` | inferred | exportNow() posts {mart}; mart is chosen from gold_tables returned by GET /api/exports (mart is one of gold_tables() returned by GET /api/exports; candidates are the Gold models in dbt/models/gold and dbt/models/foil/gold.) |
| react | `apps/web/src/api.ts:32-38` | `postJson` | verified | POST JSON helper wrapping fetch |
| api | `apps/api/app/main.py:523-528` | `def export_artifact` | verified | POST /api/exports/artifact -> exports.export(mart, columns, max_rows) |
| service | `apps/api/app/main.py:77-77` | `ExportService(settings` | verified | exports service bound per workspace in _bind |
| service | `apps/api/app/services/exports.py:172-175` | `def export` | verified | Mart must match _MART and be in gold_tables() (catalog gold schema) |
| sql | `apps/api/app/services/exports.py:199-199` | `DESCRIBE contoso.gold.` | inferred | DESCRIBE the Gold mart for column names and types (f-string on mart, validated by _MART and gold_tables() before use.) |
| sql | `apps/api/app/services/exports.py:209-210` | `SELECT count(*) FROM contoso.gold.` | inferred | Row count then bounded SELECT of columns ORDER BY (f-string on mart, validated by _MART and gold_tables() before use.) |
| sql | `apps/api/app/services/exports.py:213-213` | `COPY (SELECT * FROM contoso.gold.` | inferred | COPY mart to parquet artifact (f-string on mart, validated by _MART and gold_tables() before use.) |
| service | `apps/api/app/services/exports.py:42-44` | `"revenue": "USD"` | verified | UNITS declares unit USD for the revenue column |
| service | `apps/api/app/services/exports.py:237-238` | `column["unit"] = UNITS[name]` | verified | Unit attached to exported column |
| dbt | `dbt/models/gold/monthly_sales.sql:8-8` | `as revenue` | verified | revenue = round(sum(net_revenue),2) |
| dbt | `dbt/models/silver/stg_sales.sql:20-20` | `as net_revenue` | verified | net_revenue is USD-normalised in Silver |
| gold | `dbt/models/gold/monthly_sales.sql:8-8` | `revenue` | verified | FIELD contoso.gold.monthly_sales.revenue, unit USD |

## workspace-switch (RESOLVED)
Workspace switch: activate a named workspace

| Layer | Location | Symbol | Confidence | Note |
|---|---|---|---|---|
| react | `apps/web/src/components/WorkspaceSwitcher.tsx:79-85` | `/api/workspaces/${encodeURIComponent(id)}/activate` | inferred | activate(id) posts then reloads the page (Template URL; id is a runtime workspace id but the route POST /api/workspaces/{workspace_id}/activate is unique.) |
| react | `apps/web/src/api.ts:32-38` | `postJson` | verified | POST JSON helper wrapping fetch |
| api | `apps/api/app/main.py:153-155` | `def activate_workspace` | verified | POST /api/workspaces/{workspace_id}/activate -> _switch |
| service | `apps/api/app/main.py:130-148` | `def _switch` | verified | Takes switch lock and catalog lock, then _bind(workspaces.activate(...)) |
| service | `apps/api/app/main.py:66-77` | `def _bind` | verified | Recreates every workspace-scoped service from the new Settings |
| service | `apps/api/app/services/workspaces.py:129-134` | `def activate` | verified | settings_for(id), config.set_active, writes pointer file |
| service | `apps/api/app/config.py:67-74` | `def catalog_path` | verified | Settings.catalog_path = workspace/contoso.ducklake.sqlite (or CONTOSO_DUCKLAKE_CATALOG for the default workspace) |

## End-to-end field
`contoso.gold.monthly_sales.revenue` = `round(sum(net_revenue),2)` over `stg_sales`. `net_revenue` there is a decimal(18,2) cast of `contoso.bronze.sales.net_revenue`, which the generator writes as `round(net_revenue_local*exchange_rate_to_usd,2)`.

## Observations
- In the retail branch `_validate_model_selector` also accepts `forecast_vs_actual` (fabric_apps is not under a `foil` folder), but that model is disabled unless `fabric_apps_enabled` is passed, so a selector build of it selects nothing. Only the Fabric mirror (`apps/api/app/services/fabric_apps/mirror.py`) passes that var.
- In the FOIL branch the path selector rebuilds only FOIL models; retail Gold tables keep their last build.

## React analyzer cross-check
React analyzer cross-check: NOT_RUN (the analyzer package at React revision 2e922ea4fc4d991ba809e1d3d78a23da2fb586be ships TypeScript sources only, with no built output and no installed dependencies; running it needs an npm workspace install of that repo, and this lane's isolation does not allow reading or exporting that repo with git. Confidence labels here follow its Provenance.confidence vocabulary: verified, inferred, unresolved.)
