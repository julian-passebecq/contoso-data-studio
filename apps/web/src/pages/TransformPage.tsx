import { useEffect, useState } from "react";
import { Badge, Button, Card, CardHeader, Text, Title3 } from "@fluentui/react-components";
import { getJson, postJson } from "../api";

type DbtModel = { name:string; path:string; layer:string };
type DbtNodeResult = {
  unique_id:string;
  status:string;
  execution_time:number | null;
  message:string | null;
};
type DbtStatus = {
  available:boolean;
  executable:string | null;
  project_dir:string;
  models:DbtModel[];
  latest_run:null | {
    elapsed_time:number | null;
    generated_at:string | null;
    results:DbtNodeResult[];
  };
};
type DbtRun = {
  command:string;
  exit_code:number;
  ok:boolean;
  output:string;
  run_results:DbtStatus["latest_run"];
};

export default function TransformPage({onBuilt}:{onBuilt:()=>void}) {
  const [status,setStatus] = useState<DbtStatus|null>(null);
  const [run,setRun] = useState<DbtRun|null>(null);
  const [busy,setBusy] = useState("");
  const [error,setError] = useState("");

  async function refresh() {
    try {
      setStatus(await getJson<DbtStatus>("/api/dbt/status"));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not inspect dbt project.");
    }
  }

  useEffect(()=>{ void refresh(); },[]);

  async function execute(command:"build"|"test") {
    setBusy(command); setError("");
    try {
      const result = await postJson<DbtRun>(`/api/dbt/${command}`, {});
      setRun(result);
      await refresh();
      if (result.ok) onBuilt();
    } catch (err) {
      setError(err instanceof Error ? err.message : `dbt ${command} failed.`);
    } finally {
      setBusy("");
    }
  }

  const grouped = {
    silver: status?.models.filter(model=>model.layer==="silver") ?? [],
    gold: status?.models.filter(model=>model.layer==="gold") ?? [],
  };

  return <div className="transformGrid">
    <Card>
      <CardHeader
        header={<Title3>dbt project</Title3>}
        description={status?.project_dir ?? "Loading project..."}
        action={<div className="buttonRow">
          <Button onClick={()=>execute("test")} disabled={!!busy || !status?.available}>{busy==="test"?"Testing...":"Test"}</Button>
          <Button appearance="primary" onClick={()=>execute("build")} disabled={!!busy || !status?.available}>{busy==="build"?"Building...":"Build"}</Button>
        </div>}
      />
      <div className="runtimeRow">
        <Badge appearance="outline" color={status?.available?"success":"warning"}>
          {status?.available ? "dbt available" : "dbt not installed"}
        </Badge>
        {!status?.available && <Text className="muted tiny">Install API extras with <code>pip install -e "apps/api[dbt]"</code></Text>}
      </div>
      <div className="dag">
        <div className="dagColumn">
          <span className="dagLayer bronze">BRONZE</span>
          {["sales","customer","product","store"].map(name=><div className="dagNode source" key={name}>{name}</div>)}
        </div>
        <div className="dagArrow">→</div>
        <div className="dagColumn">
          <span className="dagLayer silver">SILVER</span>
          {grouped.silver.map(model=><div className="dagNode" key={model.path}>{model.name}</div>)}
        </div>
        <div className="dagArrow">→</div>
        <div className="dagColumn">
          <span className="dagLayer gold">GOLD</span>
          {grouped.gold.map(model=><div className="dagNode" key={model.path}>{model.name}</div>)}
        </div>
      </div>
    </Card>

    <Card>
      <CardHeader header={<Title3>Latest run</Title3>} description="dbt run_results.json"/>
      {error && <div className="errorText">{error}</div>}
      {(run?.run_results ?? status?.latest_run) ? <div className="runResults">
        {(run?.run_results ?? status?.latest_run)?.results.map(item=><div className="runResult" key={item.unique_id}>
          <Badge appearance="outline" color={item.status==="success" || item.status==="pass" ? "success" : "danger"}>{item.status}</Badge>
          <span>{item.unique_id.replace(/^model\.contoso_data_studio\.|^test\.contoso_data_studio\./,"")}</span>
          <small>{item.execution_time == null ? "" : `${item.execution_time.toFixed(2)}s`}</small>
        </div>)}
      </div> : <Text className="muted">No dbt run recorded yet.</Text>}
      {run && <details className="consoleDetails">
        <summary>Console output · exit {run.exit_code}</summary>
        <pre>{run.output}</pre>
      </details>}
    </Card>
  </div>;
}
