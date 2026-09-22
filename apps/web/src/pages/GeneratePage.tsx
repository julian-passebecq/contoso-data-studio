import { useMemo, useState } from "react";
import { Badge, Button, Card, CardHeader, Input, Text, Title3 } from "@fluentui/react-components";

import { postJson } from "../api";
import type { Scenario } from "../types";

type GenerateResult = {
  scale:number;
  scenario:string;
  scenario_name:string;
  business_focus:string;
  row_counts:Record<string,number>;
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

  const selected = useMemo(
    ()=>scenarios.find(item=>item.id===scenarioId) ?? scenarios[0],
    [scenarios,scenarioId],
  );

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
      onStatus(`Loaded ${data.scale.toLocaleString()} ${data.scenario_name} sales rows into Bronze.`);
      onGenerated();
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Generation failed.");
    } finally {
      setRunning(false);
    }
  }

  return <div className="grid">
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
        <div><span>FX rows</span><b>{lastRun.row_counts.currency_exchange.toLocaleString()}</b></div>
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
  </div>;
}
