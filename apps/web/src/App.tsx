import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Badge, Button, Spinner, Text, Title2 } from "@fluentui/react-components";
import {
  ArrowSync24Regular,
  Board24Regular,
  ChartMultiple24Regular,
  Code24Regular,
  Database24Regular,
  DataUsage24Regular,
  DocumentTable24Regular,
  Home24Regular,
} from "@fluentui/react-icons";

import { getJson, postJson } from "./api";
import { PROJECTS, groupFor, groupName, type ProjectPreset } from "./projects";
import { setSelectedProjectScenario, completeTutorialStep } from "./tutorialProgress";
import CanvasPage from "./pages/CanvasPage";
import ChartsPage from "./pages/ChartsPage";
import ExplorePage from "./pages/ExplorePage";
import GeneratePage from "./pages/GeneratePage";
import LakehousePage from "./pages/LakehousePage";
import QueryPage from "./pages/QueryPage";
import TransformPage from "./pages/TransformPage";
import type { Page, Scenario, WorkspaceProjectState } from "./types";
import "./projects.css";

const ProjectsPage=lazy(()=>import("./pages/ProjectsPage"));

const pages: Array<[Page, ReactNode]> = [
  ["Projects", <Home24Regular/>],
  ["Generate", <ArrowSync24Regular/>],
  ["Lakehouse", <Database24Regular/>],
  ["Transform", <DataUsage24Regular/>],
  ["Query", <Code24Regular/>],
  ["Explore", <DocumentTable24Regular/>],
  ["Charts", <ChartMultiple24Regular/>],
  ["Canvas", <Board24Regular/>],
];

