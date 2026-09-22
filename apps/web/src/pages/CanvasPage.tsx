import { useEffect, useState } from "react";
import { Badge, Button, Card, CardHeader, Text, Title3 } from "@fluentui/react-components";

import { getJson } from "../api";
import type { CatalogTable } from "../types";
import "../canvas.css";

type Column = {
  id:string;
  title:string;
  subtitle:string;
  nodes:Array<{id:string;label:string;kind:string;query?:string}>;
};

export default function CanvasPage({onOpenQuery}:{onOpenQuery:(sql:string)=>void}) {
  const [catalog,setCatalog] = useState<CatalogTable[]>([]);
  const [note,setNote] = useState(()=>localStorage.getItem("contoso-canvas-note") ?? "Retail baseline → Gold KPIs");
  const [saved,setSaved] = useState(false);

  useEffect(()=>{
    getJson<{tables:CatalogTable[]}>("/api/lakehouse/catalog").then(data=>setCatalog(data.tables)).catch(()=>{});
  },[]);

  const tableNodes = (schema:string) => catalog
    .filter(table=>table.schema===schema)
    .map(table=>({
      id:`${schema}.${table.name}`,
      label:table.name,
      kind:table.type,
      query:`select * from contoso.${schema}.${table.name} limit 100;`,
    }));

  const columns:Column[] = [
    {
      id:"generate",
      title:"Generate",
      subtitle:"Scenario + seed",
      nodes:[{id:"retail-baseline",label:"retail-baseline",kind:"scenario"}],
    },
    {
      id:"bronze",
      title:"Bronze",
      subtitle:"Source-shaped DuckLake",
      nodes:tableNodes("bronze"),
    },
    {
      id:"silver",
      title:"Silver",
      subtitle:"Clean reusable models",
      nodes:tableNodes("silver"),
    },
    {
      id:"gold",
      title:"Gold",
      subtitle:"Business marts / KPIs",
      nodes:tableNodes("gold"),
    },
    {
      id:"outputs",
      title:"Outputs",
      subtitle:"Query + dbt Charts",
      nodes:[
        {id:"executive-sales",label:"executive-sales.yml",kind:"dbt Charts"},
        {id:"sql-workbench",label:"SQL workbench",kind:"DuckDB"},
      ],
    },
  ];

  function saveNote() {
    localStorage.setItem("contoso-canvas-note",note);
    setSaved(true);
    window.setTimeout(()=>setSaved(false),1200);
  }

  return <div className="canvasStack">
    <Card>
      <CardHeader
        header={<Title3>Lineage canvas</Title3>}
        description="Domain-specific whiteboard generated from the local DuckLake catalog"
        action={<Badge appearance="outline">{catalog.length} catalog nodes</Badge>}
      />
      <div className="canvasBoard">
        {columns.map((column,index)=><div className="canvasStageWrap" key={column.id}>
          <section className="canvasStage">
            <div className="canvasStageHeader"><b>{column.title}</b><span>{column.subtitle}</span></div>
            <div className="canvasNodes">
              {column.nodes.map(node=><button
                className="canvasNode"
                key={node.id}
                disabled={!node.query}
                onClick={()=>node.query && onOpenQuery(node.query)}
                title={node.query ? "Open this table in Query" : node.kind}
              >
                <span>{node.label}</span><small>{node.kind}</small>
              </button>)}
              {!column.nodes.length && <div className="canvasEmpty">Run the previous stage</div>}
            </div>
          </section>
          {index<columns.length-1 && <div className="canvasConnector">→</div>}
        </div>)}
      </div>
    </Card>

    <Card className="canvasNoteCard">
      <CardHeader header={<Title3>Workspace note</Title3>} description="Local browser note — deliberately separate from dbt metadata"/>
      <textarea value={note} onChange={event=>setNote(event.target.value)} placeholder="Add a design note, KPI question, or modeling reminder..."/>
      <div className="canvasNoteActions"><Button onClick={saveNote}>Save locally</Button>{saved && <Text className="muted tiny">Saved</Text>}</div>
    </Card>
  </div>;
}
