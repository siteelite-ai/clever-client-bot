import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditIsolatedHardeningSources,
  auditMigrationSources,
  exportTestMigrations,
  isolatedHardeningMigrationNames,
  omittedMigrationNames,
  reviewedMigrationCount,
  verifyTestBundle,
} from './export-test-migrations.mjs';

const fixtureRoot = await mkdtemp(join(tmpdir(), 'volt220-test-migrations-'));
after(async () => rm(fixtureRoot, { recursive: true, force: true }));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fixture(name) {
  const root = join(fixtureRoot, name);
  const sourceDir = join(root, 'source');
  await mkdir(sourceDir, { recursive: true, mode: 0o700 });
  const keepName = '20260101000000_create_schema.sql';
  const omitName = '20260101000001_prod_data.sql';
  const keepSql = Buffer.from('CREATE TABLE isolated_example (id bigint);\n');
  const prodSql = Buffer.from("UPDATE app_settings SET value = 'PROD_SENTINEL';\n");
  await writeFile(join(sourceDir, keepName), keepSql);
  await writeFile(join(sourceDir, omitName), prodSql);
  return {
    root,
    sourceDir,
    keepName,
    omitName,
    keepSql,
    prodSql,
    options: {
      sourceDir,
      expectedManifest: new Map([[keepName, sha256(keepSql)], [omitName, sha256(prodSql)]]),
      omittedNames: new Set([omitName]),
      allowFixtureManifest: true,
    },
  };
}

test('reviewed 48-file history is followed by two isolated hardening migrations', async () => {
  const sources = await auditMigrationSources();
  const hardening = await auditIsolatedHardeningSources();
  assert.equal(reviewedMigrationCount, 48);
  assert.equal(sources.size, 48);
  assert.equal(omittedMigrationNames.length, 3);
  for (const name of omittedMigrationNames) assert.ok(sources.has(name));
  assert.equal(hardening.size, 2);
  assert.deepEqual([...hardening.keys()], isolatedHardeningMigrationNames);
  assert.ok(isolatedHardeningMigrationNames[0] > [...sources.keys()].sort().at(-1));
  assert.ok(isolatedHardeningMigrationNames[1] > isolatedHardeningMigrationNames[0]);
  const roleLookup = hardening.get(isolatedHardeningMigrationNames[0]).toString('utf8');
  assert.match(roleLookup, /_user_id = \(SELECT auth\.uid\(\)\)/);
  assert.match(roleLookup, /auth\.role\(\)\) = 'service_role'/);
  assert.match(roleLookup, /FROM public\.user_roles/);
  assert.match(roleLookup, /FROM PUBLIC, anon;/);
  assert.match(roleLookup, /TO authenticated, service_role;/);
  const tableGrants = hardening.get(isolatedHardeningMigrationNames[1]).toString('utf8');
  assert.match(tableGrants, /REVOKE ALL PRIVILEGES ON TABLE[\s\S]*FROM anon;/);
  assert.match(tableGrants, /REVOKE TRUNCATE ON TABLE[\s\S]*FROM authenticated;/);
  for (const table of [
    'ai_usage_logs', 'app_settings', 'chat_cache_v2', 'chat_request_logs',
    'chat_v3_admission_buckets', 'chat_v3_admission_decisions',
    'classifier_cache', 'classifier_eval_runs', 'classifier_evals',
    'knowledge_chunks', 'knowledge_entries', 'profiles', 'user_roles',
  ]) {
    assert.equal((tableGrants.match(new RegExp(`public\\.${table}\\b`, 'g')) || []).length, 2, table);
  }
  assert.doesNotMatch(tableGrants, /FROM service_role|FROM PUBLIC|REVOKE (SELECT|INSERT|UPDATE|DELETE) ON TABLE/);
});

