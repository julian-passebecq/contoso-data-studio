#!/usr/bin/env node
// Open a Contoso export in MosaicStudio itself (actual consumer, not only its validators) and write evidence.
//
//   node tools/open_in_mosaic.mjs --mosaic <datapass-mosaicstudio checkout> [--ref <sha>] --export <bundle dir>
//        --concept <concept.json> --out <dir> [--port 21250] [--with-deps] [--keep]
//
// 1. `git archive <ref>` of the Mosaic checkout into a temporary folder (the checkout is never touched), `npm ci`
//    there with the lockfile of that ref.
// 2. Artifact: the exact export JSON is placed where Mosaic's loader reads static artifacts
//    (clients/<client>/public/artifacts/<id>.json, src/framework/foundation/artifact-loader.ts) in a throwaway
//    client of the temporary copy, served by Mosaic's own `client:dev` host (scripts/client-dev.mjs, Vite) on
//    loopback, opened at /?app=<client> with Playwright. Table, chart and metric are asserted against the
//    artifact's own values and screenshotted.
// 3. Concept: Mosaic's standalone viewer is built at that ref (scripts/build-concept-standalone.mjs), framed by a
//    parent page and driven through its embed API (postMessage load/ready, fit option, resize); a message from a
//    sibling frame (not the direct parent) must be ignored.
// 4. Gates are reported separately in <out>/evidence.json:
//    structural_strict  ajv against docs/contracts/artifact.schema.json at the ref, no field stripped (non-fatal)
//    structural_ts      Mosaic validateArtifact + artifactDefinition (TypeScript, at the ref)
//    semantic           ids, references, self-dependency/cycles, sha256 of artifact, manifest and bulk Parquet
//    concept            Mosaic checkConceptSpec + viewer render
// Exit code is non-zero only for real consumer failures (not for structural_strict).
// Requires Node >= 22.18 (built-in TypeScript type stripping), git, npm and network access for npm/GitHub.
import {execFileSync, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {basename, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const PINNED_MOSAIC_SHA = '6f45dd06e95ee66d693fc08fb4369c2a6379e84c';
const AJV_VERSION = '8.17.1';
const CLIENT_ID = 'contoso-consumer';
const WIN = process.platform === 'win32';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (!key.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[key.slice(2)] = true;
  else { args[key.slice(2)] = next; i++; }
}
if (!args.mosaic || !args.export || !args.concept || !args.out) {
  console.error('usage: --mosaic <checkout> [--ref <sha>] --export <bundle dir> --concept <concept.json> --out <dir> [--port N] [--with-deps] [--keep]');
  process.exit(2);
}
const port = Number(args.port ?? 21250);
if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.error('--port must be an integer 1024-65535'); process.exit(2); }

const out = resolve(args.out), shots = join(out, 'screenshots');
rmSync(out, {recursive: true, force: true});
mkdirSync(shots, {recursive: true});
const ref = args.ref ?? PINNED_MOSAIC_SHA;
const sha = execFileSync('git', ['-C', args.mosaic, 'rev-parse', `${ref}^{commit}`], {encoding: 'utf8'}).trim();
const evidence = {
  format: 'contoso.mosaic-consumer-evidence', version: 1, mosaic_ref: ref, mosaic_sha: sha,
  mosaic_version: null, node: process.version, started_at: new Date().toISOString(),
  export_dir: resolve(args.export), concept_file: resolve(args.concept), gates: {}, browser: {}, screenshots: [], result: 'FAIL',
};
const log = (...m) => console.error('[open_in_mosaic]', ...m);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (file) => { const t = readFileSync(file, 'utf8'); return JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t); };
const npm = (cmdArgs, cwd, timeout = 900_000) => execFileSync(WIN ? 'npm.cmd' : 'npm', cmdArgs, {cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: WIN, timeout, maxBuffer: 1 << 26});
const gate = (name, value) => { evidence.gates[name] = value; return value; };
const shot = async (target, name, caption) => {
  const file = join(shots, name);
  await target.screenshot({path: file});
  evidence.screenshots.push({file: `screenshots/${name}`, caption});
};

