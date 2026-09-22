select
  scenario,
  order_year,
  sum(revenue_share) as revenue_share
from {{ ref('channel_performance') }}
group by 1,2
having abs(sum(revenue_share) - 1.0) > 0.001
