import { useEffect, useState } from "react";
import { Badge, Button, Card, CardHeader, Text, Title3 } from "@fluentui/react-components";
import { getJson, postJson } from "../api";
import type { DbtLineage, DbtLineageNode, DbtQuality } from "../types";
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
  const [lineage,setLineage] = useState<DbtLineage|null>(null);
  const [run,setRun] = useState<DbtRun|null>(null);
  const [busy,setBusy] = useState("");
  const [error,setError] = useState("");
  const [showIssuesOnly,setShowIssuesOnly] = useState(false);

  async function refresh() {
    try {
      const [nextStatus,nextLineage]=await Promise.all([
        getJson<DbtStatus>("/api/dbt/status"),
        getJson<DbtLineage>("/api/dbt/lineage"),
      ]);
      setStatus(nextStatus);
      setLineage(nextLineage);
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

  const manifestNodes = lineage?.nodes ?? [];
  const nodeById = new Map(manifestNodes.map(node=>[node.id,node]));
  const lineageByLayer = {
    bronze: manifestNodes.filter(node=>node.layer==="bronze"),
    silver: manifestNodes.filter(node=>node.layer==="silver"),
    gold: manifestNodes.filter(node=>node.layer==="gold"),
  };

  function fallbackNode(layer:string,name:string,resource_type:"source"|"model"):DbtLineageNode {
    return {
      id:`fallback.${layer}.${name}`,
      name,
      resource_type,
      layer,
      path:"",
      schema:layer,
      database:"contoso",
      materialized:resource_type==="source" ? "source" : "table",
    };
  }

  const dagNodes = {
    bronze: lineageByLayer.bronze.length
      ? lineageByLayer.bronze
      : ["sales","customer","product","store","currency_exchange"].map(name=>fallbackNode("bronze",name,"source")),
    silver: lineageByLayer.silver.length
      ? lineageByLayer.silver
      : grouped.silver.map(model=>fallbackNode("silver",model.name,"model")),
    gold: lineageByLayer.gold.length
      ? lineageByLayer.gold
      : grouped.gold.map(model=>fallbackNode("gold",model.name,"model")),
  };

  const quality = status?.quality;
  const qualityIssues = quality
    ? quality.summary.fail + quality.summary.error + quality.summary.warn
    : 0;

  const visibleQualityTests = quality
    ? quality.tests.filter(test=>
        !showIssuesOnly || ["fail","error","warn"].includes(test.status)
      )
    : [];

  function renderDagNode(node:DbtLineageNode) {
    const tests=quality?.tests.filter(test=>test.layer===node.layer && test.model===node.name) ?? [];
    const issues=tests.filter(test=>["fail","error","warn"].includes(test.status)).length;
    const passed=tests.filter(test=>test.status==="pass").length;
    const label=tests.length
      ? (issues ? `${issues} issue${issues===1?"":"s"}` : `${passed}/${tests.length} checks`)
      : "";
    const upstream=(lineage?.edges ?? [])
      .filter(edge=>edge.target===node.id)
      .map(edge=>nodeById.get(edge.source)?.name ?? edge.source)
      .filter(Boolean);
    return <div
      className={`dagNode${node.resource_type==="source"?" source":""}${issues?" issue":""}`}
      key={node.id}
      title={node.path || node.id}
    >
      <div className="dagNodeCopy">
        <span>{node.name}</span>
        {upstream.length>0 && <em>← {upstream.join(", ")}</em>}
      </div>
      {label && <small>{label}</small>}
    </div>;
  }

  return <div className="transformGrid">
    <Card>
      <CardHeader
        header={<Title3>dbt project</Title3>}
        description={lineage?.nodes.length
          ? `${lineage.nodes.length} manifest nodes · ${lineage.edges.length} dependencies`
          : status?.project_dir ?? "Loading project..."}
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
          {dagNodes.bronze.map(renderDagNode)}
        </div>
        <div className="dagArrow">→</div>
        <div className="dagColumn">
          <span className="dagLayer silver">SILVER</span>
          {dagNodes.silver.map(renderDagNode)}
        </div>
        <div className="dagArrow">→</div>
        <div className="dagColumn">
          <span className="dagLayer gold">GOLD</span>
          {dagNodes.gold.map(renderDagNode)}
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
          ? <div className="buttonRow">
              {qualityIssues>0 && <Button
                size="small"
                onClick={()=>setShowIssuesOnly(value=>!value)}
              >
                {showIssuesOnly ? "Show all tests" : "Issues only"}
              </Button>}
              <Badge
                appearance="outline"
                color={qualityIssues===0 ? "success" : "danger"}
              >
                {qualityIssues===0
                  ? `${quality.summary.pass}/${quality.summary.total} passing`
                  : `${qualityIssues} issue${qualityIssues===1?"":"s"}`}
              </Badge>
            </div>
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
          {visibleQualityTests.map(test=><div className="qualityTest" key={test.unique_id}>
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
          {showIssuesOnly && visibleQualityTests.length===0 && <div className="qualityEmpty">No failed, warning, or error tests.</div>}
        </div>
      </> : <Text className="muted">No dbt test results recorded yet.</Text>}
    </Card>
  </div>;
}