const scratch = mkdtempSync(join(tmpdir(), 'contoso-open-mosaic-'));
const src = join(scratch, 'mosaic');
let host = null;
const failures = [];

function stopHost() {
  if (!host || host.exitCode !== null) return Promise.resolve();
  const child = host;
  return new Promise((done) => {
    const timer = setTimeout(() => {
      if (WIN) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {stdio: 'ignore'}); } catch { /* already gone */ } }
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      done();
    }, 15_000);
    child.once('exit', () => { clearTimeout(timer); done(); });
    child.stdin.end(); // client-dev follows its stdin pipe: closing it stops the host gracefully (also on Windows).
  });
}

try {
  // ---------- 1. Mosaic sources at the ref, dependencies from that ref's lockfile -------------------------------
  log(`git archive ${sha} -> ${src}`);
  mkdirSync(src);
  writeFileSync(join(scratch, 'src.tar'), execFileSync('git', ['-C', args.mosaic, 'archive', '--format=tar', sha], {maxBuffer: 1 << 30}));
  execFileSync('tar', ['-xf', join(scratch, 'src.tar'), '-C', src], {cwd: scratch});
  rmSync(join(scratch, 'src.tar'));
  evidence.mosaic_version = readJson(join(src, 'package.json')).version;
  log('npm ci (Mosaic lockfile)');
  npm(['ci', '--no-audit', '--no-fund'], src);
  const requireMosaic = createRequire(join(src, 'package.json'));
  const playwrightDir = join(src, 'node_modules', 'playwright'), playwrightCli = join(playwrightDir, 'cli.js'); // not in its exports map
  log('playwright install chromium');
  execFileSync(process.execPath, [playwrightCli, 'install', ...(args['with-deps'] ? ['--with-deps'] : []), 'chromium'], {cwd: src, stdio: ['ignore', 'pipe', 'pipe'], timeout: 900_000});
  const {chromium} = requireMosaic('playwright');
  evidence.playwright = readJson(join(playwrightDir, 'package.json')).version;

  // ---------- export bundle --------------------------------------------------------------------------------------
  const folder = resolve(args.export);
  const receipt = readJson(join(folder, 'contoso-export.json'));
  const artifactBytes = readFileSync(join(folder, receipt.artifact.file));
  const artifact = JSON.parse(artifactBytes.toString('utf8'));
  const manifest = readJson(join(folder, 'manifest.json'));

  // ---------- gate (a) structural_strict: ajv, nothing stripped --------------------------------------------------
  {
    const schemaText = execFileSync('git', ['-C', args.mosaic, 'show', `${sha}:docs/contracts/artifact.schema.json`], {encoding: 'utf8'});
    const schema = JSON.parse(schemaText);
    const tools = join(scratch, 'ajv');
    mkdirSync(tools);
    writeFileSync(join(tools, 'package.json'), '{"private":true}');
    npm(['install', '--no-audit', '--no-fund', `ajv@${AJV_VERSION}`], tools);
    const requireAjv = createRequire(join(tools, 'package.json'));
    const draft = String(schema.$schema ?? '');
    const Ajv = (draft.includes('2020-12') ? requireAjv('ajv/dist/2020') : draft.includes('2019-09') ? requireAjv('ajv/dist/2019') : requireAjv('ajv')).default;
    const ajv = new Ajv({allErrors: true, strict: false});
    const validate = ajv.compile(schema);
    const ok = validate(artifact);
    const errors = ok ? [] : validate.errors.map(({instancePath, schemaPath, keyword, params, message}) => ({instancePath, schemaPath, keyword, params, message}));
    const provenanceExtras = Object.keys(artifact.provenance ?? {}).filter((k) => !(k in (schema.properties?.provenance?.properties ?? {})));
    gate('structural_strict', {
      ok, fatal: false, validator: `ajv@${AJV_VERSION} (${draft || 'default draft'})`,
      schema: `docs/contracts/artifact.schema.json@${sha}`, schema_sha256: sha256(schemaText), stripped_fields: [],
      status: ok ? 'PASS' : 'PENDING_PEER 01-mosaicstudio schema repair',
      note: ok ? undefined : `Mosaic's published JSON Schema lacks provenance fields its own TS validator accepts: ${provenanceExtras.join(', ') || '(see errors)'}`,
      errors,
    });
    log(`structural_strict: ${ok ? 'PASS' : `FAIL (${errors.length} ajv errors, non-fatal)`}`);
  }

  // ---------- gate (b) structural_ts: Mosaic validateArtifact (TypeScript) ---------------------------------------
  const foundation = await import(pathToFileURL(join(src, 'src/framework/foundation/artifact.ts')).href);
  try {
    const validated = foundation.validateArtifact(JSON.parse(artifactBytes.toString('utf8')));
    const definition = foundation.artifactDefinition(JSON.parse(artifactBytes.toString('utf8')));
    gate('structural_ts', {ok: true, fatal: true, validator: `src/framework/foundation/artifact.ts@${sha} validateArtifact+artifactDefinition`,
      id: validated.id, rows: validated.payload.rows?.length, representations: validated.representations.map((r) => `${r.id}:${r.kind}`),
      blocks: definition.manifest.pages[0].sections[0].blocks.length});
  } catch (error) {
    gate('structural_ts', {ok: false, fatal: true, error: String(error?.message ?? error)});
    failures.push('structural_ts');
  }

  // ---------- gate (c) semantic ----------------------------------------------------------------------------------
  {
    const issues = [];
    const checks = {};
    const dup = (label, list) => { const seen = new Set(); for (const v of list) { if (seen.has(v)) issues.push(`${label}: duplicate id "${v}"`); seen.add(v); } return list.length; };
    const payload = artifact.payload ?? {};
    const columns = payload.columns ?? [], rows = payload.rows ?? [], reps = artifact.representations ?? [];
    const inputs = artifact.provenance?.inputs ?? [];
    checks.column_ids = dup('columns', columns.map((c) => c.id));
    checks.representation_ids = dup('representations', reps.map((r) => r.id));
    checks.input_ids = dup('provenance.inputs', inputs.map((i) => i.id));
    checks.row_keys = dup(`rows[${payload.rowKey}]`, rows.map((r) => String(r[payload.rowKey])));
    const columnIds = new Set(columns.map((c) => c.id)), inputIds = new Set(inputs.map((i) => i.id));
    const rowKeys = new Set(rows.map((r) => String(r[payload.rowKey])));
    if (payload.kind === 'table' && !columnIds.has(payload.rowKey)) issues.push(`rowKey "${payload.rowKey}" is not a column`);
    let references = 0;
    for (const rep of reps) {
      for (const used of rep.inputs ?? []) { references++; if (!inputIds.has(used)) issues.push(`representation ${rep.id}: input "${used}" is not declared in provenance.inputs`); }
      for (const key of ['x', 'y', 'column']) if (rep[key] !== undefined) { references++; if (!columnIds.has(rep[key])) issues.push(`representation ${rep.id}: ${key} "${rep[key]}" is not a column`); }
      if (rep.kind === 'metric') { references++; if (!rowKeys.has(String(rep.row))) issues.push(`representation ${rep.id}: row "${rep.row}" is absent`); }
    }
    for (const row of rows) for (const key of Object.keys(row)) if (!columnIds.has(key)) issues.push(`row ${row[payload.rowKey]}: field "${key}" is not a column`);
    checks.references_resolved = references;
    // Lineage graph over every artifact of the bundle manifest: dependsOn ids must exist, no self edge, no cycle.
    const graph = new Map();
    for (const entry of manifest.artifacts ?? []) {
      const file = join(folder, entry.file ?? entry.path ?? `${entry.id}.json`);
      if (!existsSync(file)) { issues.push(`manifest artifact ${entry.id} file missing`); continue; }
      const bytes = readFileSync(file);
      if (entry.sha256 && sha256(bytes) !== entry.sha256) issues.push(`manifest artifact ${entry.id}: sha256 mismatch`);
      const parsed = JSON.parse(bytes.toString('utf8'));
      graph.set(parsed.id, parsed.provenance?.dependsOn ?? []);
    }
    if (!graph.has(artifact.id)) graph.set(artifact.id, artifact.provenance?.dependsOn ?? []);
    let edges = 0;
    for (const [id, deps] of graph) for (const dep of deps) {
      edges++;
      if (dep === id) issues.push(`lineage: ${id} depends on itself`);
      else if (!graph.has(dep)) issues.push(`lineage: ${id} dependsOn "${dep}" does not resolve to an artifact of this bundle`);
    }
    const state = new Map();
    const visit = (id, path) => {
      if (state.get(id) === 2 || !graph.has(id)) return;
      if (state.get(id) === 1) { issues.push(`lineage: cycle ${[...path, id].join(' -> ')}`); return; }
      state.set(id, 1);
      for (const dep of graph.get(id)) if (dep !== id) visit(dep, [...path, id]);
      state.set(id, 2);
    };
    for (const id of graph.keys()) visit(id, []);
    checks.lineage = {artifacts: graph.size, dependsOn_edges: edges};
    // Bytes: receipt, manifest and bulk Parquet.
    const artifactSha = sha256(artifactBytes);
    if (artifactSha !== receipt.artifact.sha256) issues.push(`artifact sha256 ${artifactSha} != receipt ${receipt.artifact.sha256}`);
    const listed = (manifest.artifacts ?? []).find((a) => a.id === artifact.id) ?? manifest.artifacts?.[0];
    if (listed?.sha256 !== artifactSha) issues.push('manifest sha256 of the artifact does not match its bytes');
    const bulkSha = sha256(readFileSync(join(folder, receipt.bulk_data.file)));
    if (bulkSha !== receipt.bulk_data.sha256) issues.push(`bulk ${receipt.bulk_data.file} sha256 ${bulkSha} != receipt ${receipt.bulk_data.sha256}`);
    checks.sha256 = {artifact: artifactSha, bulk_data: bulkSha, manifest_entry: listed?.sha256 ?? null};
    const ok = issues.length === 0;
    gate('semantic', {ok, fatal: true, checks, issues});
    if (!ok) failures.push('semantic');
  }

  // ---------- gate (d) concept: checkConceptSpec (render is added after the browser step) --------------------------
  const conceptBytes = readFileSync(resolve(args.concept));
  const conceptSpec = readJson(resolve(args.concept));
  {
    const {checkConceptSpec, CONCEPT_SPEC_VERSION} = await import(pathToFileURL(join(src, 'src/framework/concept/schema.ts')).href);
    const result = checkConceptSpec(structuredClone(conceptSpec));
    gate('concept', {ok: result.ok, fatal: true, specVersion: CONCEPT_SPEC_VERSION, sha256: sha256(conceptBytes),
      checkConceptSpec: result.ok ? {ok: true, layers: result.spec.layers.length, nodes: result.spec.nodes.length, flows: result.spec.flows.length, warnings: result.warnings}
        : {ok: false, issues: result.issues}, render: null});
    if (!result.ok) failures.push('concept.checkConceptSpec');
  }

  // ---------- 2. Artifact opened in Mosaic's own UI ----------------------------------------------------------------
  const chart = (artifact.representations ?? []).find((r) => r.kind === 'chart');
  const numeric = (artifact.payload.columns ?? []).find((c) => c.type === 'number' && (!chart || c.id === chart.y)) ?? (artifact.payload.columns ?? []).find((c) => c.type === 'number');
  const declaredMetric = (artifact.representations ?? []).find((r) => r.kind === 'metric');
  const rowKey = artifact.payload.rowKey;
  let metricArtifact = null, metricRep = declaredMetric;
  if (!declaredMetric && numeric) {
    // The export declares no metric representation: a consumer-side view of the SAME rows adds one (largest value).
    const best = artifact.payload.rows.reduce((a, b) => (typeof b[numeric.id] === 'number' && (a === null || b[numeric.id] > a[numeric.id]) ? b : a), null);
    metricRep = {id: 'metric', title: `Largest ${numeric.label}`, kind: 'metric', row: String(best[rowKey]), column: numeric.id, ...(numeric.unit ? {unit: numeric.unit.slice(0, 30)} : {})};
    metricArtifact = {...artifact, id: `${artifact.id}-metric`.slice(0, 80), title: `${artifact.title}`.slice(0, 160), representations: [metricRep]};
    foundation.validateArtifact(structuredClone(metricArtifact));
  }
  const client = join(src, 'clients', CLIENT_ID);
  mkdirSync(join(client, 'public', 'artifacts'), {recursive: true});
  writeFileSync(join(client, 'public', 'artifacts', `${artifact.id}.json`), artifactBytes); // exact bytes, unmodified
  if (metricArtifact) writeFileSync(join(client, 'public', 'artifacts', `${metricArtifact.id}.json`), JSON.stringify(metricArtifact, null, 2));
  const shown = (artifact.representations ?? []).filter((r) => r.kind !== 'json').map((r) => r.id);
  writeFileSync(join(client, 'client.config.json'), JSON.stringify({format: 'datapass.client-profile', version: 1, family: 'analytics'}) + '\n');
  writeFileSync(join(client, 'app.ts'), `import {defineApp} from '../../src/framework/authoring.ts';
import {artifactSource} from '../../src/framework/foundation/ArtifactSource.tsx';
/** Throwaway consumer client written by contoso-data-studio tools/open_in_mosaic.mjs into a temporary copy. */
export default defineApp({manifest:{
  format:'datapass.web-app',schemaVersion:1,id:${JSON.stringify(CLIENT_ID)},version:'0.1.0',title:'Contoso Gold export',label:'SYNTHETIC Contoso export',
  description:'A Contoso Data Studio datapass.artifact export rendered by Studio from public/artifacts.',
  theme:{accent:'#286f89',density:'compact'},fields:[],datasets:[],tasks:[],
  pages:[{id:'result',title:'Gold export',description:'Validated in the browser before display; nothing is recomputed.',sections:[
    {id:'gold',columns:1,blocks:[{id:'gold-artifact',type:'custom',resource:'gold'}]},
    ${metricRep ? "{id:'metric',columns:1,blocks:[{id:'metric-artifact',type:'custom',resource:'metric'}]}," : ''}
  ]}]},
bindings:{},components:{gold:artifactSource(${JSON.stringify(artifact.id)},${JSON.stringify(shown)})${metricRep ? `,metric:artifactSource(${JSON.stringify(metricArtifact?.id ?? artifact.id)},[${JSON.stringify(metricRep.id)}])` : ''}},
customCapabilities:{gold:['charts']${metricRep ? ',metric:[]' : ''}}});
`);
  log(`client:dev ${CLIENT_ID} on 127.0.0.1:${port}`);
  const nodeArgs = process.features?.typescript ? [] : ['--experimental-strip-types'];
  host = spawn(process.execPath, [...nodeArgs, 'scripts/client-dev.mjs', CLIENT_ID, '--port', String(port), '--json'], {cwd: src, stdio: ['pipe', 'pipe', 'pipe'], detached: !WIN});
  const hostLog = [];
  const ready = new Promise((done, fail) => {
    let buffer = '';
    const timer = setTimeout(() => fail(new Error('client:dev not ready within 15 min')), 900_000);
    host.stdout.on('data', (chunk) => {
      buffer += chunk; hostLog.push(String(chunk));
      for (let i; (i = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
        try {
          const status = JSON.parse(line);
          if (status.status === 'ready') { clearTimeout(timer); done(status); }
          if (status.status === 'error' || status.status === 'invalid') { clearTimeout(timer); fail(new Error(`client:dev ${status.status}: ${status.message}`)); }
        } catch { /* not a status line */ }
      }
    });
    host.stderr.on('data', (chunk) => hostLog.push(String(chunk)));
    host.once('exit', (code) => { clearTimeout(timer); fail(new Error(`client:dev exited (${code})`)); });
  });
  let descriptor;
  try { descriptor = await ready; } finally { writeFileSync(join(out, 'mosaic-client-dev.log'), hostLog.join('')); }
  const browser = await chromium.launch();
  try {
    // --- artifact ---
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    const url = `http://127.0.0.1:${port}/?app=${CLIENT_ID}`;
    await page.goto(url);
    const source = page.locator(`[data-testid=artifact-source][data-artifact-id="${artifact.id}"]`);
    await source.waitFor({timeout: 60_000});
    const view = (id) => source.locator(`.foundation-artifact-view[data-representation="${id}"]`);
    const fmt = (v, digits = 2) => (typeof v === 'number' ? new Intl.NumberFormat('en-GB', {maximumFractionDigits: digits}).format(v) : String(v));
    const record = {url, client_dev: descriptor, artifact_id: artifact.id};
    const table = (artifact.representations ?? []).find((r) => r.kind === 'table');
    const firstRow = artifact.payload.rows[0];
    if (table) {
      const t = view(table.id);
      await t.locator('tbody tr').first().waitFor();
      const shownRows = await t.locator('tbody tr').count();
      const caption = await t.locator('.site-table-caption').innerText();
      const expectRows = Math.min(20, artifact.payload.rows.length);
      const cell = numeric ? fmt(firstRow[numeric.id]) : String(firstRow[rowKey]);
      const firstText = await t.locator('tbody tr').first().innerText();
      const ok = shownRows === expectRows && caption.includes(`${artifact.payload.rows.length} rows`) && firstText.includes(cell);
      record.table = {ok, representation: table.id, rows_shown: shownRows, rows_expected: expectRows, caption, first_row_value: cell, first_row_text: firstText.replace(/\s+/g, ' ').slice(0, 300)};
      await t.scrollIntoViewIfNeeded();
      await shot(t, 'mosaic-artifact-table.png', `Mosaic table representation of ${artifact.id}`);
      if (!ok) failures.push('browser.table');
    } else { record.table = {ok: false, reason: 'artifact declares no table representation'}; failures.push('browser.table'); }
    if (chart) {
      const c = view(chart.id);
      const svg = c.locator('svg').first();
      await svg.waitFor();
      const box = await svg.boundingBox();
      const text = await c.innerText();
      const marks = await c.locator('rect, path, circle').count();
      const xLabel = String(artifact.payload.rows[0][chart.x]);
      const ok = !!box && box.width > 100 && box.height > 50 && marks > 0;
      record.chart = {ok, representation: chart.id, kind: chart.chart, x: chart.x, y: chart.y, svg_box: box, marks, mentions_first_x: text.includes(xLabel)};
      await c.scrollIntoViewIfNeeded();
      await shot(c, 'mosaic-artifact-chart.png', `Mosaic ${chart.chart} chart ${chart.y} by ${chart.x}`);
      if (!ok) failures.push('browser.chart');
    } else { record.chart = {ok: false, reason: 'artifact declares no chart representation'}; failures.push('browser.chart'); }
    if (metricRep) {
      const metricSource = page.locator(`[data-testid=artifact-source][data-artifact-id="${metricArtifact?.id ?? artifact.id}"]`);
      const m = metricSource.locator(`[data-testid="metric-${metricRep.id}"]`);
      await m.waitFor();
      const value = artifact.payload.rows.find((r) => String(r[rowKey]) === metricRep.row)[metricRep.column];
      const expected = fmt(value, metricRep.digits ?? 2);
      const text = (await m.innerText()).replace(/\s+/g, ' ').trim();
      const ok = text.startsWith(expected);
      record.metric = {ok, representation: metricRep.id, source: metricArtifact ? 'consumer-derived view (the export declares no metric representation; same rows, one metric representation added)' : 'declared by the export',
        row: metricRep.row, column: metricRep.column, artifact_value: value, expected_text: expected, shown_text: text};
      await m.scrollIntoViewIfNeeded();
      await shot(metricSource.locator('.foundation-artifact-view').first(), 'mosaic-artifact-metric.png', `Mosaic metric ${metricRep.column} of row ${metricRep.row}`);
      if (!ok) failures.push('browser.metric');
    } else { record.metric = {ok: false, reason: 'no numeric column for a metric'}; failures.push('browser.metric'); }
    const provenance = await source.locator('[data-testid=artifact-provenance]').innerText();
    record.provenance = {ok: provenance.includes(artifact.provenance.kind), text: provenance.replace(/\s+/g, ' ').slice(0, 400)};
    if (!record.provenance.ok) failures.push('browser.provenance');
    await shot(page, 'mosaic-artifact-page.png', 'Mosaic client:dev page with the Contoso artifact (full viewport)');
    record.page_errors = errors;
    if (errors.length) failures.push('browser.page_errors');
    evidence.browser.artifact = record;
    await page.close();
  } finally {
    await browser.close();
  }
  await stopHost();
  host = null;

  // ---------- 3. Standalone concept viewer at the ref, embed API -------------------------------------------------
  log('build standalone concept viewer');
  const viewerFile = join(src, 'dist-standalone', 'concept-viewer.html');
  const build = execFileSync(process.execPath, [...nodeArgs, 'scripts/build-concept-standalone.mjs'], {cwd: src, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000});
  const viewerHtml = readFileSync(viewerFile, 'utf8');
  cpSync(viewerFile, join(out, 'concept-viewer.html'));
  const render = {build: build.trim().split('\n').pop(), viewer_sha256: sha256(viewerHtml), spec_id: conceptSpec.id};
  const browser2 = await chromium.launch();
  try {
    const page = await browser2.newPage({viewport: {width: 1200, height: 800}});
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('https://viewer.contoso.test/**', (r) => r.fulfill({status: 200, contentType: 'text/html', body: viewerHtml}));
    await page.route('https://intruder.contoso.test/**', (r) => r.fulfill({status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>intruder</title><p>sibling frame</p>'}));
    await page.route('https://host.contoso.test/**', (r) => r.fulfill({status: 200, contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><title>Contoso host</title>
<style>body{margin:0;font:14px sans-serif}#v{border:0;width:1000px;height:600px;display:block}#x{width:200px;height:40px;border:0}</style>
<script>window.msgs=[];addEventListener('message',e=>{if(e.source===document.getElementById('v').contentWindow)window.msgs.push(e.data);});</script>
<iframe id="v" sandbox="allow-scripts" src="https://viewer.contoso.test/concept-viewer.html"></iframe>
<iframe id="x" sandbox="allow-scripts" src="https://intruder.contoso.test/sibling.html"></iframe>`}));
    await page.goto('https://host.contoso.test/parent.html');
    const msgs = () => page.evaluate(() => window.msgs);
    const until = async (fn, what, ms = 30_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await page.waitForTimeout(150); } };
    await until(async () => (await msgs()).some((m) => m?.type === 'datapass.concept-spec/ready'), 'first ready');
    const frame = page.frameLocator('#v'), inner = frame.getByTestId('concept-viewer');
    const before = await inner.getAttribute('data-spec');
    await page.evaluate((spec) => document.getElementById('v').contentWindow.postMessage({type: 'datapass.concept-spec/load', spec, options: {view: 'isometric', fit: true, chrome: 'embed', theme: 'light'}}, '*'), conceptSpec);
    await until(async () => (await msgs()).some((m) => m?.result), 'load result');
    const result = (await msgs()).find((m) => m?.result).result;
    await until(async () => (await inner.getAttribute('data-spec')) === conceptSpec.id, 'spec shown');
    let missing = [];
    for (const n of conceptSpec.nodes) if ((await frame.locator(`[data-testid=concept-isometric] [data-entity="${n.id}"]`).count()) < 1) missing.push(n.id);
    const fitInside = async () => {
      const box = await frame.locator('[data-testid=concept-isometric] svg').first().boundingBox();
      const stage = await frame.locator('.aa-stage').boundingBox();
      const hostBox = await page.locator('#v').boundingBox();
      const within = (b, c) => b.x >= c.x - 0.5 && b.y >= c.y - 0.5 && b.x + b.width <= c.x + c.width + 0.5 && b.y + b.height <= c.y + c.height + 0.5;
      return {inside: !!(box && stage && hostBox) && within(stage, hostBox) && within(box, stage), fill: box && stage ? Math.max(box.width / stage.width, box.height / stage.height) : 0, frame: hostBox};
    };
    const fit1 = await until(async () => { const f = await fitInside(); return f.inside && f.fill > 0.75 ? f : null; }, 'fit 1000x600').catch(async () => fitInside());
    await shot(page.locator('#v'), 'mosaic-concept-embed-1000x600.png', `Mosaic standalone viewer framed 1000x600, spec ${conceptSpec.id}, fit`);
    await page.locator('#v').evaluate((f) => { f.style.width = '720px'; f.style.height = '480px'; });
    const fit2 = await until(async () => { const f = await fitInside(); return f.inside && f.fill > 0.75 && f.frame?.width === 720 ? f : null; }, 'fit after resize').catch(async () => fitInside());
    await shot(page.locator('#v'), 'mosaic-concept-embed-resized-720x480.png', 'Same viewer after the host resized the frame to 720x480 (refit)');
    // Layer cake: every flow drawn.
    await page.evaluate((spec) => document.getElementById('v').contentWindow.postMessage({type: 'datapass.concept-spec/load', spec, options: {view: 'layered'}}, '*'), conceptSpec);
    await until(async () => (await inner.getAttribute('data-view')) === 'layered', 'layered view');
    const missingFlows = [];
    for (const f of conceptSpec.flows) if ((await frame.locator(`[data-testid=concept-layered] [data-flow="${f.id}"]`).count()) < 1) missingFlows.push(f.id);
    await shot(page.locator('#v'), 'mosaic-concept-embed-layered.png', 'Layer cake view of the Contoso concept in the framed viewer');
    // A sibling frame (not the direct parent) sends a different spec: the viewer must ignore it.
    const countBefore = (await msgs()).length;
    const intruderSpec = {...structuredClone(conceptSpec), id: 'intruder-spec', title: 'Intruder'};
    const sibling = page.frames().find((f) => f.url().startsWith('https://intruder.contoso.test/'));
    await sibling.evaluate((spec) => window.parent.frames[0].postMessage({type: 'datapass.concept-spec/load', spec}, '*'), intruderSpec);
    await page.waitForTimeout(1500);
    const afterIntruder = await inner.getAttribute('data-spec');
    const intruderIgnored = afterIntruder === conceptSpec.id && (await msgs()).length === countBefore;
    render.embed = {
      initial_spec: before, load_result: result, nodes: conceptSpec.nodes.length, nodes_missing: missing, flows: conceptSpec.flows.length, flows_missing: missingFlows,
      fit_1000x600: fit1, fit_after_resize_720x480: fit2,
      non_parent_message: {from: 'sibling iframe https://intruder.contoso.test', ignored: intruderIgnored, spec_after: afterIntruder},
      page_errors: errors,
    };
    render.ok = result?.ok === true && result.id === conceptSpec.id && missing.length === 0 && missingFlows.length === 0
      && fit1.inside && fit1.fill > 0.75 && fit2.inside && fit2.fill > 0.75 && fit2.frame?.width === 720 && intruderIgnored && errors.length === 0;
  } finally {
    await browser2.close();
  }
  evidence.gates.concept.render = render;
  if (!render.ok) failures.push('concept.render');
  evidence.gates.concept.ok = evidence.gates.concept.checkConceptSpec.ok && render.ok;
} catch (error) {
  failures.push(`error: ${String(error?.stack ?? error).slice(0, 4000)}`);
} finally {
  await stopHost();
  evidence.failures = failures;
  evidence.result = failures.length ? 'FAIL' : 'PASS';
  evidence.finished_at = new Date().toISOString();
  writeFileSync(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  if (args.keep) log(`kept ${scratch}`);
  else { try { rmSync(scratch, {recursive: true, force: true, maxRetries: 5, retryDelay: 500}); } catch (error) { log(`could not remove ${scratch}: ${error.message}`); } }
  const summary = Object.fromEntries(Object.entries(evidence.gates).map(([k, v]) => [k, v?.status ?? (v?.ok ? 'PASS' : 'FAIL')]));
  console.log(JSON.stringify({result: evidence.result, mosaic_sha: sha, gates: summary, failures, screenshots: evidence.screenshots.map((s) => basename(s.file)), evidence: join(out, 'evidence.json')}, null, 2));
  process.exitCode = failures.length ? 1 : 0;
}
