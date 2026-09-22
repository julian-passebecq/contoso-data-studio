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
  is_active: boolean;
  active_snapshot_id: number | null;
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


export type GenerationRunFile = {
  name: string;
  path: string;
  size_bytes: number;
};

export type GenerationRunDetail = {
  run_id: string;
  scenario: string | null;
  scenario_name: string | null;
  business_focus: string | null;
  created_at: string | null;
  seed: number | null;
  scale: number | null;
  row_counts: Record<string, number>;
  bronze_loaded_at: string | null;
  is_active: boolean;
  active_snapshot_id: number | null;
  files: Record<string, GenerationRunFile>;
  run_path: string;
};

export type RunReloadResult = {
  run: GenerationRunDetail;
  bronze_loaded: boolean;
  previous_snapshot_id: number | null;
  snapshot_id: number | null;
};

export type SnapshotComparisonState = {
  snapshot_id: number;
  row_count: number;
  columns: string[];
};

export type SnapshotComparison = {
  schema: string;
  table: string;
  base: SnapshotComparisonState;
  target: SnapshotComparisonState;
  row_delta: number;
  added_columns: string[];
  removed_columns: string[];
};
