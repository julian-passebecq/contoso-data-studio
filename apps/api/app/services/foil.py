"""Reproducible, synthetic decision experiments anchored to FOIL Wind R0."""
import hashlib
import json
from pathlib import Path
import random

import duckdb

FOIL_SCENARIOS = {
    'foil-energy-risk': {'name': 'FOIL · Energy uncertainty', 'description': 'Conditional AEP P50/P90 screening across nine FOIL Wind reference cases.', 'focus': 'AEP, exceedance probabilities and uncertainty assumptions.'},
    'foil-investment': {'name': 'FOIL · Investment stress', 'description': 'CAPEX +30% and OPEX +20% against the FOIL reference budgets.', 'focus': 'Real EUR 2026 cashflows, LCOE, NPV and break-even price.'},
    'foil-sensitivity': {'name': 'FOIL · Sensitivity lab', 'description': 'One-at-a-time changes in energy, CAPEX, OPEX, discount rate and electricity price.', 'focus': 'Local sensitivities and decision drivers; not causal field evidence.'},
}
FOIL_FILES = ('foil_cases', 'foil_trials', 'foil_sensitivity')

def write_parquet(con, rows, path):
    # JSON records retain typed fields without adding pandas/Arrow dependencies.
    raw = path.with_suffix('.json')
    raw.write_text(json.dumps(rows, allow_nan=False), encoding='utf-8')
    src = raw.as_posix().replace("'", "''")
    dst = path.as_posix().replace("'", "''")
    con.execute(f"COPY (SELECT * FROM read_json_auto('{src}', maximum_object_size=16777216)) TO '{dst}' (FORMAT PARQUET)")
    raw.unlink()

def generate_foil(root: Path, output: Path, scenario: str, scale: int, seed: int):
    if not 100 <= scale <= 100_000:
        raise ValueError('FOIL decision experiments support 100 to 100,000 total simulation draws')
    reference = root / 'data/foil/reference_cases.json'
    refs = json.loads(reference.read_text(encoding='utf-8'))
    rng = random.Random(seed)
    stress = scenario == 'foil-investment'
    cases, trials, sensitivities = [], [], []
    for ref in refs['cases']:
        cases.append({**ref, 'scenario': scenario,
                      'capex_eur': ref['reference_capex_eur'] * (1.3 if stress else 1),
                      'opex_eur_year': ref['reference_opex_eur_year'] * (1.2 if stress else 1),
                      'price_eur_mwh': 160.0})
    for i in range(scale):
        case = cases[i % len(cases)]
        # Illustrative assumptions; independent draws conditional on each D/N/F case.
        resource_factor = rng.lognormvariate(-0.12**2 / 2, 0.12)
        availability = rng.triangular(max(0.01, case['availability']-0.05), min(1, case['availability']+0.05), case['availability'])
        trials.append({'scenario': scenario, 'trial_key': i+1, 'case_id': case['case_id'],
            'resource_factor': resource_factor, 'availability': availability,
            'aep_year1_mwh': case['reference_aep_mwh'] * resource_factor * availability / case['availability'],
            'capex_eur': case['capex_eur'] * rng.lognormvariate(-0.15**2/2, 0.15),
            'opex_eur_year': case['opex_eur_year'] * rng.lognormvariate(-0.1**2/2, 0.1),
            'discount_rate': rng.triangular(max(0,case['discount_rate']-0.02),case['discount_rate']+0.02,case['discount_rate']),
            'price_eur_mwh': case['price_eur_mwh'] * rng.triangular(0.75,1.25,1),
            'seed': seed, 'classification': 'SYNTHETIC_CONDITIONAL_SCREENING'})
    for case in cases:
        for driver in ('aep_year1_mwh','capex_eur','opex_eur_year','discount_rate','price_eur_mwh'):
            for change in (-0.2, 0, 0.2):
                row = {'scenario':scenario,'case_id':case['case_id'],'driver':driver,'relative_change':change,
                       'aep_year1_mwh':case['reference_aep_mwh'], 'capex_eur':case['capex_eur'],
                       'opex_eur_year':case['opex_eur_year'], 'discount_rate':case['discount_rate'],
                       'price_eur_mwh':case['price_eur_mwh']}
                row[driver] *= 1+change
                sensitivities.append(row)
    files = {name: output / (name+'.parquet') for name in FOIL_FILES}
    with duckdb.connect(':memory:') as con:
        for name, rows in zip(FOIL_FILES,(cases,trials,sensitivities)):
            write_parquet(con, rows, files[name])
    return files, {name:len(rows) for name,rows in zip(FOIL_FILES,(cases,trials,sensitivities))}, {
        'reference_sha256':hashlib.sha256(reference.read_bytes()).hexdigest(),
        'source_commit': refs['source_commit'], 'fidelity':'L0 screening; no measured site data',
        'aep_p90':'10th percentile of annual energy; 90% modelled exceedance',
        'cost_p90':'90th percentile of cost; different direction from energy exceedance',
        'uncertainty':'Independent illustrative lognormal resource sigma=0.12, CAPEX sigma=0.15, OPEX sigma=0.10; triangular availability ±0.05, real discount ±0.02, price ±25%. No calibrated joint distribution.',
        'price':'160 EUR2026/MWh illustrative constant real price, not a market quote',
        'exclusions':'R&D, taxes, financing structure, grid reinforcement, floating support, moorings and marine operations; no offshore/commercial readiness claim',
        'dnf':'D/N/F are distinct assumption sets, not probability quantiles',
    }
