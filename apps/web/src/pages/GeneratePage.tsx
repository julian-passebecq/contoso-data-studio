import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardHeader, Input, Text, Title3 } from "@fluentui/react-components";

import { getJson, postJson } from "../api";
import type {
  GenerationRun,
  GenerationRunDetail,
  RunComparison,
  RunIntegrity,
  RunReloadResult,
  Scenario,
} from "../types";
import "../generator.css";

type GenerateResult = {
  run_id:string;
  scale:number;
  scenario:string;
  scenario_name:string;
  business_focus:string;
  row_counts:Record<string,number>;
  bronze_loaded_at?:string;
};

function prettyBytes(bytes:number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024*1024) return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/1024/1024).toFixed(1)} MB`;
}

export default function GeneratePage({
  scenarios,
  onStatus,
  onGenerated,
}:{scenarios:Scenario[];onStatus:(message:string)=>void;onGenerated:()=>void}) {
  const [scenarioId,setScenarioId] = useState("retail-baseline");
  const [scale,setScale] = useState("10000");
  const [seed,setSeed] = useState("42");
  const [running,setRunning] = useState(false);
  const [lastRun,setLastRun] = useState<GenerateResult|null>(null);
  const [runs,setRuns] = useState<GenerationRun[]>([]);
  const [selectedRun,setSelectedRun] = useState<GenerationRunDetail|null>(null);
  const [loadingRun,setLoadingRun] = useState("");
  const [reloadingRun,setReloadingRun] = useState("");
  const [compareBase,setCompareBase] = useState("");
  const [compareTarget,setCompareTarget] = useState("");
  const [comparison,setComparison] = useState<RunComparison|null>(null);
  const [comparing,setComparing] = useState(false);
  const [integrity,setIntegrity] = useState<RunIntegrity|null>(null);
  const [verifyingRun,setVerifyingRun] = useState("");

  const selected = useMemo(
    ()=>scenarios.find(item=>item.id===scenarioId) ?? scenarios[0],
    [scenarios,scenarioId],
  );

  async function loadRuns() {
    try {
      const data=await getJson<{runs:GenerationRun[]}>("/api/runs?limit=12");
      setRuns(data.runs);
      setCompareBase(current=>current || data.runs[1]?.run_id || data.runs[0]?.run_id || "");
      setCompareTarget(current=>current || data.runs[0]?.run_id || "");
    } catch {
      setRuns([]);
    }
  }

  useEffect(()=>{ void loadRuns(); },[]);

  async function generate() {
    const rowCount = Number(scale);
    const seedValue = Number(seed);
    setRunning(true);
    onStatus(`Generating ${selected?.name ?? scenarioId} and loading Bronze...`);
    try {
      const data = await postJson<GenerateResult>("/api/generate", {
        scenario:scenarioId,
        scale:rowCount,
        seed:seedValue,
      });
      setLastRun(data);
      await loadRuns();
      onStatus(`Loaded ${data.scale.toLocaleString()} ${data.scenario_name} sales rows into Bronze.`);
      onGenerated();
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Generation failed.");
    } finally {
      setRunning(false);
    }
  }

  async function inspectRun(runId:string) {
    setLoadingRun(runId);
    try {
      const detail=await getJson<GenerationRunDetail>(`/api/runs/${encodeURIComponent(runId)}`);
      setSelectedRun(detail);
      onStatus(`Loaded manifest for ${detail.scenario_name ?? detail.run_id}.`);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Could not load run manifest.");
    } finally {
      setLoadingRun("");
    }
  }

  function useRunParameters(run:GenerationRunDetail) {
    if (run.scenario) setScenarioId(run.scenario);
    if (run.scale != null) setScale(String(run.scale));
    if (run.seed != null) setSeed(String(run.seed));
    onStatus(`Generator parameters restored from run ${run.run_id}. Generate creates a new run; Reload Bronze restores the exact persisted files.`);
  }

  async function verifyRun(runId:string) {
    setVerifyingRun(runId);
    try {
      const result=await getJson<RunIntegrity>(
        `/api/runs/${encodeURIComponent(runId)}/verify`
      );
      setIntegrity(result);
      onStatus(
        result.all_valid
          ? `Verified ${result.valid_files}/${result.tracked_files} tracked files for ${runId}.`
          : `Integrity check found untracked or modified files for ${runId}.`
      );
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Could not verify run integrity.");
    } finally {
      setVerifyingRun("");
    }
  }

  async function compareRuns() {
    if (!compareBase || !compareTarget || compareBase===compareTarget) return;
    setComparing(true);
    try {
      const params=new URLSearchParams({base:compareBase,target:compareTarget});
      const result=await getJson<RunComparison>(`/api/runs/compare?${params}`);
      setComparison(result);
      onStatus(`Compared runs ${compareBase} and ${compareTarget}.`);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Could not compare runs.");
    } finally {
      setComparing(false);
    }
  }

  async function reloadRun(runId:string) {
    setReloadingRun(runId);
    onStatus(`Reloading exact Parquet files from ${runId} into Bronze...`);
    try {
      const result=await postJson<RunReloadResult>(
        `/api/runs/${encodeURIComponent(runId)}/reload`,
        {},
      );
      setSelectedRun(result.run);
      await loadRuns();
      onGenerated();
      const integrity=result.integrity_verified ? " · SHA-256 verified" : " · legacy run (hashes unavailable)";
      onStatus(
        result.snapshot_id == null
          ? `Reloaded exact persisted run ${runId} into Bronze${integrity}.`
          : `Reloaded exact persisted run ${runId} into Bronze · DuckLake snapshot #${result.snapshot_id}${integrity}.`
      );
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Could not reload run.");
    } finally {
      setReloadingRun("");
    }
  }

  return <div className="generateStack">
    <div className="grid">
      <Card>
        <CardHeader
          header={<Title3>{selected?.name ?? "Choose a scenario"}</Title3>}
          description="Deterministic local business scenario"
          action={selected?<Badge appearance="outline" color="success">READY</Badge>:undefined}
        />
        <Text>{selected?.description ?? "Loading scenario library..."}</Text>

        {selected && <div className="scenarioFocus">
          <span>BUSINESS FOCUS</span>
          <b>{selected.focus}</b>
        </div>}

        <div className="generatorFields">
          <label>
            <span>Sales rows</span>
            <Input
              type="number"
              value={scale}
              min={100}
              max={2000000}
              onChange={(_,data)=>setScale(data.value)}
            />
          </label>
          <label>
            <span>Seed</span>
            <Input
              type="number"
              value={seed}
              min={0}
              max={2147483647}
              onChange={(_,data)=>setSeed(data.value)}
            />
          </label>
        </div>

        <Button appearance="primary" disabled={running || !selected} onClick={generate}>
          {running ? "Generating + loading..." : "Generate + load Bronze"}
        </Button>

        {lastRun && <div className="generationReceipt">
          <div><span>Scenario</span><b>{lastRun.scenario_name}</b></div>
          <div><span>Sales</span><b>{lastRun.row_counts.sales.toLocaleString()}</b></div>
          <div><span>Run</span><b>{lastRun.run_id.slice(-8)}</b></div>
        </div>}

        <div className="flow">Scenario → Parquet → Bronze → dbt Silver → dbt Gold → Charts</div>
      </Card>

      <Card>
        <CardHeader header={<Title3>Scenario library</Title3>} description="Choose the business behavior encoded into generated data"/>
        <div className="scenarioLibrary">
          {scenarios.map(item=><button
            type="button"
            className={item.id===scenarioId ? "scenarioChoice selected" : "scenarioChoice"}
            key={item.id}
            onClick={()=>setScenarioId(item.id)}
          >
            <div>
              <b>{item.name}</b>
              <span>{item.description}</span>
            </div>
            <Badge appearance="outline" color={item.status==="ready"?"success":"informative"}>{item.status}</Badge>
          </button>)}
        </div>
      </Card>
    </div>

    <Card>
      <CardHeader
        header={<Title3>Run ledger</Title3>}
        description="Persisted manifests + exact Parquet inputs in workspace/staging"
        action={<Button onClick={loadRuns}>Refresh</Button>}
      />
      {runs.length>1 && <div className="runCompareBar">
        <div>
          <Text className="muted tiny">Base run</Text>
          <select value={compareBase} onChange={event=>setCompareBase(event.target.value)}>
            {runs.map(run=><option key={`base-${run.run_id}`} value={run.run_id}>
              {run.scenario_name ?? run.scenario ?? "Run"} · {run.run_id.slice(-8)}
            </option>)}
          </select>
        </div>
        <span>→</span>
        <div>
          <Text className="muted tiny">Target run</Text>
          <select value={compareTarget} onChange={event=>setCompareTarget(event.target.value)}>
            {runs.map(run=><option key={`target-${run.run_id}`} value={run.run_id}>
              {run.scenario_name ?? run.scenario ?? "Run"} · {run.run_id.slice(-8)}
            </option>)}
          </select>
        </div>
        <Button
          disabled={!compareBase || !compareTarget || compareBase===compareTarget || comparing}
          onClick={()=>void compareRuns()}
        >
          {comparing ? "Comparing..." : "Compare runs"}
        </Button>
      </div>}
      <div className="runLedger">
        {runs.map(run=><div className="runLedgerRow" key={run.run_id}>
          <div>
            <b>{run.scenario_name ?? run.scenario ?? "Unknown scenario"}</b>
            <code>{run.run_id}</code>
          </div>
          <span>{(run.sales_rows ?? run.scale ?? 0).toLocaleString()} sales</span>
          <span>seed {run.seed ?? "—"}</span>
          <span>{run.created_at ? new Date(run.created_at).toLocaleString() : "—"}</span>
          <span>{run.last_snapshot_id==null ? "no snapshot" : `snapshot #${run.last_snapshot_id}`}</span>
          <Badge appearance="outline" color={run.is_active?"success":run.bronze_loaded_at?"informative":"warning"}>
            {run.is_active
              ? `Active Bronze${run.active_snapshot_id==null?"":` · #${run.active_snapshot_id}`}`
              : run.bronze_loaded_at
                ? "Previously loaded"
                : "Generated"}
          </Badge>
          <div className="runLedgerActions">
            <Button
              size="small"
              disabled={loadingRun===run.run_id}
              onClick={()=>void inspectRun(run.run_id)}
            >
              {loadingRun===run.run_id ? "Loading..." : "Inspect"}
            </Button>
            <Button
              size="small"
              disabled={reloadingRun!==""}
              onClick={()=>void reloadRun(run.run_id)}
            >
              {reloadingRun===run.run_id ? "Reloading..." : "Reload Bronze"}
            </Button>
          </div>
        </div>)}
        {!runs.length && <Text className="muted tiny">No generator runs recorded yet.</Text>}
      </div>
    </Card>

    {comparison && <Card className="runComparisonCard">
      <CardHeader
        header={<Title3>Run comparison</Title3>}
        description={`${comparison.base_run_id} → ${comparison.target_run_id}`}
        action={<div className="buttonRow">
          <Badge appearance="outline" color={comparison.same_parameters?"success":"informative"}>
            {comparison.same_parameters ? "Same parameters" : "Parameters changed"}
          </Badge>
          <Badge appearance="outline" color={comparison.same_generator?"success":"warning"}>
            {comparison.same_generator ? "Same generator" : "Generator changed"}
          </Badge>
          <Badge
            appearance="outline"
            color={comparison.exact_files_equal===true?"success":comparison.exact_files_equal===false?"warning":"informative"}
          >
            {comparison.exact_files_equal===true
              ? "Exact files match"
              : comparison.exact_files_equal===false
                ? "Files differ"
                : "Hashes unavailable"}
          </Badge>
        </div>}
      />
      <div className="runCompareSummary">
        <div><span>Parameter changes</span><b>{Object.keys(comparison.parameter_changes).length}</b></div>
        <div><span>Row-count changes</span><b>{Object.keys(comparison.row_count_changes).length}</b></div>
        <div><span>Files compared</span><b>{Object.keys(comparison.files).length}</b></div>
        <div><span>Hashes tracked</span><b>{comparison.all_hashes_available ? "Yes" : "Partial"}</b></div>
      </div>
      {Object.keys(comparison.parameter_changes).length>0 && <div className="runCompareSection">
        <b>Parameters</b>
        {Object.entries(comparison.parameter_changes).map(([name,value])=><div key={name}>
          <code>{name}</code><span>{String(value.base)} → {String(value.target)}</span>
        </div>)}
      </div>}
      {Object.keys(comparison.generator_changes).length>0 && <div className="runCompareSection">
        <b>Generator provenance</b>
        {Object.entries(comparison.generator_changes).map(([name,value])=><div key={name}>
          <code>{name}</code><span>{String(value.base ?? "—")} → {String(value.target ?? "—")}</span>
        </div>)}
      </div>}
      {Object.keys(comparison.row_count_changes).length>0 && <div className="runCompareSection">
        <b>Row counts</b>
        {Object.entries(comparison.row_count_changes).map(([name,value])=><div key={name}>
          <code>{name}</code><span>{value.base ?? "—"} → {value.target ?? "—"}{value.delta==null?"":` · ${value.delta>0?"+":""}${value.delta}`}</span>
        </div>)}
      </div>}
      <div className="runFileCompareGrid">
        {Object.entries(comparison.files).map(([name,file])=><div className="runFileCompare" key={name}>
          <div><b>{name}</b><Badge appearance="outline" color={file.same_hash===true?"success":file.same_hash===false?"warning":"informative"}>
            {file.same_hash===true ? "same" : file.same_hash===false ? "different" : "untracked"}
          </Badge></div>
          <span>{prettyBytes(file.base_size_bytes ?? 0)} → {prettyBytes(file.target_size_bytes ?? 0)}</span>
        </div>)}
      </div>
    </Card>}

    {selectedRun && <Card className="runDetailCard">
      <CardHeader
        header={<Title3>{selectedRun.scenario_name ?? selectedRun.scenario ?? selectedRun.run_id}</Title3>}
        description={selectedRun.run_id}
        action={<div className="buttonRow">
          <Badge appearance="outline" color={selectedRun.integrity_tracked?"success":"warning"}>
            {selectedRun.integrity_tracked ? "SHA-256 tracked" : "Legacy untracked"}
          </Badge>
          <Badge appearance="outline" color={selectedRun.generator_sha256?"informative":"warning"}>
            {selectedRun.generator_version ? `Generator ${selectedRun.generator_version}` : "Generator unversioned"}
          </Badge>
          {selectedRun.is_active && <Badge appearance="outline" color="success">
            Active Bronze{selectedRun.active_snapshot_id==null?"":` · #${selectedRun.active_snapshot_id}`}
          </Badge>}
          <Button
            disabled={verifyingRun!==""}
            onClick={()=>void verifyRun(selectedRun.run_id)}
          >
            {verifyingRun===selectedRun.run_id ? "Verifying..." : "Verify integrity"}
          </Button>
          <Button onClick={()=>useRunParameters(selectedRun)}>Use parameters</Button>
          <Button
            appearance="primary"
            disabled={reloadingRun!==""}
            onClick={()=>void reloadRun(selectedRun.run_id)}
          >
            {reloadingRun===selectedRun.run_id ? "Reloading..." : "Reload exact Bronze"}
          </Button>
        </div>}
      />
      {selectedRun.business_focus && <Text>{selectedRun.business_focus}</Text>}
      <div className="runDetailFacts">
        <div><span>Seed</span><b>{selectedRun.seed ?? "—"}</b></div>
        <div><span>Scale</span><b>{(selectedRun.scale ?? 0).toLocaleString()}</b></div>
        <div><span>Generated</span><b>{selectedRun.created_at ? new Date(selectedRun.created_at).toLocaleString() : "—"}</b></div>
        <div><span>Last Bronze load</span><b>{selectedRun.bronze_loaded_at ? new Date(selectedRun.bronze_loaded_at).toLocaleString() : "Never"}</b></div>
        <div><span>Last snapshot</span><b>{selectedRun.last_snapshot_id!=null ? `#${selectedRun.last_snapshot_id}` : "—"}</b></div>
        <div><span>Load count</span><b>{selectedRun.load_history.length}</b></div>
        <div><span>Manifest</span><b>v{selectedRun.manifest_version}</b></div>
        <div><span>Generator hash</span><b>{selectedRun.generator_sha256 ? `${selectedRun.generator_sha256.slice(0,10)}…` : "—"}</b></div>
      </div>
      <div className="runModeNote">
        <b>Use parameters</b> generates a new deterministic run. <b>Reload exact Bronze</b> reuses these persisted Parquet files unchanged.
      </div>
      {selectedRun.load_history.length>0 && <div className="runLoadHistory">
        <b>Bronze load history</b>
        {selectedRun.load_history.slice().reverse().map((entry,index)=><div key={`${entry.loaded_at}-${index}`}>
          <span>{new Date(entry.loaded_at).toLocaleString()}</span>
          <code>{entry.snapshot_id==null ? "snapshot —" : `snapshot #${entry.snapshot_id}`}</code>
        </div>)}
      </div>}
      {integrity && integrity.run_id===selectedRun.run_id && <div className="runIntegritySummary">
        <Badge appearance="outline" color={integrity.all_valid?"success":"danger"}>
          {integrity.all_valid ? "Integrity verified" : "Integrity issue"}
        </Badge>
        <span>{integrity.valid_files}/{integrity.tracked_files} tracked files valid</span>
        {!integrity.all_tracked && <span>Some files are not hash-tracked</span>}
      </div>}
      <div className="runFileGrid">
        {Object.entries(selectedRun.files).map(([name,file])=><div className="runFile" key={name}>
          <div><b>{name}</b><Badge
            appearance="outline"
            color={integrity?.run_id===selectedRun.run_id
              ? integrity.files[name]?.valid===true
                ? "success"
                : integrity.files[name]?.valid===false
                  ? "danger"
                  : "informative"
              : undefined}
          >
            {integrity?.run_id===selectedRun.run_id
              ? integrity.files[name]?.valid===true
                ? "verified"
                : integrity.files[name]?.valid===false
                  ? "mismatch"
                  : "untracked"
              : "Parquet"}
          </Badge></div>
          <code>{file.path}</code>
          <span>
            {prettyBytes(file.size_bytes)} · {(selectedRun.row_counts[name] ?? 0).toLocaleString()} rows
            {file.sha256 ? ` · sha256 ${file.sha256.slice(0,10)}…` : ""}
          </span>
        </div>)}
      </div>
    </Card>}
  </div>;
}
