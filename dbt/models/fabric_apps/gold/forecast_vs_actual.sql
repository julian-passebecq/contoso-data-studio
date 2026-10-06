{{ config(enabled=var('fabric_apps_enabled', false), schema='gold', materialized='table') }}
-- Sales Forecasting app: monthly forecast vs booked actuals per department, with variance.
-- Built from the mirrored Bronze tables (the OneLake stand-in), never from the operational store.
with forecasts as (
    select department_id, month, sum(amount) as forecast_amount,
           max(updated_by) filter (where updated_by is not null and updated_by <> 'seed') as last_editor,
           max(_mirrored_at) as forecast_mirrored_at
    from {{ source('fabric_app', 'sfapp_forecasts') }}
    group by 1, 2
),
actuals as (
    select department_id, month, sum(amount) as actual_amount
    from {{ source('fabric_app', 'sfapp_actuals') }}
    group by 1, 2
)
select
    f.month,
    d.code as department_code,
    d.name as department_name,
    cast(f.forecast_amount as decimal(18, 2)) as forecast_amount,
    cast(a.actual_amount as decimal(18, 2)) as actual_amount,
    cast(a.actual_amount - f.forecast_amount as decimal(18, 2)) as variance,
    case when f.forecast_amount = 0 or a.actual_amount is null then null
         else round((a.actual_amount - f.forecast_amount) / f.forecast_amount, 4) end as variance_pct,
    f.last_editor,
    f.forecast_mirrored_at,
    current_timestamp as built_at
from forecasts f
join {{ source('fabric_app', 'sfapp_departments') }} d on d.id = f.department_id
left join actuals a on a.department_id = f.department_id and a.month = f.month
