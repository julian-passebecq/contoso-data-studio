// Layer model of the Sales Forecasting app, derived from the compiled Rayfin model (/model).
// Kept as plain data so a later package can render it in another visual style.

export interface ModelEntity {
  name: string;
  table: string;
  plural?: string;
  columns: Array<{ name: string; db_type: string; nullable?: boolean; references: { entity: string; field: string } | null }>;
  roles: Array<{ role: string; actions: string[]; policy: string | null }>;
}

export interface ModelInfo {
  entities: ModelEntity[];
  bronze_tables?: Record<string, string>;
  gold_table?: string;
}

export interface Layer {
  key: string;
  title: string;
  local: string;
  fabric: string;
  items: string[];
}

export interface Architecture {
  layers: Layer[];
  auth: { title: string; local: string; fabric: string; items: string[] };
}

export function buildArchitecture(model: ModelInfo): Architecture {
  const entities = model.entities;
  const relations = entities.flatMap(e =>
    e.columns.filter(c => c.references).map(c => `${e.name}.${c.name} → ${c.references!.entity}.${c.references!.field}`),
  );
  const policies = entities.flatMap(e =>
    e.roles.map(r => `${e.name} ${r.actions.join("/")}: ${r.policy ?? "any signed-in user"}`),
  );
  const bronze = Object.values(model.bronze_tables ?? {});
  return {
    layers: [
      { key: "ui", title: "UI", local: "Apps page (React + Fluent)", fabric: "Fabric static hosting", items: ["editable forecast table", "KPI cards", "monthly bar chart"] },
      { key: "service", title: "Data client", local: "LocalRayfinClient → /api/fabric-apps", fabric: "RayfinClient → Data API Builder (GraphQL)", items: entities.map(e => `client.data.${e.name} · client.data.${e.plural ?? e.table.toLowerCase()}`) },
      { key: "model", title: "Rayfin model", local: "rayfin/data/*.ts (@microsoft/rayfin-core)", fabric: "same files", items: [entities.map(e => `${e.name} (${e.columns.length})`).join(" · "), ...relations] },
      { key: "sqldb", title: "SQL DB (operational)", local: "SQLite", fabric: "Fabric SQL database", items: entities.map(e => `${e.table}: ${e.columns.map(c => c.name).join(", ")}`) },
      { key: "mirror", title: "Mirror", local: "worker: on change + timer", fabric: "SQL DB mirroring to OneLake", items: ["one DuckLake snapshot per batch", "latency stamped per write"] },
      { key: "lake", title: "Lake (Bronze)", local: "DuckLake", fabric: "OneLake Delta tables", items: bronze.length ? bronze : entities.map(e => e.table) },
      { key: "endpoint", title: "SQL endpoint", local: "read-only Query workbench", fabric: "SQL analytics endpoint", items: ["SELECT only, time travel AT (VERSION => n)"] },
      { key: "gold", title: "Gold", local: "dbt build", fabric: "dbt / notebooks / warehouse", items: [model.gold_table ?? "contoso.gold.forecast_vs_actual"] },
      { key: "chart", title: "Chart", local: "Gold read, scoped by department", fabric: "Power BI / semantic model with RLS", items: ["forecast vs actual by month"] },
    ],
    auth: {
      title: "Auth & policies",
      local: "fake users, X-Local-User header",
      fabric: "Entra ID; claims sub, email, role",
      items: policies,
    },
  };
}
