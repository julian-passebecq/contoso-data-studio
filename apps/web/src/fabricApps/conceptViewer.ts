// Concept spec v1 (format owned by DataPass MosaicStudio) for the Architecture tab.
// Contoso consumes published artifacts only: the API generates the document from the compiled
// model, and the standalone viewer is vendored unchanged under vendor/concept-viewer/.

export const CONCEPT_URL = "/api/fabric-apps/concept";
export const CONCEPT_DOWNLOAD_URL = `${CONCEPT_URL}?download=true`;
// Served from the repo's vendor/ folder by the dev middleware in vite.config.ts.
export const CONCEPT_VIEWER_URL = "/vendor/concept-viewer/concept-viewer.html";

// Proposed viewer input API (forwarded to the PM for BRIDGE-SPEC; the vendored file is never patched):
//   parent -> viewer: { type: "datapass.concept-spec/load", spec }   (posted on iframe load and on "ready")
//   viewer -> parent: { type: "datapass.concept-spec/ready" }        (viewer is listening)
export const LOAD_MESSAGE = "datapass.concept-spec/load";
export const READY_MESSAGE = "datapass.concept-spec/ready";

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

/**
 * Feature flag for the embedded viewer. Off by default until BRIDGE-SPEC publishes
 * dist-standalone/concept-viewer.html and it is vendored.
 * TODO(CONTOSO-CONCEPT): turn on by default once vendor/concept-viewer/concept-viewer.html exists.
 * On: build with VITE_CONCEPT_VIEWER=1, or open the app with ?conceptViewer=1 (=0 forces off).
 */
export function conceptViewerEnabled(search: string, env: Record<string, string | undefined> = {}): boolean {
  const param = new URLSearchParams(search).get("conceptViewer");
  if (param !== null) return param === "1" || param === "true";
  return env.VITE_CONCEPT_VIEWER === "1" || env.VITE_CONCEPT_VIEWER === "true";
}

export function summarizeConcept(spec: ConceptSpec): string {
  const kinds = new Set(spec.flows.map(f => f.kind));
  return `${spec.layers.length} layers · ${spec.nodes.length} nodes · ${spec.flows.length} flows (${[...kinds].sort().join(", ")}) · ${spec.provenance.toUpperCase()}`;
}
