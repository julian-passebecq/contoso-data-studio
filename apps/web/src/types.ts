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
  schema: Array<{name:string; type:string; nullable:string}>;
  columns: string[];
  rows: unknown[][];
  preview_count: number;
  metadata: Record<string, unknown> & {
    columns?: Array<Record<string, unknown>>;
  };
};

export type QueryResult = {
  columns: string[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
};
