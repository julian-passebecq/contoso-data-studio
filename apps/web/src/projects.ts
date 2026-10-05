export type ProjectPreset = {
  scenario: string;
  title: string;
  difficulty: "Beginner" | "Intermediate" | "Advanced";
  mission: string;
  question: string;
  query: string;
  outcome: string;
};

export const PROJECTS: ProjectPreset[] = [
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
  {
    scenario: "foil-energy-risk", title: "FOIL · AEP & P50/P90", difficulty: "Advanced",
    mission: "Build an energy decision layer from nine FOIL Wind R0 screening cases and 10,000 reproducible uncertainty draws.",
    question: "How far below median AEP is the energy exceeded in 90% of simulated draws?",
    query: "select case_id, draw_count, aep_p50_mwh, aep_p90_mwh, aep_p10_mwh from contoso.gold.foil_energy_risk order by case_id;",
    outcome: "Conditional energy risk · P90 = energy 10th percentile · synthetic assumptions",
  },
  {
    scenario: "foil-investment", title: "FOIL · LCOE & Investment", difficulty: "Advanced",
    mission: "Stress reference CAPEX by +30% and OPEX by +20%, then inspect discounted costs, energy and investment outcomes.",
    question: "What electricity price would break even, and how do cost overruns change NPV?",
    query: "select case_id, capex_eur, opex_eur_year, lcoe_eur_mwh, npv_eur, break_even_price_eur_mwh, positive_npv_probability from contoso.gold.foil_project_summary order by case_id;",
    outcome: "CAPEX / OPEX → annual cashflows → LCOE / NPV · real EUR 2026",
  },
  {
    scenario: "foil-sensitivity", title: "FOIL · Sensitivity Lab", difficulty: "Advanced",
    mission: "Compare ±20% one-at-a-time changes in AEP, CAPEX, OPEX, discount rate and assumed electricity price.",
    question: "Which assumption most changes the nominal A-family investment decision?",
    query: "select driver, relative_change, npv_eur, npv_delta_eur, lcoe_delta_eur_mwh from contoso.gold.foil_sensitivity where case_id='FOIL-WIND-A-N-R0' order by driver, relative_change;",
    outcome: "Auditable dbt decision layers · local sensitivity · D/N/F remain assumption sets",
  },
];

export type ProjectGroup = "foil" | "samples";
export const groupFor = (scenario:string):ProjectGroup => scenario.startsWith("foil-") ? "foil" : "samples";
export const groupName = (group:ProjectGroup) => group === "foil" ? "FOIL" : "Samples";
