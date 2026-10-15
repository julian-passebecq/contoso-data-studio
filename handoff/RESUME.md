# Resume - contoso-data-studio lane 07-contoso (updated 2026-10-12 night)

- Surface: Claude Code desktop, model claude-opus-5-5; native session id not exposed (null).
- Full release (10 Oct): #17 package, #16 traces, #18 Mosaic consumer, #19 journey, #20 lead, #21 receipt (final main fe83dbd).
- E2E-05 (11-12 Oct): #22 Mosaic pin b3f194d, #23 receipt (PASS), #24 React 7f56479 leg (13/14), #28 React d55e65d
  re-check: 14/14 at a6d5d08; 13/14 at current main because the analyzer does not follow query_with_lineage ->
  _run_read_only (React gap, reported). Receipts in `handoff/evidence/e2e-05-*.json`.
- Night 12 Oct (merged): #25 Transform selector builds app-lab Gold with its var, 0-node dbt runs flagged, web 0.2.0;
  #27 web tests on Node 22+26; #26 Query "Reads from" runtime lineage (DuckDB-resolved, linked to dbt models).
  Windows clean-venv package install PASS at 9d99330 (zip sha256 bc022103..., 14/14 checks).
- Night 12 Oct (merged, cont.): #30 lineage chips deep-link to the exact Lakehouse table / dbt model; #31 retail Gold
  "last built / not rebuilt by this run" marker + GET /api/dbt/gold-builds; #33 retail journey covers both (UX05, UX06;
  FOIL build in workspace B); #32 TRACES.md rendered from traces.json (`render_traces.py`, stale check in check_traces).
- Galaxy Finition 13-14 Oct: #35 #36 docs; #37 0.3.0 (guide, notes); #38 installed-package journeys. Package
  0.3.0-ac98102 sha256 050b548d... staged locally (receipt in ACCEPTANCE.md); React leg 14/14 at 8a429c3.
- 15 Oct: E2E-05 joint vector on installed artifacts PASS (11 VERIFIED + 2 INFERRED): Contoso 0.3.0-ac98102 + Mosaic
  0.11.1-3575e6b SDK release + React 2.2.4-2d3b814 CLI, React trace 14/14 (7V/7I). New `--mosaic-release` in
  `open_in_mosaic.mjs` / `qa_install_package.py`; the 120 s browser wait fixed the local Mosaic timeout. Receipt
  `handoff/evidence/e2e-05-joint-vector-2026-10-15.json`.
- In flight: none. Open (optional): mapping/API-down/UX browser phases on installed bytes (E2E-05 step 12 INFERRED).
- Re-qualify: E2E-05 installed: `py -3.12 tools/qa_install_package.py --zip <vault zip> --mosaic-release <Mosaic SDK
  release folder> --keep`, then React CLI `datapass-analyze analyze <unpacked zip root> ... --oracle-trace charts-kpi-revenue`;
  `python tools/qa_retail_journey.py --mosaic <datapass-mosaicstudio>`; `node tools/open_in_mosaic.mjs ...`;
  `python tools/package_release.py && python tools/qa_install_package.py`; `pytest -q apps/api/tests` (venv Scripts on PATH);
  `npm --prefix apps/web test` (Node 22 or 26); `python -I docs/datapass-react/render_traces.py`; React leg: React CLI `datapass-analyze.mjs analyze <root> --oracle`.
- Owner gates (not authorized): tag/release/public distribution, Fabric/cloud (E2E-09), E2E-08 release-set assembly.
- Processes: none left running by the lead. Worktrees from workflows remain (no cleanup authorized).
