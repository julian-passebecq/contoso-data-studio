# Local project portfolio

The Projects home page groups the existing portfolio into **FOIL** (three projects) and **Samples** (five retail scenarios). FOIL is the default group on a new browser; the chosen group is remembered locally. Browsing a group does not change the active data.

Each group exposes its projects and a shared architecture overview. “View group architecture” jumps to the macro view: reference/scenario inputs → Parquet and DuckLake Bronze → dbt Silver → Gold marts → decision outputs. This is the group's declared analytical design; Canvas shows the actual active project's dbt lineage.

“Open project” activates the selected project's complete pipeline and opens Charts when its readiness and quality checks pass. “Switch project” remains available in all workbenches, with options grouped by FOIL and Samples. The active workspace name and readiness are always visible. The guide's workbench buttons also activate their project before navigation.

The API orchestration endpoint is `POST /api/projects/{scenario}/open`. It reuses the latest matching saved run (default seed 42, scale 10,000), verifies its file hashes and generator fingerprint, reloads Bronze when switching, and runs a full build for the appropriate domain. Reopening an unchanged active project resumes directly only when a readiness receipt matches the active run/snapshot, dbt source files and build results, and quality has no failures, errors or skipped checks. A modified generator creates a fresh reproducible run. Corrupted saved data and failed builds return an explicit error rather than a ready dashboard.

The workbenches start in the active project's context: Query receives its decision SQL and domain examples; Explore selects that saved run's main Parquet file; Lakehouse selects its summary Gold mart; Generate restores its scenario, seed and scale. Transform and Canvas use the active domain lineage; Charts loads its domain board and metrics.

One activation runs at a time. The UI disables navigation and switching while opening and shows progress; a concurrent activation request gets HTTP 409. A failed activation refreshes the real workspace state so incomplete data is not represented as ready. Saved runs and per-project guide progress are retained across group/project changes.

API DuckLake connections and dbt subprocesses share a reentrant lock per catalog. State/catalog requests wait during activation rather than competing with SQLite commits. Catalog metadata connections close explicitly after reads. This coordinates the single local API process; independently launched external writers are outside that process's lock.

The desktop shortcut continues to open this local checkout. These changes do not move the published v1.0.0 tag. There is no cloud dependency or Databricks dataset.

Validation: API orchestration tests cover saved-run reuse, current-build resumption, domain round trips, integrity rejection, failed builds/quality, unknown projects, concurrent opens and readiness signature invalidation. `apps/web/qa/portfolio-smoke.mjs` exercises group browsing, all eight project dashboards, FOIL/Samples round trips, remembered group after reload, guide navigation and a compact desktop layout. `browser-smoke.mjs` retains the retail guided-navigation check.

Local verification on 2026-10-05: the 86-test API suite plus the catalog concurrency test passed (87 unique tests); seven web tests and typecheck/build passed. Chromium opened all eight projects and verified ready state, correct Gold scenario, quality and saved-run identity on round trips, with no unexpected HTTP or JavaScript errors. `qa/project-workbenches.mjs` additionally verified project-specific SQL, active Parquet selection, Gold default, lineage, Canvas and generator defaults for Retail and FOIL, guided progress 7/7, reload retention, macro-architecture navigation, a simulated activation failure and successful retry. Evidence is saved locally under `D:/PROJ/contoso-data-studio-launcher/portfolio-evidence/`. The final active project is `foil-sensitivity`.
