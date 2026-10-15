import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportTestFunctions, includedDirectories } from './export-test-functions.mjs';
import {
  expectedOpenRouterRoutes,
  relayBaseUrl,
  routeTestOpenRouterBundle,
  verifyRoutedTestOpenRouterBundle,
} from './route-test-openrouter.mjs';

const fixtureRoot = await mkdtemp(join(tmpdir(), 'volt220-relay-route-'));
after(async () => rm(fixtureRoot, { recursive: true, force: true }));

const originalChat = 'https://openrouter.ai/api/v1/chat/completions';
const originalEmbeddings = 'https://openrouter.ai/api/v1/embeddings';
const fixtureExpectedRoutes = { '_shared/v3-tools/llm.ts': [1, 1] };

async function fixture(name) {
  const root = join(fixtureRoot, name);
  const functionsRoot = join(root, 'source', 'functions');
  await mkdir(functionsRoot, { recursive: true, mode: 0o700 });
  for (const dir of includedDirectories) {
    await mkdir(join(functionsRoot, dir), { mode: 0o700 });
    if (dir !== '_shared') {
      await writeFile(join(functionsRoot, dir, 'index.ts'), `export const name = '${dir}';\n`);
    }
  }
  await mkdir(join(functionsRoot, '_shared', 'v3-tools'), { mode: 0o700 });
  const helper = join(functionsRoot, '_shared', 'v3-tools', 'llm.ts');
  await writeFile(helper, `export const chat = '${originalChat}';\nexport const embedding = '${originalEmbeddings}';\n`);
  const options = { functionsRoot, expectedRoutes: fixtureExpectedRoutes };
  const reviewed = join(root, 'reviewed');
  const routed = join(root, 'routed');
  await exportTestFunctions(reviewed, options);
  return { root, functionsRoot, helper, options, reviewed, routed };
}

test('real source inventory is pinned at all 17 routes in four selected functions and shared files', async () => {
  const root = join(fixtureRoot, 'real-reviewed');
  await mkdir(root, { mode: 0o700 });
  const reviewed = join(root, 'reviewed');
  const routed = join(root, 'routed');
  await exportTestFunctions(reviewed);
  const result = await routeTestOpenRouterBundle(reviewed, routed);
  assert.deepEqual(result.counts, { chatCompletions: 15, embeddings: 2 });
  assert.ok(result.fileCount > 50);
  assert.equal(Object.values(expectedOpenRouterRoutes).reduce((sum, counts) => sum + counts[0] + counts[1], 0), 17);
  assert.deepEqual((await verifyRoutedTestOpenRouterBundle(reviewed, routed)).counts, result.counts);
  const manifest = JSON.parse(await readFile(join(routed, 'manifest.json'), 'utf8'));
  assert.equal(manifest.relayBaseUrl, relayBaseUrl);
  assert.match(manifest.sourceBundleManifestSha256, /^[a-f0-9]{64}$/);
  assert.ok(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sourceSha256) && /^[a-f0-9]{64}$/.test(file.outputSha256)));
  assert.equal((await lstat(routed)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(routed, 'manifest.json'))).mode & 0o777, 0o600);
});

test('routes only exact calls, preserves payload/streaming code, and leaves source bundle unchanged', async () => {
  const f = await fixture('happy');
  const sourceBefore = await readFile(join(f.reviewed, 'functions', '_shared', 'v3-tools', 'llm.ts'), 'utf8');
  const reviewedManifestBefore = await readFile(join(f.reviewed, 'manifest.json'));
  const result = await routeTestOpenRouterBundle(f.reviewed, f.routed, f.options);
  assert.deepEqual(result.counts, { chatCompletions: 1, embeddings: 1 });
  const output = await readFile(join(f.routed, 'functions', '_shared', 'v3-tools', 'llm.ts'), 'utf8');
  assert.equal(output, sourceBefore
    .replaceAll(originalChat, `${relayBaseUrl}/chat/completions`)
    .replaceAll(originalEmbeddings, `${relayBaseUrl}/embeddings`));
  assert.equal(await readFile(join(f.reviewed, 'functions', '_shared', 'v3-tools', 'llm.ts'), 'utf8'), sourceBefore);
  assert.deepEqual(await readFile(join(f.reviewed, 'manifest.json')), reviewedManifestBefore);
  assert.deepEqual((await verifyRoutedTestOpenRouterBundle(f.reviewed, f.routed, f.options)).counts, result.counts);
  assert.equal((await lstat(join(f.routed, 'functions', '_shared', 'v3-tools', 'llm.ts'))).mode & 0o777, 0o600);
});

