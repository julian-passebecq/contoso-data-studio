/**
 * Compile the Rayfin model offline into the artefacts the local lab consumes.
 *
 * Uses only @microsoft/rayfin-core (no CLI, no login, no cloud):
 *  - SchemaAnalyzer + ConfigGenerator  -> rayfin/generated/dab-config.json (what Rayfin feeds Data API Builder)
 *  - getEntityMetadata + serializeCheckToAst -> rayfin/generated/model.json (our adapter's input:
 *    tables, columns, foreign keys, and each role declaration with its policy as an AST)
 *
 * `--check` fails when the committed files are stale (used by CI).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claims,
  createItemProxy,
  getEntityMetadata,
  serializeCheckToAst,
  type EntityClass,
} from '@microsoft/rayfin-core';
import { ConfigGenerator, SchemaAnalyzer } from '@microsoft/rayfin-core/analysis';
import { schema } from '../rayfin/data/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
// dist/scripts -> package root
const root = join(here, '..', '..');
const outDir = join(root, 'rayfin', 'generated');
const check = process.argv.includes('--check');

const entities = Object.values(schema) as unknown as EntityClass[];
const analyzer = new SchemaAnalyzer(entities, 'mssql', { log: () => undefined });
const analysis = analyzer.analyzeEntities();
const dab = new ConfigGenerator('mssql').generateConfig(analysis);

const model = {
  generated_by: '@microsoft/rayfin-core 1.36.2 (offline analyzer)',
  dialect: 'mssql',
  entities: analysis.map((entity) => {
    const metadata = getEntityMetadata(schema[entity.name as keyof typeof schema] as unknown as EntityClass);
    return {
      name: entity.name,
      table: entity.tableName,
      plural: entity.tableName,
      // Column order and SQL types come from the DAB x-schema Rayfin generates;
      // validation hints (min/max/regex/format) come from the decorator metadata.
      columns: Object.entries(dab.entities[entity.name]['x-schema']?.fields ?? {}).map(([column, info]) => {
        const field = entity.fields.find(
          (candidate) => (candidate.generatedForeignKeyColumn ?? candidate.columnName ?? candidate.name) === column,
        );
        const meta = field?.originalFieldMetadata;
        const format = meta?.format ?? (field?.isRelationship ? 'uuid' : null);
        return {
          name: column,
          db_type: info.dbType,
          nullable: info.nullable,
          primary_key: field?.primaryKey ?? false,
          unique: field?.unique ?? false,
          references: field?.foreignKey
            ? { entity: field.foreignKey.referencedEntity, field: field.foreignKey.referencedField }
            : null,
          format,
          min: meta?.min ?? null,
          max: meta?.max ?? null,
          // Email format is validated by the adapter itself; only explicit text regexes are exported.
          regex: format === 'text' && meta?.regex ? meta.regex.source : null,
        };
      }),
      roles: (metadata.roles ?? []).map((declaration) => ({
        role: declaration.role,
        actions: declaration.actions,
        policy: declaration.policy
          ? serializeCheckToAst(declaration.policy.check(claims, createItemProxy()))
          : null,
        policy_text: declaration.policy
          ? declaration.policy.check(claims, createItemProxy()).toString()
          : null,
      })),
    };
  }),
};

const outputs: Record<string, string> = {
  'dab-config.json': JSON.stringify(dab, null, 2) + '\n',
  'model.json': JSON.stringify(model, null, 2) + '\n',
};

mkdirSync(outDir, { recursive: true });
let stale = false;
for (const [name, content] of Object.entries(outputs)) {
  const path = join(outDir, name);
  if (check) {
    let current = '';
    try {
      current = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    } catch {
      current = '';
    }
    if (current !== content) {
      console.error(`stale: rayfin/generated/${name} (run npm run export-model)`);
      stale = true;
    }
  } else {
    writeFileSync(path, content);
    console.log(`wrote rayfin/generated/${name}`);
  }
}
if (stale) process.exit(1);
