import { useEffect, useState } from "react";
import { Badge, Button, Card, CardHeader, Text, Title3 } from "@fluentui/react-components";
import { getJson, postJson } from "../api";
import type { DbtQuality } from "../types";
import "../transform.css";

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
  quality:DbtQuality;
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

  const quality = status?.quality;
  const qualityIssues = quality
    ? quality.summary.fail + quality.summary.error + quality.summary.warn
    : 0;

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

    <Card className="qualityCard">
      <CardHeader
        header={<Title3>Data quality</Title3>}
        description={quality?.generated_at
          ? `Latest dbt test artifacts · ${new Date(quality.generated_at).toLocaleString()}`
          : "Run dbt Test or Build to populate quality results"}
        action={quality && quality.summary.total>0
          ? <Badge
              appearance="outline"
              color={qualityIssues===0 ? "success" : "danger"}
            >
              {qualityIssues===0
                ? `${quality.summary.pass}/${quality.summary.total} passing`
                : `${qualityIssues} issue${qualityIssues===1?"":"s"}`}
            </Badge>
          : undefined}
      />
      {quality && quality.summary.total>0 ? <>
        <div className="qualitySummary">
          <div><span>Total</span><b>{quality.summary.total}</b></div>
          <div><span>Pass</span><b>{quality.summary.pass}</b></div>
          <div><span>Fail</span><b>{quality.summary.fail}</b></div>
          <div><span>Warn</span><b>{quality.summary.warn}</b></div>
          <div><span>Error</span><b>{quality.summary.error}</b></div>
          <div><span>Skip</span><b>{quality.summary.skip}</b></div>
        </div>
        <div className="qualityTests">
          {quality.tests.map(test=><div className="qualityTest" key={test.unique_id}>
            <Badge
              appearance="outline"
              color={test.status==="pass" ? "success" : test.status==="warn" || test.status==="skip" ? "warning" : "danger"}
            >
              {test.status}
            </Badge>
            <span className="qualityLayer">{test.layer.toUpperCase()}</span>
            <div className="qualityTestName">
              <b>{test.model}</b>
              <span>{test.test_type}{test.column_name ? ` · ${test.column_name}` : ""}</span>
              {test.message && test.status!=="pass" && <small>{test.message}</small>}
            </div>
            <small>{test.failures == null ? "" : `${test.failures} fail${test.failures===1?"":"s"}`}</small>
            <small>{test.execution_time == null ? "" : `${test.execution_time.toFixed(2)}s`}</small>
          </div>)}
        </div>
      </> : <Text className="muted">No dbt test results recorded yet.</Text>}
    </Card>
  </div>;
}
