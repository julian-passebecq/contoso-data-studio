import { useEffect, useState, type ReactNode } from "react";
import { Badge, Text, Title2 } from "@fluentui/react-components";
import {
  ArrowSync24Regular,
  Board24Regular,
  ChartMultiple24Regular,
  Code24Regular,
  Database24Regular,
  DataUsage24Regular,
  DocumentTable24Regular,
} from "@fluentui/react-icons";

import { getJson } from "./api";
import CanvasPage from "./pages/CanvasPage";
import ChartsPage from "./pages/ChartsPage";
import ExplorePage from "./pages/ExplorePage";
import GeneratePage from "./pages/GeneratePage";
import LakehousePage from "./pages/LakehousePage";
import QueryPage from "./pages/QueryPage";
import TransformPage from "./pages/TransformPage";
import type { Page, Scenario } from "./types";

const pages: Array<[Page, ReactNode]> = [
  ["Generate", <ArrowSync24Regular/>],
  ["Lakehouse", <Database24Regular/>],
  ["Transform", <DataUsage24Regular/>],
  ["Query", <Code24Regular/>],
  ["Explore", <DocumentTable24Regular/>],
  ["Charts", <ChartMultiple24Regular/>],
  ["Canvas", <Board24Regular/>],
];

export default function App() {
  const [page,setPage] = useState<Page>("Generate");
  const [scenarios,setScenarios] = useState<Scenario[]>([]);
  const [message,setMessage] = useState("Ready.");
  const [querySeed,setQuerySeed] = useState("");
  const [refreshToken,setRefreshToken] = useState(0);

  useEffect(() => {
    getJson<Scenario[]>("/api/scenarios").then(setScenarios).catch(()=>setScenarios([]));
  }, []);

  function openQuery(sql:string) {
    setQuerySeed(sql);
    setPage("Query");
  }

  function onDbtBuilt() {
    setRefreshToken(value=>value+1);
    setMessage("dbt completed. Silver and Gold catalog state refreshed.");
  }

  function renderPage() {
    if (page==="Generate") return <GeneratePage scenarios={scenarios} onStatus={setMessage} onGenerated={()=>setRefreshToken(v=>v+1)}/>;
    if (page==="Lakehouse") return <LakehousePage refreshToken={refreshToken}/>;
    if (page==="Transform") return <TransformPage onBuilt={onDbtBuilt} onOpenQuery={openQuery}/>;
    if (page==="Query") return <QueryPage initialSql={querySeed}/>;
    if (page==="Explore") return <ExplorePage onOpenQuery={openQuery}/>;
    if (page==="Charts") return <ChartsPage/>;
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
          <button key={label} className={page===label?"active":""} onClick={()=>setPage(label)}>
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
        {renderPage()}
      </main>
    </div>
  </div>;
}
