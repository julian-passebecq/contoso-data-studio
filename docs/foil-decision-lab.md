# FOIL Wind decision content pack

Three local projects connect Parquet, persistent DuckLake, dbt analytical/decision layers, SQL, charts and lineage:

1. **FOIL · AEP & P50/P90**: conditional energy distributions for nine P/A/B × D/N/F cases.
2. **FOIL · LCOE & Investment**: reference CAPEX +30%, OPEX +20%, with real discounted cashflows and NPV.
3. **FOIL · Sensitivity Lab**: separate ±20% one-at-a-time changes in AEP, CAPEX, OPEX, real discount rate and assumed electricity price.

## Source and fidelity

Reference inputs and software outputs come from the local checkout of `julian-passebecq/foil-streamlit-wind-3d-lcoe`, commit `c4b18e81ecff91f2294920d3346c22240b9598da`, files `reference/r0/cases/*.json` and `reference/r0/results/*.result.json`. The source checkout was clean when imported. `data/foil/reference_cases.json` retains source URLs and SHA-256 hashes for all nine input/result pairs. No Databricks datasets, telemetry or cloud services are used. `foil-study` was inspected but concerns PDF evidence extraction, so it is not a numeric energy/economic source.

These are synthetic L0 screening cases. AEP comes from the reference's prescribed-coefficient power model and synthetic Weibull resource; no measured site resource or validated FOIL performance is implied. Budgets are not quotations. Prototype P results are didactic, not an investment appraisal of a commercial product.

## Metric definitions

- AEP: first-year net energy, **MWh/year**; source kWh converted once to MWh.
- Energy P50: energy 50th percentile. **Energy P90: energy 10th percentile**, exceeded by 90% of modelled draws. P10 energy is the 90th percentile. D/N/F are separate coherent assumption sets, **not quantiles**.
- Cost P90: 90th percentile of cost, explicitly distinguished from energy exceedance.
- LCOE: discounted lifetime costs / discounted lifetime MWh, **EUR2026/MWh**.
- NPV: discounted revenue minus discounted costs, **real EUR2026**; year-zero CAPEX included, later cashflows discounted at each case's real rate.
- Revenue assumes constant real electricity price **160 EUR2026/MWh**, a scenario assumption, not a market quote.
- Energy degrades annually. OPEX is constant in real terms. Replacement occurs in the source's specified year as a fraction of CAPEX. Terminal cost equals decommissioning minus residual value.
- At constant real price without taxation/financing structure, break-even price equals LCOE. Positive-NPV probability is a frequency under the illustrative simulation assumptions, not a calibrated project success probability.

## Uncertainty experiment

10,000 total draws, deterministically allocated across nine cases, seed 42 by default. Each case has its own distribution; families and D/N/F are never pooled into a purported portfolio probability. Independent illustrative variables: resource multiplier lognormal sigma 0.12 (mean one), CAPEX multiplier lognormal sigma 0.15, OPEX multiplier lognormal sigma 0.10; triangular availability ±0.05 bounded to (0,1], real discount rate ±0.02 bounded below at zero, and price multiplier ±25%. AEP scales the reference energy by resource multiplier and relative availability. This is a local uncertainty surrogate, not a rerun of the wind physics kernel or a calibrated dependence model. Seed/sample/distribution and reference hash are saved in each staging manifest.

Excluded: R&D, taxes, financing structure, grid reinforcement, floating support, moorings and marine operations. No offshore/commercial LCOE claim.

## dbt layers

- Bronze: `foil_cases`, `foil_trials`, `foil_sensitivity`.
- Silver: `foil_experiments` unifies references, uncertainty draws and sensitivity experiments; `foil_cashflows` expands annual physical/economic flows.
- Gold: `foil_experiment_metrics`, `foil_energy_risk`, `foil_project_summary`, `foil_sensitivity`, `foil_cashflow_schedule`.
- Board: `charts/foil-decision.yml`; Charts also renders paired energy bars, signed NPV sensitivity and inspectable annual cashflows.

FOIL models/sources are disabled by default to preserve retail-only CI and clean retail builds. For an active FOIL project, the API runs dbt with `--vars '{"foil_enabled": true}' --select path:models/foil`. Retail source/models remain unchanged. Readiness checks the appropriate domain mart; changing FOIL scenarios rejects previous scenario Gold before rebuild.

## Validation

`apps/api/tests/test_foil.py` checks Parquet reproduction/integrity, seed effects, exact reference LCOE reconciliation for all nine cases, energy quantile direction, discounted cashflows recomputed independently in Python, economic sensitivity direction, and stale-state protection on switching to investment stress. The existing retail release suite remains applicable.

The local app is populated through the normal Projects prepare flow. Select a reference case in Charts to inspect its source, units, finance assumptions and sensitivities. The desktop shortcut continues to launch the local checkout; the published v1.0.0 tag is unchanged.

Local verification on 2026-10-05: 81 API tests, 7 web tests, typecheck/build, and FOIL board validation passed. All three projects were prepared through Chromium with 10,000 draws; their charts and SQL returned nine cases. FOIL sensitivity additionally passed Parquet inspection, Lakehouse preview, dbt lineage, Canvas, run ledger and guided progress 7/7 after reload. The active sensitivity build has 25 quality checks passing, zero failures/errors. Browser evidence is saved locally in `D:/PROJ/contoso-data-studio-launcher/foil-evidence/`; the existing Keyborg development diagnostic remains non-blocking.
