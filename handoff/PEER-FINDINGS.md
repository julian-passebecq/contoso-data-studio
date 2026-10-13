# Peer findings from lane 07-contoso (not applied: no peer repo writes)

1. **01-mosaicstudio** - RESOLVED 2026-10-10 by MosaicStudio #46 (`f3a02bc`): `artifact.schema.json` now declares the
   provenance lineage fields; Contoso exports pass it strictly and the gate is required.
2. **Product decision (owner)** - RESOLVED 2026-10-09 by #15 (NORD/SOUTH/ONLINE mapping, `GOLD-MAPPING.md` section 3).
3. **02-datapass-react** - traces completed on the Contoso side with verified/inferred/unresolved labels (#16); one
   trace stays PARTIAL because its SQL is user input. The React headless CLI (`datapass-analyze.mjs --oracle`) now
   cross-checks `charts-kpi-revenue`: 14/14 grounded at React d55e65d before #26, 13/14 after it. OPEN for the React
   lane: the analyzer does not follow `query_with_lineage -> _run_read_only` (step 5 UNMAPPED); re-run the E2E-05 React
   leg when it lands (receipts `handoff/evidence/e2e-05-react-leg-*.json`).
4. RESOLVED 2026-10-12 by #25 and #31 (see `docs/datapass-react/TRACES.md`, Observations): on a retail project the
   Transform selector builds `forecast_vs_actual` with `fabric_apps_enabled` when the app lab is enabled and refuses it
   otherwise, and a 0-node dbt run is reported as not ok; on a FOIL project `dbt build` still rebuilds only the FOIL
   models, and the Transform page marks retail Gold models "not rebuilt by this run" with their last build.
