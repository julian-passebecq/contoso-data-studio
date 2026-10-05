import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardHeader, Spinner, Text, Title2, Title3 } from "@fluentui/react-components";

import { PROJECTS, groupFor, groupName, type ProjectPreset, type ProjectGroup } from "../projects";
import PortfolioOverview from "../components/PortfolioOverview";
import type { Page, Scenario, WorkspaceProjectState } from "../types";
import {
  readTutorialProgress,
  resetTutorialProgress,
  setSelectedProjectScenario,
  writeTutorialProgress,
} from "../tutorialProgress";
import "../projects.css";

type TutorialStep = {
  id: string;
  title: string;
  description: string;
  page?: Page;
  query?: string;
};


function stepsFor(project: ProjectPreset): TutorialStep[] {
  return [
    {
      id: "prepare",
      title: "Prepare the sample project",
      description: "Generate deterministic Parquet data, load DuckLake Bronze, then run dbt through Silver and Gold.",
    },
    {
      id: "explore",
      title: "Inspect the source files",
      description: `Open ${project.scenario.startsWith("foil-") ? "foil_trials" : "sales"}.parquet, inspect schema, row groups, metadata and sample rows.`,
      page: "Explore",
    },
    {
      id: "lakehouse",
      title: "Browse Bronze / Silver / Gold",
      description: "Confirm the generated source tables and the dbt-managed analytical layers.",
      page: "Lakehouse",
    },
    {
      id: "transform",
      title: "Read the dbt DAG and tests",
      description: "Trace sources through Silver transformations into Gold decision marts, then inspect data-quality results.",
      page: "Transform",
    },
    {
      id: "query",
      title: "Answer the business question",
      description: project.question,
      page: "Query",
      query: project.query,
    },
    {
      id: "charts",
      title: "Review the KPI output",
      description: "Compare the SQL result with the Gold KPI and chart view.",
      page: "Charts",
    },
    {
      id: "canvas",
      title: "Review the architecture",
      description: "Use the Canvas to connect the case study back to the end-to-end data flow.",
      page: "Canvas",
    },
  ];
}

