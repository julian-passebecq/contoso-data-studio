import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardHeader, Text, Title3 } from "@fluentui/react-components";

import { getJson, postJson } from "../api";
import type { QueryResult } from "../types";
import "../charts.css";

type ChartsStatus = {
  available:boolean;
  version:string | null;
  boards:string[];
};

type ValidationResult = {
  board:string;
  ok:boolean;
  exit_code:number;
  output:string;
};

function money(value:number) {
  return new Intl.NumberFormat(undefined,{style:"currency",currency:"USD",maximumFractionDigits:0}).format(value);
}

function number(value:number) {
  return new Intl.NumberFormat(undefined,{maximumFractionDigits:0}).format(value);
}

export default function ChartsPage() {
  const [status,setStatus] = useState<ChartsStatus|null>(null);
  const [metrics,setMetrics] = useState<{revenue:number;margin:number;units:number}|null>(null);
  const [trend,setTrend] = useState<Array<{month:string;revenue:number}>>([]);
  const [validation,setValidation] = useState<ValidationResult|null>(null);
  const [error,setError] = useState("");
  const [validating,setValidating] = useState(false);

  useEffect(()=>{
    getJson<ChartsStatus>("/api/charts/status").then(setStatus).catch(()=>{});

    postJson<QueryResult>("/api/query",{
      sql:"select round(sum(revenue),2) revenue, round(sum(gross_margin),2) gross_margin, sum(units) units from contoso.gold.monthly_sales",
      limit:10,
    }).then(result=>{
      const row=result.rows[0] ?? [];
      setMetrics({revenue:Number(row[0] ?? 0),margin:Number(row[1] ?? 0),units:Number(row[2] ?? 0)});
    }).catch(err=>setError(err instanceof Error ? err.message : "Gold KPI query failed."));

    postJson<QueryResult>("/api/query",{
      sql:"select order_month, round(sum(revenue),2) revenue from contoso.gold.monthly_sales group by 1 order by 1",
      limit:100,
    }).then(result=>{
      setTrend(result.rows.map(row=>({month:String(row[0]),revenue:Number(row[1] ?? 0)})));
    }).catch(()=>{});
  },[]);

  const maxRevenue = useMemo(()=>Math.max(1,...trend.map(item=>item.revenue)),[trend]);
  const board = status?.boards[0] ?? "executive-sales.yml";

  async function validateBoard() {
    setValidating(true); setError("");
    try {
      setValidation(await postJson<ValidationResult>(`/api/charts/validate?board=${encodeURIComponent(board)}`,{}));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Board validation failed.");
    } finally {
      setValidating(false);
    }
  }

  return <div className="chartsStack">
    <div className="kpiGrid">
      <Card><Text className="kpiLabel">Revenue</Text><div className="kpiValue">{metrics?money(metrics.revenue):"—"}</div></Card>
      <Card><Text className="kpiLabel">Gross margin</Text><div className="kpiValue">{metrics?money(metrics.margin):"—"}</div></Card>
      <Card><Text className="kpiLabel">Units sold</Text><div className="kpiValue">{metrics?number(metrics.units):"—"}</div></Card>
    </div>

    <div className="chartGrid">
      <Card>
        <CardHeader header={<Title3>Gold data preview</Title3>} description="Same Gold mart used by the dbt Charts board"/>
        {trend.length ? <div className="barChart" aria-label="Monthly revenue">
          {trend.map((item,index)=><div className="barSlot" key={item.month} title={`${item.month}: ${money(item.revenue)}`}>
            <div className="bar" style={{height:`${Math.max(3,(item.revenue/maxRevenue)*100)}%`}}/>
            {(index%3===0 || index===trend.length-1) && <span>{item.month.slice(0,7)}</span>}
          </div>)}
        </div> : <div className="emptyState">Run Generate, then dbt Build, to populate Gold KPIs.</div>}
        {error && <div className="errorText">{error}</div>}
      </Card>

      <Card>
        <CardHeader
          header={<Title3>dbt Charts</Title3>}
          description="Declarative board validation / external live preview"
          action={<Button onClick={validateBoard} disabled={!status?.available || validating}>{validating?"Validating...":"Validate board"}</Button>}
        />
        <div className="chartRuntime">
          <div><span>Runtime</span><Badge appearance="outline" color={status?.available?"success":"warning"}>{status?.available?"dct available":"dct not on PATH"}</Badge></div>
          <div><span>Board</span><code>charts/{board}</code></div>
          <div><span>Source</span><code>dbt profile → DuckLake Gold</code></div>
        </div>
        {!status?.available && <div className="installHint">
          <Text>Keep dbt Charts isolated from the API environment:</Text>
          <code>uv tool install dbt-charts --with dbt-duckdb==1.11.0</code>
        </div>}
        {validation && <div className={validation.ok?"validationOk":"errorText"}>
          {validation.ok ? "Board validates successfully." : `Validation failed (exit ${validation.exit_code}).`}
        </div>}
        {validation?.output && <details className="consoleDetails"><summary>Validation output</summary><pre>{validation.output}</pre></details>}
        <div className="serveHint"><Text className="muted tiny">Live dbt Charts renderer:</Text><code>dct serve --project-dir . --dbt-project-dir dbt</code></div>
      </Card>
    </div>
  </div>;
}
