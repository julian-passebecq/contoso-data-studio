{{ config(enabled=var('foil_enabled', false), schema='gold', materialized='table') }}
select scenario, case_id, experiment_id, sample_kind, driver, relative_change,
       family, assumption_set, aep_year1_mwh, capex_eur, opex_eur_year, discount_rate, price_eur_mwh,
       sum(energy_mwh * discount_factor) as pv_energy_mwh,
       sum(cost_eur * discount_factor) as pv_cost_eur,
       sum(revenue_eur * discount_factor) as pv_revenue_eur,
       sum(net_cashflow_eur * discount_factor) as npv_eur,
       sum(cost_eur * discount_factor) / nullif(sum(energy_mwh * discount_factor),0) as lcoe_eur_mwh
from {{ ref('foil_cashflows') }}
group by all