export default function ProjectsPage({
  scenarios,
  onStatus,
  onOpenProject,
  opening,
  workspace,
  onNavigate,
}:{
  scenarios: Scenario[];
  onStatus: (message:string)=>void;
  onOpenProject: (project:ProjectPreset, destination?:Page, sql?:string)=>Promise<boolean>;
  opening: string;
  workspace: WorkspaceProjectState|null;
  onNavigate: (page:Page)=>void;
}) {
  const [selectedScenario,setSelectedScenario] = useState(
    ()=>localStorage.getItem("contoso-selected-project") || ""
  );
  const [progress,setProgress] = useState<Record<string,boolean>>(
    ()=>selectedScenario ? readTutorialProgress(selectedScenario) : {}
  );
  const preparing=opening;
  const [group,setGroup] = useState<ProjectGroup>(()=>{
    const saved=localStorage.getItem("contoso-project-group");
    return saved==="samples" ? "samples" : "foil";
  });

  const selected = useMemo(
    ()=>PROJECTS.find(project=>project.scenario===selectedScenario && groupFor(project.scenario)===group) ?? null,
    [selectedScenario,group],
  );

  useEffect(()=>{
    if (!selectedScenario) return;
    setSelectedProjectScenario(selectedScenario);
    setProgress(readTutorialProgress(selectedScenario));
  },[selectedScenario]);

  function updateProgress(next:Record<string,boolean>) {
    setProgress(next);
    if (selectedScenario) {
      writeTutorialProgress(selectedScenario,next);
    }
  }

  function toggleStep(stepId:string) {
    updateProgress({...progress,[stepId]:!progress[stepId]});
  }

  async function prepareProject(project:ProjectPreset, destination:Page="Charts") {
    const opened=await onOpenProject(project,destination);
    if(opened && destination==="Projects") {
      setSelectedScenario(project.scenario);
      setProgress(readTutorialProgress(project.scenario));
    }
  }

  function switchGroup(next:ProjectGroup) {
    setGroup(next);
    localStorage.setItem("contoso-project-group",next);
  }

  function openStep(step:TutorialStep) {
    if(!selected) return;
    void onOpenProject(selected,step.page ?? "Projects",step.query);
  }

  function resetGuide() {
    if (!selectedScenario) return;
    resetTutorialProgress(selectedScenario);
    setProgress({});
    onStatus("Tutorial progress reset. Generated project data was kept.");
  }

  const selectedScenarioInfo=scenarios.find(item=>item.id===selectedScenario);
  const tutorialSteps=selected ? stepsFor(selected) : [];
  const done=tutorialSteps.filter(step=>progress[step.id]).length;

  return <div className="projectsStack">
    <section className="projectHero">
      <div>
        <Text className="eyebrow">PROJECT PORTFOLIO</Text>
        <Title2>Your projects, one workspace</Title2>
        <Text className="projectLead">
          Choose a group, explore its architecture, then open a project.
          Its data, models and dashboard activate together.
        </Text>
      </div>
      <Button appearance="subtle" disabled={Boolean(preparing)} onClick={()=>onNavigate("Generate")}>Manual workspace</Button>
    </section>

    <div className="groupSwitcher" role="group" aria-label="Project groups">
      {(["foil","samples"] as const).map(item=><button key={item} aria-pressed={group===item}
        className={group===item ? "groupTile selected" : "groupTile"} disabled={Boolean(preparing)} onClick={()=>switchGroup(item)}>
        <b>{groupName(item)}</b><span>{item==="foil" ? "Energy · economics · sensitivity" : "Retail · channels · margins · logistics · FX"}</span>
        <small>{PROJECTS.filter(p=>groupFor(p.scenario)===item).length} projects</small>
      </button>)}
    </div>
    <div className="projectSectionHeader"><Title2>{groupName(group)} projects</Title2><Button appearance="subtle" onClick={()=>{const overview=document.getElementById("group-architecture");overview?.scrollIntoView({behavior:"smooth",block:"start"});overview?.focus({preventScroll:true});}}>View group architecture ↓</Button></div>
    <div className="projectGrid">
      {PROJECTS.filter(project=>groupFor(project.scenario)===group).map(project=>{
        const scenario=scenarios.find(item=>item.id===project.scenario);
        const busy=preparing===project.scenario;
        return <Card key={project.scenario} className={selectedScenario===project.scenario ? "projectCard selected" : "projectCard"}>
          <CardHeader
            header={<Title3>{project.title}</Title3>}
            description={scenario?.name ?? project.scenario}
            action={<Badge appearance="outline" color={project.difficulty==="Beginner"?"success":project.difficulty==="Advanced"?"warning":"informative"}>{project.difficulty}</Badge>}
          />
          {workspace?.active_scenario===project.scenario && <Badge appearance="outline" color={workspace.ready ? "success" : "warning"}>{workspace.ready ? "Active · ready" : "Active · needs preparation"}</Badge>}
          <Text>{project.mission}</Text>
          <div className="projectOutcome">{project.outcome}</div>
          <div className="projectQuestion">
            <span>BUSINESS QUESTION</span>
            <b>{project.question}</b>
          </div>
          <div className="projectActions">
            <Button
              appearance="primary"
              disabled={Boolean(preparing)}
              onClick={()=>void prepareProject(project)}
            >
              {busy ? "Opening..." : workspace?.active_scenario===project.scenario && workspace.ready ? "Open dashboard" : "Open project"}
            </Button>
            <Button disabled={Boolean(preparing)} onClick={()=>setSelectedScenario(project.scenario)}>View guide</Button>
          </div>
        </Card>;
      })}
    </div>

    <section id="group-architecture" tabIndex={-1}><PortfolioOverview group={group} activeScenario={workspace?.active_scenario ?? null}/></section>

    {preparing && <Card className="prepareCard">
      <Spinner size="tiny"/>
      <div role="status">
        <b>Activating the complete local project</b>
        <Text>Generator → Parquet → DuckLake Bronze → dbt Silver → dbt Gold</Text>
      </div>
    </Card>}

    {selected && <section className="guidePanel">
      <div className="guideHeader">
        <div>
          <Text className="eyebrow">ACTIVE GUIDE</Text>
          <Title3>{selected.title}</Title3>
          <Text className="muted">{selectedScenarioInfo?.focus ?? selected.mission}</Text>
          <Text className="muted tiny">Progress completes automatically from real workspace activity; manual controls remain available.</Text>
        </div>
        <div className="guideProgress">
          <b>{done} / {tutorialSteps.length}</b>
          <span>steps complete</span>
          <Button size="small" appearance="subtle" onClick={resetGuide}>Reset guide</Button>
        </div>
      </div>

      <div className="guideProgressBar">
        <i style={{width:`${tutorialSteps.length ? Math.round(done/tutorialSteps.length*100) : 0}%`}}/>
      </div>

      <div className="tutorialSteps">
        {tutorialSteps.map((step,index)=><div className={progress[step.id] ? "tutorialStep done" : "tutorialStep"} key={step.id}>
          <button className="stepCheck" type="button" onClick={()=>toggleStep(step.id)} aria-label={progress[step.id] ? "Mark incomplete" : "Mark complete"}>
            {progress[step.id] ? "✓" : index+1}
          </button>
          <div className="stepCopy">
            <b>{step.title}</b>
            <span>{step.description}</span>
            {step.id==="prepare" && <code>10,000 {selected.scenario.startsWith("foil-") ? "simulation draws" : "sales rows"} · seed 42 · deterministic</code>}
          </div>
          <div className="stepActions">
            {step.id==="prepare"
              ? <Button size="small" disabled={Boolean(preparing)} onClick={()=>void prepareProject(selected,"Projects")}>
                  {preparing ? "Preparing..." : progress.prepare ? "Activate project" : "Prepare project"}
                </Button>
              : <Button size="small" onClick={()=>openStep(step)}>Open {step.page}</Button>}
            {step.id!=="prepare" && <Button size="small" appearance="subtle" onClick={()=>toggleStep(step.id)}>
              {progress[step.id] ? "Undo" : "Mark done"}
            </Button>}
          </div>
        </div>)}
      </div>

      <Card className="missionCard">
        <CardHeader header={<Title3>Mission</Title3>} description="Use the existing Gold contract; do not invent a parallel dataset"/>
        <Text>{selected.mission}</Text>
        <pre>{selected.query}</pre>
        <Button appearance="primary" disabled={Boolean(preparing)} onClick={()=>void onOpenProject(selected,"Query",selected.query)}>Open this query</Button>
      </Card>
    </section>}
  </div>;
}
