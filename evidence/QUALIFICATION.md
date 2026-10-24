# CONTOSO DATA STUDIO V1 QUALIFICATION

**FINAL VERDICT: PASS, with non-blocking issues.**

**RELEASE DECISION: READY FOR v1.0.0 at the tested SHA.**

Qualification performed independently on Windows on 4 October 2026. No tag, release, push, or product-code change was made.

| Baseline | Observed |
|---|---|
| Repo | https://github.com/julian-passebecq/contoso-data-studio |
| Fresh clone | `D:\PROJ\contoso-data-studio-qa-20261004` |
| Branch | `main` |
| Tested SHA | `c63446b122038735e400a4129a6eb540bfda8101` |
| Initial working tree | Clean; exact expected SHA |
| OS | Windows 11 Pro, 10.0.26200 |
| Python / pip | 3.12.10 / 26.2.1, isolated `.venv` |
| Node / npm | 22.23.3 / 10.9.9, local runtime in `qa-tools` |
| dbt | Core 1.12.5; dbt-duckdb 1.11.0 |
| DuckDB | 1.5.6 |
| dbt Charts | 0.8.0, separate `.charts-venv` |
| Browser | Playwright 1.56.1 Chromium 141.0.7390.37, Windows headless, 1440×1000 |

## STATIC/UNIT

- Python compile: **PASS** (`python -m compileall -q apps/api/app`).
- API tests: **79 passed / 0 failed**, 51.31 seconds. Includes `test_release_qualification.py` without modifying its assertions.
- Web tests: **PASS**, 7/7 tests, 1 test file.
- Web typecheck and build: **PASS**, `npm run build`; Vite production build 20.50 seconds.

Evidence: `api-tests.log`, `web-tests.log`, `web-build.log`, `api-freeze.txt`.

## DATA FLOW

| Component | Result and evidence |
|---|---|
| Generator | PASS: retail-baseline, scale 10000, seed 42, persisted hashed Parquet |
| Parquet Explorer | PASS: Parquet format, 10000 sales rows, 1 readable row group, 25 sample rows independently inspected, required columns present |
| DuckLake Bronze | PASS: customer, currency_exchange, product, sales, store; SQLite metadata inspected; 10000 sales rows reopened in a separate Python process |
| dbt parse / Silver | PASS: parse succeeded; stg_sales materialized |
| dbt Gold | PASS: all six expected marts exist and contain rows |
| Gold SQL | PASS: country/revenue/gross_margin/margin_rate, 5 countries; board and CI analytical queries returned rows |
| Quality | PASS: 70 total, 70 PASS, 0 FAIL/WARN/ERROR/SKIP; Bronze 33, Silver 15, Gold 22 |
| Lineage | PASS: 12 manifest nodes, 9 dependencies; model detail and Bronze→Silver→Gold visible |
| Charts | PASS: 2 board queries, 4 chart specifications, real KPI/chart data; CLI and in-app board validation succeeded |
| Snapshot history | PASS: historical previews and same-data Bronze reload comparison; 10000→10000 rows, no row/schema delta |
| Guided READY | PASS: live state ready=true, gold_current=true, retail-baseline |

Gold marts: monthly_sales, channel_performance, delivery_metrics, currency_exposure, product_performance, store_performance.

Evidence: `integration.log`, `parquet-inspection.json`, `persisted-catalog.json`, `built-catalog.json`, `quality.json`, `lineage.json`, `gold-query.json`, `charts-board.json`, `charts-validate.log`, `ci-extras.json`, and dbt build logs.

## STALE STATE

- Stale Gold rejected: **PASS**. After activating margin-pressure, runtime reported active_scenario=margin-pressure, gold_current=false, ready=false.
- Rebuilt scenario current: **PASS**. After build, gold_scenarios=[margin-pressure], gold_current=true, ready=true.

Evidence: `margin-stale.json`, `margin-rebuilt.json`, `margin-dbt-build.log`. The independent integration and browser runs used separate disposable workspaces with explicit absolute environment paths. Shared dbt artifacts were exercised sequentially.

## WINDOWS BROWSER

