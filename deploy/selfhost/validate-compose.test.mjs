import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPECTED_SETTINGS, parseEnv, validatePrivateEnv, validateRenderedConfig,
} from './validate-compose.mjs';
import { generateSecrets, renderPrivateEnv } from './init-private-env.mjs';

const TEST_PRIVATE_JWT_KEYS = JSON.stringify([{
  kty: 'EC', kid: 'test', crv: 'P-256', x: 'x', y: 'y', d: 'd',
}]);
const TEST_PUBLIC_JWKS = JSON.stringify({ keys: [{
  kty: 'EC', kid: 'test', crv: 'P-256', x: 'x', y: 'y',
}] });

test('documented non-secret settings exactly match initializer policy', () => {
  const documented = parseEnv(readFileSync(join(dirname(fileURLToPath(import.meta.url)),
    'settings.example'), 'utf8'));
  assert.deepEqual(Object.fromEntries(documented), EXPECTED_SETTINGS);
});

const names = {
  studio: 'volt220test-studio',
  'api-gw': 'volt220test-api-gw',
  auth: 'volt220test-auth',
  rest: 'volt220test-rest',
  realtime: 'realtime-dev.volt220test-realtime',
  storage: 'volt220test-storage',
  imgproxy: 'volt220test-imgproxy',
  meta: 'volt220test-meta',
  functions: 'volt220test-functions',
  db: 'volt220test-db',
  supavisor: 'volt220test-supavisor',
};

function validConfig() {
  const services = Object.fromEntries(Object.entries(names).map(([key, container_name]) => [key, {
    container_name,
    image: 'example/image:v1.2.3',
    networks: { default: null },
    mem_limit: 256 * 1024 ** 2,
    cpus: 0.5,
    pids_limit: 128,
    logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
  }]));
  services['api-gw'].ports = [{ host_ip: '127.0.0.1', published: '18081', target: 8000, protocol: 'tcp' }];
  services['api-gw'].command = ['--concurrency', '2'];
  services['api-gw'].environment = {
    SUPABASE_PUBLISHABLE_KEY: 'test-publishable',
    SUPABASE_SECRET_KEY: 'test-secret',
    ANON_KEY_ASYMMETRIC: 'test-anon-asymmetric',
    SERVICE_ROLE_KEY_ASYMMETRIC: 'test-service-asymmetric',
  };
  services.auth.environment = {
    API_EXTERNAL_URL: 'https://api-volt-next.testdevops.ru/auth/v1',
    GOTRUE_SITE_URL: 'https://chat-volt-next.testdevops.ru',
    GOTRUE_DISABLE_SIGNUP: 'true',
    GOTRUE_JWT_KEYS: TEST_PRIVATE_JWT_KEYS,
  };
  services.studio.environment = { SUPABASE_PUBLIC_URL: 'https://api-volt-next.testdevops.ru' };
  services.realtime.environment = { API_JWT_JWKS: TEST_PUBLIC_JWKS };
  services.rest.environment = { PGRST_JWT_SECRET: TEST_PUBLIC_JWKS, GHCRTS: '-N2' };
  services.storage.environment = { JWT_JWKS: TEST_PUBLIC_JWKS };
  services.functions.environment = {
    SUPABASE_PUBLIC_URL: 'https://api-volt-next.testdevops.ru',
    VERIFY_JWT: 'false',
    SUPABASE_JWKS: TEST_PUBLIC_JWKS,
    SELFHOST_TEST_MODE: 'true',
    KNOWLEDGE_REMOTE_IMPORT_ENABLED: 'false',
    CHAT_V3_ADMISSION_MODE: 'enforce',
    CHAT_V3_ADMISSION_LIMIT_PER_MINUTE: '3',
    CHAT_V3_ADMISSION_LIMIT_IN_FLIGHT: '2',
    LOVABLE_AGENT_FAILOVER_ENABLED: 'false',
    LOVABLE_AGENT_FAILOVER_PREVIEW_ENABLED: 'false',
  };
  return {
    name: 'volt220test', services,
    networks: { default: { name: 'volt220test_internal' } },
    volumes: {
      'db-config': { name: 'volt220test_db-config' },
      'deno-cache': { name: 'volt220test_deno-cache' },
    },
  };
}

test('accepts only a private, capped, loopback-only test stack', () => {
  assert.equal(validateRenderedConfig(validConfig()).serviceCount, 11);
});

