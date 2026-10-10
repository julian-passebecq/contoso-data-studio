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

## Full release 2026-10-10 (packet `galaxy-full-release-2026-10-10/07-contoso`, revision 1)

Baseline `f2d0c759b2362b94db0cd73c3a9d901ed4aed9f0` (CI run 37960928179). The rows above stay as recorded at
`d79e0b4`; this section appends the two completion deltas and reconciles stale statements. Data is synthetic.

| Delta | Maps to | Status | Evidence |
| --- | --- | --- | --- |
| 07-contoso/FR-01 exported data and traces in the actual consumers | F06, F07, F09, UX02 | MET | #18 `tools/open_in_mosaic.mjs` (CI job `open-in-mosaic`): the journey's Gold artifact opened in MosaicStudio's own UI (table 48 rows, bar chart, metric 123,166.82 USD from the artifact) and the concept spec in Mosaic's standalone viewer by postMessage embed (13/13 nodes, 17/17 flows, fit after resize, non-parent message ignored). Gates reported separately: strict JSON Schema, Mosaic TypeScript, semantic (ids, references, self-dependency/cycles, sha256 of artifact/manifest/Parquet), concept. Strict schema now PASS at MosaicStudio `f3a02bc` (its #46 schema repair) and required; lineage keeps dbt invocation, model checksum, DuckLake snapshot, generator and staging sha256. #16 traces: 20 traces, 277 steps, every step labelled verified 207 / inferred 67 / unresolved 3; `query-page` split into 8 preset sub-traces and `transform-dbt-build` into retail/foil/selector branches, both RESOLVED; only `query-page/free-sql` stays PARTIAL (user SQL, history replay, runtime result columns, listed). React analyzer cross-check NOT_RUN (needs a workspace install in the private React repo; analyzer not edited) |
| 07-contoso/FR-02 retail product and release notes | F03, F08, F10, F12, UX01, UX03, UX04 | MET | #19 journey phases `mapping` (72 items, ONLINE/NORD/SOUTH non-empty, unmapped [], app total = Gold total at the pinned snapshot, all 10 channel/country pairs in exactly one department, Gold digest unchanged by the read, copy/non-authoritative provenance) and `backup` -> API process restart -> `restore` (new workspace, Gold revenue and both export ids equal journey-a); injected dbt failure/repair kept (`fault-broken`/`fault-repaired`); workspace A/B kept. #17 package: `tools/package_release.py` zip (source + prebuilt web) + SHA256SUMS, `contoso-studio` one-process loopback run, `tools/qa_install_package.py` clean-venv install -> health -> UI -> retail project to Gold (Windows 11 local and Ubuntu CI job `package`). Release notes corrected (`docs/release/v1.md`) |

Reconciliation of stale statements (the originals above are kept as history):
- F08 "mapping disabled" and the omission "retail-to-app mapping (product decision)": superseded by #15 (2026-10-09), the
  NORD/SOUTH/ONLINE mapping in `mapping.py` (single owner), on by default, qualified by the journey `mapping` phase.
- F12 "No desktop installer (omission)": still true; the release is the source/prebuilt-web zip with `contoso-studio`.
- UX02 / `mosaic-validation.log` "studio-v0.8.1 (8b22d9c)": consumer pin is now MosaicStudio `f3a02bc` (main, 0.9.0, no
  tag); vendored `vendor/` copies stay byte-exact at studio-v0.8.1 (`test_vendor_contracts.py`).
- "Mosaic import UI click-through" omission: closed by FR-01 (Mosaic UI and viewer opened by Playwright).

Omissions: Fabric/cloud runtime and real Entra login (not authorized), tag/release/publication (not authorized),
desktop installer (not promised), React analyzer cross-check (NOT_RUN), E2E-08 cross-product clean-release set (owned by
the release-set coordinator; Contoso supplies its package and install receipt).

### Post-merge receipt (2026-10-10)

- Final main `fe83dbd0805fb787f4beb0d7485827ec059e8578` (#20; earlier #17 a671b36, #16 d23949f, #18 d2056c1, #19 3d257a0).
- CI on final main: run 38020549227 attempt 1, ubuntu-latest: api, web, charts, fabric-app-model, package success.
  `qa-browser.yml` runs on pull requests: PR #20 head `3b5d5d7` (same tree as `fe83dbd`, empty diff) passed
  browser-smoke (journey) and open-in-mosaic (structural_strict, structural_ts, semantic, concept all PASS at MosaicStudio `f3a02bc`).
- Native journey on Windows 11 Pro 10.0.26300 at `fe83dbd` (Python 3.12.10, Node 26.9.0, dbt-core 1.12.5): PASS, 9 phases
  (build, reopen, fault-broken, fault-repaired, mapping, backup, restore, api-down, ux); mapping 72 items, Gold = app
  total 4,424,416.84 (0 cents), 10/10 pairs covered once; restore `journey-a-restored` same revenue and 2 export ids.
  Export sha256 `bd5e19c7...2e51` passes MosaicStudio's strict JSON Schema, TypeScript validator and Python mirror at `f3a02bc`.
  Evidence: `handoff/evidence/journey-2026-10-10-windows.json`, `handoff/evidence/open-in-mosaic-2026-10-10.json`.
- Package: `contoso-data-studio-0.2.0-fe83dbd.zip`, 2,963,772 bytes, sha256 `c065671d0acbe4520860fcd6dca93842aa1a75bd7ee7808d56106a8e58b0fbd1`,
  clean-venv install receipt PASS (CI, final main); Windows install PASS at #17 head. Kept locally, not published.
- Gates: LOCAL (this repo) PASS; PUBLIC_DISTRIBUTION and tags NOT_AUTHORIZED; FABRIC_AUTHENTICATED BLOCKED (not authorized).
