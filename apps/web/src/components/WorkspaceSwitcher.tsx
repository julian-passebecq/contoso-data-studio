import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Text,
} from "@fluentui/react-components";

import { getJson, postJson } from "../api";
import { rememberWorkspaceId } from "../workspaceScope";

export type LocalWorkspace = {
  id: string;
  name: string;
  path: string;
  created_at: string | null;
  catalog_exists: boolean;
  active_scenario: string | null;
  active: boolean;
  restored_from?: { backup: string; workspace: string } | null;
};
type WorkspaceList = {
  active: string;
  home: string;
  workspaces: LocalWorkspace[];
  backups: Array<{ backup: string; bytes: number; modified_at: string }>;
};

function formatBytes(bytes: number) {
  return bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Local workspace switcher: each workspace has its own DuckLake catalog, staging runs, imports, dbt results,
 * exports, query history and guided progress. Switching reloads the page so no result of the previous
 * workspace stays on screen.
 */
export default function WorkspaceSwitcher({ disabled, onChanged }: { disabled?: boolean; onChanged: (id: string) => void }) {
  const [list, setList] = useState<WorkspaceList | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [restoreName, setRestoreName] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refresh() {
    try {
      const next = await getJson<WorkspaceList>("/api/workspaces");
      setList(next);
      if (rememberWorkspaceId(next.active)) onChanged(next.active);
    } catch (exc) {
      setList(null);
      setError(exc instanceof Error ? exc.message : "Workspaces are unavailable.");
    }
  }

  useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : `${label} failed.`);
    } finally {
      setBusy("");
    }
  }

  function activate(id: string) {
    return run("Switching", async () => {
      await postJson(`/api/workspaces/${encodeURIComponent(id)}/activate`, {});
      rememberWorkspaceId(id);
      window.location.reload();
    });
  }

  const active = list?.workspaces.find(item => item.active);

  return <>
    <label className="themePicker workspacePicker">Workspace
      <select
        aria-label="Local workspace"
        disabled={disabled || !list || Boolean(busy)}
        value={list?.active ?? ""}
        onChange={event => void activate(event.target.value)}
      >
        {!list && <option value="">Unavailable</option>}
        {list?.workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>
    <Button size="small" disabled={!list} onClick={() => { setOpen(true); void refresh(); }}>Manage</Button>
    <Dialog open={open} onOpenChange={(_, data) => setOpen(data.open)}>
      <DialogSurface aria-describedby="workspace-help">
        <DialogBody>
          <DialogTitle>Local workspaces</DialogTitle>
          <DialogContent className="workspaceDialog">
            <Text id="workspace-help" className="muted">
              Each workspace keeps its own DuckLake catalog, generated runs, imports, dbt results, exports and query history.
              Backups are zip files in <code>{list?.home ?? "workspaces"}/_backups</code>; a restore always creates a new workspace.
            </Text>
            <ul className="workspaceList" aria-label="Workspaces">
              {list?.workspaces.map(item => <li key={item.id}>
                <div>
                  <b>{item.name}</b>{item.active && <span className="workspaceActive"> · active</span>}
                  <Text className="muted tiny" block>{item.active_scenario ? `Project ${item.active_scenario}` : "No project yet"} · {item.catalog_exists ? "catalog present" : "empty"}{item.restored_from ? ` · restored from ${item.restored_from.backup}` : ""}</Text>
                  <Text className="muted tiny" block>{item.path}</Text>
                </div>
                <div className="buttonRow">
                  {!item.active && <Button size="small" disabled={Boolean(busy)} onClick={() => void activate(item.id)}>Open</Button>}
                  <Button size="small" disabled={Boolean(busy)} onClick={() => void run("Backup", async () => {
                    const result = await postJson<{ backup: string; bytes: number; files: number }>(`/api/workspaces/${encodeURIComponent(item.id)}/backup`, {});
                    setNotice(`Backup ${result.backup} written (${result.files} files, ${formatBytes(result.bytes)}).`);
                    await refresh();
                  })}>Back up</Button>
                </div>
              </li>)}
            </ul>
            <form className="workspaceForm" onSubmit={event => {
              event.preventDefault();
              void run("Create", async () => {
                const created = await postJson<LocalWorkspace>("/api/workspaces", { name });
                setName("");
                setNotice(`Workspace ${created.name} created.`);
                await refresh();
              });
            }}>
              <Field label="New workspace name">
                <Input value={name} maxLength={80} onChange={(_, data) => setName(data.value)} placeholder="e.g. Retail training B"/>
              </Field>
              <Button type="submit" appearance="primary" disabled={!name.trim() || Boolean(busy)}>Create</Button>
            </form>
            {Boolean(list?.backups.length) && <div className="workspaceBackups">
              <Text weight="semibold">Restore a backup as a new workspace</Text>
              <Field label="Name for the restored workspace">
                <Input value={restoreName} maxLength={80} onChange={(_, data) => setRestoreName(data.value)} placeholder="e.g. Restored retail lab"/>
              </Field>
              <ul className="workspaceList" aria-label="Backups">
                {list?.backups.map(item => <li key={item.backup}>
                  <div><b>{item.backup}</b><Text className="muted tiny" block>{formatBytes(item.bytes)} · {item.modified_at}</Text></div>
                  <Button size="small" disabled={!restoreName.trim() || Boolean(busy)} onClick={() => void run("Restore", async () => {
                    const restored = await postJson<LocalWorkspace>("/api/workspaces/restore", { backup: item.backup, name: restoreName });
                    setRestoreName("");
                    setNotice(`Restored into new workspace ${restored.name}. Open it to continue.`);
                    await refresh();
                  })}>Restore</Button>
                </li>)}
              </ul>
            </div>}
            {busy && <Text role="status" aria-live="polite">{busy}…</Text>}
            {notice && <Text role="status" aria-live="polite" className="successText">{notice}</Text>}
            {error && <div className="errorText" role="alert">{error}</div>}
            {active && <Text className="muted tiny">Active: {active.name}</Text>}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setOpen(false)}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  </>;
}