for (const [name, mutate, expected] of [
  ['public API binding', (c) => { c.services['api-gw'].ports[0].host_ip = '0.0.0.0'; }, /127\.0\.0\.1/],
  ['upstream public gateway retained', (c) => { c.services['api-gw'].ports.push({ host_ip: '0.0.0.0', published: '8000', target: 8000, protocol: 'tcp' }); }, /127\.0\.0\.1/],
  ['Postgres/pooler port', (c) => { c.services.supavisor.ports = [{ host_ip: '127.0.0.1', published: '5432', target: 5432 }]; }, /must not publish/],
  ['stock container name', (c) => { c.services.db.container_name = 'supabase-db'; }, /non-test/],
  ['external network', (c) => { c.networks.default.external = true; }, /dedicated test network/],
  ['missing memory cap', (c) => { delete c.services.functions.mem_limit; }, /memory limit/],
  ['unbounded Envoy workers', (c) => { delete c.services['api-gw'].command; }, /two workers/],
  ['unbounded PostgREST workers', (c) => { delete c.services.rest.environment.GHCRTS; }, /GHC worker/],
  ['production Auth URL', (c) => { c.services.auth.environment.API_EXTERNAL_URL = 'https://yngoixmvmxdfxokuafjp.supabase.co/auth/v1'; }, /test-only/],
  ['public signup', (c) => { c.services.auth.environment.GOTRUE_DISABLE_SIGNUP = 'false'; }, /signup/],
  ['missing asymmetric gateway key', (c) => { c.services['api-gw'].environment.ANON_KEY_ASYMMETRIC = ''; }, /ANON_KEY_ASYMMETRIC/],
  ['global function JWT drift', (c) => { c.services.functions.environment.VERIFY_JWT = 'true'; }, /JWT setting/],
  ['missing Auth JWT_KEYS', (c) => { delete c.services.auth.environment.GOTRUE_JWT_KEYS; }, /JWT\/JWKS/],
  ['JWKS mismatch', (c) => { c.services.storage.environment.JWT_JWKS = '{"keys":[]}'; }, /differs/],
  ['remote knowledge import enabled', (c) => { c.services.functions.environment.KNOWLEDGE_REMOTE_IMPORT_ENABLED = 'true'; }, /safety flags/],
  ['chat admission off', (c) => { c.services.functions.environment.CHAT_V3_ADMISSION_MODE = 'off'; }, /ADMISSION_MODE/],
  ['Lovable failover on', (c) => { c.services.functions.environment.LOVABLE_AGENT_FAILOVER_ENABLED = 'true'; }, /LOVABLE_AGENT_FAILOVER_ENABLED/],
  ['Lovable key present', (c) => { c.services.functions.environment.LOVABLE_API_KEY = 'forbidden'; }, /LOVABLE_API_KEY/],
  ['OpenRouter fallback key present', (c) => { c.services.functions.environment.OPENROUTER_API_KEY = 'forbidden'; }, /OPENROUTER_API_KEY/],
  ['catalog fallback token present', (c) => { c.services.functions.environment.VOLT220_API_TOKEN = 'forbidden'; }, /VOLT220_API_TOKEN/],
]) {
  test(`rejects ${name}`, () => {
    const config = validConfig();
    mutate(config);
    assert.throws(() => validateRenderedConfig(config), expected);
  });
}

test('rejects a production URL and unchanged example secrets', () => {
  const example = new Map([
    ['POSTGRES_PASSWORD', 'sample-default'],
    ['JWT_SECRET', 'sample-default'],
  ]);
  const actual = new Map([
    ['SUPABASE_PUBLIC_URL', 'https://api-volt-next.testdevops.ru'],
    ['API_EXTERNAL_URL', 'https://api-volt-next.testdevops.ru/auth/v1'],
    ['SITE_URL', 'https://chat-volt-next.testdevops.ru'],
    ['ADDITIONAL_REDIRECT_URLS', 'https://chat-volt-next.testdevops.ru'],
    ['PROXY_DOMAIN', 'api-volt-next.testdevops.ru'],
    ['DISABLE_SIGNUP', 'true'],
    ['ENABLE_EMAIL_SIGNUP', 'true'],
    ['ENABLE_PHONE_SIGNUP', 'false'],
    ['ENABLE_ANONYMOUS_USERS', 'false'],
    ['FUNCTIONS_VERIFY_JWT', 'false'],
    ['SELFHOST_TEST_MODE', 'true'],
    ['KNOWLEDGE_REMOTE_IMPORT_ENABLED', 'false'],
    ['CHAT_V3_ADMISSION_MODE', 'enforce'],
    ['CHAT_V3_ADMISSION_LIMIT_PER_MINUTE', '3'],
    ['CHAT_V3_ADMISSION_LIMIT_IN_FLIGHT', '2'],
    ['LOVABLE_AGENT_FAILOVER_ENABLED', 'false'],
    ['LOVABLE_AGENT_FAILOVER_PREVIEW_ENABLED', 'false'],
    ['API_GW_HTTP_PORT', '18081'],
    ['KONG_HTTP_PORT', '18081'],
    ['POOLER_TENANT_ID', 'volt220test'],
    ['OPENAI_API_KEY', ''],
    ['POSTGRES_PASSWORD', 'sample-default'],
  ]);
  assert.throws(() => validatePrivateEnv(actual, example), /POSTGRES_PASSWORD/);
  actual.set('SUPABASE_PUBLIC_URL', 'https://yngoixmvmxdfxokuafjp.supabase.co');
  assert.throws(() => validatePrivateEnv(actual, example), /SUPABASE_PUBLIC_URL/);
});

