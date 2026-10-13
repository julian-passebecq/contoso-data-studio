## End-to-end field
`contoso.gold.monthly_sales.revenue` = `round(sum(net_revenue),2)` over `stg_sales`. `net_revenue` there is a decimal(18,2) cast of `contoso.bronze.sales.net_revenue`, which the generator writes as `round(net_revenue_local*exchange_rate_to_usd,2)`.

## Observations
- In the retail branch `_validate_model_selector` also accepts `forecast_vs_actual` (fabric_apps is not under a `foil` folder). That model is disabled unless `fabric_apps_enabled` is passed, so `_run` passes the var when the app lab is enabled in the workspace (its operational store exists) and refuses the build otherwise; the Fabric mirror (`apps/api/app/services/fabric_apps/mirror.py`) also passes it. A build or test that executes 0 nodes is reported as `ok: false` with a warning.
- In the FOIL branch the path selector rebuilds only FOIL models; retail Gold tables keep their last build. The Transform page shows each Gold model's last build and marks the ones "not rebuilt by this run" (`GET /api/dbt/gold-builds`).

## React analyzer cross-check
Confidence labels here follow the React analyzer's Provenance.confidence vocabulary: verified, inferred, unresolved. `traces.json` is the oracle its headless CLI reads (`node scripts/datapass-analyze.mjs analyze <contoso archive> --json --oracle docs/datapass-react/traces.json --oracle-trace <id>`, run from read-only git archives).
- React 2e922ea (2026-10-10): NOT_RUN, no headless CLI at that revision (TypeScript sources only).
- React 7f56479 on Contoso 523c442 (2026-10-11): `charts-kpi-revenue` 13/14 steps grounded; step 6 (Revenue card read by position) UNMAPPED. Receipt `handoff/evidence/e2e-05-react-leg-2026-10-11.json`.
- React d55e65d (2026-10-12): 14/14 grounded (7 verified, 7 inferred) on Contoso a6d5d08, before the runtime query lineage; 13/14 on 90714e8, after it, because the analyzer does not follow `query_with_lineage -> _run_read_only` (step 5 UNMAPPED, a React analyzer gap reported to the React lane). Receipt `handoff/evidence/e2e-05-react-leg-2026-10-12.json`.
- Only `charts-kpi-revenue` has been cross-checked; the other traces are not yet compared with the analyzer.