test('fails closed on changed route count or an unreviewed OpenRouter path', async () => {
  const missing = await fixture('missing');
  await writeFile(missing.helper, `export const chat = '${originalChat}';\n`);
  await rm(missing.reviewed, { recursive: true });
  await exportTestFunctions(missing.reviewed, missing.options);
  await assert.rejects(routeTestOpenRouterBundle(missing.reviewed, missing.routed, missing.options), /route inventory changed/);
  await assert.rejects(lstat(missing.routed), { code: 'ENOENT' });

  const unknown = await fixture('unknown');
  await writeFile(unknown.helper, `export const chat = '${originalChat}?unsafe=true';\nexport const embedding = '${originalEmbeddings}';\n`);
  await rm(unknown.reviewed, { recursive: true });
  await exportTestFunctions(unknown.reviewed, unknown.options);
  await assert.rejects(routeTestOpenRouterBundle(unknown.reviewed, unknown.routed, unknown.options), /Unreviewed OpenRouter endpoint/);
  await assert.rejects(lstat(unknown.routed), { code: 'ENOENT' });

  const disguised = await fixture('disguised');
  await writeFile(disguised.helper, `export const chat = 'https://www.openrouter.ai/api/v1/chat/completions';\nexport const embedding = '${originalEmbeddings}';\n`);
  await rm(disguised.reviewed, { recursive: true });
  await exportTestFunctions(disguised.reviewed, disguised.options);
  await assert.rejects(routeTestOpenRouterBundle(disguised.reviewed, disguised.routed, disguised.options), /Unreviewed OpenRouter endpoint/);
});

test('rejects stale input source and pre-existing output without overwriting it', async () => {
  const f = await fixture('stale');
  await writeFile(f.helper, `export const chat = '${originalChat}';\nexport const embedding = '${originalEmbeddings}';\nexport const changed = true;\n`);
  await assert.rejects(routeTestOpenRouterBundle(f.reviewed, f.routed, f.options), /manifest\/source mismatch/);
  await assert.rejects(lstat(f.routed), { code: 'ENOENT' });

  const protectedFixture = await fixture('protected');
  await mkdir(protectedFixture.routed, { mode: 0o700 });
  await writeFile(join(protectedFixture.routed, 'owner-data'), 'keep');
  await assert.rejects(routeTestOpenRouterBundle(protectedFixture.reviewed, protectedFixture.routed, protectedFixture.options), { code: 'EEXIST' });
  assert.equal(await readFile(join(protectedFixture.routed, 'owner-data'), 'utf8'), 'keep');
});

test('rejects output tampering, symlinks, unexpected directories and non-private modes', async () => {
  const tampered = await fixture('tampered');
  await routeTestOpenRouterBundle(tampered.reviewed, tampered.routed, tampered.options);
  const copy = join(tampered.routed, 'functions', '_shared', 'v3-tools', 'llm.ts');
  const good = await readFile(copy);
  await writeFile(copy, 'export const bad = true;\n');
  await assert.rejects(verifyRoutedTestOpenRouterBundle(tampered.reviewed, tampered.routed, tampered.options), /checksum mismatch/);
  await writeFile(copy, good);
  await symlink('llm.ts', join(tampered.routed, 'functions', '_shared', 'v3-tools', 'linked.ts'));
  await assert.rejects(verifyRoutedTestOpenRouterBundle(tampered.reviewed, tampered.routed, tampered.options), /linked/);
  await rm(join(tampered.routed, 'functions', '_shared', 'v3-tools', 'linked.ts'));
  await mkdir(join(tampered.routed, 'functions', '_shared', 'extra'), { mode: 0o700 });
  await assert.rejects(verifyRoutedTestOpenRouterBundle(tampered.reviewed, tampered.routed, tampered.options), /extra files\/directories/);
});

test('source changes during copy abort the route and remove only the new routed bundle', async () => {
  const f = await fixture('concurrent');
  await assert.rejects(routeTestOpenRouterBundle(f.reviewed, f.routed, {
    ...f.options,
    afterCopy: async () => writeFile(f.helper, `export const chat = '${originalChat}';\nexport const embedding = '${originalEmbeddings}';\nexport const changed = true;\n`),
  }), /manifest\/source mismatch/);
  await assert.rejects(lstat(f.routed), { code: 'ENOENT' });
  assert.deepEqual((await readdir(f.reviewed)).sort(), ['functions', 'manifest.json']);
});

test('does not route into the repository or nest output inside the reviewed bundle', async () => {
  const f = await fixture('location');
  const insideRepo = join(dirname(fileURLToPath(import.meta.url)), 'generated-routed-should-not-exist');
  await assert.rejects(routeTestOpenRouterBundle(f.reviewed, insideRepo, f.options), /outside the source repository/);
  await assert.rejects(routeTestOpenRouterBundle(f.reviewed, join(f.reviewed, 'nested'), f.options), /not replace or nest/);
});
