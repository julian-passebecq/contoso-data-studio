import { Badge, Button, Text } from "@fluentui/react-components";
import type { LineageRelation, NavigationIntent, QueryLineage } from "../types";

export type LineageDestination = NavigationIntent["page"];

// Display strings for the strip; callers may override any of them.
export const LINEAGE_LABELS = {
  title: "Reads from",
  none: "This statement reads no lake table.",
  unavailable: "Lineage not available for this statement.",
  columns: (count: number) => (count === 1 ? "1 column" : `${count} columns`),
  noColumns: "columns not attributed",
  openIn: (destination: LineageDestination) => `Open in ${destination}`,
  openModel: "Open model",
  openModelIn: (destination: LineageDestination) => `Open dbt model in ${destination}`,
  confidence: {
    verified: "resolved by DuckDB",
    inferred: "partly resolved",
    unresolved: "unresolved",
  },
};

export type LineageLabels = typeof LINEAGE_LABELS;

/** The lake table a relation reads, as a Lakehouse selection; null when it is not a resolved lake table. */
export function tableIntent(relation: LineageRelation): NavigationIntent | null {
  if (relation.confidence === "unresolved" || !relation.schema || !relation.layer) return null;
  return {page: "Lakehouse", schema: relation.schema, table: relation.table};
}

/** The dbt model behind a relation, as a Transform selection; null when no model produced it. */
export function modelIntent(relation: LineageRelation): NavigationIntent | null {
  if (relation.confidence === "unresolved" || !relation.dbt_model) return null;
  return {page: "Transform", nodeId: relation.dbt_model};
}

/**
 * Where a relation chip opens: the exact table in Lakehouse, else its dbt model in Transform.
 * `model` is the extra "Open model" target, set only when the chip itself opens the table.
 */
export function lineageIntents(relation: LineageRelation): {primary: NavigationIntent | null; model: NavigationIntent | null} {
  const table = tableIntent(relation);
  const model = modelIntent(relation);
  return table ? {primary: table, model} : {primary: model, model: null};
}

/** Page a relation chip opens, or null when the relation is not clickable. */
export function lineageDestination(relation: LineageRelation): LineageDestination | null {
  return lineageIntents(relation).primary?.page ?? null;
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
  onOpen?: (intent: NavigationIntent, relation: LineageRelation) => void;
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
        const {primary, model} = onOpen ? lineageIntents(relation) : {primary: null, model: null};
        const content = <>
          {relation.layer && <Badge size="small" appearance="tint" className={`lineageLayer ${relation.layer}`}>{relation.layer}</Badge>}
          <code>{name}</code>
          <span className="lineageMeta">
            {relation.columns.length ? labels.columns(relation.columns.length) : labels.confidence[relation.confidence]}
          </span>
        </>;
        return <li key={`${relation.catalog}.${name}`} data-confidence={relation.confidence}>
          {primary
            ? <Button size="small" appearance="subtle" title={detail}
                aria-label={`${name}: ${detail}. ${labels.openIn(primary.page)}`}
                onClick={() => onOpen?.(primary, relation)}>{content}</Button>
            : <span className="lineageStatic" tabIndex={0} title={detail} aria-label={`${name}: ${detail}`}>{content}</span>}
          {model && <Button size="small" appearance="transparent" className="lineageModelLink"
            aria-label={`${name}: ${labels.openModelIn(model.page)}`}
            onClick={() => onOpen?.(model, relation)}>{labels.openModel}</Button>}
        </li>;
      })}
    </ul>
  </section>;
}
