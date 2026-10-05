{{ config(enabled=var('foil_enabled', false), schema='gold', materialized='table') }}
select m.scenario, m.case_id, m.family, m.assumption_set,
       m.aep_year1_mwh, m.capex_eur, m.opex_eur_year, m.price_eur_mwh, m.discount_rate,
       m.pv_energy_mwh, m.pv_cost_eur, m.pv_revenue_eur, m.npv_eur, m.lcoe_eur_mwh,
       m.lcoe_eur_mwh as break_even_price_eur_mwh,
       r.aep_p50_mwh, r.aep_p90_mwh, r.lcoe_cost_p50_eur_mwh, r.lcoe_cost_p90_eur_mwh,
       r.positive_npv_probability, r.draw_count,
       c.reference_lcoe_eur_mwh, c.source_case_sha256, c.source_result_sha256, c.source_url,
       'SYNTHETIC L0 SCREENING; D/N/F are not quantiles; real EUR 2026; price assumed' as interpretation
from {{ ref('foil_experiment_metrics') }} m
join {{ ref('foil_energy_risk') }} r using (scenario, case_id)
join {{ source('foil', 'foil_cases') }} c using (scenario, case_id)
where m.sample_kind = 'reference'
