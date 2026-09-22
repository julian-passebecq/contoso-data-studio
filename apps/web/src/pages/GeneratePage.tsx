import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardHeader, Input, Text, Title3 } from "@fluentui/react-components";

import { getJson, postJson } from "../api";
import type {
  GenerationRun,
  GenerationRunDetail,
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

  const selected = useMemo(
    ()=>scenarios.find(item=>item.id===scenarioId) ?? scenarios[0],
    [scenarios,scenarioId],
  );

  async function loadRuns() {
    try {
      const data=await getJson<{runs:GenerationRun[]}>("/api/runs?limit=12");
      setRuns(data.runs);
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
      onStatus(
        result.snapshot_id == null
          ? `Reloaded exact persisted run ${runId} into Bronze.`
          : `Reloaded exact persisted run ${runId} into Bronze · DuckLake snapshot #${result.snapshot_id}.`
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
      <div className="runLedger">
        {runs.map(run=><div className="runLedgerRow" key={run.run_id}>
          <div>
            <b>{run.scenario_name ?? run.scenario ?? "Unknown scenario"}</b>
            <code>{run.run_id}</code>
          </div>
          <span>{(run.sales_rows ?? run.scale ?? 0).toLocaleString()} sales</span>
          <span>seed {run.seed ?? "—"}</span>
          <span>{run.created_at ? new Date(run.created_at).toLocaleString() : "—"}</span>
          <Badge appearance="outline" color={run.bronze_loaded_at?"success":"warning"}>
            {run.bronze_loaded_at ? "Bronze loaded" : "Generated"}
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

    {selectedRun && <Card className="runDetailCard">
      <CardHeader
        header={<Title3>{selectedRun.scenario_name ?? selectedRun.scenario ?? selectedRun.run_id}</Title3>}
        description={selectedRun.run_id}
        action={<div className="buttonRow">
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
      </div>
      <div className="runModeNote">
        <b>Use parameters</b> generates a new deterministic run. <b>Reload exact Bronze</b> reuses these persisted Parquet files unchanged.
      </div>
      <div className="runFileGrid">
        {Object.entries(selectedRun.files).map(([name,file])=><div className="runFile" key={name}>
          <div><b>{name}</b><Badge appearance="outline">Parquet</Badge></div>
          <code>{file.path}</code>
          <span>{prettyBytes(file.size_bytes)} · {(selectedRun.row_counts[name] ?? 0).toLocaleString()} rows</span>
        </div>)}
      </div>
    </Card>}
  </div>;
}
