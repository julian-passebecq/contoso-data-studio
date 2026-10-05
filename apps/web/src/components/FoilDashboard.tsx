import { useEffect, useState } from "react";
import { Card, CardHeader, Text, Title3 } from "@fluentui/react-components";
import { postJson } from "../api";
import type { QueryResult } from "../types";
import DataTable from "./DataTable";
import "../foil.css";

type Case = {id:string;p50:number;p90:number;lcoe:number;npv:number;capex:number;opex:number;probability:number;draws:number;source:string};
const decimal=(value:number,digits=2)=>new Intl.NumberFormat(undefined,{maximumFractionDigits:digits}).format(value);
const eur=(value:number)=>`${decimal(value,0)} EUR`;

export default function FoilDashboard({scenario}:{scenario:string}) {
  const [cases,setCases]=useState<Case[]>([]);
  const [sensitivity,setSensitivity]=useState<QueryResult|null>(null);
  const [cashflows,setCashflows]=useState<QueryResult|null>(null);
  const [selected,setSelected]=useState("FOIL-WIND-A-N-R0");
  const [error,setError]=useState("");
  useEffect(()=>{
    let current=true;
    const filter=scenario.replaceAll("'","''");
    setError(""); setCases([]); setSensitivity(null); setCashflows(null);
    Promise.all([
      postJson<QueryResult>("/api/query",{sql:`select case_id,aep_p50_mwh,aep_p90_mwh,lcoe_eur_mwh,npv_eur,capex_eur,opex_eur_year,positive_npv_probability,draw_count,source_url from contoso.gold.foil_project_summary where scenario='${filter}' order by case_id`,limit:100}),
      postJson<QueryResult>("/api/query",{sql:`select case_id,driver,relative_change,npv_eur,npv_delta_eur,lcoe_delta_eur_mwh from contoso.gold.foil_sensitivity where scenario='${filter}' order by case_id,driver,relative_change`,limit:200}),
      postJson<QueryResult>("/api/query",{sql:`select case_id,year,energy_mwh,investment_eur,operating_cost_eur,replacement_eur,terminal_net_cost_eur,revenue_eur,net_cashflow_eur,discounted_cashflow_eur from contoso.gold.foil_cashflow_schedule where scenario='${filter}' order by case_id,year`,limit:500}),
    ]).then(([summary,sens,cash])=>{
      if(!current) return;
      setCases(summary.rows.map(r=>({id:String(r[0]),p50:Number(r[1]),p90:Number(r[2]),lcoe:Number(r[3]),npv:Number(r[4]),capex:Number(r[5]),opex:Number(r[6]),probability:Number(r[7]),draws:Number(r[8]),source:String(r[9])})));
      setSensitivity(sens); setCashflows(cash);
    }).catch(e=>{if(current) setError(e instanceof Error?e.message:"FOIL data could not load.");});
    return ()=>{current=false;};
  },[scenario]);
  const selectedCase=cases.find(c=>c.id===selected);
  const visibleSens=sensitivity?.rows.filter(r=>r[0]===selected) ?? [];
  const maxEnergy=Math.max(1,...cases.map(c=>c.p50));
  const maxImpact=Math.max(1,...visibleSens.map(r=>Math.abs(Number(r[4]))));
  return <div className="foilDashboard">
    <Card>
      <CardHeader header={<Title3>FOIL Wind · Decision Lab</Title3>} description="dbt analytical and decision layers · synthetic L0 screening · real EUR 2026"/>
      <Text>Energy P90 is the 10th percentile: 90% of modelled draws exceed it. D/N/F are separate assumption sets, not quantiles. Cost P90 uses the opposite, 90th-percentile convention.</Text>
      <Text className="muted">Price: assumed 160 EUR/MWh. Independent illustrative uncertainties; no measured site or calibrated probability model. Budgets exclude R&amp;D, taxes, grid reinforcement, floating support, moorings and marine operations.</Text>
      {scenario==="foil-investment" && <Text>Investment stress: reference CAPEX +30%, OPEX +20%.</Text>}
      {error && <div className="errorText">{error}</div>}
      <label className="foilCasePicker">Reference case <select value={selected} onChange={e=>setSelected(e.target.value)}>{cases.map(c=><option key={c.id}>{c.id}</option>)}</select></label>
      {selectedCase && <a href={selectedCase.source} target="_blank" rel="noreferrer">FOIL source case and provenance</a>}
    </Card>
    {!error && !cases.length && <Card><Text>Loading FOIL decision marts…</Text></Card>}
    {selectedCase && <div className="foilKpis">
      <Card><Text>AEP P50 / P90 · MWh/year</Text><b>{decimal(selectedCase.p50)} / {decimal(selectedCase.p90)}</b><Text className="muted">{selectedCase.draws.toLocaleString()} conditional draws for this case</Text></Card>
      <Card><Text>LCOE / break-even price · EUR/MWh</Text><b>{decimal(selectedCase.lcoe)}</b><Text className="muted">Discounted cost / discounted energy</Text></Card>
      <Card><Text>NPV · EUR 2026</Text><b>{eur(selectedCase.npv)}</b><Text className="muted">Positive NPV in {(selectedCase.probability*100).toFixed(1)}% of illustrative draws</Text></Card>
      <Card><Text>CAPEX / annual OPEX</Text><b>{eur(selectedCase.capex)} / {eur(selectedCase.opex)}</b><Text className="muted">Budgets, not supplier quotations</Text></Card>
    </div>}
    {cases.length>0 && <Card>
      <CardHeader header={<Title3>Conditional energy · P50 versus P90</Title3>} description="MWh/year · zero-based common scale · blue P50, green P90 exceedance"/>
      <div className="foilEnergyChart" aria-label="FOIL AEP P50 and P90 comparison">{cases.map(c=><div className="foilEnergyRow" key={c.id}>
        <b>{c.id}</b><div><div className="foilEnergyBar p50" style={{width:`${100*c.p50/maxEnergy}%`}} title={`P50 ${decimal(c.p50)} MWh/year`}/><div className="foilEnergyBar p90" style={{width:`${100*c.p90/maxEnergy}%`}} title={`P90 ${decimal(c.p90)} MWh/year`}/></div><span>{decimal(c.p50)} / {decimal(c.p90)}</span>
      </div>)}</div>
    </Card>}
    {visibleSens.length>0 && <Card>
      <CardHeader header={<Title3>NPV sensitivity · one assumption at a time</Title3>} description={`${selected} · ±20% relative change · delta EUR 2026 from this case's baseline`}/>
      <div className="foilTornado" aria-label="FOIL signed NPV sensitivity">{visibleSens.filter(r=>Number(r[2])!==0).map(r=>{
        const delta=Number(r[4]); const width=50*Math.abs(delta)/maxImpact;
        return <div className="foilTornadoRow" key={`${r[1]}:${r[2]}`}><span>{String(r[1])} {Number(r[2])>0?"+":""}{Number(r[2])*100}%</span><div className="foilImpactTrack"><div className={delta>=0?"positive":"negative"} style={{left:`${delta>=0?50:50-width}%`,width:`${width}%`}}/></div><span>{delta>0?"+":""}{eur(delta)}</span></div>;
      })}</div>
      <DataTable columns={sensitivity!.columns.slice(1)} rows={visibleSens.map(r=>r.slice(1))}/>
    </Card>}
    {cashflows && <Card><CardHeader header={<Title3>Annual discounted cashflows</Title3>} description={`${selected} · year 0 CAPEX; real constant price/OPEX; degradation, replacement and terminal net cost included`}/><DataTable columns={cashflows.columns.slice(1)} rows={cashflows.rows.filter(r=>r[0]===selected).map(r=>r.slice(1))}/></Card>}
  </div>;
}
