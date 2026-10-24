import json, sys, time, sqlite3
from pathlib import Path
from app.config import Settings
from app.services.generator import GeneratorService
from app.services.ducklake import DuckLakeService
from app.services.explorer import ExplorerService
from app.services.dbt_runner import DbtService
from app.services.charts import ChartsService
from app.services.workspace_state import WorkspaceStateService

s = Settings.load()
g, lake, dbt = GeneratorService(s), DuckLakeService(s), DbtService(s)
state = WorkspaceStateService(g, lake, dbt)
out = Path(__file__).parent
def save(name, obj):
    (out / (name + '.json')).write_text(json.dumps(obj, default=str, indent=2), encoding='utf-8')
def generate(scenario):
    start = time.perf_counter()
    m = g.generate(scenario, 10000, 42)
    print('generation_seconds', scenario, time.perf_counter()-start, flush=True)
    lake.load_parquet_to_bronze(g.run_files(m['run_id'], verify_hashes=True))
    g.mark_bronze_loaded(m['run_id'], int(lake.snapshots(1)[0]['snapshot_id']))
    save(scenario+'-run', g.get_run(m['run_id']))
    return m
if sys.argv[1] == 'generate':
    m = generate('retail-baseline')
    inspected = ExplorerService(s).inspect(str(m['files']['sales']), limit=25)
    save('parquet-inspection', inspected)
    assert inspected['metadata']['row_count'] == 10000
    assert inspected['metadata']['num_row_groups'] >= 1
    assert len(inspected['rows']) == 25
    assert {'scenario','sales_key','customer_key','product_key','store_key','order_date','net_revenue'} <= set(inspected['columns'])
    with sqlite3.connect(s.catalog_path) as con:
        assert con.execute('select count(*) from ducklake_table').fetchone()[0] >= 5
    print('GENERATION_PASS', flush=True)
elif sys.argv[1] == 'verify':
    catalog = lake.catalog()
    save('persisted-catalog', catalog)
    assert {r['name'] for r in catalog if r['schema']=='bronze'} == {'customer','currency_exchange','product','sales','store'}
    assert lake.query('select count(*) from contoso.bronze.sales', 10)[1][0][0] == 10000
    print('SEPARATE_PROCESS_PERSISTENCE_PASS', flush=True)
elif sys.argv[1] == 'flow':
    catalog = lake.catalog()
    save('built-catalog', catalog)
    assert 'stg_sales' in {r['name'] for r in catalog if r['schema']=='silver'}
    assert {'monthly_sales','channel_performance','delivery_metrics','currency_exposure','product_performance','store_performance'} <= {r['name'] for r in catalog if r['schema']=='gold'}
    quality = dbt.quality(); save('quality', quality)
    assert quality['summary']['pass'] == quality['summary']['total'] == 70
    lineage = dbt.lineage(); save('lineage', lineage)
    assert lineage['nodes'] and lineage['edges']
    board = ChartsService(s).board('executive-sales.yml'); save('charts-board', board)
    for q in board['queries']:
        if q.get('sql'):
            result = lake.query(q['sql'], 100)
            assert result[0] and result[1]
            save('board-query-'+q['name'], result)
    sql = 'select store_country as country, round(sum(revenue),2) revenue, round(sum(gross_margin),2) gross_margin, round(sum(gross_margin)/nullif(sum(revenue),0),4) margin_rate from contoso.gold.store_performance group by 1 order by revenue desc'
    start = time.perf_counter(); result=lake.query(sql,100)
    print('gold_query_seconds', time.perf_counter()-start, flush=True)
    save('gold-query', result)
    assert result[0] == ['country','revenue','gross_margin','margin_rate'] and result[1]
    ready=state.state(); save('retail-ready',ready)
    assert ready['ready'] and ready['gold_current'] and ready['active_scenario']=='retail-baseline'
    generate('margin-pressure')
    stale=state.state(); save('margin-stale',stale)
    assert stale['active_scenario']=='margin-pressure' and not stale['gold_current'] and not stale['ready']
    start=time.perf_counter(); build=dbt.run('build')
    (out/'margin-dbt-build.log').write_text(build['output'], encoding='utf-8')
    print('margin_build_seconds',time.perf_counter()-start,flush=True)
    assert build['ok'], build['output']
    refreshed=state.state(); save('margin-rebuilt',refreshed)
    assert refreshed['gold_scenarios']==['margin-pressure'] and refreshed['gold_current'] and refreshed['ready']
    print('INDEPENDENT_RELEASE_FLOW_AND_STALE_PASS',flush=True)
