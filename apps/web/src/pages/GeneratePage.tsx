import { Badge, Button, Card, CardHeader, Input, Text, Title3 } from "@fluentui/react-components";
import { postJson } from "../api";
import type { Scenario } from "../types";

export default function GeneratePage({
  scenarios,
  onStatus,
  onGenerated,
}:{scenarios:Scenario[];onStatus:(message:string)=>void;onGenerated:()=>void}) {
  async function generate() {
    const input = document.getElementById("scale-input") as HTMLInputElement | null;
    const scale = Number(input?.value ?? 10000);
    onStatus("Generating Parquet and loading Bronze...");
    try {
      const data = await postJson<{scale:number}>("/api/generate", {scenario:"retail-baseline",scale,seed:42});
      onStatus(`Loaded ${data.scale.toLocaleString()} sales rows into Bronze.`);
      onGenerated();
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Generation failed.");
    }
  }

  return <div className="grid">
    <Card>
      <CardHeader header={<Title3>Retail baseline</Title3>} description="Executable local scenario"/>
      <Text>Generate deterministic retail Parquet, then load Customer, Product, Store and Sales into DuckLake Bronze.</Text>
      <div className="controls">
        <Input id="scale-input" type="number" defaultValue="10000" min={100} max={2000000}/>
        <Button appearance="primary" onClick={generate}>Generate + load Bronze</Button>
      </div>
      <div className="flow">Scenario → Parquet → Bronze → dbt Silver → dbt Gold → Charts</div>
    </Card>
    <Card>
      <CardHeader header={<Title3>Scenario library</Title3>}/>
      {scenarios.map(s=><div className="scenario" key={s.id}>
        <div><b>{s.name}</b><span>{s.description}</span></div>
        <Badge appearance="outline" color={s.status==="ready"?"success":"informative"}>{s.status}</Badge>
      </div>)}
    </Card>
  </div>;
}
