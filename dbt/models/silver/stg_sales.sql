select
  sales_key,
  cast(order_date as date) as order_date,
  customer_key, product_key, store_key, channel, quantity,
  cast(unit_price as decimal(18,2)) as unit_price,
  cast(unit_cost as decimal(18,2)) as unit_cost,
  discount_rate,
  cast(net_revenue as decimal(18,2)) as net_revenue,
  cast(total_cost as decimal(18,2)) as total_cost,
  cast(net_revenue-total_cost as decimal(18,2)) as gross_margin
from {{ source('bronze','sales') }}
