import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardHeader, Text, Title3 } from "@fluentui/react-components";
import { getJson, postBinary } from "../api";
import DataTable from "../components/DataTable";
import type { FileProfile, InspectResult, WorkspaceFile } from "../types";

type Tab = "Data"|"Profile"|"Schema"|"Metadata";

function prettyBytes(bytes:number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024*1024) return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/1024/1024).toFixed(1)} MB`;
}

export default function ExplorePage({onOpenQuery}:{onOpenQuery:(sql:string)=>void}) {
  const [files,setFiles] = useState<WorkspaceFile[]>([]);
  const [selected,setSelected] = useState("");
  const [inspect,setInspect] = useState<InspectResult|null>(null);
  const [profile,setProfile] = useState<FileProfile|null>(null);
  const [profiling,setProfiling] = useState(false);
  const [tab,setTab] = useState<Tab>("Data");
  const [error,setError] = useState("");
  const [importing,setImporting] = useState(false);

  async function loadFiles() {
    try {
      const data = await getJson<{files:WorkspaceFile[]}>("/api/explore/files");
      setFiles(data.files);
      if (!selected && data.files.length) setSelected(data.files[0].path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not list files.");
    }
  }

  useEffect(()=>{ void loadFiles(); },[]);
  useEffect(()=>{
    if (!selected) { setInspect(null); setProfile(null); return; }
    setInspect(null); setProfile(null); setTab("Data"); setError("");
    getJson<InspectResult>(`/api/explore/inspect?path=${encodeURIComponent(selected)}&limit=200`)
      .then(setInspect)
      .catch(err=>setError(err instanceof Error ? err.message : "Could not inspect file."));
  },[selected]);

  async function loadProfile() {
    if (!inspect || profiling) return;
    setProfiling(true); setError("");
    try {
      const selectedSheet = typeof inspect.metadata.selected_sheet === "string"
        ? `&sheet=${encodeURIComponent(inspect.metadata.selected_sheet)}`
        : "";
      setProfile(await getJson<FileProfile>(
        `/api/explore/profile?path=${encodeURIComponent(inspect.path)}${selectedSheet}`
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not profile file.");
    } finally {
      setProfiling(false);
    }
  }

  function selectTab(next: Tab) {
    setTab(next);
    if (next === "Profile" && !profile) void loadProfile();
  }

  async function importFile(file: File) {
    setImporting(true); setError("");
    try {
      const imported = await postBinary<WorkspaceFile>(
        `/api/explore/import?filename=${encodeURIComponent(file.name)}`,
        file,
      );
      await loadFiles();
      setSelected(imported.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not import file.");
    } finally {
      setImporting(false);
    }
  }

  const metadataRows = useMemo(()=>{
    if (!inspect) return [];
    return Object.entries(inspect.metadata)
      .filter(([key])=>key!=="columns")
      .map(([key,value])=>[key,value]);
  },[inspect]);

  return <div className="workbench explorerWorkbench">
    <Card className="filePane">
      <CardHeader
        header={<Title3>Workspace files</Title3>}
        action={<div className="buttonRow">
          <label className="fileImportButton">
            <input
              type="file"
              accept=".parquet,.json,.jsonl,.ndjson,.csv,.xlsx"
              disabled={importing}
              onChange={event=>{
                const file=event.target.files?.[0];
                if (file) void importFile(file);
                event.currentTarget.value="";
              }}
            />
            <span>{importing ? "Importing..." : "Import file"}</span>
          </label>
          <Button onClick={loadFiles}>Refresh</Button>
        </div>}
      />
      <Text className="muted tiny">Generated files and workspace/imports</Text>
      <div className="fileList">
        {files.map(file=><button className={file.path===selected?"selected":""} key={file.path} onClick={()=>setSelected(file.path)}>
          <div><b>{file.name}</b><span>{file.path}</span></div>
          <div><Badge appearance="outline">{file.format}</Badge><small>{prettyBytes(file.size_bytes)}</small></div>
        </button>)}
        {!files.length && <div className="emptyState">Generate a dataset or place a supported file in workspace/imports.</div>}
      </div>
    </Card>
    <Card className="inspectPane">
      <CardHeader
        header={<Title3>{inspect ? inspect.path.split("/").at(-1) : "File inspector"}</Title3>}
        description={inspect ? `${String(inspect.metadata.format)} · ${Number(inspect.metadata.row_count ?? 0).toLocaleString()} rows` : "Parquet · JSON · CSV · XLSX"}
        action={inspect?<Button onClick={()=>onOpenQuery(`select * from ${inspect.source_sql} limit 100;`)}>Open in Query</Button>:undefined}
      />
      {error && <div className="errorText">{error}</div>}
      {inspect && <>
        <div className="tabStrip">
          {(["Data","Profile","Schema","Metadata"] as Tab[]).map(name=><button className={tab===name?"selected":""} key={name} onClick={()=>selectTab(name)}>{name}</button>)}
        </div>
        {tab==="Data" && <DataTable columns={inspect.columns} rows={inspect.rows}/>}
        {tab==="Profile" && (profile
          ? <DataTable columns={profile.columns} rows={profile.rows}/>
          : <div className="emptyState">{profiling ? "Profiling file..." : "Open Profile to compute statistics."}</div>
        )}
        {tab==="Schema" && <DataTable columns={["Column","Type","Nullable"]} rows={inspect.schema.map(c=>[c.name,c.type,c.nullable])}/>}
        {tab==="Metadata" && <div className="metadataStack">
          <DataTable columns={["Property","Value"]} rows={metadataRows}/>
          {Array.isArray(inspect.metadata.columns) && inspect.metadata.columns.length>0 && <>
            <Title3>Parquet column statistics</Title3>
            <DataTable
              columns={["Column","Physical type","Compression","Min","Max","Nulls"]}
              rows={inspect.metadata.columns.map(c=>[c.name,c.type,c.compression,c.min,c.max,c.null_count])}
            />
          </>}
        </div>}
      </>}
    </Card>
  </div>;
}
