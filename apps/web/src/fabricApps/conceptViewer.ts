// Concept spec v1 (format owned by DataPass MosaicStudio) for the Architecture tab.
// Contoso consumes published artifacts only: the API generates the document from the compiled
// model, and the standalone viewer is vendored unchanged under vendor/concept-viewer/.

export const CONCEPT_URL = "/api/fabric-apps/concept";
export const CONCEPT_DOWNLOAD_URL = `${CONCEPT_URL}?download=true`;
// Served from the repo's vendor/ folder by vite.config.ts (dev middleware, copied into the build).
export const CONCEPT_VIEWER_URL = "/vendor/concept-viewer/concept-viewer.html";

// Viewer embed API (datapass-mosaicstudio spec/concept/v1/README.md "Embedding"):
//   parent -> viewer: { type: "datapass.concept-spec/load", spec, options } (after the first "ready")
//   viewer -> parent: { type: "datapass.concept-spec/ready", specVersion } once listening, then again after
//                     every load with result {ok, id, warnings} | {ok: false, issues}
export const LOAD_MESSAGE = "datapass.concept-spec/load";
export const READY_MESSAGE = "datapass.concept-spec/ready";

// Load options (viewer >= studio-v0.8.1): layer cake view, whole diagram fitted to the frame, no example
// gallery or open/URL/paste controls inside the app, colours following the system scheme.
export interface ViewerOptions {
  view?: "isometric" | "layered" | "3d";
  fit?: boolean;
  chrome?: "full" | "embed";
  theme?: "light" | "dark" | "auto";
}
export const VIEWER_OPTIONS: Readonly<Required<ViewerOptions>> = { view: "layered", fit: true, chrome: "embed", theme: "auto" };

export function loadMessage(spec: ConceptSpec, options: ViewerOptions = VIEWER_OPTIONS) {
  return { type: LOAD_MESSAGE, spec, options };
}

export interface ConceptSpec {
  format: "datapass.concept-spec";
  version: 1;
  id: string;
  title: string;
  provenance: "synthetic" | "documented";
  note: string;
  layers: Array<{ id: string; label: string }>;
  domains: Array<{ id: string; label: string; placement?: "main" | "side" }>;
  nodes: Array<{ id: string; kind: string; layer: string; domain: string; label: string }>;
  flows: Array<{ id: string; from: string; to: string; kind: "data" | "control" | "auth"; label: string }>;
}

export interface ViewerResult {
  ok: boolean;
  id?: string;
  warnings?: Array<{ path: string; message: string }>;
  issues?: Array<{ path: string; message: string }>;
}

/**
 * Feature flag for the embedded viewer (vendored from studio-v0.8.1). On by default;
 * `?conceptViewer=0` or a build with VITE_CONCEPT_VIEWER=0 opts out to the static SVG.
 */
export function conceptViewerEnabled(search: string, env: Record<string, string | undefined> = {}): boolean {
  const param = new URLSearchParams(search).get("conceptViewer");
  if (param !== null) return !(param === "0" || param === "false");
  return !(env.VITE_CONCEPT_VIEWER === "0" || env.VITE_CONCEPT_VIEWER === "false");
}

export function summarizeConcept(spec: ConceptSpec): string {
  const kinds = new Set(spec.flows.map(f => f.kind));
  return `${spec.layers.length} layers · ${spec.nodes.length} nodes · ${spec.flows.length} flows (${[...kinds].sort().join(", ")}) · ${spec.provenance.toUpperCase()}`;
}
