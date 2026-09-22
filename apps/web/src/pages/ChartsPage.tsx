import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardHeader, Text, Title3 } from "@fluentui/react-components";

import { getJson, postJson } from "../api";
import type { GenerationRunDetail, QueryResult } from "../types";
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

type Kpi = {
  label:string;
  value:string;
  detail?:string;
};

type ChartItem = {
  label:string;
  value:number;
  detail:string;
};

type ChartFormat = "money"|"percent"|"days"|"decimal"|"number";

function money(value:number) {
  return new Intl.NumberFormat(undefined,{style:"currency",currency:"USD",maximumFractionDigits:0}).format(value);
}

function number(value:number) {
  return new Intl.NumberFormat(undefined,{maximumFractionDigits:0}).format(value);
}

function percent(value:number) {
  return `${(value*100).toFixed(1)}%`;
}

function chartValue(value:number,format:ChartFormat) {
  if (format==="money") return money(value);
  if (format==="percent") return percent(value);
  if (format==="days") return `${value.toFixed(1)} days`;
  if (format==="decimal") return value.toFixed(4);
  return number(value);
}

export default function ChartsPage() {
  const [status,setStatus] = useState<ChartsStatus|null>(null);
  const [activeRun,setActiveRun] = useState<GenerationRunDetail|null>(null);
  const [goldScenario,setGoldScenario] = useState<string|null>(null);
  const [kpis,setKpis] = useState<Kpi[]>([]);
  const [chartItems,setChartItems] = useState<ChartItem[]>([]);
  const [chartTitle,setChartTitle] = useState("Gold KPI preview");
  const [chartFormat,setChartFormat] = useState<ChartFormat>("money");
  const [validation,setValidation] = useState<ValidationResult|null>(null);
  const [dashboardError,setDashboardError] = useState("");
  const [validationError,setValidationError] = useState("");
  const [validating,setValidating] = useState(false);

  useEffect(()=>{
    void loadDashboard();
    getJson<ChartsStatus>("/api/charts/status").then(setStatus).catch(()=>{});
  },[]);

  async function loadDashboard() {
    setDashboardError("");
    setKpis([]);
    setChartItems([]);
    try {
      const active=await getJson<{run:GenerationRunDetail|null}>("/api/workspace/active-run");
      setActiveRun(active.run);
      if (!active.run?.scenario) {
        setGoldScenario(null);
        return;
      }

      const scenarioResult=await postJson<QueryResult>("/api/query",{
        sql:"select scenario from contoso.gold.monthly_sales group by 1 order by 1",
        limit:10,
      });
      const scenarios=scenarioResult.rows.map(row=>String(row[0]));
      const currentGold=scenarios.length===1 ? scenarios[0] : scenarios.join(", ");
      setGoldScenario(currentGold || null);
      if (scenarios.length!==1 || currentGold!==active.run.scenario) return;

      await loadScenarioDashboard(active.run.scenario);
    } catch (err) {
      setDashboardError(err instanceof Error ? err.message : "Gold KPI query failed.");
    }
  }

  async function loadScenarioDashboard(scenario:string) {
    if (scenario==="online-migration") {
      const result=await postJson<QueryResult>("/api/query",{
        sql:"select order_year, revenue_share, revenue from contoso.gold.channel_performance where channel='Online' order by order_year",
        limit:20,
      });
      const rows=result.rows.map(row=>({
        year:Number(row[0]),
        share:Number(row[1] ?? 0),
        revenue:Number(row[2] ?? 0),
      }));
      const y2024=rows.find(row=>row.year===2024);
      const y2025=rows.find(row=>row.year===2025);
      const shift=(y2025?.share ?? 0)-(y2024?.share ?? 0);
      setKpis([
        {label:"Online share · 2024",value:percent(y2024?.share ?? 0)},
        {label:"Online share · 2025",value:percent(y2025?.share ?? 0)},
        {label:"Channel shift",value:`${shift>=0?"+":""}${(shift*100).toFixed(1)} pp`,detail:"2025 vs 2024"},
      ]);
      setChartTitle("Online revenue share by year");
      setChartFormat("percent");
      setChartItems(rows.map(row=>({
        label:String(row.year),
        value:row.share,
        detail:`${percent(row.share)} · ${money(row.revenue)} revenue`,
      })));
      return;
    }

    if (scenario==="margin-pressure") {
      const result=await postJson<QueryResult>("/api/query",{
        sql:"select extract(year from order_month)::integer yr, sum(gross_margin)/nullif(sum(revenue),0) margin_rate, avg(avg_discount_rate) discount_rate, sum(revenue) revenue from contoso.gold.monthly_sales group by 1 order by 1",
        limit:20,
      });
      const rows=result.rows.map(row=>({
        year:Number(row[0]),
        margin:Number(row[1] ?? 0),
        discount:Number(row[2] ?? 0),
        revenue:Number(row[3] ?? 0),
      }));
      const y2024=rows.find(row=>row.year===2024);
      const y2025=rows.find(row=>row.year===2025);
      const compression=(y2025?.margin ?? 0)-(y2024?.margin ?? 0);
      setKpis([
        {label:"Gross margin · 2024",value:percent(y2024?.margin ?? 0)},
        {label:"Gross margin · 2025",value:percent(y2025?.margin ?? 0)},
        {label:"Margin change",value:`${compression>=0?"+":""}${(compression*100).toFixed(1)} pp`,detail:`2025 discount ${percent(y2025?.discount ?? 0)}`},
      ]);
      setChartTitle("Gross margin rate by year");
      setChartFormat("percent");
      setChartItems(rows.map(row=>({
        label:String(row.year),
        value:row.margin,
        detail:`${percent(row.margin)} margin · ${percent(row.discount)} avg discount`,
      })));
      return;
    }

    if (scenario==="logistics-delays") {
      const result=await postJson<QueryResult>("/api/query",{
        sql:"select channel, round(avg(avg_delivery_days),2) avg_days, round(avg(p90_delivery_days),2) p90_days, round(avg(over_7_day_rate),4) over_7_rate from contoso.gold.delivery_metrics group by 1 order by 1",
        limit:20,
      });
      const rows=result.rows.map(row=>({
        channel:String(row[0]),
        avgDays:Number(row[1] ?? 0),
        p90Days:Number(row[2] ?? 0),
        over7:Number(row[3] ?? 0),
      }));
      const online=rows.find(row=>row.channel==="Online");
      setKpis([
        {label:"Online avg delivery",value:`${(online?.avgDays ?? 0).toFixed(1)} days`},
        {label:"Online p90",value:`${(online?.p90Days ?? 0).toFixed(1)} days`},
        {label:"Online >7 days",value:percent(online?.over7 ?? 0)},
      ]);
      setChartTitle("Average delivery days by channel");
      setChartFormat("days");
      setChartItems(rows.map(row=>({
        label:row.channel,
        value:row.avgDays,
        detail:`${row.avgDays.toFixed(1)} avg · p90 ${row.p90Days.toFixed(1)} · >7d ${percent(row.over7)}`,
      })));
      return;
    }

    if (scenario==="currency-exposure") {
      const result=await postJson<QueryResult>("/api/query",{
        sql:"select currency, min(avg_exchange_rate_to_usd) min_rate, max(avg_exchange_rate_to_usd) max_rate, max(avg_exchange_rate_to_usd)-min(avg_exchange_rate_to_usd) spread, sum(revenue_usd) revenue_usd from contoso.gold.currency_exposure group by 1 order by spread desc",
        limit:20,
      });
      const rows=result.rows.map(row=>({
        currency:String(row[0]),
        minRate:Number(row[1] ?? 0),
        maxRate:Number(row[2] ?? 0),
        spread:Number(row[3] ?? 0),
        revenue:Number(row[4] ?? 0),
      }));
      const volatile=rows[0];
      const totalRevenue=rows.reduce((sum,row)=>sum+row.revenue,0);
      setKpis([
        {label:"Most volatile",value:volatile?.currency ?? "—",detail:volatile ? `spread ${volatile.spread.toFixed(4)}` : undefined},
        {label:"Largest FX spread",value:(volatile?.spread ?? 0).toFixed(4)},
        {label:"Revenue normalized",value:money(totalRevenue),detail:"USD"},
      ]);
      setChartTitle("Observed FX spread by currency");
      setChartFormat("decimal");
      setChartItems(rows.map(row=>({
        label:row.currency,
        value:row.spread,
        detail:`${row.spread.toFixed(4)} spread · ${money(row.revenue)} revenue`,
      })));
      return;
    }

    const [metricsResult,trendResult]=await Promise.all([
      postJson<QueryResult>("/api/query",{
        sql:"select round(sum(revenue),2) revenue, round(sum(gross_margin),2) gross_margin, sum(units) units from contoso.gold.monthly_sales",
        limit:10,
      }),
      postJson<QueryResult>("/api/query",{
        sql:"select order_month, round(sum(revenue),2) revenue from contoso.gold.monthly_sales group by 1 order by 1",
        limit:100,
      }),
    ]);
    const row=metricsResult.rows[0] ?? [];
    setKpis([
      {label:"Revenue",value:money(Number(row[0] ?? 0))},
      {label:"Gross margin",value:money(Number(row[1] ?? 0))},
      {label:"Units sold",value:number(Number(row[2] ?? 0))},
    ]);
    setChartTitle("Monthly revenue");
    setChartFormat("money");
    setChartItems(trendResult.rows.map(row=>({
      label:String(row[0]).slice(0,7),
      value:Number(row[1] ?? 0),
      detail:`${String(row[0]).slice(0,7)} · ${money(Number(row[1] ?? 0))}`,
    })));
  }

  const maxValue = useMemo(
    ()=>Math.max(1e-9,...chartItems.map(item=>item.value)),
    [chartItems],
  );
  const board = status?.boards[0] ?? "executive-sales.yml";
  const goldCurrent = Boolean(
    activeRun?.scenario && goldScenario && activeRun.scenario===goldScenario
  );

  async function validateBoard() {
    setValidating(true); setValidationError("");
    try {
      setValidation(await postJson<ValidationResult>(`/api/charts/validate?board=${encodeURIComponent(board)}`,{}));
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : "Board validation failed.");
    } finally {
      setValidating(false);
    }
  }

  return <div className="chartsStack">
    <Card className="scenarioContextCard">
      <CardHeader
        header={<Title3>{activeRun?.scenario_name ?? "No active Bronze scenario"}</Title3>}
        description={activeRun?.business_focus ?? "Generate or reload a Contoso run to establish the active scenario."}
        action={<div className="buttonRow">
          {activeRun?.active_snapshot_id!=null && <Badge appearance="outline">Bronze #{activeRun.active_snapshot_id}</Badge>}
          {activeRun && <Badge appearance="outline" color={goldCurrent?"success":"warning"}>
            {goldCurrent ? "Gold current" : goldScenario ? "Gold stale" : "Gold unavailable"}
          </Badge>}
          <Button size="small" onClick={()=>void loadDashboard()}>Refresh</Button>
        </div>}
      />
      {activeRun && goldScenario && !goldCurrent && <div className="staleGoldWarning">
        Active Bronze contains <b>{activeRun.scenario}</b>, but Gold contains <b>{goldScenario}</b>. Run <b>dbt Build</b> in Transform before using these KPIs.
      </div>}
      {dashboardError && <div className="errorText">{dashboardError}</div>}
    </Card>

    {goldCurrent && <>
      <div className="kpiGrid">
        {kpis.map(kpi=><Card key={kpi.label}>
          <Text className="kpiLabel">{kpi.label}</Text>
          <div className="kpiValue">{kpi.value}</div>
          {kpi.detail && <Text className="muted tiny">{kpi.detail}</Text>}
        </Card>)}
      </div>

      <Card>
        <CardHeader
          header={<Title3>{chartTitle}</Title3>}
          description={activeRun?.scenario_name ?? "Gold mart"}
        />
        {chartItems.length ? <div className="barChart" aria-label={chartTitle}>
          {chartItems.map((item,index)=><div className="barSlot" key={`${item.label}-${index}`} title={item.detail}>
            <div className="bar" style={{height:`${Math.max(3,(item.value/maxValue)*100)}%`}}/>
            {(chartItems.length<=8 || index%3===0 || index===chartItems.length-1) && <span>{item.label}</span>}
          </div>)}
        </div> : <div className="emptyState">No Gold chart rows for this scenario.</div>}
        {chartItems.length>0 && <div className="chartFootnote">
          {chartItems.slice(0,6).map(item=><span key={item.detail}>{item.label}: {chartValue(item.value,chartFormat)}</span>)}
        </div>}
      </Card>
    </>}

    {!goldCurrent && !dashboardError && <Card>
      <CardHeader header={<Title3>Scenario KPIs unavailable</Title3>} description="Gold must be rebuilt from the active Bronze run."/>
      <Text className="muted">Generate or reload Bronze, then open Transform and run dbt Build. The dashboard refuses to mix KPIs from a previous scenario with the current Bronze data.</Text>
    </Card>}

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
      {validationError && <div className="errorText">{validationError}</div>}
      {validation && <div className={validation.ok?"validationOk":"errorText"}>
        {validation.ok ? "Board validates successfully." : `Validation failed (exit ${validation.exit_code}).`}
      </div>}
      {validation?.output && <details className="consoleDetails"><summary>Validation output</summary><pre>{validation.output}</pre></details>}
      <div className="serveHint"><Text className="muted tiny">Live dbt Charts renderer:</Text><code>dct serve --project-dir . --dbt-project-dir dbt</code></div>
    </Card>
  </div>;
}
