import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, Spinner, Tab, TabList, Text, Title3 } from "@fluentui/react-components";

import ArchitectureDiagram from "../fabricApps/ArchitectureDiagram";
import ConceptPanel from "../fabricApps/ConceptPanel";
import { buildArchitecture, type ModelInfo } from "../fabricApps/architecture";

import MonthlyBarChart from "../fabricApps/MonthlyBarChart";
import {
  buildPlanRows,
  computeKpis,
  dataPathStages,
  formatMoney,
  formatPct,
  formatTime,
  monthlySeries,
  validateAmount,
  validateNote,
  type PlanRow,
} from "../fabricApps/forecastLogic";
import { APP_BASE, LocalRayfinClient } from "../fabricApps/localRayfinClient";
import type { Actual, Department, Forecast, GoldRow, LocalUser, MirrorStatus, Trace } from "../fabricApps/types";
import "../fabricApps/fabricApps.css";

const USER_KEY = "contoso-fabric-app-user";

type Draft = { amount: string; note: string; error?: string; saving?: boolean };
type Version = { snapshot_id: number; snapshot_time: string; amount: number | null; updated_by: string | null; commit_message: string | null };

// Lab endpoints (mirror status, trace, Gold read) are local only; in Fabric these are platform views.
async function labGet<T>(path: string, user?: LocalUser | null): Promise<T> {
  const response = await fetch(`${APP_BASE}${path}`, { headers: user ? { "X-Local-User": user.id } : {} });
  const body = await response.json();
  if (!response.ok) throw new Error(body.detail ?? `Request failed: ${response.status}`);
  return body as T;
}

