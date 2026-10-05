{{ config(enabled=var('foil_enabled', false), schema='silver', materialized='table') }}
with experiments as (
    select scenario, case_id, 'trial:' || trial_key as experiment_id,
           'monte_carlo' as sample_kind, null::varchar as driver, 0.0 as relative_change,
           aep_year1_mwh, capex_eur, opex_eur_year, discount_rate, price_eur_mwh
    from {{ source('foil', 'foil_trials') }}
    union all
    select scenario, case_id, 'reference:' || case_id, 'reference', null, 0,
           reference_aep_mwh, capex_eur, opex_eur_year, discount_rate, price_eur_mwh
    from {{ source('foil', 'foil_cases') }}
    union all
    select scenario, case_id, 'sensitivity:' || case_id || ':' || driver || ':' || relative_change,
           'sensitivity', driver, relative_change,
           aep_year1_mwh, capex_eur, opex_eur_year, discount_rate, price_eur_mwh
    from {{ source('foil', 'foil_sensitivity') }}
)
select e.*, c.family, c.assumption_set, c.life_years, c.degradation_rate,
       c.replacement_year, c.replacement_fraction, c.terminal_fraction
from experiments e
join {{ source('foil', 'foil_cases') }} c using (scenario, case_id)
