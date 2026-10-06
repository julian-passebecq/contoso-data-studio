// Row shapes of the Rayfin entities in apps/fabric-app-lab/rayfin/data/entities.
// In a real Fabric App these come from the entity classes themselves (RayfinClient<AppSchema>).
export interface Department {
  id: string;
  code: string;
  name: string;
  finance_owner_email: string;
}

export interface Forecast {
  id: string;
  department_id: string;
  month: string;
  amount: number;
  note: string | null;
  owner_email: string;
  updated_by: string | null;
  updated_at: string | null;
}

export interface Actual {
  id: string;
  department_id: string;
  month: string;
  amount: number;
  owner_email: string;
}

export type AppSchema = { Department: Department; Forecast: Forecast; Actual: Actual };

export interface LocalUser {
  id: string;
  display_name: string;
  email: string;
  role: "finance" | "executive";
  department_code: string | null;
}

export interface GoldRow {
  month: string;
  department_code: string;
  department_name: string;
  forecast_amount: number | string;
  actual_amount: number | string | null;
  variance: number | string | null;
  variance_pct: number | null;
  last_editor: string | null;
  built_at: string;
}

export interface MirrorRecord {
  seq: number;
  mirrored_at: string;
  latency_ms: number;
  snapshot_id: number | null;
  endpoint_at: string | null;
  gold_at: string | null;
  gold_snapshot_id: number | null;
  gold_ok: number | null;
}

export interface ChangeRecord {
  seq: number;
  entity: string;
  row_id: string | null;
  op: string;
  committed_at: string;
  actor: string;
  summary: string | null;
}

export interface Trace {
  change: ChangeRecord;
  mirror: MirrorRecord | null;
}

export interface MirrorStatus {
  stats: { count: number; last_ms: number; p50_ms: number; max_ms: number } | null;
  pending: number;
  mode: string;
  gold_auto: boolean;
  last_error: string | null;
  snapshots: Array<{ snapshot_id: number; snapshot_time: string; commit_message: string | null }>;
}
