select
  s.scenario,
  p.category,
  s.product_key,
  p.product_name,
  sum(s.quantity) as units,
  round(avg(s.discount_rate),4) as avg_discount_rate,
  round(sum(s.net_revenue),2) as revenue,
  round(sum(s.gross_margin),2) as gross_margin,
  round(sum(s.gross_margin)/nullif(sum(s.net_revenue),0),4) as gross_margin_rate
from {{ ref('stg_sales') }} s
join {{ source('bronze','product') }} p using(product_key)
group by 1,2,3,4
order by revenue desc
