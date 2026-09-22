select
  scenario,
  extract(year from order_date)::integer as order_year,
  channel,
  count(*) as sales_lines,
  sum(quantity) as units,
  round(avg(discount_rate),4) as avg_discount_rate,
  round(sum(net_revenue),2) as revenue,
  round(sum(gross_margin),2) as gross_margin,
  round(sum(net_revenue) / nullif(sum(sum(net_revenue)) over (
    partition by scenario, extract(year from order_date)
  ),0),4) as revenue_share
from {{ ref('stg_sales') }}
group by 1,2,3
order by 2,3
