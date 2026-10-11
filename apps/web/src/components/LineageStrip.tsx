import { Badge, Button, Text } from "@fluentui/react-components";
import type { LineageRelation, QueryLineage } from "../types";

export type LineageDestination = "Lakehouse" | "Transform";

// Display strings for the strip; callers may override any of them.
export const LINEAGE_LABELS = {
  title: "Reads from",
  none: "This statement reads no lake table.",
  unavailable: "Lineage not available for this statement.",
  columns: (count: number) => (count === 1 ? "1 column" : `${count} columns`),
  noColumns: "columns not attributed",
  openIn: (destination: LineageDestination) => `Open in ${destination}`,
  confidence: {
    verified: "resolved by DuckDB",
    inferred: "partly resolved",
    unresolved: "unresolved",
  },
};

export type LineageLabels = typeof LINEAGE_LABELS;

/** Where a relation opens: its dbt model in Transform, else its layer in Lakehouse, else nowhere. */
export function lineageDestination(relation: LineageRelation): LineageDestination | null {
  if (relation.confidence === "unresolved") return null;
  if (relation.dbt_model) return "Transform";
  if (relation.layer) return "Lakehouse";
  return null;
}

export function relationName(relation: LineageRelation): string {
  return [relation.schema, relation.table].filter(Boolean).join(".");
}

export function relationDetail(relation: LineageRelation, labels: LineageLabels = LINEAGE_LABELS): string {
  const parts = [
    relation.columns.length ? relation.columns.join(", ") : labels.noColumns,
    relation.dbt_model ? `dbt ${relation.dbt_model}` : "",
    relation.at.length ? relation.at.map(at => `AT ${at.unit} ${String(at.value)}`).join(", ") : "",
    labels.confidence[relation.confidence],
    relation.note,
  ];
  return parts.filter(Boolean).join(" · ");
}

export default function LineageStrip({lineage, onOpen, labels = LINEAGE_LABELS}:{
  lineage: QueryLineage | null | undefined;
  onOpen?: (destination: LineageDestination, relation: LineageRelation) => void;
  labels?: LineageLabels;
}) {
  if (!lineage) return null;
  const titleId = "query-lineage-title";
  return <section className="lineageStrip" aria-labelledby={titleId} data-confidence={lineage.confidence}>
    <Text id={titleId} weight="semibold" size={200}>{labels.title}</Text>
    {!lineage.relations.length && <Text className="muted tiny">
      {lineage.method === "none" ? labels.unavailable : labels.none}
    </Text>}
    <ul className="lineageRelations">
      {lineage.relations.map(relation => {
        const name = relationName(relation);
        const detail = relationDetail(relation, labels);
        const destination = onOpen ? lineageDestination(relation) : null;
        const content = <>
          {relation.layer && <Badge size="small" appearance="tint" className={`lineageLayer ${relation.layer}`}>{relation.layer}</Badge>}
          <code>{name}</code>
          <span className="lineageMeta">
            {relation.columns.length ? labels.columns(relation.columns.length) : labels.confidence[relation.confidence]}
          </span>
        </>;
        return <li key={`${relation.catalog}.${name}`} data-confidence={relation.confidence}>
          {destination
            ? <Button size="small" appearance="subtle" title={detail}
                aria-label={`${name}: ${detail}. ${labels.openIn(destination)}`}
                onClick={() => onOpen?.(destination, relation)}>{content}</Button>
            : <span className="lineageStatic" tabIndex={0} title={detail} aria-label={`${name}: ${detail}`}>{content}</span>}
        </li>;
      })}
    </ul>
  </section>;
}
