select *
from {{ ref('delivery_metrics') }}
where over_7_day_rate < 0
   or over_7_day_rate > 1
