select
  scenario,
  date_trunc('month', order_date)::date as order_month,
  store_country,
  currency,
  round(avg(exchange_rate_to_usd),6) as avg_exchange_rate_to_usd,
  round(sum(net_revenue_local),2) as revenue_local,
  round(sum(net_revenue),2) as revenue_usd,
  round(sum(gross_margin),2) as gross_margin_usd
from {{ ref('stg_sales') }}
group by 1,2,3,4
order by 2,3,4
