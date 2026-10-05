{{ config(enabled=var('foil_enabled', false), schema='gold', materialized='table') }}
select scenario, case_id, family, assumption_set, year, energy_mwh, investment_eur,
       operating_cost_eur, replacement_eur, terminal_net_cost_eur, revenue_eur,
       net_cashflow_eur, discount_factor, net_cashflow_eur * discount_factor as discounted_cashflow_eur
from {{ ref('foil_cashflows') }}
where sample_kind = 'reference'
