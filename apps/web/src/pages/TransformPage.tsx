import { useEffect, useState } from "react";
import { Badge, Button, Card, CardHeader, Text, Title3 } from "@fluentui/react-components";

import { getJson, postJson } from "../api";
import type {
  DbtLineage,
  DbtLineageNode,
  DbtNodeDetail,
  DbtQuality,
} from "../types";
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
  selector:string | null;
  exit_code:number;
  ok:boolean;
  output:string;
  run_results:DbtStatus["latest_run"];
};
type WorkbenchTab = "Source"|"Compiled"|"Lineage"|"Tests"|"Columns";

export default function TransformPage({
  onBuilt,
  onOpenQuery,
}:{
  onBuilt:()=>void;
  onOpenQuery:(sql:string)=>void;
}) {
  const [status,setStatus] = useState<DbtStatus|null>(null);
  const [lineage,setLineage] = useState<DbtLineage|null>(null);
  const [run,setRun] = useState<DbtRun|null>(null);
  const [busy,setBusy] = useState("");
  const [error,setError] = useState("");
  const [showIssuesOnly,setShowIssuesOnly] = useState(false);
  const [selectedNodeId,setSelectedNodeId] = useState("");
  const [nodeDetail,setNodeDetail] = useState<DbtNodeDetail|null>(null);
  const [loadingNode,setLoadingNode] = useState("");
  const [workbenchTab,setWorkbenchTab] = useState<WorkbenchTab>("Source");

  async function loadNode(uniqueId:string) {
    if (!uniqueId || uniqueId.startsWith("fallback.")) return;
    setSelectedNodeId(uniqueId);
    setLoadingNode(uniqueId);
    setError("");
    try {
      const detail=await getJson<DbtNodeDetail>(
        `/api/dbt/node?unique_id=${encodeURIComponent(uniqueId)}`
      );
      setNodeDetail(detail);
      setWorkbenchTab(detail.resource_type==="model" ? "Source" : "Lineage");
    } catch (err) {
      setNodeDetail(null);
      setError(err instanceof Error ? err.message : "Could not inspect dbt node.");
    } finally {
      setLoadingNode("");
    }
  }

  async function refresh() {
    try {
      const [nextStatus,nextLineage]=await Promise.all([
        getJson<DbtStatus>("/api/dbt/status"),
        getJson<DbtLineage>("/api/dbt/lineage"),
      ]);
      setStatus(nextStatus);
      setLineage(nextLineage);
      setError("");
      if (selectedNodeId && !selectedNodeId.startsWith("fallback.")) {
        try {
          setNodeDetail(await getJson<DbtNodeDetail>(
            `/api/dbt/node?unique_id=${encodeURIComponent(selectedNodeId)}`
          ));
        } catch {
          setNodeDetail(null);
          setSelectedNodeId("");
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not inspect dbt project.");
    }
  }

  useEffect(()=>{ void refresh(); },[]);

  async function execute(command:"build"|"test", selector?:string) {
    const busyKey=selector ? `${command}:${selector}` : command;
    setBusy(busyKey); setError("");
    try {
      const suffix=selector ? `?selector=${encodeURIComponent(selector)}` : "";
      const result = await postJson<DbtRun>(`/api/dbt/${command}${suffix}`, {});
      setRun(result);
      await refresh();
      if (selector && selectedNodeId) await loadNode(selectedNodeId);
      if (result.ok && command==="build") onBuilt();
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
    const selected=node.id===selectedNodeId;

    return <button
      type="button"
      className={`dagNode${node.resource_type==="source"?" source":""}${issues?" issue":""}${selected?" selected":""}`}
      key={node.id}
      title={node.path || node.id}
      disabled={node.id.startsWith("fallback.")}
      onClick={()=>void loadNode(node.id)}
    >
      <div className="dagNodeCopy">
        <span>{loadingNode===node.id ? "Loading..." : node.name}</span>
        {upstream.length>0 && <em>← {upstream.join(", ")}</em>}
      </div>
      {label && <small>{label}</small>}
    </button>;
  }

  function relationButton(node:{id:string;name:string;layer:string}) {
    return <button
      type="button"
      className="dependencyChip"
      key={node.id}
      onClick={()=>void loadNode(node.id)}
    >
      <span>{node.name}</span>
      <small>{node.layer}</small>
    </button>;
  }

  const workbenchTests=nodeDetail?.tests ?? [];

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
      <CardHeader
        header={<Title3>Latest run</Title3>}
        description={run?.selector
          ? `dbt ${run.command} --select ${run.selector}`
          : run
            ? `dbt ${run.command}`
            : "dbt run_results.json"}
      />
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

    <Card className="modelWorkbenchCard">
      <CardHeader
        header={<Title3>{nodeDetail ? nodeDetail.name : "Model workbench"}</Title3>}
        description={nodeDetail
          ? `${nodeDetail.layer.toUpperCase()} · ${nodeDetail.resource_type} · ${nodeDetail.materialized}${nodeDetail.path ? ` · ${nodeDetail.path}` : ""}`
          : "Select a Bronze, Silver, or Gold node in the DAG to inspect it"}
        action={nodeDetail
          ? <div className="buttonRow">
              {nodeDetail.resource_type==="model" && <>
                <Button
                  disabled={!!busy || !status?.available}
                  onClick={()=>void execute("test",nodeDetail.name)}
                >
                  {busy===`test:${nodeDetail.name}` ? "Testing model..." : "Test model"}
                </Button>
                <Button
                  disabled={!!busy || !status?.available}
                  onClick={()=>void execute("build",nodeDetail.name)}
                >
                  {busy===`build:${nodeDetail.name}` ? "Building model..." : "Build model"}
                </Button>
              </>}
              {nodeDetail.physical_query && <Button
                appearance="primary"
                onClick={()=>onOpenQuery(nodeDetail.physical_query!)}
              >
                Open result in Query
              </Button>}
            </div>
          : undefined}
      />
      {nodeDetail ? <>
        <div className="modelFacts">
          <div><span>Layer</span><b>{nodeDetail.layer}</b></div>
          <div><span>Materialization</span><b>{nodeDetail.materialized}</b></div>
          <div><span>Upstream</span><b>{nodeDetail.upstream.length}</b></div>
          <div><span>Downstream</span><b>{nodeDetail.downstream.length}</b></div>
          <div><span>Tests</span><b>{nodeDetail.tests.length}</b></div>
          <div><span>Relation</span><b>{nodeDetail.relation_name ?? "—"}</b></div>
        </div>

        <div className="workbenchTabs">
          {(["Source","Compiled","Lineage","Tests","Columns"] as WorkbenchTab[]).map(tab=><button
            type="button"
            className={workbenchTab===tab ? "selected" : ""}
            key={tab}
            onClick={()=>setWorkbenchTab(tab)}
          >{tab}</button>)}
        </div>

        {workbenchTab==="Source" && <div className="codeWorkbench">
          {nodeDetail.source_code
            ? <pre>{nodeDetail.source_code}</pre>
            : <div className="qualityEmpty">No source SQL is available for this node.</div>}
        </div>}

        {workbenchTab==="Compiled" && <div className="codeWorkbench">
          {nodeDetail.compiled_code ? <>
            <div className="codeWorkbenchToolbar">
              <Text className="muted tiny">dbt compiled SQL</Text>
              <Button size="small" onClick={()=>onOpenQuery(nodeDetail.compiled_code!)}>Run compiled SQL</Button>
            </div>
            <pre>{nodeDetail.compiled_code}</pre>
          </> : <div className="qualityEmpty">Compiled SQL is unavailable. Run dbt Build, then refresh the node.</div>}
        </div>}

        {workbenchTab==="Lineage" && <div className="nodeLineage">
          <section>
            <b>Upstream</b>
            <div>{nodeDetail.upstream.map(relationButton)}</div>
            {!nodeDetail.upstream.length && <Text className="muted tiny">No upstream dbt nodes.</Text>}
          </section>
          <span className="lineageFocus">{nodeDetail.name}</span>
          <section>
            <b>Downstream</b>
            <div>{nodeDetail.downstream.map(relationButton)}</div>
            {!nodeDetail.downstream.length && <Text className="muted tiny">No downstream dbt nodes.</Text>}
          </section>
        </div>}

        {workbenchTab==="Tests" && <div className="modelTests">
          {workbenchTests.map(test=><div className="modelTest" key={test.unique_id}>
            <Badge
              appearance="outline"
              color={test.status==="pass"?"success":test.status==="warn"||test.status==="skip"?"warning":"danger"}
            >
              {test.status}
            </Badge>
            <div>
              <b>{test.test_type}</b>
              <span>{test.column_name ?? "model-level"}</span>
            </div>
            <small>{test.execution_time == null ? "" : `${test.execution_time.toFixed(2)}s`}</small>
          </div>)}
          {!workbenchTests.length && <div className="qualityEmpty">No dbt test results are attached to this node.</div>}
        </div>}

        {workbenchTab==="Columns" && <div className="modelColumns">
          {nodeDetail.columns.map(column=><div key={column.name}>
            <code>{column.name}</code>
            <span>{column.data_type ?? "type unspecified"}</span>
            <small>{column.description ?? ""}</small>
          </div>)}
          {!nodeDetail.columns.length && <div className="qualityEmpty">No column metadata is declared in the dbt manifest.</div>}
        </div>}
      </> : <div className="workbenchEmpty">
        <span>Click a node in the DAG.</span>
        <small>The inspector uses dbt manifest metadata and never edits model files.</small>
      </div>}
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
