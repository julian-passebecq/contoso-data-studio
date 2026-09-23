import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardHeader, Text, Title3 } from "@fluentui/react-components";

import { getJson } from "../api";
import type {
  CatalogTable,
  DbtLineage,
  DbtLineageNode,
  DbtQuality,
  GenerationRunDetail,
} from "../types";
import "../canvas.css";
import { completeTutorialStep } from "../tutorialProgress";

type CanvasNode = {
  id:string;
  label:string;
  kind:string;
  query?:string;
  upstream?:string[];
  quality?:{checks:number;issues:number;passed:number};
};

type Column = {
  id:string;
  title:string;
  subtitle:string;
  nodes:CanvasNode[];
};

export default function CanvasPage({onOpenQuery}:{onOpenQuery:(sql:string)=>void}) {
  const [catalog,setCatalog] = useState<CatalogTable[]>([]);
  const [lineage,setLineage] = useState<DbtLineage|null>(null);
  const [quality,setQuality] = useState<DbtQuality|null>(null);
  const [activeRun,setActiveRun] = useState<GenerationRunDetail|null>(null);
  const [note,setNote] = useState(()=>localStorage.getItem("contoso-canvas-note") ?? "Active scenario → Bronze → dbt → Gold KPIs");
  const [saved,setSaved] = useState(false);

  useEffect(()=>{
    void (async()=>{
      const [catalogResult,lineageResult,qualityResult,activeResult]=await Promise.allSettled([
        getJson<{tables:CatalogTable[]}>("/api/lakehouse/catalog"),
        getJson<DbtLineage>("/api/dbt/lineage"),
        getJson<DbtQuality>("/api/dbt/quality"),
        getJson<{run:GenerationRunDetail|null}>("/api/workspace/active-run"),
      ]);
      if (catalogResult.status==="fulfilled") setCatalog(catalogResult.value.tables);
      if (lineageResult.status==="fulfilled") setLineage(lineageResult.value);
      if (qualityResult.status==="fulfilled") setQuality(qualityResult.value);
      if (activeResult.status==="fulfilled") setActiveRun(activeResult.value.run);
      if (
        activeResult.status==="fulfilled" &&
        activeResult.value.run?.scenario &&
        ((catalogResult.status==="fulfilled" && catalogResult.value.tables.length>0) ||
          (lineageResult.status==="fulfilled" && lineageResult.value.nodes.length>0))
      ) {
        completeTutorialStep("canvas",activeResult.value.run.scenario);
      }
    })();
  },[]);

  const catalogKeys = useMemo(
    ()=>new Set(catalog.map(table=>`${table.schema}.${table.name}`)),
    [catalog],
  );
  const lineageNodeById = useMemo(
    ()=>new Map((lineage?.nodes ?? []).map(node=>[node.id,node])),
    [lineage],
  );

  function queryFor(node:DbtLineageNode) {
    if (!["bronze","silver","gold"].includes(node.layer)) return undefined;
    if (!catalogKeys.has(`${node.layer}.${node.name}`)) return undefined;
    return `select * from contoso.${node.layer}.${node.name} limit 100;`;
  }

  function qualityFor(layer:string,name:string) {
    const tests=quality?.tests.filter(test=>test.layer===layer && test.model===name) ?? [];
    if (!tests.length) return undefined;
    const issues=tests.filter(test=>["fail","warn","error"].includes(test.status)).length;
    const passed=tests.filter(test=>test.status==="pass").length;
    return {checks:tests.length,issues,passed};
  }

  function upstreamFor(nodeId:string) {
    return (lineage?.edges ?? [])
      .filter(edge=>edge.target===nodeId)
      .map(edge=>lineageNodeById.get(edge.source)?.name ?? edge.source);
  }

  function manifestNodes(layer:string):CanvasNode[] {
    return (lineage?.nodes ?? [])
      .filter(node=>node.layer===layer)
      .map(node=>({
        id:node.id,
        label:node.name,
        kind:node.resource_type==="source" ? "dbt source" : `dbt ${node.materialized}`,
        query:queryFor(node),
        upstream:upstreamFor(node.id),
        quality:qualityFor(node.layer,node.name),
      }));
  }

  function catalogNodes(schema:string):CanvasNode[] {
    return catalog
      .filter(table=>table.schema===schema)
      .map(table=>({
        id:`${schema}.${table.name}`,
        label:table.name,
        kind:table.type,
        query:`select * from contoso.${schema}.${table.name} limit 100;`,
        quality:qualityFor(schema,table.name),
      }));
  }

  function nodesFor(layer:string) {
    const fromManifest=manifestNodes(layer);
    return fromManifest.length ? fromManifest : catalogNodes(layer);
  }

  const columns:Column[] = [
    {
      id:"generate",
      title:"Generate",
      subtitle:"Active persisted scenario",
      nodes:activeRun ? [{
        id:activeRun.run_id,
        label:activeRun.scenario ?? activeRun.scenario_name ?? "scenario",
        kind:`seed ${activeRun.seed ?? "—"} · ${(activeRun.scale ?? 0).toLocaleString()} sales`,
      }] : [],
    },
    {
      id:"bronze",
      title:"Bronze",
      subtitle:"DuckLake sources",
      nodes:nodesFor("bronze"),
    },
    {
      id:"silver",
      title:"Silver",
      subtitle:"dbt staging / reusable models",
      nodes:nodesFor("silver"),
    },
    {
      id:"gold",
      title:"Gold",
      subtitle:"dbt business marts / KPIs",
      nodes:nodesFor("gold"),
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
        description={lineage?.generated_at
          ? `dbt manifest · ${lineage.nodes.length} nodes · ${lineage.edges.length} dependencies`
          : "DuckLake catalog fallback — run dbt Parse/Build for manifest lineage"}
        action={<div className="buttonRow">
          {activeRun?.is_active && <Badge appearance="outline" color="success">Active Bronze #{activeRun.active_snapshot_id ?? "—"}</Badge>}
          {quality && quality.summary.total>0 && <Badge
            appearance="outline"
            color={quality.summary.fail+quality.summary.error+quality.summary.warn===0 ? "success" : "danger"}
          >
            {quality.summary.pass}/{quality.summary.total} quality checks
          </Badge>}
          <Badge appearance="outline">{catalog.length} physical tables</Badge>
        </div>}
      />
      <div className="canvasBoard">
        {columns.map((column,index)=><div className="canvasStageWrap" key={column.id}>
          <section className="canvasStage">
            <div className="canvasStageHeader"><b>{column.title}</b><span>{column.subtitle}</span></div>
            <div className="canvasNodes">
              {column.nodes.map(node=><button
                className={node.quality?.issues ? "canvasNode issue" : "canvasNode"}
                key={node.id}
                disabled={!node.query}
                onClick={()=>node.query && onOpenQuery(node.query)}
                title={node.query ? "Open this physical table in Query" : node.kind}
              >
                <span>{node.label}</span>
                <small>{node.kind}</small>
                {node.quality && <strong className={node.quality.issues ? "nodeQuality issue" : "nodeQuality"}>
                  {node.quality.issues
                    ? `${node.quality.issues} issue${node.quality.issues===1?"":"s"} · ${node.quality.checks} checks`
                    : `${node.quality.passed}/${node.quality.checks} checks passing`}
                </strong>}
                {node.upstream && node.upstream.length>0 && <em>← {node.upstream.join(", ")}</em>}
              </button>)}
              {!column.nodes.length && <div className="canvasEmpty">Run the previous stage</div>}
            </div>
          </section>
          {index<columns.length-1 && <div className="canvasConnector">→</div>}
        </div>)}
      </div>

      {lineage && lineage.edges.length>0 && <div className="manifestEdges">
        <Text className="muted tiny">MANIFEST DEPENDENCIES</Text>
        <div>
          {lineage.edges.map(edge=>{
            const source=lineageNodeById.get(edge.source);
            const target=lineageNodeById.get(edge.target);
            return <code key={`${edge.source}->${edge.target}`}>
              {source?.name ?? edge.source} → {target?.name ?? edge.target}
            </code>;
          })}
        </div>
      </div>}
    </Card>

    <Card className="canvasNoteCard">
      <CardHeader header={<Title3>Workspace note</Title3>} description="Local browser note — deliberately separate from dbt metadata"/>
      <textarea value={note} onChange={event=>setNote(event.target.value)} placeholder="Add a design note, KPI question, or modeling reminder..."/>
      <div className="canvasNoteActions"><Button onClick={saveNote}>Save locally</Button>{saved && <Text className="muted tiny">Saved</Text>}</div>
    </Card>
  </div>;
}
