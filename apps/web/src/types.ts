export type Page = "Generate"|"Lakehouse"|"Transform"|"Query"|"Explore"|"Charts"|"Canvas";

export type Scenario = {
  id: string;
  name: string;
  description: string;
  focus: string;
  status: string;
};

export type CatalogTable = {
  schema: string;
  name: string;
  type: string;
};

export type WorkspaceFile = {
  path: string;
  name: string;
  format: string;
  size_bytes: number;
  modified_at: string;
};

export type InspectResult = {
  path: string;
  source_sql: string;
  raw_text: string | null;
  raw_truncated: boolean;
  schema: Array<{name:string; type:string; nullable:string}>;
  columns: string[];
  rows: unknown[][];
  preview_count: number;
  metadata: Record<string, unknown> & {
    columns?: Array<Record<string, unknown>>;
  };
};

export type FileProfile = {
  path: string;
  selected_sheet: string | null;
  columns: string[];
  rows: unknown[][];
};

export type QueryResult = {
  columns: string[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
};


export type GenerationRun = {
  run_id: string;
  scenario: string | null;
  scenario_name: string | null;
  created_at: string | null;
  seed: number | null;
  scale: number | null;
  sales_rows: number | null;
  bronze_loaded_at: string | null;
};


export type DuckLakeSnapshot = {
  snapshot_id: number;
  snapshot_time: string;
  schema_version: number;
  changes: Record<string, unknown> | null;
  author: string | null;
  commit_message: string | null;
};


export type DbtQualitySummary = {
  total: number;
  pass: number;
  fail: number;
  warn: number;
  error: number;
  skip: number;
};

export type DbtQualityTest = {
  unique_id: string;
  name: string;
  test_type: string;
  column_name: string | null;
  layer: string;
  model: string;
  status: "pass" | "fail" | "warn" | "error" | "skip";
  failures: number | null;
  execution_time: number | null;
  message: string | null;
};

export type DbtQuality = {
  generated_at: string | null;
  summary: DbtQualitySummary;
  by_layer: Record<string, DbtQualitySummary>;
  tests: DbtQualityTest[];
};
