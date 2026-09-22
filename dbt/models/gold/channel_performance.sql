with channel_year as (
  select
    scenario,
    extract(year from order_date)::integer as order_year,
    channel,
    count(*) as sales_lines,
    sum(quantity) as units,
    round(avg(discount_rate),4) as avg_discount_rate,
    round(sum(net_revenue),2) as revenue,
    round(sum(gross_margin),2) as gross_margin
  from {{ ref('stg_sales') }}
  group by 1,2,3
)

select
  scenario,
  order_year,
  channel,
  sales_lines,
  units,
  avg_discount_rate,
  revenue,
  gross_margin,
  round(
    revenue / nullif(sum(revenue) over (partition by scenario, order_year), 0),
    4
  ) as revenue_share
from channel_year
order by order_year, channel
