# Lane 07-contoso: acceptance to evidence (packet galaxy-opus-2026-10-09)

Qualified commit: `d79e0b41794756c34f89127ee704632c30968553` (branch `claude/contoso-retail-v1`, PR #14). Local OS: Windows 11 Pro 10.0.26300,
Python 3.13.1, Node 26.9.0 (web unit tests on Node 22), dbt-core 1.12.5, DuckDB 1.5.6. Data is synthetic.
Journey: `python tools/qa_retail_journey.py --mosaic <datapass-mosaicstudio>` -> `qa-evidence/retail-journey/evidence.json`
(production web build, real API, real dbt; not mocked). CI repeats it on Ubuntu (`qa-browser.yml`).

Packet row keys are handoff labels; the repo had no prior canonical feature IDs, so these rows are proposed V1
acceptance for the owner to adopt.

| Row | Status | Evidence |
| --- | --- | --- |
| F01 Preserve the retail product | MET | All pages kept (README "What is in the release"); journey visits Projects, Generate, Explore, Lakehouse, Transform, Query, Charts, Apps/Architecture; existing smokes in `qa-browser.yml` unchanged |
| F02 Reproducible generation | MET | `test_release_gaps.py` seed determinism; manifest v2 with seed/run/scenario/generator sha256/file sha256; journey UX01 Parquet metadata and row count step |
| F03 Durable Bronze/Silver/Gold | MET | journey `reopen` phase: API restart, same workspace, Gold query result identical; real `dbt build` with tests; Transform shows run results/lineage |
| F04 SQL and exploration | MET | `test_release_gaps.py` (row limit, read-only refusal, inert CSV/JSON/XLSX imports, path escape); journey `ux` failed and denied query feedback |
| F05 Charts and business UX | MET | Charts page KPIs and filters over active Gold; dbt Charts `dct` board (official renderer, no second implementation); no false "no scenario" while loading |
| F06 Concept export and viewer | MET | vendored schema/viewer hashes equal studio-v0.8.1 (`test_vendor_contracts.py`); Mosaic `checkConceptSpec` OK (6 layers / 13 nodes / 17 flows) |
| F07 Portable result export | MET | `ExportService` -> `datapass.artifact` v1 + full Parquet + receipt; units, lineage (dbt invocation, model checksum, DuckLake snapshot, generator and staging sha256); Mosaic `validateArtifact`+`artifactDefinition` OK; no recomputation |
| F08 Rayfin boundary | MET (mapping disabled) | `test_rayfin_boundary.py`; `docs/fabric-apps/GOLD-MAPPING.md`; app mirror carries its own provenance. Retail-channel to app-department mapping awaits a product decision |
| F09 DataPass React traces | MET (2 partial labelled) | `docs/datapass-react/TRACES.md` 8 traces (6 resolved, 2 partial), 66 steps, `check_traces.py` in CI |
| F10 Workspace isolation/recovery | MET | `test_workspaces_exports.py` (two workspaces, backup, restore after moving data, gate); journey UX04 switch A/B; default workspace adopted in place on upgrade |
| F11 Responsive and failure states | MET | journey `api-down`, `fault-broken`/`fault-repaired`, `ux` (keyboard, reduced motion, 390 px phone without horizontal scroll); missing dbt/`dct` shown as status badges and API errors (source-checked, not exercised by the journey) |
| F12 Installable release | MET (source install) | `docs/release/v1.md` install/run/recover/rollback/qualification; production build; journey from generation to reopened Gold query/chart and architecture export. No desktop installer (omission) |
| UX01 Retail end to end | PASS | journey `build` + `reopen` |
| UX02 Architecture to Mosaic | PASS | journey export from the UI + concept viewer; `mosaic-validation.log` at studio-v0.8.1 (8b22d9c) |
| UX03 Fault and recovery | PASS | journey `fault-broken` (monthly_sales.sql broken in fixture, export refused) and `fault-repaired` (new successful invocation referenced) |
| UX04 Isolation | PASS | journey switch between `journey-a` and `journey-b`: catalogs, history and results separate |

Omissions: Fabric/cloud runtime (not authorized), desktop installer, retail-to-app mapping (product decision),
Mosaic import UI click-through (validated with Mosaic's own validators instead; Mosaic repo not modified).
