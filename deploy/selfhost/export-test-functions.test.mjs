import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditTestFunctionSources,
  exportTestFunctions,
  includedDirectories,
  verifyTestFunctionBundle,
} from './export-test-functions.mjs';

const fixtureRoot = await mkdtemp(join(tmpdir(), 'volt220-test-functions-'));
after(async () => rm(fixtureRoot, { recursive: true, force: true }));

async function fixture(name) {
  const root = join(fixtureRoot, name);
  const functionsRoot = join(root, 'source', 'functions');
  await mkdir(functionsRoot, { recursive: true, mode: 0o700 });
  for (const dir of [...includedDirectories, 'main', 'chat-consultant-v3-preview']) {
    await mkdir(join(functionsRoot, dir), { mode: 0o700 });
    await writeFile(join(functionsRoot, dir, 'index.ts'), `export const name = '${dir}';\n`);
  }
  await mkdir(join(functionsRoot, '_shared', 'v3-tools'), { mode: 0o700 });
  await writeFile(join(functionsRoot, '_shared', 'v3-tools', 'helper.ts'), 'export const value = 1;\n');
  await writeFile(join(functionsRoot, '_shared', 'v3-tools', 'helper_test.ts'), 'throw Error("not bundled");\n');
  await writeFile(join(functionsRoot, 'chat-consultant-v3', 'selection_test.ts'), 'throw Error("not bundled");\n');
  return { root, functionsRoot, options: { functionsRoot } };
}

test('real repository audit selects only three entrypoints and non-test shared TypeScript', async () => {
  const sources = await auditTestFunctionSources();
  assert.ok(sources.size > 50);
  for (const dir of includedDirectories.filter((name) => name !== '_shared')) {
    assert.ok(sources.has(`${dir}/index.ts`));
  }
  assert.ok([...sources.keys()].every((path) => path.endsWith('.ts') && !path.endsWith('_test.ts')));
  assert.ok([...sources.keys()].every((path) => includedDirectories.some((dir) => path.startsWith(`${dir}/`))));
  assert.ok(!sources.has('main/index.ts'));
  assert.ok(!sources.has('chat-consultant-v3-preview/index.ts'));
});

test('real repository can be staged and verified without unrelated functions', async () => {
  const root = join(fixtureRoot, 'real-reviewed');
  await mkdir(root, { mode: 0o700 });
  const output = join(root, 'bundle');
  const result = await exportTestFunctions(output);
  assert.ok(result.fileCount > 50);
  assert.equal((await verifyTestFunctionBundle(output)).fileCount, result.fileCount);
  assert.deepEqual((await readdir(join(output, 'functions'))).sort(), [...includedDirectories].sort());
});

test('exports exact allowlisted source files and verifies private bundle hashes', async () => {
  const f = await fixture('happy');
  const output = join(f.root, 'bundle');
  const result = await exportTestFunctions(output, f.options);
  assert.equal(result.fileCount, 5);
  assert.deepEqual((await readdir(output)).sort(), ['functions', 'manifest.json']);
  assert.deepEqual((await readdir(join(output, 'functions'))).sort(), [...includedDirectories].sort());
  assert.deepEqual((await readdir(join(output, 'functions', '_shared', 'v3-tools'))), ['helper.ts']);
  assert.deepEqual((await readdir(join(output, 'functions', 'chat-consultant-v3'))), ['index.ts']);
  assert.equal((await verifyTestFunctionBundle(output, f.options)).fileCount, 5);
  assert.equal((await stat(output)).mode & 0o777, 0o700);
  assert.equal((await stat(join(output, 'functions', '_shared', 'v3-tools'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(output, 'functions', 'admin-users', 'index.ts'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(output, 'manifest.json'))).mode & 0o777, 0o600);
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.directories, includedDirectories);
  assert.equal(manifest.files.length, 5);
  assert.ok(manifest.files.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
});

test('a concurrent source edit invalidates export and removes only its new private bundle', async () => {
  const f = await fixture('concurrent-edit');
  const output = join(f.root, 'bundle');
  await assert.rejects(exportTestFunctions(output, {
    ...f.options,
    afterCopy: async () => writeFile(join(f.functionsRoot, 'admin-users', 'index.ts'), 'export const changed = true;\n'),
  }), /source changed during copy/);
  await assert.rejects(lstat(output), { code: 'ENOENT' });
});

test('rejects a production project literal and credential literal before writing output', async () => {
  const f = await fixture('secrets');
  const output = join(f.root, 'bundle');
  await writeFile(join(f.functionsRoot, '_shared', 'literal.ts'), 'export const url = "https://yngoixmvmxdfxokuafjp.supabase.co";\n');
  await assert.rejects(exportTestFunctions(output, f.options), /Credential or production project literal/);
  await assert.rejects(lstat(output), { code: 'ENOENT' });
  await writeFile(join(f.functionsRoot, '_shared', 'literal.ts'), 'export const key = "sk-or-v1-0123456789abcdefghijkl";\n');
  await assert.rejects(exportTestFunctions(output, f.options), /Credential or production project literal/);
  await assert.rejects(lstat(output), { code: 'ENOENT' });
});

test('rejects linked or unexpected source files in selected directories', async () => {
  const f = await fixture('source-symlink');
  await symlink('index.ts', join(f.functionsRoot, 'admin-users', 'linked.ts'));
  await assert.rejects(auditTestFunctionSources(f.options), /Linked function source/);
  await rm(join(f.functionsRoot, 'admin-users', 'linked.ts'));
  await writeFile(join(f.functionsRoot, 'admin-users', '.env'), 'NOT_A_REAL_KEY=example\n');
  await assert.rejects(auditTestFunctionSources(f.options), /Unexpected non-TypeScript/);
});

test('never overwrites an existing output or writes inside the repository', async () => {
  const f = await fixture('no-overwrite');
  const output = join(f.root, 'bundle');
  await mkdir(output);
  await writeFile(join(output, 'owner-data'), 'keep');
  await assert.rejects(exportTestFunctions(output, f.options), { code: 'EEXIST' });
  assert.equal(await readFile(join(output, 'owner-data'), 'utf8'), 'keep');
  const insideRepo = join(dirname(fileURLToPath(import.meta.url)), 'generated-functions-should-not-exist');
  await assert.rejects(exportTestFunctions(insideRepo, f.options), /outside the source repository/);
});

test('verification detects copied file tampering, source drift, and extra functions', async () => {
  const f = await fixture('tamper');
  const output = join(f.root, 'bundle');
  await exportTestFunctions(output, f.options);
  const copied = join(output, 'functions', 'admin-users', 'index.ts');
  await writeFile(copied, 'export const tampered = true;\n');
  await assert.rejects(verifyTestFunctionBundle(output, f.options), /checksum mismatch/);
  await writeFile(copied, await readFile(join(f.functionsRoot, 'admin-users', 'index.ts')));
  await writeFile(join(f.functionsRoot, 'admin-users', 'index.ts'), 'export const updated = true;\n');
  await assert.rejects(verifyTestFunctionBundle(output, f.options), /manifest\/source mismatch/);
  await writeFile(join(f.functionsRoot, 'admin-users', 'index.ts'), 'export const name = \'admin-users\';\n');
  await mkdir(join(output, 'functions', 'other'));
  await assert.rejects(verifyTestFunctionBundle(output, f.options), /unexpected function directories/);
});
