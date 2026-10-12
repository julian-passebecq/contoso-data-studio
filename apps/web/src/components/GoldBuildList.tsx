import { Badge, Text } from "@fluentui/react-components";
import type { DbtBuildRef, GoldBuildReport, GoldModelBuild } from "../types";
import "../goldBuilds.css";

// Display strings for Gold build notes; callers may override any of them.
export const GOLD_BUILD_LABELS = {
  title: "Gold builds",
  empty: "No Gold model found in the dbt project.",
  noBuild: "No dbt build recorded yet.",
  lastBuilt: (time: string, shortId: string | null) => (shortId ? `last built ${time} (run ${shortId})` : `last built ${time}`),
  neverBuilt: "never built",
  notRebuilt: "not rebuilt by this run",
  failed: (status: string) => `${status} in this run`,
  scope: { retail: "retail", foil: "FOIL", app_lab: "app lab" } as Record<GoldModelBuild["scope"], string>,
  latest: (build: DbtBuildRef, time: string) =>
    `Latest build: ${build.command ? `dbt ${build.command}` : "dbt"}${build.selector ? ` --select ${build.selector}` : ""}`
    + `${build.scope === "foil" ? " (FOIL project: path:models/foil only)" : ""} · ${time}${build.short_id ? ` · run ${build.short_id}` : ""}`,
  notRebuiltDetail: (build: DbtBuildRef) =>
    build.scope === "foil"
      ? "The latest dbt build ran for a FOIL project and selected models/foil only; this table keeps its last build."
      : "The latest dbt build did not select this model; this table keeps its last build.",
};

export type GoldBuildLabels = typeof GOLD_BUILD_LABELS;

/** Deterministic UTC time, minutes precision: "2026-10-12 08:00 UTC". */
export function formatBuildTime(value: string | null | undefined): string {
  if (!value) return "time unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export type GoldBuildNote = {
  note: string;
  /** Set when the latest build did not rebuild this model: the "not rebuilt by this run" marker. */
  marker: string | null;
  markerDetail: string | null;
};

export function goldBuildNote(
  model: GoldModelBuild,
  latest: DbtBuildRef | null,
  labels: GoldBuildLabels = GOLD_BUILD_LABELS,
): GoldBuildNote {
  const note = model.last_build
    ? labels.lastBuilt(formatBuildTime(model.last_build.generated_at), model.last_build.short_id)
    : labels.neverBuilt;
  if (!latest || model.rebuilt_by_latest) return { note, marker: null, markerDetail: null };
  if (model.latest_build_status) {
    return { note, marker: labels.failed(model.latest_build_status), markerDetail: null };
  }
  return { note, marker: labels.notRebuilt, markerDetail: labels.notRebuiltDetail(latest) };
}

export default function GoldBuildList({report, labels = GOLD_BUILD_LABELS}:{
  report: GoldBuildReport | null;
  labels?: GoldBuildLabels;
}) {
  if (!report) return null;
  const latest = report.latest_build;
  return <section className="goldBuilds" aria-label={labels.title}>
    <Text weight="semibold" size={200}>{labels.title}</Text>
    <Text className="muted tiny" as="p">
      {latest ? labels.latest(latest, formatBuildTime(latest.generated_at)) : labels.noBuild}
    </Text>
    {!report.models.length && <Text className="muted tiny">{labels.empty}</Text>}
    <ul className="goldBuildList">
      {report.models.map(model => {
        const { note, marker, markerDetail } = goldBuildNote(model, latest, labels);
        return <li key={model.unique_id} data-rebuilt={model.rebuilt_by_latest ? "yes" : "no"}>
          <code>{model.name}</code>
          <Badge size="small" appearance="outline">{labels.scope[model.scope]}</Badge>
          <span className="goldBuildNote">{note}</span>
          {marker && <Badge size="small" appearance="tint" color="warning" className="goldBuildMarker"
            title={markerDetail ?? undefined}>{marker}</Badge>}
          {markerDetail && <span className="visuallyHidden">{markerDetail}</span>}
        </li>;
      })}
    </ul>
  </section>;
}
