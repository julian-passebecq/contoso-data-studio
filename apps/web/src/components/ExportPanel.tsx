import { useEffect, useState } from "react";
import { Badge, Button, Card, CardHeader, Text, Title3 } from "@fluentui/react-components";

import { getJson, postJson } from "../api";

type ExportReceipt = {
  export_id: string;
  exported_at: string;
  workspace_id: string;
  source_commit: string | null;
  data_label: string;
  artifact: { file: string; sha256: string; bytes: number; rows: number; total_rows: number; truncated: boolean };
  bulk_data: { file: string; sha256: string; bytes: number; rows: number };
  lineage: {
    gold_table: string;
    dbt_run: { invocation_id: string; generated_at: string; status: string };
    ducklake_snapshot_id: number | null;
    generator_run: { run_id: string; scenario: string; seed: number; scale: number };
  };
};

function fileUrl(receipt: ExportReceipt, name: string) {
  return `/api/exports/${encodeURIComponent(receipt.export_id)}/${encodeURIComponent(name)}`;
}

/**
 * Export one Gold table as a datapass.artifact v1 bundle for MosaicStudio. The export reads the already built
 * Gold table; it never reruns dbt or the generator, and is refused when the latest dbt run of the model failed.
 */
export default function ExportPanel({ refreshToken = 0 }: { refreshToken?: number }) {
  const [tables, setTables] = useState<string[]>([]);
  const [mart, setMart] = useState("monthly_sales");
  const [exports, setExports] = useState<ExportReceipt[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function load() {
    getJson<{ exports: ExportReceipt[]; gold_tables: string[] }>("/api/exports")
      .then(data => {
        setExports(data.exports);
        setTables(data.gold_tables);
        if (data.gold_tables.length && !data.gold_tables.includes(mart)) setMart(data.gold_tables[0]);
      })
      .catch(exc => setError(exc instanceof Error ? exc.message : "Exports are unavailable."));
  }

  useEffect(load, [refreshToken]); // eslint-disable-line react-hooks/exhaustive-deps

  async function exportNow() {
    setBusy(true);
    setError("");
    try {
      await postJson<ExportReceipt>("/api/exports/artifact", { mart });
      load();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  const latest = exports[0];
  return <Card className="exportPanel" aria-busy={busy}>
    <CardHeader
      header={<Title3>Export for Mosaic</Title3>}
      description={<Text className="muted">Portable <code>datapass.artifact</code> v1 of a Gold table with units, lineage and source hashes, plus the full table as Parquet. Synthetic data.</Text>}
      action={<div className="buttonRow">
        <label className="themePicker">Gold table <select aria-label="Gold table to export" value={mart} disabled={busy || !tables.length} onChange={event => setMart(event.target.value)}>
          {!tables.length && <option value="">No Gold tables yet</option>}
          {tables.map(name => <option key={name} value={name}>{name}</option>)}
        </select></label>
        <Button appearance="primary" disabled={busy || !tables.length} onClick={() => void exportNow()}>{busy ? "Exporting…" : "Export artifact"}</Button>
      </div>}
    />
    {error && <div className="errorText" role="alert">{error}</div>}
    {!tables.length && !error && <div className="emptyState">Run dbt build in Transform to create Gold tables, then export.</div>}
    {latest && <div className="exportLatest" role="status" aria-live="polite">
      <div className="buttonRow">
        <Badge appearance="outline" color="success">{latest.lineage.gold_table}</Badge>
        <Badge appearance="outline">{latest.data_label}</Badge>
        {latest.artifact.truncated && <Badge appearance="outline" color="warning">first {latest.artifact.rows} of {latest.artifact.total_rows} rows</Badge>}
      </div>
      <Text block className="tiny">
        {latest.artifact.rows} rows · dbt run {latest.lineage.dbt_run.invocation_id.slice(0, 8)} ({latest.lineage.dbt_run.status}) ·
        snapshot {latest.lineage.ducklake_snapshot_id ?? "unknown"} · generator run {latest.lineage.generator_run.run_id} (seed {latest.lineage.generator_run.seed})
      </Text>
      <Text block className="muted tiny">artifact sha256 {latest.artifact.sha256.slice(0, 16)}… · exported {latest.exported_at}</Text>
      <div className="buttonRow">
        <a href={fileUrl(latest, latest.artifact.file)} download>Artifact JSON</a>
        <a href={fileUrl(latest, "manifest.json")} download>manifest.json</a>
        <a href={fileUrl(latest, "contoso-export.json")} download>Lineage receipt</a>
        <a href={fileUrl(latest, latest.bulk_data.file)} download>Full table (Parquet, {latest.bulk_data.rows} rows)</a>
      </div>
    </div>}
    {exports.length > 1 && <details>
      <summary>Earlier exports ({exports.length - 1})</summary>
      <ul className="exportHistory">
        {exports.slice(1, 11).map(item => <li key={item.export_id}>
          <a href={fileUrl(item, item.artifact.file)} download>{item.export_id}</a> · {item.lineage.gold_table} · {item.artifact.rows} rows
        </li>)}
      </ul>
    </details>}
  </Card>;
}
