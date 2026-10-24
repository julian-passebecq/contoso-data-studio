import json
from pathlib import Path
from app.config import Settings
from app.services.ducklake import DuckLakeService
from app.services.generator import GeneratorService
s=Settings.load(); lake=DuckLakeService(s); g=GeneratorService(s)
evidence={}
for name in ['monthly_sales','channel_performance','delivery_metrics','currency_exposure','product_performance','store_performance']:
    result=lake.query(f'select count(*) from contoso.gold.{name}',10)
    assert result[1][0][0]>0
    evidence[name]=result
queries={
 'gold_scenario':'select scenario from contoso.gold.monthly_sales group by 1 order by 1',
 'online_migration':"select order_year, revenue_share, revenue from contoso.gold.channel_performance where channel='Online' order by order_year",
 'margin_pressure':'select extract(year from order_month)::integer yr, sum(gross_margin)/nullif(sum(revenue),0) margin_rate, avg(avg_discount_rate) discount_rate, sum(revenue) revenue from contoso.gold.monthly_sales group by 1 order by 1',
 'logistics_delays':'select channel, round(avg(avg_delivery_days),2) avg_days, round(avg(p90_delivery_days),2) p90_days, round(avg(over_7_day_rate),4) over_7_rate from contoso.gold.delivery_metrics group by 1 order by 1',
 'currency_exposure':'select currency, min(avg_exchange_rate_to_usd) min_rate, max(avg_exchange_rate_to_usd) max_rate, max(avg_exchange_rate_to_usd)-min(avg_exchange_rate_to_usd) spread, sum(revenue_usd) revenue_usd from contoso.gold.currency_exposure group by 1 order by spread desc',
}
for name,sql in queries.items():
    result=lake.query(sql,100); assert result[0] and result[1]; evidence[name]=result
before=int(lake.snapshots(1)[0]['snapshot_id'])
assert lake.preview_at_snapshot('gold','monthly_sales',before,5)[1]
run_id=str(g.list_runs(1)[0]['run_id'])
lake.load_parquet_to_bronze(g.run_files(run_id,verify_hashes=True))
after=int(lake.snapshots(1)[0]['snapshot_id'])
comparison=lake.compare_snapshots('bronze','sales',before,after)
assert comparison['base']['row_count']==comparison['target']['row_count']==10000
assert comparison['row_delta']==0 and comparison['added_columns']==comparison['removed_columns']==[]
evidence['snapshot_comparison']=comparison
Path(__file__).with_name('ci-extras.json').write_text(json.dumps(evidence,default=str,indent=2),encoding='utf-8')
print('CI_QUERY_AND_SNAPSHOT_CONTRACT_PASS')
