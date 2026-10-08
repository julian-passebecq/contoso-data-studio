#!/usr/bin/env node
// Validate Contoso export bundles with MosaicStudio's own TypeScript validators (read-only consumer check).
//
//   node tools/validate_with_mosaic.mjs --mosaic <datapass-mosaicstudio checkout> [--ref studio-v0.8.1] \
//        [--export <workspace>/exports/<id>] [--concept <concept.json>]
//
// The Mosaic sources are extracted with `git archive <ref>` into a temporary folder; the Mosaic checkout is
// never modified. Requires Node >= 22.18 (built-in TypeScript type stripping).
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) =>
  value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]]] : pairs, []));
if (!args.mosaic || (!args.export && !args.concept)) {
  console.error('usage: --mosaic <checkout> [--ref <tag>] --export <bundle dir> | --concept <file>');
  process.exit(2);
}
const ref = args.ref ?? 'studio-v0.8.1';
const sha = execFileSync('git', ['-C', args.mosaic, 'rev-parse', `${ref}^{commit}`], {encoding: 'utf8'}).trim();
const scratch = mkdtempSync(join(tmpdir(), 'contoso-mosaic-'));
const report = {mosaic_ref: ref, mosaic_sha: sha, checks: []};
try {
  const tar = join(scratch, 'src.tar');
  writeFileSync(tar, execFileSync('git', ['-C', args.mosaic, 'archive', '--format=tar', sha, 'src', 'spec'], {maxBuffer: 1 << 28}));
  execFileSync('tar', ['-xf', 'src.tar'], {cwd: scratch});
  writeFileSync(join(scratch, 'package.json'), '{"type":"module"}');
  if (args.export) {
    const {validateArtifact, artifactDefinition} = await import(pathToFileURL(join(scratch, 'src/framework/foundation/artifact.ts')).href);
    const folder = resolve(args.export);
    const receipt = JSON.parse(readFileSync(join(folder, 'contoso-export.json'), 'utf8'));
    const raw = readFileSync(join(folder, receipt.artifact.file));
    const digest = createHash('sha256').update(raw).digest('hex');
    if (digest !== receipt.artifact.sha256) throw new Error(`artifact sha256 mismatch: ${digest}`);
    const artifact = validateArtifact(JSON.parse(raw.toString('utf8')));
    const definition = artifactDefinition(JSON.parse(raw.toString('utf8')));
    const bulk = createHash('sha256').update(readFileSync(join(folder, receipt.bulk_data.file))).digest('hex');
    if (bulk !== receipt.bulk_data.sha256) throw new Error('bulk Parquet sha256 mismatch');
    const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
    if (manifest.artifacts?.[0]?.sha256 !== digest) throw new Error('manifest sha256 mismatch');
    report.checks.push({check: 'validateArtifact+artifactDefinition', file: receipt.artifact.file, sha256: digest,
      rows: artifact.payload.rows?.length, representations: artifact.representations.map(r => r.kind),
      blocks: Array.isArray(definition?.blocks) ? definition.blocks.length : undefined, ok: true});
  }
  if (args.concept) {
    // schema.ts needs zod: install the exact version Mosaic pins at this ref into the scratch folder only.
    const pkg = JSON.parse(execFileSync('git', ['-C', args.mosaic, 'show', `${sha}:package.json`], {encoding: 'utf8'}));
    const zod = pkg.dependencies?.zod ?? pkg.devDependencies?.zod;
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund', '--no-save', `zod@${zod}`],
      {cwd: scratch, stdio: 'ignore', shell: process.platform === 'win32'});
    const {checkConceptSpec, CONCEPT_SPEC_VERSION} = await import(pathToFileURL(join(scratch, 'src/framework/concept/schema.ts')).href);
    const raw = readFileSync(resolve(args.concept));
    const text = raw.toString('utf8');
    const result = checkConceptSpec(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
    report.checks.push({check: 'checkConceptSpec', specVersion: CONCEPT_SPEC_VERSION, zod, file: args.concept,
      sha256: createHash('sha256').update(raw).digest('hex'), ok: result.ok,
      counts: result.ok ? {layers: result.spec.layers.length, nodes: result.spec.nodes.length, flows: result.spec.flows.length} : undefined,
      issues: result.ok ? undefined : result.issues, warnings: result.warnings});
    if (!result.ok) throw new Error('concept spec rejected: ' + JSON.stringify(result.issues).slice(0, 2000));
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(scratch, {recursive: true, force: true});
}
