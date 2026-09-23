select
  scenario,
  date_trunc('month', order_date)::date as order_month,
  channel,
  count(*) as sales_lines,
  round(avg(delivery_days),2) as avg_delivery_days,
  quantile_cont(delivery_days, 0.90) as p90_delivery_days,
  sum(case when delivery_days > 7 then 1 else 0 end) as over_7_day_deliveries,
  round(
    sum(case when delivery_days > 7 then 1 else 0 end)::double / nullif(count(*),0),
    4
  ) as over_7_day_rate
from {{ ref('stg_sales') }}
group by 1,2,3
order by 2,3
