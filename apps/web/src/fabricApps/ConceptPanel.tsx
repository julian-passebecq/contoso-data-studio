import { useEffect, useRef, useState, type ReactNode } from "react";
import { Badge, Button, Text } from "@fluentui/react-components";
import { ArrowDownloadRegular } from "@fluentui/react-icons";

import {
  CONCEPT_DOWNLOAD_URL, CONCEPT_URL, CONCEPT_VIEWER_URL, LOAD_MESSAGE, READY_MESSAGE,
  conceptViewerEnabled, summarizeConcept, type ConceptSpec,
} from "./conceptViewer";

type ViewerState = "off" | "checking" | "missing" | "ready";

function flagFromEnv(): Record<string, string | undefined> {
  return (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
}

/**
 * Concept rendering for the Architecture tab. The embedded viewer is behind a feature flag; the
 * static SVG (`fallback`) is shown whenever the flag is off or the viewer is not vendored yet.
 */
export default function ConceptPanel({ fallback }: { fallback: ReactNode }) {
  const [spec, setSpec] = useState<ConceptSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const enabled = conceptViewerEnabled(window.location.search, flagFromEnv());
  const [viewer, setViewer] = useState<ViewerState>(enabled ? "checking" : "off");
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
    // The dev middleware marks the vendored file; anything else (SPA fallback, 404) means missing.
    fetch(CONCEPT_VIEWER_URL, { method: "HEAD" })
      .then(res => { if (live) setViewer(res.ok && res.headers.get("x-concept-viewer") === "vendored" ? "ready" : "missing"); })
      .catch(() => { if (live) setViewer("missing"); });
    return () => { live = false; };
  }, [enabled]);

  useEffect(() => {
    if (viewer !== "ready" || !spec) return;
    const post = () => frame.current?.contentWindow?.postMessage({ type: LOAD_MESSAGE, spec }, "*");
    const onMessage = (event: MessageEvent) => {
      if (event.source === frame.current?.contentWindow && event.data?.type === READY_MESSAGE) post();
    };
    window.addEventListener("message", onMessage);
    const node = frame.current;
    node?.addEventListener("load", post);
    post();
    return () => { window.removeEventListener("message", onMessage); node?.removeEventListener("load", post); };
  }, [viewer, spec]);

  return <div className="faConcept" data-viewer={viewer}>
    <div className="faConceptBar">
      <Badge appearance="tint" color="warning">SYNTHETIC</Badge>
      <Text className="faConceptSummary">
        {spec ? <>Concept spec v1 · {summarizeConcept(spec)}</> : error ? `Concept file unavailable (${error})` : "Generating concept file…"}
      </Text>
      <Button as="a" href={CONCEPT_DOWNLOAD_URL} download="contoso-sales-forecasting.concept.json"
        icon={<ArrowDownloadRegular />} appearance="secondary" disabled={!spec}>Download concept file</Button>
    </div>
    {viewer === "missing" && <Text className="muted faConceptNote" role="note">
      Concept viewer is not vendored yet (vendor/concept-viewer/concept-viewer.html); showing the static diagram.
    </Text>}
    {viewer === "ready"
      ? <>
        <iframe ref={frame} className="faConceptFrame" title="Concept viewer" src={CONCEPT_VIEWER_URL}
          sandbox="allow-scripts" referrerPolicy="no-referrer" />
        <details className="faConceptFallback"><summary>Static diagram</summary>{fallback}</details>
      </>
      : fallback}
  </div>;
}
