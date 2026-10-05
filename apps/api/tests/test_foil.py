from pathlib import Path

from app.config import Settings
from app.services.generator import GeneratorService
from app.services.ducklake import DuckLakeService
from app.services.dbt_runner import DbtService
from app.services.workspace_state import WorkspaceStateService

def settings(monkeypatch,tmp_path):
    root=Path(__file__).resolve().parents[3]
    workspace=tmp_path/'workspace'
    monkeypatch.setenv('CONTOSO_WORKSPACE',str(workspace))
    monkeypatch.setenv('CONTOSO_PROJECT_ROOT',str(root))
    monkeypatch.setenv('CONTOSO_DUCKLAKE_CATALOG',str(workspace/'lake.sqlite'))
    monkeypatch.setenv('CONTOSO_DUCKLAKE_DATA_PATH',str(workspace/'lake.files'))
    return Settings.load()

def test_foil_reproduction_and_reference_provenance(monkeypatch,tmp_path):
    g=GeneratorService(settings(monkeypatch,tmp_path))
    first=g.generate('foil-energy-risk',1000,42)
    second=g.generate('foil-energy-risk',1000,42)
    assert first['file_sha256']==second['file_sha256']
    assert first['row_counts']=={'foil_cases':9,'foil_trials':1000,'foil_sensitivity':135}
    assert first['methodology']['aep_p90'].startswith('10th percentile')
    assert g.get_run(first['run_id'])['integrity_tracked']
    assert g.run_files(first['run_id'],verify_hashes=True)
    changed=g.generate('foil-energy-risk',1000,43)
    assert changed['file_sha256']['foil_trials']!=first['file_sha256']['foil_trials']

def test_foil_dbt_accounting_risk_and_stale_state(monkeypatch,tmp_path):
    s=settings(monkeypatch,tmp_path)
    g,lake,dbt=GeneratorService(s),DuckLakeService(s),DbtService(s)
    state=WorkspaceStateService(g,lake,dbt)
    def activate(scenario):
        m=g.generate(scenario,1000,42)
        lake.load_parquet_to_bronze(g.run_files(m['run_id'],True))
        g.mark_bronze_loaded(m['run_id'],int(lake.snapshots(1)[0]['snapshot_id']))
        return m
    activate('foil-energy-risk')
    build=dbt.run('build'); assert build['ok'],build['output']
    assert state.state()['ready']
    _,rows,_=lake.query('select lcoe_eur_mwh, reference_lcoe_eur_mwh, aep_p50_mwh, aep_p90_mwh from contoso.gold.foil_project_summary',100)
    assert len(rows)==9
    for lcoe,reference,p50,p90 in rows:
        assert abs(lcoe-reference)<1e-8
        assert 0<p90<p50
    assert dbt.quality()['summary']['fail']==dbt.quality()['summary']['error']==0
    assert all(node['name'].startswith('foil_') for node in dbt.lineage()['nodes'])
    # Independently recompute the selected trial's discounted lifetime cashflows.
    _,data,_=lake.query("select aep_year1_mwh,capex_eur,opex_eur_year,discount_rate,price_eur_mwh from contoso.bronze.foil_trials where trial_key=1",10)
    aep,capex,opex,rate,price=data[0]
    _,case,_=lake.query("select life_years,degradation_rate,replacement_year,replacement_fraction,terminal_fraction from contoso.bronze.foil_cases where case_id=(select case_id from contoso.bronze.foil_trials where trial_key=1)",10)
    life,degradation,replacement_year,replacement_fraction,terminal_fraction=case[0]
    cost,energy=capex,0
    for year in range(1,life+1):
        disc=(1+rate)**(-year)
        energy+=aep*(1-degradation)**(year-1)*disc
        cost+=(opex+(capex*replacement_fraction if year==replacement_year else 0)+(capex*terminal_fraction if year==life else 0))*disc
    _,metrics,_=lake.query("select pv_cost_eur,pv_energy_mwh,npv_eur,lcoe_eur_mwh from contoso.gold.foil_experiment_metrics where experiment_id='trial:1'",10)
    pc,pe,npv,lcoe=metrics[0]
    assert abs(pc-cost)<1e-7 and abs(pe-energy)<1e-8
    assert abs(npv-(price*energy-cost))<1e-7 and abs(lcoe-cost/energy)<1e-8
    _,base,_=lake.query("select npv_eur,lcoe_eur_mwh from contoso.gold.foil_project_summary where case_id='FOIL-WIND-A-N-R0'",10)
    activate('foil-investment')
    assert not state.state()['gold_current'] and not state.state()['ready']
    build=dbt.run('build'); assert build['ok'],build['output']
    assert state.state()['ready'] and state.state()['gold_scenarios']==['foil-investment']
    _,stress,_=lake.query("select npv_eur,lcoe_eur_mwh from contoso.gold.foil_project_summary where case_id='FOIL-WIND-A-N-R0'",10)
    assert stress[0][0]<base[0][0] and stress[0][1]>base[0][1]
    _,sens,_=lake.query("select driver,npv_delta_eur,lcoe_delta_eur_mwh from contoso.gold.foil_sensitivity where case_id='FOIL-WIND-A-N-R0' and relative_change>0",100)
    effects={r[0]:r[1:] for r in sens}
    assert effects['capex_eur'][0]<0 and effects['capex_eur'][1]>0
    assert effects['aep_year1_mwh'][0]>0 and effects['aep_year1_mwh'][1]<0
    assert effects['price_eur_mwh'][0]>0 and abs(effects['price_eur_mwh'][1])<1e-9
