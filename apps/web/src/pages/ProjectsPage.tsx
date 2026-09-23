import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardHeader, Spinner, Text, Title2, Title3 } from "@fluentui/react-components";

import { postJson } from "../api";
import type { Page, Scenario } from "../types";
import {
  readTutorialProgress,
  resetTutorialProgress,
  setSelectedProjectScenario,
  writeTutorialProgress,
} from "../tutorialProgress";
import "../projects.css";

type ProjectPreset = {
  scenario: string;
  title: string;
  difficulty: "Beginner" | "Intermediate" | "Advanced";
  mission: string;
  question: string;
  query: string;
  outcome: string;
};

type TutorialStep = {
  id: string;
  title: string;
  description: string;
  page?: Page;
  query?: string;
};

const PROJECTS: ProjectPreset[] = [
  {
    scenario: "retail-baseline",
    title: "Retail Sales 101",
    difficulty: "Beginner",
    mission: "Build a complete local retail lakehouse and identify the strongest markets, channels and products.",
    question: "Which countries generate the most revenue and gross margin?",
    query: `select
  store_country as country,
  round(sum(revenue), 2) as revenue,
  round(sum(gross_margin), 2) as gross_margin,
  round(sum(gross_margin) / nullif(sum(revenue), 0), 4) as margin_rate
from contoso.gold.store_performance
group by 1
order by revenue desc;`,
    outcome: "Parquet → DuckLake Bronze → dbt Silver/Gold → SQL → KPI review",
  },
  {
    scenario: "online-migration",
    title: "Online Channel Shift",
    difficulty: "Intermediate",
    mission: "Investigate a sharp move toward online sales and measure how channel mix changes in year two.",
    question: "How quickly does Online gain revenue share, and what happens to the other channels?",
    query: `select
  order_year,
  channel,
  revenue,
  revenue_share,
  gross_margin
from contoso.gold.channel_performance
order by order_year, revenue_share desc;`,
    outcome: "Channel mix analysis using dbt Gold marts",
  },
  {
    scenario: "margin-pressure",
    title: "Margin Crisis",
    difficulty: "Intermediate",
    mission: "Diagnose margin compression caused by heavier discounting and rising costs.",
    question: "When does gross margin rate deteriorate, and does discounting move with it?",
    query: `select
  extract(year from order_month)::integer as year,
  round(sum(gross_margin) / nullif(sum(revenue), 0), 4) as margin_rate,
  round(avg(avg_discount_rate), 4) as avg_discount_rate,
  round(sum(revenue), 2) as revenue
from contoso.gold.monthly_sales
group by 1
order by 1;`,
    outcome: "Margin diagnostics across monthly Gold facts",
  },
  {
    scenario: "logistics-delays",
    title: "Logistics SLA Investigation",
    difficulty: "Intermediate",
    mission: "Find the fulfilment channel with the worst delivery performance and quantify service degradation.",
    question: "Which channel has the highest p90 delivery time and over-7-day rate?",
    query: `select
  channel,
  round(avg(avg_delivery_days), 2) as avg_delivery_days,
  round(avg(p90_delivery_days), 2) as p90_delivery_days,
  round(avg(over_7_day_rate), 4) as over_7_day_rate
from contoso.gold.delivery_metrics
group by 1
order by p90_delivery_days desc;`,
    outcome: "Operational SLA analysis from Gold delivery metrics",
  },
  {
    scenario: "currency-exposure",
    title: "FX Exposure",
    difficulty: "Advanced",
    mission: "Measure currency volatility and compare local-currency activity with USD-normalized revenue.",
    question: "Which currencies show the largest exchange-rate spread and revenue exposure?",
    query: `select
  currency,
  min(avg_exchange_rate_to_usd) as min_rate,
  max(avg_exchange_rate_to_usd) as max_rate,
  max(avg_exchange_rate_to_usd) - min(avg_exchange_rate_to_usd) as rate_spread,
  round(sum(revenue_usd), 2) as revenue_usd
from contoso.gold.currency_exposure
group by 1
order by rate_spread desc;`,
    outcome: "FX normalization and exposure analysis",
  },
];

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
      description: "Open sales.parquet, inspect schema, row groups, metadata and sample rows.",
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
      description: "Trace sources into stg_sales and the Gold marts, then inspect data-quality results.",
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
  onPrepared,
  onNavigate,
  onOpenQuery,
}:{
  scenarios: Scenario[];
  onStatus: (message:string)=>void;
  onPrepared: ()=>void;
  onNavigate: (page:Page)=>void;
  onOpenQuery: (sql:string)=>void;
}) {
  const [selectedScenario,setSelectedScenario] = useState(
    ()=>localStorage.getItem("contoso-selected-project") || ""
  );
  const [progress,setProgress] = useState<Record<string,boolean>>(
    ()=>selectedScenario ? readTutorialProgress(selectedScenario) : {}
  );
  const [preparing,setPreparing] = useState("");
  const [error,setError] = useState("");

  const selected = useMemo(
    ()=>PROJECTS.find(project=>project.scenario===selectedScenario) ?? null,
    [selectedScenario],
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

  async function prepareProject(project:ProjectPreset) {
    setSelectedScenario(project.scenario);
    setSelectedProjectScenario(project.scenario);
    setPreparing(project.scenario);
    setError("");
    onStatus(`Preparing ${project.title}: generating sample data...`);
    try {
      await postJson<Record<string,unknown>>("/api/generate", {
        scenario:project.scenario,
        scale:10_000,
        seed:42,
      });
      onStatus(`Preparing ${project.title}: building dbt Silver and Gold...`);
      await postJson<Record<string,unknown>>("/api/dbt/build", {});
      const next={...readTutorialProgress(project.scenario),prepare:true};
      writeTutorialProgress(project.scenario,next);
      setProgress(next);
      onPrepared();
      onStatus(`${project.title} is ready: sample Parquet, DuckLake Bronze, dbt Silver and Gold are populated.`);
    } catch (exc) {
      const message=exc instanceof Error ? exc.message : "Could not prepare the sample project.";
      setError(message);
      onStatus(message);
    } finally {
      setPreparing("");
    }
  }

  function openStep(step:TutorialStep) {
    if (step.query) {
      onOpenQuery(step.query);
      return;
    }
    if (step.page) onNavigate(step.page);
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
        <Text className="eyebrow">START WITH A WORKING CASE STUDY</Text>
        <Title2>Guided projects</Title2>
        <Text className="projectLead">
          Open a deterministic sample project with real Parquet files, DuckLake Bronze,
          dbt Silver/Gold models, SQL questions and KPI outputs.
        </Text>
      </div>
      <Button appearance="subtle" onClick={()=>onNavigate("Generate")}>Manual workspace</Button>
    </section>

    <div className="projectGrid">
      {PROJECTS.map(project=>{
        const scenario=scenarios.find(item=>item.id===project.scenario);
        const busy=preparing===project.scenario;
        return <Card key={project.scenario} className={selectedScenario===project.scenario ? "projectCard selected" : "projectCard"}>
          <CardHeader
            header={<Title3>{project.title}</Title3>}
            description={scenario?.name ?? project.scenario}
            action={<Badge appearance="outline" color={project.difficulty==="Beginner"?"success":project.difficulty==="Advanced"?"warning":"informative"}>{project.difficulty}</Badge>}
          />
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
              {busy ? "Preparing..." : "Open + prepare demo"}
            </Button>
            <Button onClick={()=>setSelectedScenario(project.scenario)}>View guide</Button>
          </div>
        </Card>;
      })}
    </div>

    {preparing && <Card className="prepareCard">
      <Spinner size="tiny"/>
      <div>
        <b>Preparing the complete local project</b>
        <Text>Generator → Parquet → DuckLake Bronze → dbt Silver → dbt Gold</Text>
      </div>
    </Card>}

    {error && <div className="errorText">{error}</div>}

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
            {step.id==="prepare" && <code>10,000 sales rows · seed 42 · deterministic</code>}
          </div>
          <div className="stepActions">
            {step.id==="prepare"
              ? <Button size="small" disabled={Boolean(preparing)} onClick={()=>void prepareProject(selected)}>
                  {preparing ? "Preparing..." : progress.prepare ? "Rebuild demo" : "Prepare demo"}
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
        <Button appearance="primary" onClick={()=>onOpenQuery(selected.query)}>Open this query</Button>
      </Card>
    </section>}
  </div>;
}