test('real 50-file export verifies against pinned hashes and detects later tampering', async () => {
  const root = join(fixtureRoot, 'real-reviewed');
  await mkdir(root, { mode: 0o700 });
  const output = join(root, 'bundle');
  const result = await exportTestMigrations(output);
  assert.equal(result.sourceCount, 48);
  assert.equal(result.migrationCount, 50);
  assert.equal(result.hardeningCount, 2);
  assert.equal((await verifyTestBundle(output)).migrationCount, 50);
  const manifest = JSON.parse(await readFile(join(result.bundleDir, 'migration-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.files.slice(-2).map((item) => item.name), isolatedHardeningMigrationNames);
  assert.equal(manifest.files.at(-2).isolatedHardening, true);
  assert.equal(manifest.files.at(-1).isolatedHardening, true);
  for (const name of isolatedHardeningMigrationNames) {
    const hardening = join(result.bundleDir, 'migrations', name);
    await writeFile(hardening, 'SELECT true;');
    await assert.rejects(verifyTestBundle(output), /hardening SQL checksum mismatch/);
    await writeFile(hardening, (await auditIsolatedHardeningSources()).get(name));
  }
  const tampered = join(result.bundleDir, 'migrations', omittedMigrationNames[0]);
  await writeFile(tampered, 'SELECT 2;');
  await assert.rejects(verifyTestBundle(output), /SQL checksum mismatch/);
});

test('exports byte-identical schema and a no-op historical data file to private ready bundle', async () => {
  const f = await fixture('happy');
  const output = join(f.root, 'bundle');
  const result = await exportTestMigrations(output, f.options);
  assert.equal(result.bundleDir, join(output, 'supabase'));
  assert.equal(result.sourceCount, 2);
  assert.equal(result.migrationCount, 4);
  assert.equal(result.omittedCount, 1);
  assert.equal(result.hardeningCount, 2);
  assert.deepEqual(await readFile(join(result.bundleDir, 'migrations', f.keepName)), f.keepSql);
  const omitted = await readFile(join(result.bundleDir, 'migrations', f.omitName), 'utf8');
  assert.match(omitted, /^SELECT 1;/);
  assert.doesNotMatch(omitted, /PROD_SENTINEL/);
  const config = await readFile(join(result.bundleDir, 'config.toml'), 'utf8');
  assert.match(config, /volt220-server3-isolated-test/);
  assert.doesNotMatch(config, /yngoixmvmxdfxokuafjp/);
  const manifest = JSON.parse(await readFile(join(result.bundleDir, 'migration-manifest.json'), 'utf8'));
  assert.equal(manifest.sourceCount, 2);
  assert.equal(manifest.migrationCount, 4);
  assert.equal(manifest.omittedCount, 1);
  assert.equal(manifest.hardeningCount, 2);
  assert.equal(manifest.files.find((item) => item.name === f.omitName).omittedDataOnly, true);
  assert.equal(manifest.files.at(-2).isolatedHardening, true);
  assert.equal(manifest.files.at(-1).isolatedHardening, true);
  assert.equal((await stat(output)).mode & 0o777, 0o700);
  assert.equal((await stat(result.bundleDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(result.bundleDir, 'migrations', f.keepName))).mode & 0o777, 0o600);
  assert.equal((await stat(join(result.bundleDir, 'config.toml'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(result.bundleDir, 'migration-manifest.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(output), ['supabase']);
});

test('rejects changed source checksum before creating output', async () => {
  const f = await fixture('checksum');
  await writeFile(join(f.sourceDir, f.keepName), 'changed');
  const output = join(f.root, 'bundle');
  await assert.rejects(exportTestMigrations(output, f.options), /checksum mismatch/);
  await assert.rejects(lstat(output), { code: 'ENOENT' });
});

test('rejects extra migration before creating output', async () => {
  const f = await fixture('extra');
  await writeFile(join(f.sourceDir, '20260101000002_extra.sql'), 'SELECT 1;');
  const output = join(f.root, 'bundle');
  await assert.rejects(exportTestMigrations(output, f.options), /filename\/count mismatch/);
  await assert.rejects(lstat(output), { code: 'ENOENT' });
});

test('rejects a symlink migration even when its contents match', async () => {
  const f = await fixture('symlink');
  const linkName = '20260101000002_symlink.sql';
  await symlink(f.keepName, join(f.sourceDir, linkName));
  f.options.expectedManifest.set(linkName, sha256(f.keepSql));
  await assert.rejects(auditMigrationSources(f.options), /regular file/);
});

test('never overwrites an existing output directory', async () => {
  const f = await fixture('no-overwrite');
  const output = join(f.root, 'bundle');
  await mkdir(output);
  await writeFile(join(output, 'owner-data'), 'keep');
  await assert.rejects(exportTestMigrations(output, f.options), { code: 'EEXIST' });
  assert.equal(await readFile(join(output, 'owner-data'), 'utf8'), 'keep');
});

test('refuses an output inside the source repository', async () => {
  const pathInsideRepo = join(dirname(fileURLToPath(import.meta.url)), 'generated-migrations-should-not-exist');
  await assert.rejects(exportTestMigrations(pathInsideRepo), /outside the source repository/);
});