async function labPost<T>(path: string): Promise<T> {
  const response = await fetch(`${APP_BASE}${path}`, { method: "POST" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.detail ?? `Request failed: ${response.status}`);
  return body as T;
}

/** Integers with thousands separators on display; the raw value is kept while editing. */
function displayAmount(raw: string) {
  const parsed = validateAmount(raw);
  return parsed.ok ? formatMoney(parsed.value) : raw;
}

function storedUser() {
  try { return localStorage.getItem(USER_KEY); } catch { return null; }
}

export default function AppsPage({ onOpenQuery }: { onOpenQuery: (sql: string) => void }) {
  const [users, setUsers] = useState<LocalUser[]>([]);
  const [user, setUser] = useState<LocalUser | null>(null);
  const client = useMemo(() => new LocalRayfinClient(null), []);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [forecasts, setForecasts] = useState<Forecast[]>([]);
  const [actuals, setActuals] = useState<Actual[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [gold, setGold] = useState<GoldRow[]>([]);
  const [goldReady, setGoldReady] = useState(false);
  const [status, setStatus] = useState<MirrorStatus | null>(null);
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [chartAt, setChartAt] = useState<string | null>(null);
  const [waitingChart, setWaitingChart] = useState(false);
  const [versions, setVersions] = useState<Version[]>([]);
  const [lastEdit, setLastEdit] = useState<{ id: string; month: string; seq: number } | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [view, setView] = useState<"app" | "architecture">("app");
  const [focused, setFocused] = useState<string | null>(null);
  const traceTimer = useRef<number | null>(null);

  useEffect(() => {
    labGet<{ users: LocalUser[] }>("/users").then(result => {
      setUsers(result.users);
      const remembered = result.users.find(u => u.id === storedUser());
      setUser(remembered ?? result.users[0]);
    }).catch(exc => setMessage(String(exc.message ?? exc)));
    labGet<ModelInfo>("/model").then(setModel).catch(() => setModel(null));
  }, []);

  const loadGold = useCallback(async (who: LocalUser) => {
    const result = await labGet<{ ready: boolean; items: GoldRow[] }>("/gold", who);
    setGold(result.items);
    setGoldReady(result.ready);
    return result;
  }, []);

  const loadAll = useCallback(async (who: LocalUser) => {
    client.signInAs(who);
    setLoading(true);
    try {
      const [d, f, a] = await Promise.all([
        client.data.Department.select(["id", "code", "name", "finance_owner_email"]).orderBy({ code: "asc" }).execute(),
        client.data.forecasts.query().select(["id", "department_id", "month", "amount", "note", "owner_email", "updated_by", "updated_at"]).first(-1).execute(),
        client.data.Actual.select(["id", "department_id", "month", "amount", "owner_email"]).first(-1).execute(),
      ]);
      setDepartments(d);
      setForecasts(f);
      setActuals(a);
      setDrafts({});
      await loadGold(who);
    } catch (exc) {
      setMessage(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setLoading(false);
    }
  }, [client, loadGold]);

  useEffect(() => {
    if (!user) return;
    try { localStorage.setItem(USER_KEY, user.id); } catch { /* storage is optional */ }
    void loadAll(user);
  }, [user, loadAll]);

  // Mirror status: light polling so latency and pending counts stay current.
  useEffect(() => {
    let alive = true;
    const tick = () => labGet<MirrorStatus>("/mirror/status").then(s => { if (alive) setStatus(s); }).catch(() => undefined);
    tick();
    const id = window.setInterval(tick, 3000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  // Follow the last write along the data path until Gold has been rebuilt.
  useEffect(() => {
    if (!lastEdit || !user) return;
    let alive = true;
    const poll = async () => {
      try {
        const result = await labGet<{ trace: Trace | null }>(`/trace?seq=${lastEdit.seq}`);
        if (!alive) return;
        setTrace(result.trace);
        const mirror = result.trace?.mirror;
        if (mirror?.gold_at || mirror?.gold_ok === 0) {
          await loadGold(user);
          if (!alive) return;
          setWaitingChart(true);
          const history = await labGet<{ versions: Version[] }>(`/history/${lastEdit.id}`);
          if (alive) setVersions(history.versions);
          return;
        }
      } catch { /* keep polling */ }
      if (alive) traceTimer.current = window.setTimeout(poll, 400);
    };
    void poll();
    return () => { alive = false; if (traceTimer.current) window.clearTimeout(traceTimer.current); };
  }, [lastEdit, user, loadGold]);

  // The chart stage is stamped once React has painted the new Gold rows.
  useEffect(() => {
    if (!waitingChart) return;
    const frame = requestAnimationFrame(() => { setChartAt(new Date().toISOString()); setWaitingChart(false); });
    return () => cancelAnimationFrame(frame);
  }, [waitingChart, gold]);

  const rows = useMemo(() => buildPlanRows(departments, forecasts, actuals), [departments, forecasts, actuals]);
  const kpis = useMemo(() => computeKpis(rows), [rows]);
  const bars = useMemo(() => monthlySeries(gold), [gold]);
  const stages = useMemo(() => dataPathStages(trace, chartAt), [trace, chartAt]);
  const canWrite = user?.role === "finance";
  const architecture = useMemo(() => model ? buildArchitecture(model) : null, [model]);
  const forecastPolicies = model?.entities.find(e => e.name === "Forecast")?.roles ?? [];

  function draftFor(row: PlanRow): Draft {
    return drafts[row.forecastId] ?? { amount: String(row.forecast), note: row.note ?? "" };
  }

  function edit(row: PlanRow, patch: Partial<Draft>) {
    setDrafts(current => ({ ...current, [row.forecastId]: { ...draftFor(row), ...patch, error: undefined } }));
  }

  async function save(row: PlanRow) {
    if (!user) return;
    const draft = draftFor(row);
    const amount = validateAmount(draft.amount);
    const noteError = validateNote(draft.note);
    if (!amount.ok || noteError) {
      setDrafts(current => ({ ...current, [row.forecastId]: { ...draft, error: amount.ok ? noteError ?? undefined : amount.error } }));
      return;
    }
    setDrafts(current => ({ ...current, [row.forecastId]: { ...draft, saving: true } }));
    try {
      const saved = await client.data.Forecast.update(
        { id: row.forecastId },
        { amount: amount.value, note: draft.note.trim() || null, updated_by: user.email, updated_at: new Date().toISOString() },
      );
      setForecasts(current => current.map(f => f.id === saved.id ? { ...f, ...saved } : f));
      setDrafts(current => { const next = { ...current }; delete next[row.forecastId]; return next; });
      setTrace(null);
      setChartAt(null);
      setVersions([]);
      setLastEdit({ id: row.forecastId, month: row.month, seq: saved._seq });
      setMessage(`Saved ${row.departmentCode} ${row.month}: ${formatMoney(amount.value)}. Following it to the chart…`);
    } catch (exc) {
      setDrafts(current => ({ ...current, [row.forecastId]: { ...draft, saving: false, error: exc instanceof Error ? exc.message : String(exc) } }));
    }
  }

  async function rebuildGold() {
    if (!user) return;
    setRebuilding(true);
    try {
      await labPost("/mirror/run");
      await labPost("/gold/refresh");
      await loadGold(user);
      setMessage("Gold rebuilt from the mirrored Bronze tables.");
    } catch (exc) {
      setMessage(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setRebuilding(false);
    }
  }

  return <div className="faPage">
    <Card className="faHeader">
      <div>
        <Text className="eyebrow">FABRIC-STYLE APP · LOCAL PROTOTYPE · SYNTHETIC DATA</Text>
        <Title3>Sales Forecasting</Title3>
        <Text className="muted">Model: Rayfin decorators in <code>apps/fabric-app-lab/rayfin/data</code> · operational store: SQLite · mirror: DuckLake Bronze</Text>
      </div>
      <label className="faRole">Signed in as (local fake user)
        <select aria-label="Role switcher" value={user?.id ?? ""} onChange={event => setUser(users.find(u => u.id === event.target.value) ?? null)}>
          {(["finance", "executive"] as const).map(role => <optgroup key={role} label={role}>
            {users.filter(u => u.role === role).map(u => <option key={u.id} value={u.id}>{u.display_name}</option>)}
          </optgroup>)}
        </select>
      </label>
    </Card>

    <TabList selectedValue={view} onTabSelect={(_, data) => setView(data.value as "app" | "architecture")} aria-label="Apps area">
      <Tab value="app">App</Tab>
      <Tab value="architecture">Architecture</Tab>
    </TabList>

    {view === "architecture" ? <Card className="faArchCard">
      <div className="faCardHead"><div><Title3>Architecture</Title3><Text className="muted">Generated from the compiled Rayfin model (<code>rayfin/generated/model.json</code>) and the local data path. Each layer shows its local stand-in and the Fabric piece it replaces.</Text></div></div>
      <ConceptPanel fallback={architecture ? <ArchitectureDiagram architecture={architecture} /> : <Spinner label="Loading model…" />} />
    </Card> : <>
    {user && <div className={`faRls ${canWrite ? "write" : "read"}`} role="note">
      <Badge appearance="filled" color={canWrite ? "brand" : "informative"}>{user.role}</Badge>
      <span>{canWrite
        ? `Row policy: you see and edit ${user.department_code} only (${rows.length} forecast rows).`
        : `Read only: executives see every department (${rows.length} forecast rows) and cannot write.`}</span>
      <span className="faPolicy">{forecastPolicies.map(p => `${p.actions.join("/")}: ${p.policy ?? "everyone signed in"}`).join("  ·  ")}</span>
    </div>}

    <section className="faPath" aria-label="Data path">
      {stages.map((stage, index) => <div key={stage.key} className={`faStage ${stage.state}`} data-stage={stage.key}>
        <div className="faStageHead"><span className="faDot" />{stage.label}{index < stages.length - 1 && <i>→</i>}</div>
        <b>{formatTime(stage.at)}</b>
        <span>{stage.deltaMs !== null ? `+${stage.deltaMs} ms · ` : ""}{stage.detail}</span>
      </div>)}
    </section>

    <div className="faKpis">
      <Card><Text className="eyebrow">FORECAST FY 2026</Text><b data-kpi="forecast-year">{formatMoney(kpis.forecastYear)}</b></Card>
      <Card><Text className="eyebrow">ACTUAL YTD ({kpis.monthsWithActuals} MONTHS)</Text><b>{formatMoney(kpis.actualYtd)}</b></Card>
      <Card><Text className="eyebrow">FORECAST YTD</Text><b>{formatMoney(kpis.forecastYtd)}</b></Card>
      <Card><Text className="eyebrow">VARIANCE YTD</Text><b>{formatMoney(kpis.varianceYtd)}</b><span className="muted">{formatPct(kpis.variancePct)} vs forecast</span></Card>
      <Card><Text className="eyebrow">MIRROR LATENCY</Text><b data-kpi="mirror-latency">{status?.stats ? `${status.stats.last_ms} ms` : "–"}</b>
        <span className="muted">{status?.stats ? `p50 ${status.stats.p50_ms} ms · max ${status.stats.max_ms} ms · ${status.mode}` : status?.mode ?? ""}</span></Card>
    </div>

    <div className="faGridTwo">
      <Card className="faChartCard">
        <div className="faCardHead">
          <div><Title3>Forecast vs actual by month</Title3><Text className="muted">From Gold <code>contoso.gold.forecast_vs_actual</code>{user?.role === "finance" ? ` · ${user.department_code} only` : " · all departments"}</Text></div>
          <Button size="small" disabled={rebuilding} onClick={() => void rebuildGold()}>{rebuilding ? "Rebuilding…" : "Rebuild Gold"}</Button>
        </div>
        {goldReady || bars.length ? <MonthlyBarChart bars={bars} highlightMonth={lastEdit?.month} /> : <div className="faEmpty">{status?.gold_auto === false ? "dbt is not installed: Gold cannot be built." : "Building Gold for the first time…"}</div>}
      </Card>
      <Card className="faSide">
        <Title3>History (DuckLake snapshots)</Title3>
        <Text className="muted">Each mirror batch is one snapshot, like a Delta version.</Text>
        {versions.length ? <table className="faMini"><thead><tr><th>Snapshot</th><th>Time</th><th>Amount</th></tr></thead><tbody>
          {versions.map(v => <tr key={v.snapshot_id}><td>{v.snapshot_id}</td><td>{formatTime(v.snapshot_time)}</td><td>{formatMoney(v.amount === null ? null : Number(v.amount))}</td></tr>)}
        </tbody></table> : <table className="faMini"><thead><tr><th>Snapshot</th><th>Time</th><th>Commit</th></tr></thead><tbody>
          {(status?.snapshots ?? []).slice(0, 6).map(s => <tr key={s.snapshot_id}><td>{s.snapshot_id}</td><td>{formatTime(s.snapshot_time)}</td><td>{s.commit_message ?? "–"}</td></tr>)}
        </tbody></table>}
        <div className="faActions">
          <Button size="small" onClick={() => onOpenQuery("select department_id, month, amount, updated_by, _mirrored_at\nfrom contoso.bronze.sfapp_forecasts\norder by _mirrored_at desc, month")}>Open mirrored table in Query</Button>
          <Button size="small" onClick={() => onOpenQuery("select * from contoso.gold.forecast_vs_actual order by month, department_code")}>Open Gold in Query</Button>
        </div>
      </Card>
    </div>

    <Card>
      <div className="faCardHead">
        <div><Title3>Forecast vs actual</Title3><Text className="muted">{canWrite ? "Edit a forecast, then Save (or press Enter). Values are checked here and again by the backend policy." : "Executive view: read only."}</Text></div>
        {message && <Text className="statusText" role="status">{message}</Text>}
      </div>
      {loading ? <Spinner label="Loading app data…" /> : <div className="faTableWrap"><table className="faTable">
        <thead><tr><th>Department</th><th>Month</th><th className="num">Forecast</th><th className="num">Actual</th><th className="num">Variance</th><th className="num">Var %</th><th>Note</th><th>Last edit</th>{canWrite && <th />}</tr></thead>
        <tbody>
          {rows.map(row => {
            const draft = draftFor(row);
            const dirty = draft.amount !== String(row.forecast) || draft.note !== (row.note ?? "");
            return <tr key={row.forecastId} data-row={`${row.departmentCode}-${row.month}`} className={lastEdit?.id === row.forecastId ? "edited" : undefined}>
              <td>{row.departmentCode}</td>
              <td>{row.month}</td>
              <td className="num">{canWrite
                ? <input aria-label={`Forecast ${row.departmentCode} ${row.month}`} inputMode="decimal"
                    value={focused === row.forecastId ? draft.amount : displayAmount(draft.amount)}
                    onFocus={event => {
                      // Swap to the raw value synchronously so select-all/typing apply to it, not to the formatted text.
                      event.currentTarget.value = draft.amount;
                      event.currentTarget.select();
                      setFocused(row.forecastId);
                    }} onBlur={() => setFocused(current => current === row.forecastId ? null : current)}
                    onChange={event => edit(row, { amount: event.target.value })}
                    onKeyDown={event => { if (event.key === "Enter") void save(row); }} aria-invalid={Boolean(draft.error)} />
                : formatMoney(row.forecast)}</td>
              <td className="num">{formatMoney(row.actual)}</td>
              <td className={`num ${row.variance !== null && row.variance < 0 ? "neg" : ""}`}>{formatMoney(row.variance)}</td>
              <td className="num">{formatPct(row.variancePct)}</td>
              <td>{canWrite
                ? <input aria-label={`Note ${row.departmentCode} ${row.month}`} value={draft.note} maxLength={220}
                    onChange={event => edit(row, { note: event.target.value })}
                    onKeyDown={event => { if (event.key === "Enter") void save(row); }} />
                : row.note ?? ""}</td>
              <td className="muted">{row.updatedBy && row.updatedBy !== "seed" ? row.updatedBy : "–"}</td>
              {canWrite && <td>
                <Button size="small" appearance={dirty ? "primary" : "secondary"} disabled={!dirty || draft.saving} onClick={() => void save(row)}>{draft.saving ? "Saving…" : "Save"}</Button>
                {draft.error && <div className="faError" role="alert">{draft.error}</div>}
              </td>}
            </tr>;
          })}
        </tbody>
      </table></div>}
    </Card>
    {status?.last_error && <div className="errorText" role="alert">Mirror error: {status.last_error}</div>}
    </>}
  </div>;
}
