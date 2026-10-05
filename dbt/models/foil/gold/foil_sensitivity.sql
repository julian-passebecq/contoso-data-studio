{{ config(enabled=var('foil_enabled', false), schema='gold', materialized='table') }}
select s.scenario, s.case_id, s.family, s.assumption_set, s.driver, s.relative_change,
       s.npv_eur, s.lcoe_eur_mwh, s.npv_eur - b.npv_eur as npv_delta_eur,
       s.lcoe_eur_mwh - b.lcoe_eur_mwh as lcoe_delta_eur_mwh
from {{ ref('foil_experiment_metrics') }} s
join {{ ref('foil_experiment_metrics') }} b using (scenario, case_id)
where s.sample_kind = 'sensitivity' and b.sample_kind = 'reference'
