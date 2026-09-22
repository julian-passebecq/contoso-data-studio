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
  last_snapshot_id: number | null;
  load_count: number;
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
  sha256: string | null;
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
  last_snapshot_id: number | null;
  load_history: Array<{loaded_at:string;snapshot_id:number|null}>;
  is_active: boolean;
  active_snapshot_id: number | null;
  integrity_tracked: boolean;
  files: Record<string, GenerationRunFile>;
  run_path: string;
};

export type RunReloadResult = {
  run: GenerationRunDetail;
  bronze_loaded: boolean;
  previous_snapshot_id: number | null;
  snapshot_id: number | null;
  integrity_verified: boolean;
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


export type DbtLineageNode = {
  id: string;
  name: string;
  resource_type: "source" | "model";
  layer: string;
  path: string;
  schema: string | null;
  database: string | null;
  materialized: string;
};

export type DbtLineageEdge = {
  source: string;
  target: string;
};

export type DbtLineage = {
  generated_at: string | null;
  nodes: DbtLineageNode[];
  edges: DbtLineageEdge[];
};


export type RunComparisonFile = {
  same_hash: boolean | null;
  base_sha256: string | null;
  target_sha256: string | null;
  base_size_bytes: number | null;
  target_size_bytes: number | null;
};

export type RunComparison = {
  base_run_id: string;
  target_run_id: string;
  same_parameters: boolean;
  parameter_changes: Record<string,{base:unknown;target:unknown}>;
  row_count_changes: Record<string,{base:number|null;target:number|null;delta:number|null}>;
  all_hashes_available: boolean;
  exact_files_equal: boolean | null;
  files: Record<string,RunComparisonFile>;
  base_snapshot_id: number | null;
  target_snapshot_id: number | null;
};
