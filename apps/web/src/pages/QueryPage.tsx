import { useEffect, useState } from "react";
import { Badge, Button, Card, CardHeader, Text, Title3 } from "@fluentui/react-components";
import { getJson, postJson } from "../api";
import DataTable from "../components/DataTable";
import type { CatalogTable, QueryResult } from "../types";

const DEFAULT_SQL = "select *\nfrom contoso.bronze.sales\nlimit 100;";

export default function QueryPage({initialSql}:{initialSql?:string}) {
  const [sql,setSql] = useState(initialSql || DEFAULT_SQL);
  const [catalog,setCatalog] = useState<CatalogTable[]>([]);
  const [result,setResult] = useState<QueryResult|null>(null);
  const [error,setError] = useState("");
  const [running,setRunning] = useState(false);

  useEffect(()=>{ if (initialSql) setSql(initialSql); },[initialSql]);
  useEffect(()=>{ getJson<{tables:CatalogTable[]}>("/api/lakehouse/catalog").then(d=>setCatalog(d.tables)).catch(()=>{}); },[]);

  async function run() {
    setRunning(true); setError("");
    try {
      setResult(await postJson<QueryResult>("/api/query",{sql,limit:500}));
    } catch (err) {
      setResult(null); setError(err instanceof Error ? err.message : "Query failed.");
    } finally {
      setRunning(false);
    }
  }

  function openTable(table: CatalogTable) {
    setSql(`select *\nfrom contoso.${table.schema}.${table.name}\nlimit 100;`);
  }

  return <div className="workbench">
    <Card className="catalogPane">
      <CardHeader header={<Title3>Catalog</Title3>}/>
      {["bronze","silver","gold"].map(layer=><div className="catalogGroup" key={layer}>
        <div className="catalogLabel">{layer.toUpperCase()}</div>
        {catalog.filter(t=>t.schema===layer).map(table=><button key={table.name} onClick={()=>openTable(table)}>{table.name}</button>)}
      </div>)}
    </Card>
    <div className="editorStack">
      <Card>
        <CardHeader header={<Title3>DuckDB SQL</Title3>} description="Read-only local workbench" action={<Button appearance="primary" disabled={running} onClick={run}>{running?"Running...":"Run"}</Button>}/>
        <textarea className="sqlEditor" spellCheck={false} value={sql} onChange={event=>setSql(event.target.value)}/>
        {error && <div className="errorText">{error}</div>}
      </Card>
      <Card>
        <CardHeader header={<Title3>Results</Title3>} action={result?<Badge appearance="outline">{result.row_count}{result.truncated?"+":""} rows</Badge>:undefined}/>
        {result ? <DataTable columns={result.columns} rows={result.rows}/> : <Text className="muted">Run a query to inspect the result.</Text>}
      </Card>
    </div>
  </div>;
}
