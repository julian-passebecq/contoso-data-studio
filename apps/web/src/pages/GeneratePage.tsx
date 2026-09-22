import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardHeader, Input, Text, Title3 } from "@fluentui/react-components";

import { getJson, postJson } from "../api";
import type { GenerationRun, Scenario } from "../types";
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

  const selected = useMemo(
    ()=>scenarios.find(item=>item.id===scenarioId) ?? scenarios[0],
    [scenarios,scenarioId],
  );

  async function loadRuns() {
    try {
      const data=await getJson<{runs:GenerationRun[]}>("/api/runs?limit=8");
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
      <CardHeader header={<Title3>Run ledger</Title3>} description="Generator manifests persisted in workspace/staging" action={<Button onClick={loadRuns}>Refresh</Button>}/>
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
        </div>)}
        {!runs.length && <Text className="muted tiny">No generator runs recorded yet.</Text>}
      </div>
    </Card>
  </div>;
}
