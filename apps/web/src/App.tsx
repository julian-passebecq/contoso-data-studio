import { useEffect, useState } from "react";
import { Badge, Button, Card, CardHeader, Input, Text, Title2, Title3 } from "@fluentui/react-components";
import { ArrowSync24Regular, Database24Regular, Code24Regular, DataUsage24Regular, ChartMultiple24Regular, Board24Regular, DocumentTable24Regular } from "@fluentui/react-icons";

type Scenario = { id:string; name:string; description:string; status:string };
type Page = "Generate"|"Lakehouse"|"Transform"|"Query"|"Explore"|"Charts"|"Canvas";

const pages: Array<[Page, JSX.Element]> = [
  ["Generate", <ArrowSync24Regular/>],
  ["Lakehouse", <Database24Regular/>],
  ["Transform", <DataUsage24Regular/>],
  ["Query", <Code24Regular/>],
  ["Explore", <DocumentTable24Regular/>],
  ["Charts", <ChartMultiple24Regular/>],
  ["Canvas", <Board24Regular/>]
];

export default function App() {
  const [page,setPage] = useState<Page>("Generate");
  const [scenarios,setScenarios] = useState<Scenario[]>([]);
  const [scale,setScale] = useState("10000");
  const [message,setMessage] = useState("Ready.");

  useEffect(() => {
    fetch("/api/scenarios").then(r=>r.json()).then(setScenarios).catch(()=>setScenarios([]));
  }, []);

  async function generate() {
    setMessage("Generating Parquet and loading Bronze...");
    const response = await fetch("/api/generate", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({scenario:"retail-baseline", scale:Number(scale), seed:42})
    });
    const data = await response.json();
    setMessage(response.ok ? `Loaded ${data.scale.toLocaleString()} sales rows into Bronze.` : JSON.stringify(data));
  }

  return <div className="shell">
    <header>
      <div><Text size={500} weight="semibold">Contoso Data Studio</Text><Text className="muted">Local DuckLake + dbt workbench</Text></div>
      <div className="badges"><Badge appearance="outline" color="success">LOCAL</Badge><Badge appearance="outline">DuckDB</Badge><Badge appearance="outline">DuckLake</Badge><Badge appearance="outline">dbt</Badge></div>
    </header>
    <div className="layout">
      <aside>
        {pages.map(([label,icon]) => <button key={label} className={page===label?"active":""} onClick={()=>setPage(label)}>{icon}{label}</button>)}
      </aside>
      <main>
        <div className="pageTitle"><div><Text className="eyebrow">CONTOSO / LOCAL WORKSPACE</Text><Title2>{page}</Title2></div><Text className="muted">{message}</Text></div>
        {page==="Generate" ? <div className="grid">
          <Card>
            <CardHeader header={<Title3>Retail baseline</Title3>} description="First executable scenario"/>
            <Text>Generate deterministic retail Parquet and load it into the local DuckLake Bronze layer.</Text>
            <div className="controls"><Input value={scale} onChange={(_,d)=>setScale(d.value)}/><Button appearance="primary" onClick={generate}>Generate + load Bronze</Button></div>
            <div className="flow">Scenario → Parquet → Bronze → dbt → Gold → Charts</div>
          </Card>
          <Card>
            <CardHeader header={<Title3>Scenario library</Title3>}/>
            {scenarios.map(s=><div className="scenario" key={s.id}><div><b>{s.name}</b><span>{s.description}</span></div><Badge appearance="outline" color={s.status==="ready"?"success":"informative"}>{s.status}</Badge></div>)}
          </Card>
        </div> : <Card><CardHeader header={<Title3>{page}</Title3>}/><Text>This workbench is scaffolded and will be implemented on top of the same local workspace.</Text></Card>}
      </main>
    </div>
  </div>
}
