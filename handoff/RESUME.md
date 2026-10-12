# Resume - contoso-data-studio lane 07-contoso (updated 2026-10-12 night)

- Surface: Claude Code desktop, model claude-opus-5-5; native session id not exposed (null).
- Full release (10 Oct): #17 package, #16 traces, #18 Mosaic consumer, #19 journey, #20 lead, #21 receipt (final main fe83dbd).
- E2E-05 (11-12 Oct): #22 Mosaic pin b3f194d, #23 receipt (PASS), #24 React 7f56479 leg (13/14), #28 React d55e65d
  re-check: 14/14 at a6d5d08; 13/14 at current main because the analyzer does not follow query_with_lineage ->
  _run_read_only (React gap, reported). Receipts in `handoff/evidence/e2e-05-*.json`.
- Night 12 Oct (merged): #25 Transform selector builds app-lab Gold with its var, 0-node dbt runs flagged, web 0.2.0;
  #27 web tests on Node 22+26; #26 Query "Reads from" runtime lineage (DuckDB-resolved, linked to dbt models).
  Windows clean-venv package install PASS at 9d99330 (zip sha256 bc022103..., 14/14 checks).
- In flight: Query lineage deep links to Lakehouse/Transform; retail Gold "last built / not rebuilt" marker after FOIL builds.
- Re-qualify: `python tools/qa_retail_journey.py --mosaic <datapass-mosaicstudio>`; `node tools/open_in_mosaic.mjs ...`;
  `python tools/package_release.py && python tools/qa_install_package.py`; `pytest -q apps/api/tests` (venv Scripts on PATH);
  `npm --prefix apps/web test` (Node 22 or 26); React leg: React CLI `datapass-analyze.mjs analyze <root> --oracle`.
- Owner gates (not authorized): tag/release/public distribution, Fabric/cloud (E2E-09), E2E-08 release-set assembly.
- Processes: none left running by the lead. Worktrees from workflows remain (no cleanup authorized).