test('private env requires separate generated asymmetric gateway keys', () => {
  const generated = generateSecrets();
  const settings = new Map([...Object.entries(EXPECTED_SETTINGS), ...generated]);
  const upstream = new Map([...generated.keys()].map((key) => [key, 'upstream-placeholder']));
  assert.doesNotThrow(() => validatePrivateEnv(settings, upstream));
  settings.set('ANON_KEY_ASYMMETRIC', '');
  assert.throws(() => validatePrivateEnv(settings, upstream), /ANON_KEY_ASYMMETRIC/);
  settings.set('ANON_KEY_ASYMMETRIC', generated.get('ANON_KEY_ASYMMETRIC'));
  settings.set('LOVABLE_API_KEY', 'forbidden');
  assert.throws(() => validatePrivateEnv(settings, upstream), /LOVABLE_API_KEY/);
  settings.delete('LOVABLE_API_KEY');
  settings.set('OPENROUTER_API_KEY', 'forbidden');
  assert.throws(() => validatePrivateEnv(settings, upstream), /OPENROUTER_API_KEY/);
  settings.delete('OPENROUTER_API_KEY');
  settings.set('VOLT220_API_TOKEN', 'forbidden');
  assert.throws(() => validatePrivateEnv(settings, upstream), /VOLT220_API_TOKEN/);
});

test('generated legacy and asymmetric JWTs verify with matching roles', () => {
  const generated = generateSecrets(1_800_000_000);
  const privateKeys = JSON.parse(generated.get('JWT_KEYS'));
  const publicJwks = JSON.parse(generated.get('JWT_JWKS'));
  const ecPublic = publicJwks.keys.find((key) => key.kty === 'EC');
  const ecPrivate = privateKeys.find((key) => key.kty === 'EC');
  assert.equal(ecPublic.kid, ecPrivate.kid);
  assert.equal(ecPublic.d, undefined);
  const publicKey = createPublicKey({ key: ecPublic, format: 'jwk' });
  for (const [role, key] of [
    ['anon', 'ANON_KEY_ASYMMETRIC'],
    ['service_role', 'SERVICE_ROLE_KEY_ASYMMETRIC'],
  ]) {
    const [header, body, signature] = generated.get(key).split('.');
    assert.equal(JSON.parse(Buffer.from(body, 'base64url')).role, role);
    assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'ES256');
    assert.equal(verify('SHA256', Buffer.from(`${header}.${body}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
  }
});

test('rendered private env contains all generated values without changing upstream input', () => {
  // A compact fixture exercises the no-overwrite/replacement behavior without
  // ever writing a credential or reading a production env file.
  const fixture = 'POSTGRES_PASSWORD=old\nJWT_SECRET=old\nSITE_URL=http://localhost\n';
  const beforeHash = createHash('sha256').update(fixture).digest('hex');
  const rendered = renderPrivateEnv(fixture,
    new Map([['POSTGRES_PASSWORD', 'new-private-value'], ['JWT_SECRET', 'new-private-value']]),
    { SITE_URL: 'https://chat-volt-next.testdevops.ru' });
  assert.equal(rendered, 'POSTGRES_PASSWORD=new-private-value\nJWT_SECRET=new-private-value\nSITE_URL=https://chat-volt-next.testdevops.ru\n');
  assert.equal(createHash('sha256').update(fixture).digest('hex'), beforeHash);
  assert.throws(() => renderPrivateEnv(fixture,
    new Map([['MISSING', 'value']]), {}), /Missing upstream/);
});

const upstreamRoot = process.env.OFFICIAL_SUPABASE_ROOT;
const composeBinary = process.env.COMPOSE_BIN;
test('full official .env.example can be rendered privately without upstream edits',
  { skip: !upstreamRoot }, () => {
    const composePath = join(upstreamRoot, 'docker/docker-compose.yml');
    const exampleText = readFileSync(join(upstreamRoot, 'docker/.env.example'), 'utf8');
    const before = createHash('sha256').update(readFileSync(composePath)).digest('hex');
    const rendered = renderPrivateEnv(exampleText, generateSecrets());
    assert.doesNotThrow(() => validatePrivateEnv(parseEnv(rendered), parseEnv(exampleText)));
    assert.equal(createHash('sha256').update(readFileSync(composePath)).digest('hex'), before);
  });
test('official pinned Compose plus overlay renders without a leaked public port',
  { skip: !upstreamRoot || !composeBinary }, () => {
    const overlay = join(dirname(fileURLToPath(import.meta.url)), 'docker-compose.test.yml');
    const base = join(upstreamRoot, 'docker/docker-compose.yml');
    const example = join(upstreamRoot, 'docker/.env.example');
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...EXPECTED_SETTINGS,
      ...Object.fromEntries(generateSecrets()),
    };
    const rendered = spawnSync(composeBinary, [
      '--project-name', 'volt220test', '--env-file', example,
      '-f', base, '-f', overlay, 'config', '--format', 'json',
    ], { env, encoding: 'utf8', maxBuffer: 16 * 1024 ** 2 });
    assert.equal(rendered.status, 0, 'Official Compose render failed (diagnostics intentionally suppressed)');
    // Never attach rendered stdout to test diagnostics: it includes sample keys.
    validateRenderedConfig(JSON.parse(rendered.stdout));
  });
