select sales_key
from {{ ref('stg_sales') }}
where abs((net_revenue - total_cost) - gross_margin) > 0.01
