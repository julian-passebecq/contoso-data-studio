import { useEffect, useRef, useState, type ReactNode } from "react";
import { Badge, Button, Text } from "@fluentui/react-components";
import { ArrowDownloadRegular } from "@fluentui/react-icons";

import {
  CONCEPT_DOWNLOAD_URL, CONCEPT_URL, CONCEPT_VIEWER_URL, READY_MESSAGE, VIEWER_OPTIONS,
  conceptViewerEnabled, loadMessage, summarizeConcept, type ConceptSpec, type ViewerResult,
} from "./conceptViewer";

// off: flag off · checking: probing the vendored file · loading: framed, waiting for "ready"
// ready: viewer answered · missing: no viewer (404 or no "ready" in time) -> static SVG
type ViewerState = "off" | "checking" | "loading" | "ready" | "missing";
const READY_TIMEOUT_MS = 15_000;

function flagFromEnv(): Record<string, string | undefined> {
  return (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
}

/**
 * Concept rendering for the Architecture tab: the vendored standalone viewer in a sandboxed
 * iframe, fed through its postMessage embed API. The static SVG (`fallback`) is shown when the
 * flag is off (`?conceptViewer=0`) or the viewer is unavailable, and stays reachable below it.
 */
export default function ConceptPanel({ fallback }: { fallback: ReactNode }) {
  const [spec, setSpec] = useState<ConceptSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const enabled = conceptViewerEnabled(window.location.search, flagFromEnv());
  const [viewer, setViewer] = useState<ViewerState>(enabled ? "checking" : "off");
  const [result, setResult] = useState<ViewerResult | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let live = true;
    fetch(CONCEPT_URL)
      .then(async res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json() as Promise<ConceptSpec>; })
      .then(doc => { if (live) setSpec(doc); })
      .catch(err => { if (live) setError(String(err)); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetch(CONCEPT_VIEWER_URL, { method: "HEAD" })
      .then(res => { if (live) setViewer(res.ok && (res.headers.get("content-type") ?? "").includes("text/html") ? "loading" : "missing"); })
      .catch(() => { if (live) setViewer("missing"); });
    return () => { live = false; };
  }, [enabled]);

  // Embed handshake: send the spec after the first bare "ready"; later "ready" messages carry the result.
  const framed = viewer === "loading" || viewer === "ready";
  useEffect(() => {
    if (!framed) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== READY_MESSAGE) return;
      if (event.data.result) setResult(event.data.result as ViewerResult);
      else setViewer("ready");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [framed]);

  useEffect(() => {
    if (viewer === "ready" && spec) frame.current?.contentWindow?.postMessage(loadMessage(spec), "*");
  }, [viewer, spec]);

  useEffect(() => {
    if (viewer !== "loading") return;
    const timer = window.setTimeout(() => setViewer(state => state === "loading" ? "missing" : state), READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [viewer]);

  return <div className="faConcept" data-viewer={viewer} data-viewer-result={result ? (result.ok ? "ok" : "invalid") : undefined}
    data-viewer-warnings={result ? (result.warnings ?? []).length : undefined}>
    <div className="faConceptBar">
      <Badge appearance="tint" color="warning">SYNTHETIC</Badge>
      <Text className="faConceptSummary">
        {spec ? <>Concept spec v1 · {summarizeConcept(spec)}</> : error ? `Concept file unavailable (${error})` : "Generating concept file…"}
      </Text>
      <Button as="a" href={CONCEPT_DOWNLOAD_URL} download="contoso-sales-forecasting.concept.json"
        icon={<ArrowDownloadRegular />} appearance="secondary" disabled={!spec}>Download concept file</Button>
    </div>
    {viewer === "missing" && <Text className="muted faConceptNote" role="note">
      Concept viewer unavailable (vendor/concept-viewer/concept-viewer.html); showing the static diagram.
    </Text>}
    {result && !result.ok && <Text className="faConceptNote" role="alert">
      The viewer rejected the concept file: {(result.issues ?? []).map(i => `${i.path}: ${i.message}`).join("; ")}
    </Text>}
    {framed
      ? <>
        <iframe ref={frame} className="faConceptFrame" title="Concept viewer" src={`${CONCEPT_VIEWER_URL}?view=${VIEWER_OPTIONS.view}`}
          sandbox="allow-scripts" referrerPolicy="no-referrer" />
        <details className="faConceptFallback"><summary>Static diagram</summary>{fallback}</details>
      </>
      : fallback}
  </div>;
}
