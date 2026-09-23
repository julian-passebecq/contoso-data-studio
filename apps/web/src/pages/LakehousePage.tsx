import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardHeader, Text, Title3 } from "@fluentui/react-components";

import { getJson } from "../api";
import DataTable from "../components/DataTable";
import type { CatalogTable, DbtQuality, DuckLakeSnapshot, QueryResult, SnapshotComparison, WorkspaceProjectState } from "../types";
import { completeTutorialStep } from "../tutorialProgress";

function changeSummary(changes: Record<string, unknown> | null) {
  if (!changes) return "No catalog changes";
  const entries=Object.entries(changes);
  if (!entries.length) return "No catalog changes";
  return entries
    .slice(0,3)
    .map(([key,value])=>{
      const count=Array.isArray(value) ? value.length : 1;
      return `${key.replaceAll("_"," ")} ${count}`;
    })
    .join(" · ");
}

export default function LakehousePage({refreshToken=0}:{refreshToken?:number}) {
  const [tables,setTables] = useState<CatalogTable[]>([]);
  const [snapshots,setSnapshots] = useState<DuckLakeSnapshot[]>([]);
  const [quality,setQuality] = useState<DbtQuality|null>(null);
  const [selectedTable,setSelectedTable] = useState<CatalogTable|null>(null);
  const [preview,setPreview] = useState<QueryResult|null>(null);
  const [previewSnapshot,setPreviewSnapshot] = useState<DuckLakeSnapshot|null>(null);
  const [error,setError] = useState("");
  const [previewError,setPreviewError] = useState("");
  const [loadingSnapshot,setLoadingSnapshot] = useState<number|null>(null);
  const [compareBase,setCompareBase] = useState("");
  const [compareTarget,setCompareTarget] = useState("");
  const [comparison,setComparison] = useState<SnapshotComparison|null>(null);
  const [compareError,setCompareError] = useState("");
  const [comparing,setComparing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [catalogData,snapshotData,qualityData,projectState] = await Promise.all([
        getJson<{tables:CatalogTable[]}>("/api/lakehouse/catalog"),
        getJson<{snapshots:DuckLakeSnapshot[]}>("/api/lakehouse/snapshots?limit=40"),
        getJson<DbtQuality>("/api/dbt/quality"),
        getJson<WorkspaceProjectState>("/api/workspace/project-state"),
      ]);
      setTables(catalogData.tables);
      setSnapshots(snapshotData.snapshots);
      setQuality(qualityData);
      if (
        projectState.active_scenario &&
        projectState.gold_current &&
        projectState.layers.bronze>0 &&
        projectState.layers.silver>0 &&
        projectState.layers.gold>0
      ) {
        completeTutorialStep("lakehouse",projectState.active_scenario);
      }
      setCompareTarget(current=>{
        if (current && snapshotData.snapshots.some(item=>String(item.snapshot_id)===current)) return current;
        return snapshotData.snapshots[0] ? String(snapshotData.snapshots[0].snapshot_id) : "";
      });
      setCompareBase(current=>{
        if (current && snapshotData.snapshots.some(item=>String(item.snapshot_id)===current)) return current;
        return snapshotData.snapshots[1]
          ? String(snapshotData.snapshots[1].snapshot_id)
          : snapshotData.snapshots[0]
            ? String(snapshotData.snapshots[0].snapshot_id)
            : "";
      });
      setSelectedTable(current=>{
        if (current && catalogData.tables.some(
          table=>table.schema===current.schema && table.name===current.name
        )) return current;
        return catalogData.tables.find(
          table=>table.schema==="gold" && table.name==="monthly_sales"
        ) ?? catalogData.tables[0] ?? null;
      });
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load lakehouse.");
    }
  },[]);

  useEffect(()=>{ void load(); },[load,refreshToken]);

  const grouped = useMemo(()=>({
    bronze:tables.filter(table=>table.schema==="bronze"),
    silver:tables.filter(table=>table.schema==="silver"),
    gold:tables.filter(table=>table.schema==="gold"),
  }),[tables]);

  function layerHealth(layer:string) {
    const summary=quality?.by_layer[layer];
    if (!summary || summary.total===0) return null;
    const issues=summary.fail+summary.error+summary.warn;
    return {
      label: issues===0 ? `${summary.pass}/${summary.total} tests` : `${issues} issue${issues===1?"":"s"}`,
      color: issues===0 ? "success" as const : "danger" as const,
    };
  }

  function tableHealth(table:CatalogTable) {
    const tests=quality?.tests.filter(test=>test.layer===table.schema && test.model===table.name) ?? [];
    if (!tests.length) return null;
    const issues=tests.filter(test=>["fail","error","warn"].includes(test.status)).length;
    const passed=tests.filter(test=>test.status==="pass").length;
    return issues===0 ? `${passed}/${tests.length} tests` : `${issues} issue${issues===1?"":"s"}`;
  }

  async function compareSelectedSnapshots() {
    if (!selectedTable || !compareBase || !compareTarget || compareBase===compareTarget) return;
    setComparing(true); setCompareError(""); setComparison(null);
    try {
      const params=new URLSearchParams({
        schema:selectedTable.schema,
        table:selectedTable.name,
        base:compareBase,
        target:compareTarget,
      });
      setComparison(await getJson<SnapshotComparison>(`/api/lakehouse/compare?${params}`));
    } catch (err) {
      setCompareError(err instanceof Error ? err.message : "Snapshot comparison failed.");
    } finally {
      setComparing(false);
    }
  }

  async function inspectSnapshot(snapshot:DuckLakeSnapshot) {
    if (!selectedTable) return;
    setLoadingSnapshot(snapshot.snapshot_id);
    setPreview(null); setPreviewSnapshot(snapshot); setPreviewError("");
    try {
      const params=new URLSearchParams({
        schema:selectedTable.schema,
        table:selectedTable.name,
        snapshot:String(snapshot.snapshot_id),
        limit:"100",
      });
      setPreview(await getJson<QueryResult>(`/api/lakehouse/time-travel?${params}`));
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Time-travel preview failed.");
    } finally {
      setLoadingSnapshot(null);
    }
  }

  return <div className="lakehouseStack">
    <Card>
      <CardHeader
        header={<Title3>DuckLake catalog</Title3>}
        description="SQLite metadata catalog · managed Parquet data · Bronze / Silver / Gold"
        action={<Button onClick={load}>Refresh</Button>}
      />
      {error && <div className="errorText">{error}</div>}
      <div className="layerColumns">
        {(["bronze","silver","gold"] as const).map(layer=><section className="layer" key={layer}>
          <div className="layerTitle">
            <b>{layer.toUpperCase()}</b>
            <div className="layerTitleBadges">
              {layerHealth(layer) && <Badge appearance="outline" color={layerHealth(layer)!.color}>{layerHealth(layer)!.label}</Badge>}
              <Badge appearance="outline">{grouped[layer].length}</Badge>
            </div>
          </div>
          {grouped[layer].map(table=><button
            className={
              selectedTable?.schema===table.schema && selectedTable?.name===table.name
                ? "tableItem tableItemButton selected"
                : "tableItem tableItemButton"
            }
            key={`${table.schema}.${table.name}`}
            onClick={()=>{
              setSelectedTable(table);
              setPreview(null);
              setPreviewSnapshot(null);
              setPreviewError("");
              setComparison(null);
              setCompareError("");
            }}
          >
            <span>{table.name}</span><small>{tableHealth(table) ?? table.type}</small>
          </button>)}
          {!grouped[layer].length && <div className="emptyState">No tables yet.</div>}
        </section>)}
      </div>
    </Card>

    <Card>
      <CardHeader
        header={<Title3>DuckLake snapshots</Title3>}
        description={selectedTable
          ? `Time travel preview target: ${selectedTable.schema}.${selectedTable.name}`
          : "Select a table above to inspect historical versions"}
        action={<Badge appearance="outline">{snapshots.length} shown</Badge>}
      />
      <div className="snapshotCompareBar">
        <div>
          <Text className="muted tiny">Base</Text>
          <select value={compareBase} onChange={event=>setCompareBase(event.target.value)}>
            {snapshots.map(snapshot=><option key={`base-${snapshot.snapshot_id}`} value={snapshot.snapshot_id}>
              #{snapshot.snapshot_id} · {new Date(snapshot.snapshot_time).toLocaleString()}
            </option>)}
          </select>
        </div>
        <span>→</span>
        <div>
          <Text className="muted tiny">Target</Text>
          <select value={compareTarget} onChange={event=>setCompareTarget(event.target.value)}>
            {snapshots.map(snapshot=><option key={`target-${snapshot.snapshot_id}`} value={snapshot.snapshot_id}>
              #{snapshot.snapshot_id} · {new Date(snapshot.snapshot_time).toLocaleString()}
            </option>)}
          </select>
        </div>
        <Button
          disabled={!selectedTable || !compareBase || !compareTarget || compareBase===compareTarget || comparing}
          onClick={()=>void compareSelectedSnapshots()}
        >
          {comparing ? "Comparing..." : "Compare"}
        </Button>
      </div>
      {compareError && <div className="errorText">{compareError}</div>}
      <div className="snapshotList">
        {snapshots.map(snapshot=><div className="snapshotRow" key={snapshot.snapshot_id}>
          <div className="snapshotId">
            <b>#{snapshot.snapshot_id}</b>
            <span>schema v{snapshot.schema_version}</span>
          </div>
          <div className="snapshotWhen">
            <b>{new Date(snapshot.snapshot_time).toLocaleString()}</b>
            <span>{changeSummary(snapshot.changes)}</span>
          </div>
          <Button
            size="small"
            disabled={!selectedTable || loadingSnapshot!==null}
            onClick={()=>void inspectSnapshot(snapshot)}
          >
            {loadingSnapshot===snapshot.snapshot_id ? "Loading..." : "Preview"}
          </Button>
        </div>)}
        {!snapshots.length && <Text className="muted tiny">No DuckLake snapshots yet.</Text>}
      </div>
    </Card>

    {comparison && <Card>
      <CardHeader
        header={<Title3>Snapshot comparison</Title3>}
        description={`${comparison.schema}.${comparison.table} · #${comparison.base.snapshot_id} → #${comparison.target.snapshot_id}`}
        action={<Badge
          appearance="outline"
          color={comparison.row_delta===0 && !comparison.added_columns.length && !comparison.removed_columns.length ? "success" : "informative"}
        >
          {comparison.row_delta===0 ? "same row count" : `${comparison.row_delta>0?"+":""}${comparison.row_delta.toLocaleString()} rows`}
        </Badge>}
      />
      <div className="snapshotCompareResult">
        <div><span>Base rows</span><b>{comparison.base.row_count.toLocaleString()}</b></div>
        <div><span>Target rows</span><b>{comparison.target.row_count.toLocaleString()}</b></div>
        <div><span>Row delta</span><b>{comparison.row_delta>0?"+":""}{comparison.row_delta.toLocaleString()}</b></div>
        <div><span>Columns</span><b>{comparison.target.columns.length}</b></div>
      </div>
      <div className="schemaDelta">
        <div>
          <span>Added columns</span>
          {comparison.added_columns.length
            ? comparison.added_columns.map(column=><Badge key={column} appearance="outline" color="success">{column}</Badge>)
            : <Text className="muted tiny">None</Text>}
        </div>
        <div>
          <span>Removed columns</span>
          {comparison.removed_columns.length
            ? comparison.removed_columns.map(column=><Badge key={column} appearance="outline" color="danger">{column}</Badge>)
            : <Text className="muted tiny">None</Text>}
        </div>
      </div>
    </Card>}

    {(previewSnapshot || previewError) && <Card>
      <CardHeader
        header={<Title3>Historical preview</Title3>}
        description={previewSnapshot && selectedTable
          ? `${selectedTable.schema}.${selectedTable.name} at snapshot #${previewSnapshot.snapshot_id}`
          : "DuckLake time travel"}
        action={preview?<Badge appearance="outline">{preview.row_count}{preview.truncated?"+":""} rows</Badge>:undefined}
      />
      {previewError && <div className="errorText">{previewError}</div>}
      {preview && <DataTable columns={preview.columns} rows={preview.rows}/>}
    </Card>}
  </div>;
}
