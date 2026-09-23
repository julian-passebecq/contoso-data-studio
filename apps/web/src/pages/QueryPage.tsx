import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardHeader, Text, Title3 } from "@fluentui/react-components";
import { getJson, postJson } from "../api";
import DataTable from "../components/DataTable";
import type { CatalogTable, QueryResult, WorkspaceProjectState } from "../types";
import { completeTutorialStep, isGoldQuery } from "../tutorialProgress";

const DEFAULT_SQL = "select *\nfrom contoso.bronze.sales\nlimit 100;";

const EXAMPLES = [
  {
    name:"Revenue by channel",
    sql:"select channel, round(sum(net_revenue),2) as revenue\nfrom contoso.bronze.sales\ngroup by channel\norder by revenue desc;",
  },
  {
    name:"Monthly Gold KPI",
    sql:"select order_month, channel, revenue, gross_margin, gross_margin_rate\nfrom contoso.gold.monthly_sales\norder by order_month, channel\nlimit 100;",
  },
  {
    name:"Top products",
    sql:"select p.product_name, p.category, round(sum(s.net_revenue),2) revenue\nfrom contoso.bronze.sales s\njoin contoso.bronze.product p using(product_key)\ngroup by 1,2\norder by revenue desc\nlimit 20;",
  },
];

type HistoryItem = {sql:string; ranAt:string; rows:number};

function csvCell(value:unknown) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"','""')}"` : text;
}

export default function QueryPage({initialSql}:{initialSql?:string}) {
  const [sql,setSql] = useState(initialSql || DEFAULT_SQL);
  const [catalog,setCatalog] = useState<CatalogTable[]>([]);
  const [result,setResult] = useState<QueryResult|null>(null);
  const [error,setError] = useState("");
  const [running,setRunning] = useState(false);
  const [projectState,setProjectState] = useState<WorkspaceProjectState|null>(null);
  const [history,setHistory] = useState<HistoryItem[]>(()=>{
    try { return JSON.parse(localStorage.getItem("contoso-query-history") ?? "[]"); }
    catch { return []; }
  });

  useEffect(()=>{ if (initialSql) setSql(initialSql); },[initialSql]);
  useEffect(()=>{ getJson<{tables:CatalogTable[]}>("/api/lakehouse/catalog").then(d=>setCatalog(d.tables)).catch(()=>{}); },[]);
  useEffect(()=>{
    getJson<WorkspaceProjectState>("/api/workspace/project-state")
      .then(setProjectState)
      .catch(()=>setProjectState(null));
  },[]);

  const grouped = useMemo(()=>({
    bronze:catalog.filter(t=>t.schema==="bronze"),
    silver:catalog.filter(t=>t.schema==="silver"),
    gold:catalog.filter(t=>t.schema==="gold"),
  }),[catalog]);

  async function run() {
    setRunning(true); setError("");
    try {
      const next = await postJson<QueryResult>("/api/query",{sql,limit:500});
      setResult(next);
      if (
        projectState?.active_scenario &&
        projectState.gold_current &&
        isGoldQuery(sql)
      ) {
        completeTutorialStep("query",projectState.active_scenario);
      }
      const item:HistoryItem = {sql,ranAt:new Date().toISOString(),rows:next.row_count};
      setHistory(previous=>{
        const updated=[item,...previous.filter(entry=>entry.sql!==sql)].slice(0,12);
        localStorage.setItem("contoso-query-history",JSON.stringify(updated));
        return updated;
      });
    } catch (err) {
      setResult(null); setError(err instanceof Error ? err.message : "Query failed.");
    } finally {
      setRunning(false);
    }
  }

  function openTable(table: CatalogTable) {
    setSql(`select *\nfrom contoso.${table.schema}.${table.name}\nlimit 100;`);
  }

  function exportCsv() {
    if (!result) return;
    const lines=[
      result.columns.map(csvCell).join(","),
      ...result.rows.map(row=>row.map(csvCell).join(",")),
    ];
    const blob=new Blob([lines.join("\n")],{type:"text/csv;charset=utf-8"});
    const url=URL.createObjectURL(blob);
    const anchor=document.createElement("a");
    anchor.href=url;
    anchor.download="contoso-query-result.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return <div className="workbench queryWorkbench">
    <Card className="catalogPane">
      <CardHeader header={<Title3>Catalog</Title3>}/>
      {(["bronze","silver","gold"] as const).map(layer=><div className="catalogGroup" key={layer}>
        <div className="catalogLabel">{layer.toUpperCase()}</div>
        {grouped[layer].map(table=><button key={table.name} onClick={()=>openTable(table)}>{table.name}</button>)}
        {!grouped[layer].length && <Text className="muted tiny">No tables</Text>}
      </div>)}
      <div className="catalogGroup">
        <div className="catalogLabel">EXAMPLES</div>
        {EXAMPLES.map(example=><button key={example.name} onClick={()=>setSql(example.sql)}>{example.name}</button>)}
      </div>
    </Card>

    <div className="editorStack">
      <Card>
        <CardHeader
          header={<Title3>DuckDB SQL</Title3>}
          description="Read-only local workbench · Ctrl/Cmd + Enter to run"
          action={<Button appearance="primary" disabled={running} onClick={run}>{running?"Running...":"Run"}</Button>}
        />
        <textarea
          className="sqlEditor"
          spellCheck={false}
          value={sql}
          onChange={event=>setSql(event.target.value)}
          onKeyDown={event=>{
            if (event.key==="Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void run();
            }
          }}
        />
        {error && <div className="errorText">{error}</div>}
      </Card>

      <Card>
        <CardHeader
          header={<Title3>Results</Title3>}
          action={result?<div className="buttonRow">
            <Badge appearance="outline">{result.row_count}{result.truncated?"+":""} rows</Badge>
            <Button onClick={exportCsv}>Export CSV</Button>
          </div>:undefined}
        />
        {result ? <DataTable columns={result.columns} rows={result.rows}/> : <Text className="muted">Run a query to inspect the result.</Text>}
      </Card>

      <Card>
        <CardHeader
          header={<Title3>Query history</Title3>}
          description="Stored locally in this browser"
          action={history.length?<Button onClick={()=>{
            setHistory([]);
            localStorage.removeItem("contoso-query-history");
          }}>Clear</Button>:undefined}
        />
        <div className="queryHistory">
          {history.map((item,index)=><button key={`${item.ranAt}-${index}`} onClick={()=>setSql(item.sql)}>
            <code>{item.sql.replace(/\s+/g," ").slice(0,110)}</code>
            <span>{item.rows} rows · {new Date(item.ranAt).toLocaleString()}</span>
          </button>)}
          {!history.length && <Text className="muted tiny">No queries run yet.</Text>}
        </div>
      </Card>
    </div>
  </div>;
}
