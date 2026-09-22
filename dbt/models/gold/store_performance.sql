select
  s.scenario,
  s.store_key,
  st.store_name,
  s.store_country,
  s.currency,
  count(*) as sales_lines,
  sum(s.quantity) as units,
  round(sum(s.net_revenue),2) as revenue,
  round(sum(s.gross_margin),2) as gross_margin,
  round(sum(s.gross_margin)/nullif(sum(s.net_revenue),0),4) as gross_margin_rate,
  round(avg(s.delivery_days),2) as avg_delivery_days
from {{ ref('stg_sales') }} s
join {{ source('bronze','store') }} st using(store_key)
group by 1,2,3,4,5
order by revenue desc