export default function App() {
  const [page,setPage] = useState<Page>("Projects");
  const [scenarios,setScenarios] = useState<Scenario[]>([]);
  const [message,setMessage] = useState("Choose a guided project or open the manual workspace.");
  const [querySeed,setQuerySeed] = useState("");
  const [refreshToken,setRefreshToken] = useState(0);
  const [workspace,setWorkspace] = useState<WorkspaceProjectState|null>(null);
  const [workspaceLoading,setWorkspaceLoading] = useState(true);
  const [opening,setOpening] = useState("");
  const [projectError,setProjectError] = useState("");
  const openingRef=useRef(false);

  useEffect(() => {
    getJson<Scenario[]>("/api/scenarios").then(setScenarios).catch(()=>setScenarios([]));
  }, []);

  useEffect(()=>{
    let current=true;
    setWorkspaceLoading(true);
    getJson<WorkspaceProjectState>("/api/workspace/project-state").then(state=>{
      if(!current) return;
      setWorkspace(state);
      if(state.active_scenario) setSelectedProjectScenario(state.active_scenario);
      setQuerySeed(value=>value || PROJECTS.find(project=>project.scenario===state.active_scenario)?.query || "");
    }).catch(()=>{if(current) setWorkspace(null);}).finally(()=>{if(current) setWorkspaceLoading(false);});
    return ()=>{current=false;};
  },[refreshToken]);

  async function openProject(project:ProjectPreset, destination:Page="Charts", sql?:string) {
    if(openingRef.current) return false;
    openingRef.current=true;
    setOpening(project.scenario);
    setProjectError("");
    setMessage(`Opening ${project.title}: activating data, models and quality checks…`);
    try {
      const result=await postJson<{state:WorkspaceProjectState;resumed:boolean}>(`/api/projects/${project.scenario}/open`,{});
      if(!result.state.ready || result.state.active_scenario!==project.scenario) throw new Error("Project is not ready. Please inspect Transform.");
      setWorkspace(result.state);
      setSelectedProjectScenario(project.scenario);
      completeTutorialStep("prepare",project.scenario);
      localStorage.setItem("contoso-project-group",groupFor(project.scenario));
      setQuerySeed(sql ?? project.query);
      setRefreshToken(value=>value+1);
      setPage(destination);
      setMessage(`${project.title} is ready · data, models, quality and dashboard activated.`);
      return true;
    } catch(exc) {
      const error=exc instanceof Error ? exc.message : "Could not open this project.";
      setProjectError(error.split("\n")[0]);
      setMessage("Project activation failed. Please retry or inspect Transform.");
      // A failed build may have activated Bronze; show its real state.
      setRefreshToken(value=>value+1);
      setPage("Projects");
      return false;
    } finally {
      setOpening("");
      openingRef.current=false;
    }
  }

  function openQuery(sql:string) {
    setQuerySeed(sql);
    setPage("Query");
  }

  function onDbtBuilt() {
    setRefreshToken(value=>value+1);
    setMessage("dbt completed. Silver and Gold catalog state refreshed.");
  }

  function renderPage() {
    if (page==="Projects") return <ProjectsPage
      scenarios={scenarios}
      onStatus={setMessage}
      onOpenProject={openProject}
      opening={opening}
      workspace={workspace}
      onNavigate={setPage}
    />;
    if (page==="Generate") return <GeneratePage scenarios={scenarios} activeRun={workspace?.active_run ?? null} onStatus={setMessage} onGenerated={()=>{setQuerySeed("");setRefreshToken(v=>v+1);}}/>;
    if (page==="Lakehouse") return <LakehousePage refreshToken={refreshToken}/>;
    if (page==="Transform") return <TransformPage activeScenario={workspace?.active_scenario} onBuilt={onDbtBuilt} onOpenQuery={openQuery}/>;
    if (page==="Query") return <QueryPage initialSql={querySeed} initialProjectState={workspace}/>;
    if (page==="Explore") return <ExplorePage onOpenQuery={openQuery}/>;
    if (page==="Charts") return <ChartsPage onOpenQuery={openQuery}/>;
    return <CanvasPage onOpenQuery={openQuery}/>;
  }

  return <div className="shell">
    <header>
      <div className="brand">
        <Text size={500} weight="semibold">Contoso Data Studio</Text>
        <Text className="muted">Local lakehouse engineering workbench</Text>
      </div>
      <div className="badges">
        <Badge appearance="outline" color="success">LOCAL</Badge>
        <Badge appearance="outline">DuckDB</Badge>
        <Badge appearance="outline">DuckLake</Badge>
        <Badge appearance="outline">dbt</Badge>
      </div>
    </header>
    <div className="layout">
      <aside>
        <div className="navSection">WORKSPACE</div>
        {pages.map(([label,icon]) =>
          <button key={label} disabled={Boolean(opening)} className={page===label?"active":""} onClick={()=>setPage(label)}>
            {icon}{label}
          </button>
        )}
        <div className="pipelineMini">
          <span>Bronze</span><i>→</i><span>Silver</span><i>→</i><span>Gold</span>
        </div>
      </aside>
      <main>
        <div className="pageTitle">
          <div>
            <Text className="eyebrow">CONTOSO / LOCAL WORKSPACE</Text>
            <Title2>{page}</Title2>
          </div>
          <Text className="statusText">{message}</Text>
        </div>
        <div className="workspaceProjectBar">
          <div><Text className="eyebrow">ACTIVE WORKSPACE</Text><b>{workspaceLoading ? "Loading active workspace…" : workspace?.active_scenario ? `${groupName(groupFor(workspace.active_scenario))} / ${PROJECTS.find(p=>p.scenario===workspace.active_scenario)?.title ?? workspace.active_scenario}` : "Choose your first project"}</b></div>
          {workspace?.active_scenario && !workspaceLoading && <Badge appearance="outline" color={opening ? "informative" : workspace.ready ? "success" : "warning"}>{opening ? "Opening…" : workspace.ready ? "Ready" : "Needs preparation"}</Badge>}
          <label>Switch project <select aria-label="Switch project" disabled={Boolean(opening)||workspaceLoading} value={workspace?.active_scenario ?? ""}
            onChange={event=>{const project=PROJECTS.find(p=>p.scenario===event.target.value);if(project) void openProject(project);}}>
            <option value="" disabled>Choose a project</option>
            {(["foil","samples"] as const).map(group=><optgroup label={groupName(group)} key={group}>{PROJECTS.filter(p=>groupFor(p.scenario)===group).map(project=><option value={project.scenario} key={project.scenario}>{project.title}</option>)}</optgroup>)}
          </select></label>
          <Button disabled={Boolean(opening)} onClick={()=>setPage("Projects")}>Portfolio & architecture</Button>
        </div>
        {projectError && <div className="errorText" role="alert">{projectError} <Button size="small" onClick={()=>setPage("Transform")}>Inspect Transform</Button></div>}
        {opening ? <div className="projectOpening" role="status" aria-live="polite"><Spinner/><Title2>Opening {PROJECTS.find(p=>p.scenario===opening)?.title}</Title2><Text>Activating project data, rebuilding analytical layers and checking quality.</Text><Text className="muted">Your dashboard will open automatically when everything is ready.</Text></div>
          : <div key={refreshToken}><Suspense fallback={<Spinner label="Loading project portfolio…"/>}>{renderPage()}</Suspense></div>}
      </main>
    </div>
  </div>;
}
