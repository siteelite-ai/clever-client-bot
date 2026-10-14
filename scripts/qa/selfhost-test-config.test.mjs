import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { productionPublicKey, validateSelfhostTestConfig } from '../selfhost-test-config.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const otherRef = 'testprojectrefabcd12';
const valid = {
  url: `https://${otherRef}.supabase.co`,
  publicKey: `sb_publishable_${'x'.repeat(32)}`,
  backendKind: 'managed',
  originalPublicKey: productionPublicKey(),
};

test('ordinary Vite configuration still matches the original production widget', () => {
  const env = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
  const widget = readFileSync(new URL('../../public/widget.js', import.meta.url), 'utf8');
  const url = env.match(/^VITE_SUPABASE_URL=["']?([^"'\r\n]+)["']?$/m)?.[1];
  assert.ok(url);
  assert.ok(widget.includes(`directOrigin: '${url}'`));
  assert.ok(widget.includes(`supabaseKey: '${productionPublicKey()}'`));
});
const jwt = (claims) => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.${'a'.repeat(43)}`;
};

test('a distinct managed project with a public key is accepted', () => {
  assert.equal(validateSelfhostTestConfig(valid).url, valid.url);
  assert.equal(validateSelfhostTestConfig({ ...valid, publicKey: jwt({ role: 'anon', ref: otherRef }) }).backendKind, 'managed');
});

test('a separate custom HTTPS backend can be selected explicitly', () => {
  assert.equal(validateSelfhostTestConfig({
    ...valid,
    backendKind: 'selfhost',
    url: 'https://api-volt-next.testdevops.ru',
    publicKey: jwt({ role: 'anon' }),
  }).backendKind, 'selfhost');
});

test('missing, production, local, and unrelated backend origins are refused', () => {
  for (const url of [
    undefined,
    'http://api-volt-next.testdevops.ru',
    'https://yngoixmvmxdfxokuafjp.supabase.co',
    'https://supabase-proxy.bold-dawn-058f.workers.dev',
    'https://220volt.testdevops.ru',
    'https://localhost',
    'https://127.0.0.1',
    'https://[::1]',
    'https://example.lovable.app',
  ]) {
    assert.throws(() => validateSelfhostTestConfig({ ...valid, url }));
  }
  assert.throws(() => validateSelfhostTestConfig({ ...valid, backendKind: 'selfhost' }));
  assert.throws(() => validateSelfhostTestConfig({
    ...valid,
    backendKind: 'selfhost',
    url: 'https://api-chat-volt-next.testdevops.ru',
  }));
  assert.throws(() => validateSelfhostTestConfig({ ...valid, backendKind: 'unknown' }));
});

test('only a separate anon/public key is accepted', () => {
  for (const publicKey of [
    '',
    'sb_publishable_weak',
    'sb_secret_' + 's'.repeat(32),
    valid.originalPublicKey,
    jwt({ role: 'service_role', ref: otherRef }),
    jwt({ role: 'anon', ref: 'wrongtestprojectref' }),
    jwt({ role: 'anon', ref: 'yngoixmvmxdfxokuafjp' }),
  ]) {
    assert.throws(() => validateSelfhostTestConfig({ ...valid, publicKey }));
  }
});

test('a failed validation or build removes a stale deployable artifact', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'volt-selfhost-failclosed-'));
  const output = path.join(fixture, 'dist-selfhost-test');
  const pending = path.join(fixture, 'dist-selfhost-test.pending');
  try {
    await mkdir(path.join(fixture, 'scripts'));
    await copyFile(new URL('../build-selfhost-test.mjs', import.meta.url), path.join(fixture, 'scripts/build-selfhost-test.mjs'));
    await copyFile(new URL('../selfhost-test-config.mjs', import.meta.url), path.join(fixture, 'scripts/selfhost-test-config.mjs'));
    await writeFile(path.join(fixture, 'package.json'), '{"type":"module"}\n');
    await writeFile(path.join(fixture, '.env'), `VITE_SUPABASE_PUBLISHABLE_KEY="sb_publishable_${'p'.repeat(32)}"\n`);

    await mkdir(output);
    await writeFile(path.join(output, 'index.html'), 'stale deployable artifact');
    const invalid = spawnSync(process.execPath, ['scripts/build-selfhost-test.mjs'], {
      cwd: fixture,
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /SELFHOST_TEST_BACKEND_KIND/);
    await assert.rejects(access(output), { code: 'ENOENT' });
    await assert.rejects(access(pending), { code: 'ENOENT' });

    await mkdir(output);
    await writeFile(path.join(output, 'index.html'), 'another stale artifact');
    const viteBin = path.join(fixture, 'node_modules/vite/bin');
    await mkdir(viteBin, { recursive: true });
    await writeFile(path.join(viteBin, 'vite.js'),
      "import fs from 'node:fs'; fs.mkdirSync(process.argv.at(-1)); " +
      "fs.writeFileSync(process.argv.at(-1) + '/partial.js', 'partial'); process.exit(1);\n");
    const failedBuild = spawnSync(process.execPath, ['scripts/build-selfhost-test.mjs'], {
      cwd: fixture,
      env: {
        PATH: process.env.PATH,
        SELFHOST_TEST_BACKEND_KIND: valid.backendKind,
        SELFHOST_TEST_SUPABASE_URL: valid.url,
        SELFHOST_TEST_SUPABASE_PUBLIC_KEY: valid.publicKey,
      },
      encoding: 'utf8',
    });
    assert.notEqual(failedBuild.status, 0);
    assert.match(failedBuild.stderr, /self-hosted Vite build failed/);
    await assert.rejects(access(output), { code: 'ENOENT' });
    await assert.rejects(access(pending), { code: 'ENOENT' });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('plain Vite cannot emit an unpatched selfhost widget', () => {
  const child = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      VITE_DEPLOY_TARGET: 'selfhost-test',
      VITE_SELFHOST_TEST_BACKEND_KIND: 'selfhost',
      VITE_SELFHOST_TEST_SUPABASE_URL: 'https://api-volt-next.testdevops.ru',
      VITE_SELFHOST_TEST_SUPABASE_PUBLIC_KEY: valid.publicKey,
    },
    encoding: 'utf8',
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /Use build:selfhost-test/);
});
