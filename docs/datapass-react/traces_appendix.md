## End-to-end field
`contoso.gold.monthly_sales.revenue` = `round(sum(net_revenue),2)` over `stg_sales`. `net_revenue` there is a decimal(18,2) cast of `contoso.bronze.sales.net_revenue`, which the generator writes as `round(net_revenue_local*exchange_rate_to_usd,2)`.

## Observations
- In the retail branch `_validate_model_selector` also accepts `forecast_vs_actual` (fabric_apps is not under a `foil` folder). That model is disabled unless `fabric_apps_enabled` is passed, so `_run` passes the var when the app lab is enabled in the workspace (its operational store exists) and refuses the build otherwise; the Fabric mirror (`apps/api/app/services/fabric_apps/mirror.py`) also passes it. A build or test that executes 0 nodes is reported as `ok: false` with a warning.
- In the FOIL branch the path selector rebuilds only FOIL models; retail Gold tables keep their last build.

## React analyzer cross-check
React analyzer cross-check: NOT_RUN (the analyzer package at React revision 2e922ea4fc4d991ba809e1d3d78a23da2fb586be ships TypeScript sources only, with no built output and no installed dependencies; running it needs an npm workspace install of that repo, and this lane's isolation does not allow reading or exporting that repo with git. Confidence labels here follow its Provenance.confidence vocabulary: verified, inferred, unresolved.)
