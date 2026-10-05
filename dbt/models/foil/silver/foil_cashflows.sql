{{ config(enabled=var('foil_enabled', false), schema='silver', materialized='table') }}
with annual as (
    select e.*, y.year,
        power(1 + discount_rate, -y.year) as discount_factor,
        case when y.year = 0 then 0 else aep_year1_mwh * power(1-degradation_rate, y.year-1) end as energy_mwh,
        case when y.year = 0 then capex_eur else 0 end as investment_eur,
        case when y.year = 0 then 0 else opex_eur_year end as operating_cost_eur,
        case when y.year = replacement_year then capex_eur * replacement_fraction else 0 end as replacement_eur,
        case when y.year = life_years then capex_eur * terminal_fraction else 0 end as terminal_net_cost_eur
    from {{ ref('foil_experiments') }} e,
         lateral range(0, life_years + 1) y(year)
)
select *, energy_mwh * price_eur_mwh as revenue_eur,
    investment_eur + operating_cost_eur + replacement_eur + terminal_net_cost_eur as cost_eur,
    energy_mwh * price_eur_mwh - (investment_eur + operating_cost_eur + replacement_eur + terminal_net_cost_eur) as net_cashflow_eur
from annual
