import { Badge, Card, Text, Title3 } from "@fluentui/react-components";
import { groupFor, type ProjectGroup } from "../projects";

const ARCHITECTURES = {
  foil: [
    ["Reference & scenarios", "FOIL Wind R0 · 9 reference cases", "Seeded uncertainty · investment stress · ±20% sensitivity"],
    ["Bronze · Parquet / DuckLake", "foil_cases · foil_trials", "foil_sensitivity · saved run provenance"],
    ["Silver · dbt", "foil_experiments", "foil_cashflows · annual energy, costs and revenue"],
    ["Gold · decision marts", "Energy risk · project summary", "Experiment metrics · sensitivity · cashflow schedule"],
    ["Decision views", "AEP P50/P90 · LCOE · NPV", "SQL · Charts · project lineage Canvas"],
  ],
  samples: [
    ["Sample scenarios", "Retail · online · margin · logistics · FX", "Deterministic sales and reference data"],
    ["Bronze · Parquet / DuckLake", "customer · product · store", "currency_exchange · sales"],
    ["Silver · dbt", "stg_sales", "Reusable sales, cost, channel and geography layer"],
    ["Gold · business marts", "Monthly sales · store · channel", "Product · delivery · currency performance"],
    ["Business views", "Revenue · margin · service · FX", "SQL · Charts · project lineage Canvas"],
  ],
};

export default function PortfolioOverview({group,activeScenario}:{group:ProjectGroup;activeScenario:string|null}) {
  const foil=group==="foil";
  return <Card className="portfolioOverview">
    <div className="portfolioHeading"><div><Text className="eyebrow">GROUP OVERVIEW</Text><Title3>{foil ? "FOIL · from energy yield to investment decisions" : "Samples · a complete retail analytics portfolio"}</Title3></div>
      <Badge appearance="outline">{foil ? "3 projects · shared analytical foundation" : "5 projects · shared retail foundation"}</Badge>
    </div>
    <Text>{foil
      ? "Explore expected production and uncertainty, stress the investment budget, then identify the assumptions that move the decision. The three projects share nine FOIL reference cases and reusable dbt layers."
      : "Explore baseline performance, channel migration, margin pressure, delivery service and currency exposure through five scenarios built on the same retail model."}</Text>
    <div className="portfolioThemes">{(foil
      ? ["01 · Yield & risk — AEP P50/P90", "02 · Investment — CAPEX/OPEX, LCOE & NPV", "03 · Sensitivity — decision drivers"]
      : ["Sales & channels", "Margins & profitability", "Delivery & currency exposure"]).map(theme=><span key={theme}>{theme}</span>)}</div>
    <div className="portfolioArchitecture" aria-label={`${foil ? "FOIL" : "Samples"} group architecture`}>
      {ARCHITECTURES[group].map(([title,main,detail],index)=><section className="portfolioStage" key={title}><span className="stageNumber">{index+1}</span><b>{title}</b><strong>{main}</strong><small>{detail}</small>{index<4 && <span className="stageArrow" aria-hidden="true">→</span>}</section>)}
    </div>
    <Text className="muted">{foil
      ? "Synthetic screening scenarios, with explicit assumptions and source provenance. Energy P90 means the 10th percentile."
      : "Synthetic sample data for learning and demonstration."} One project is active at a time; your saved runs and guide progress remain available.</Text>
    {activeScenario && groupFor(activeScenario)!==group && <Text className="portfolioBrowseNote">You are browsing this group. The active workspace stays on the other group until you open a project.</Text>}
  </Card>;
}
