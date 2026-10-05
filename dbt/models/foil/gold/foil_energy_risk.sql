{{ config(enabled=var('foil_enabled', false), schema='gold', materialized='table') }}
select scenario, case_id, family, assumption_set, count(*) as draw_count,
       avg(aep_year1_mwh) as aep_mean_mwh,
       quantile_cont(aep_year1_mwh, 0.5) as aep_p50_mwh,
       quantile_cont(aep_year1_mwh, 0.1) as aep_p90_mwh,
       quantile_cont(aep_year1_mwh, 0.9) as aep_p10_mwh,
       quantile_cont(lcoe_eur_mwh, 0.5) as lcoe_cost_p50_eur_mwh,
       quantile_cont(lcoe_eur_mwh, 0.9) as lcoe_cost_p90_eur_mwh,
       quantile_cont(npv_eur, 0.1) as npv_q10_eur,
       quantile_cont(npv_eur, 0.5) as npv_q50_eur,
       quantile_cont(npv_eur, 0.9) as npv_q90_eur,
       avg(case when npv_eur > 0 then 1.0 else 0.0 end) as positive_npv_probability
from {{ ref('foil_experiment_metrics') }}
where sample_kind = 'monte_carlo'
group by all