Projects **PASS**; Explore **PASS**; Lakehouse **PASS**; Transform **PASS**; Query **PASS**; Charts **PASS**; Canvas **PASS**.

Actual UI preparation, file selection, table scrolling, schema/metadata/row-group tabs, Bronze and Gold snapshot previews, model detail/lineage, Gold SQL execution, chart validation, and Canvas horizontal scrolling were exercised. Guided progress reached 7/7 and persisted after browser reload. Keyboard Tab navigation moved focus from Projects to Generate. Final API checks confirmed readiness, 70/70 quality, and 20 Gold store rows remaining after the rejected mutation.

Repository browser smoke: **BROWSER_SMOKE_PASS**. Extended browser run: **PASS**.

- Browser console errors: two `Keyborg instance k1 is being disposed incorrectly.` diagnostics; one expected resource error for the deliberately rejected SQL mutation.
- Uncaught exceptions / React runtime crashes: **0**.
- Failed network requests in completed extended run: **0**.
- HTTP errors: one intentional **400** for mutation; no unexpected 4xx and no 5xx in that run.
- Console warnings: **0**.
- Visual review: no page-level horizontal overflow at 1440px, overlapping cards, hidden errors, or unusable tables. Canvas uses an internal horizontal scroller (80px tested).

Evidence directory: `D:\PROJ\contoso-data-studio-qa-20261004\evidence\browser` (16 detailed screenshots plus 5 viewport screenshots, `results.json`, `visual-details.json`). Original smoke screenshots: `apps\web\qa-artifacts`. Logs: `browser-extended.log`, `browser-repository-smoke.log`, `api-runtime-captured.log`.

Early QA-script attempts captured still-loading views and aborted requests when reloading with pending API calls. Their results are retained as first/second/third-attempt JSON files. The QA script was corrected to wait for the selected file and track pending API requests; product code and repository tests were untouched. The final complete evidence set is `browser/results.json` and its named screenshots.

## PERFORMANCE SANITY

| Operation | Approximate observed time |
|---|---|
| Startup | API ready within the 10-second launch observation window; Vite reported ready in 1.04 seconds (not a measured combined browser-ready time) |
| Retail project prepare | 23.30 seconds first clean preparation; 14.31–17.70 seconds later preparations |
| 10000-row Parquet generation | 0.14 seconds retail; 0.08 seconds margin |
| dbt build | 16.78 seconds retail; 18.62 seconds margin, including process startup |
| Explore sales.parquet | 0.28–0.55 seconds |
| Gold query | 0.22 seconds service call; 0.45 seconds completed UI query |

No obvious hang or performance regression observed. These are sanity observations, not benchmarks.

## ISSUES

- **P0: none found.**
- **P1: none found.**
- **P2:** npm audit reports two moderate development-dependency findings (vitest and @vitest/mocker) for the same redirect-mock path-traversal advisory. They are outside the built app/runtime flow; no exploit validation or dependency upgrade was undertaken. Audit details retained in `npm-audit.json`.
- **P3:** development-only Keyborg disposal diagnostic. Installed Keyborg source emits it only outside production; React StrictMode is enabled. Repeated development lifecycle cleanup is the likely trigger, not independently proven. Keyboard navigation and all workbenches remained usable.
- **P3:** badges wrap awkwardly in Charts/Canvas; Explore toolbar is cramped; Transform and snapshot history produce very long pages and truncated identifiers. All relevant controls remained usable.

Setup notes: uv fell back from hardlinks to copying across disks (installation performance only). npm emitted a deprecated whatwg-encoding warning. The documented npm --prefix install failed looking for root package.json on this machine; npm install from apps/web succeeded. An overlapping QA dependency install caused temporary ENOTEMPTY/EPERM cleanup errors; the incomplete node_modules was moved aside and a clean sequential installation succeeded. No force audit fix or global runtime replacement was performed.

The fresh clone now has untracked QA scripts, environments, dependencies, workspaces, and evidence; `git diff --exit-code` confirms every tracked product file remains unchanged. No fix branch was needed because no P0/P1 issue was found.
