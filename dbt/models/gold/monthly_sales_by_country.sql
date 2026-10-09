select
  scenario,
  date_trunc('month', order_date)::date as order_month,
  channel,
  store_country,
  count(*) as sales_lines,
  round(sum(net_revenue),2) as revenue
from {{ ref('stg_sales') }}
group by 1,2,3,4
order by 2,3,4
