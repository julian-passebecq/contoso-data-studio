select
  scenario,
  date_trunc('month', order_date)::date as order_month,
  channel,
  count(*) as sales_lines,
  sum(quantity) as units,
  round(avg(discount_rate),4) as avg_discount_rate,
  round(sum(net_revenue),2) as revenue,
  round(sum(total_cost),2) as cost,
  round(sum(gross_margin),2) as gross_margin,
  round(sum(gross_margin)/nullif(sum(net_revenue),0),4) as gross_margin_rate
from {{ ref('stg_sales') }}
group by 1,2,3
order by 2,3
