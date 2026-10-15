#!/usr/bin/env node
// Read-only preflight. Never prints docker compose config (it contains secrets).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = 'volt220test';
export const UPSTREAM_COMMIT = '564eab8ad7840b13324f68b1bfac074ef8d51c21';
export const UPSTREAM_COMPOSE_SHA256 = '8ba18fd43e9afba90e8287c8e8afc4bdda1e38d2228e57ff660968bb550da054';
const EXPECTED_SERVICES = [
  'studio', 'api-gw', 'auth', 'rest', 'realtime', 'storage',
  'imgproxy', 'meta', 'functions', 'db', 'supavisor',
];
const EXPECTED_NAMES = Object.fromEntries(EXPECTED_SERVICES.map((service) => [
  service,
  service === 'realtime' ? 'realtime-dev.volt220test-realtime' : `volt220test-${service}`,
]));
export const EXPECTED_SETTINGS = {
  SUPABASE_PUBLIC_URL: 'https://api-volt-next.testdevops.ru',
  API_EXTERNAL_URL: 'https://api-volt-next.testdevops.ru/auth/v1',
  SITE_URL: 'https://chat-volt-next.testdevops.ru',
  ADDITIONAL_REDIRECT_URLS: 'https://chat-volt-next.testdevops.ru',
  PROXY_DOMAIN: 'api-volt-next.testdevops.ru',
  DISABLE_SIGNUP: 'true',
  ENABLE_EMAIL_SIGNUP: 'true',
  ENABLE_PHONE_SIGNUP: 'false',
  ENABLE_ANONYMOUS_USERS: 'false',
  FUNCTIONS_VERIFY_JWT: 'false',
  SELFHOST_TEST_MODE: 'true',
  KNOWLEDGE_REMOTE_IMPORT_ENABLED: 'false',
  CHAT_V3_ADMISSION_MODE: 'enforce',
  CHAT_V3_ADMISSION_LIMIT_PER_MINUTE: '3',
  CHAT_V3_ADMISSION_LIMIT_IN_FLIGHT: '2',
  LOVABLE_AGENT_FAILOVER_ENABLED: 'false',
  LOVABLE_AGENT_FAILOVER_PREVIEW_ENABLED: 'false',
  API_GW_HTTP_PORT: '18081',
  KONG_HTTP_PORT: '18081',
  POOLER_TENANT_ID: 'volt220test',
  OPENAI_API_KEY: '',
};
const SECRET_NAMES = [
  'POSTGRES_PASSWORD', 'JWT_SECRET', 'ANON_KEY', 'SERVICE_ROLE_KEY',
  'DASHBOARD_PASSWORD', 'SECRET_KEY_BASE', 'REALTIME_DB_ENC_KEY',
  'VAULT_ENC_KEY', 'PG_META_CRYPTO_KEY', 'S3_PROTOCOL_ACCESS_KEY_SECRET',
  'S3_PROTOCOL_ACCESS_KEY_ID', 'MINIO_ROOT_PASSWORD',
  'LOGFLARE_PUBLIC_ACCESS_TOKEN', 'LOGFLARE_PRIVATE_ACCESS_TOKEN',
  'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'JWT_KEYS', 'JWT_JWKS',
  'ANON_KEY_ASYMMETRIC', 'SERVICE_ROLE_KEY_ASYMMETRIC',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function parseEnv(content) {
  const settings = new Map();
  for (const [lineNumber, line] of content.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)=(.*)$/);
    assert(match, `Invalid .env assignment on line ${lineNumber + 1}`);
    const [, key, rawValue] = match;
    assert(!settings.has(key), `Duplicate .env key: ${key}`);
    const value = rawValue.length >= 2 &&
      ((rawValue.startsWith('"') && rawValue.endsWith('"')) ||
       (rawValue.startsWith("'") && rawValue.endsWith("'")))
      ? rawValue.slice(1, -1) : rawValue;
    settings.set(key, value);
  }
  return settings;
}

export function validatePrivateEnv(actual, upstreamExample) {
  for (const key of ['LOVABLE_API_KEY', 'OPENROUTER_API_KEY', 'VOLT220_API_TOKEN',
    'CATALOG_API_TOKEN']) {
    assert(!actual.has(key), `${key} must not be present in the test .env`);
  }
  for (const [key, expected] of Object.entries(EXPECTED_SETTINGS)) {
    assert(actual.get(key) === expected, `${key} must be the isolated test value`);
  }
  for (const key of SECRET_NAMES) {
    const value = actual.get(key);
    assert(typeof value === 'string' && value.length > 0, `${key} must be configured privately`);
    assert(value !== upstreamExample.get(key), `${key} must not use the upstream example value`);
  }
  assert((actual.get('POSTGRES_PASSWORD') ?? '').length >= 24, 'POSTGRES_PASSWORD is too short');
  assert((actual.get('JWT_SECRET') ?? '').length >= 32, 'JWT_SECRET is too short');
  assert(actual.get('ANON_KEY') !== actual.get('SERVICE_ROLE_KEY'), 'Legacy API keys must differ');
  assert(actual.get('SUPABASE_PUBLISHABLE_KEY') !== actual.get('SUPABASE_SECRET_KEY'), 'Opaque API keys must differ');
  assert(actual.get('ANON_KEY_ASYMMETRIC') !== actual.get('SERVICE_ROLE_KEY_ASYMMETRIC'),
    'Asymmetric API keys must differ');
  let privateKeys;
  let publicJwks;
  try {
    privateKeys = JSON.parse(actual.get('JWT_KEYS'));
    publicJwks = JSON.parse(actual.get('JWT_JWKS'));
  } catch {
    throw new Error('JWT_KEYS/JWT_JWKS must be valid JSON');
  }
  assert(Array.isArray(privateKeys) && privateKeys.some((key) =>
    key.kty === 'EC' && key.crv === 'P-256' && key.d && key.kid),
  'JWT_KEYS lacks a private EC signing key');
  assert(Array.isArray(publicJwks?.keys) && publicJwks.keys.some((key) =>
    key.kty === 'EC' && key.crv === 'P-256' && !key.d && key.kid),
  'JWT_JWKS lacks a public EC verification key');
  const privateEc = privateKeys.find((key) => key.kty === 'EC' && key.d);
  assert(publicJwks.keys.some((key) => key.kty === 'EC' && key.kid === privateEc.kid &&
    key.x === privateEc.x && key.y === privateEc.y),
  'JWT_KEYS/JWT_JWKS signing pair does not match');
}

function bytes(value) {
  if (typeof value === 'number') return value;
  const match = String(value ?? '').match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)(?:i?b)?$/i);
  if (!match) return NaN;
  return Number(match[1]) * (1024 ** { '': 0, k: 1, m: 2, g: 3, t: 4 }[match[2].toLowerCase()]);
}

export function validateRenderedConfig(config) {
  assert(config?.name === PROJECT, 'Compose project name is not isolated');
  const services = config.services ?? {};
  assert(
    JSON.stringify(Object.keys(services).sort()) === JSON.stringify([...EXPECTED_SERVICES].sort()),
    'Unexpected/missing service in rendered Compose',
  );

  const network = config.networks?.default;
  assert(Object.keys(config.networks ?? {}).length === 1, 'Only one private project network is allowed');
  assert(network?.name === 'volt220test_internal' && network?.external !== true,
    'Default network is not the dedicated test network');

  const volumes = config.volumes ?? {};
  assert(JSON.stringify(Object.keys(volumes).sort()) === JSON.stringify(['db-config', 'deno-cache']),
    'Unexpected named volume in rendered Compose');
  for (const [key, volume] of Object.entries(volumes)) {
    assert(volume.name === `${PROJECT}_${key}` && volume.external !== true,
      `Named volume ${key} is not project-scoped`);
  }

  let totalMemory = 0;
  const seenNames = new Set();
  for (const [serviceName, service] of Object.entries(services)) {
    assert(service.container_name === EXPECTED_NAMES[serviceName],
      `${serviceName} has a non-test or colliding container name`);
    assert(!seenNames.has(service.container_name), 'Duplicate container name');
    seenNames.add(service.container_name);
    assert(!service.privileged && service.network_mode !== 'host' && service.pid !== 'host',
      `${serviceName} requests privileged/host isolation bypass`);
    const attachedNetworks = Array.isArray(service.networks)
      ? service.networks : Object.keys(service.networks ?? {});
    assert(attachedNetworks.length === 1 && attachedNetworks[0] === 'default',
      `${serviceName} joins a non-test network`);
    assert(typeof service.image === 'string' && /:[^/:]+$/.test(service.image) &&
      !service.image.endsWith(':latest'), `${serviceName} image is not pinned`);
    const memory = bytes(service.mem_limit);
    assert(Number.isFinite(memory) && memory >= 128 * 1024 ** 2 && memory <= 2 * 1024 ** 3,
      `${serviceName} has an unsafe memory limit`);
    totalMemory += memory;
    assert(Number(service.cpus) > 0 && Number(service.cpus) <= 2,
      `${serviceName} has no CPU cap`);
    assert(Number.isInteger(Number(service.pids_limit)) && Number(service.pids_limit) >= 64 &&
      Number(service.pids_limit) <= 512, `${serviceName} has no PID cap`);
    assert(service.logging?.driver === 'json-file' &&
      service.logging?.options?.['max-size'] === '10m' &&
      String(service.logging?.options?.['max-file']) === '3',
    `${serviceName} logs are not bounded`);

    const ports = service.ports ?? [];
    if (serviceName === 'api-gw') {
      assert(ports.length === 1 && String(ports[0].target) === '8000' &&
        String(ports[0].published) === '18081' &&
        ports[0].host_ip === '127.0.0.1' && ports[0].protocol === 'tcp',
      'API gateway must bind only 127.0.0.1:18081 -> 8000/tcp');
    } else {
      assert(ports.length === 0, `${serviceName} must not publish host ports`);
    }
  }
  assert(totalMemory <= 8 * 1024 ** 3, 'Combined container memory caps exceed 8 GiB');

  assert(JSON.stringify(services['api-gw'].command) === JSON.stringify(['--concurrency', '2']),
    'Envoy must use exactly two workers within its PID cap');
  assert(services.rest.environment?.GHCRTS === '-N2',
    'PostgREST must use exactly two GHC worker capabilities within its PID cap');

  assert(services.auth.environment?.API_EXTERNAL_URL === EXPECTED_SETTINGS.API_EXTERNAL_URL,
    'Auth callback URL is not test-only');
  assert(services.auth.environment?.GOTRUE_SITE_URL === EXPECTED_SETTINGS.SITE_URL,
    'Auth site URL is not test-only');
  assert(String(services.auth.environment?.GOTRUE_DISABLE_SIGNUP) === 'true',
    'Public signup must be disabled');
  assert(services.studio.environment?.SUPABASE_PUBLIC_URL === EXPECTED_SETTINGS.SUPABASE_PUBLIC_URL,
    'Studio API URL is not test-only');
  assert(services.functions.environment?.SUPABASE_PUBLIC_URL === EXPECTED_SETTINGS.SUPABASE_PUBLIC_URL,
    'Edge Function public API URL is not test-only');
  assert(String(services.functions.environment?.VERIFY_JWT) === 'false',
    'Function JWT setting differs from the reviewed public-chat model');
  assert(String(services.functions.environment?.SELFHOST_TEST_MODE) === 'true' &&
    String(services.functions.environment?.KNOWLEDGE_REMOTE_IMPORT_ENABLED) === 'false',
  'Edge Function test-only/remote-import safety flags are missing');
  for (const [key, expected] of Object.entries({
    CHAT_V3_ADMISSION_MODE: 'enforce',
    CHAT_V3_ADMISSION_LIMIT_PER_MINUTE: '3',
    CHAT_V3_ADMISSION_LIMIT_IN_FLIGHT: '2',
    LOVABLE_AGENT_FAILOVER_ENABLED: 'false',
    LOVABLE_AGENT_FAILOVER_PREVIEW_ENABLED: 'false',
  })) {
    assert(String(services.functions.environment?.[key]) === expected,
      `Edge Function ${key} is not test-safe`);
  }
  for (const key of ['LOVABLE_API_KEY', 'OPENROUTER_API_KEY', 'VOLT220_API_TOKEN',
    'CATALOG_API_TOKEN']) {
    assert(!Object.prototype.hasOwnProperty.call(services.functions.environment ?? {}, key),
      `${key} must never be passed to the self-hosted test functions`);
  }
  let privateKeys;
  let publicJwks;
  try {
    privateKeys = JSON.parse(services.auth.environment?.GOTRUE_JWT_KEYS);
    publicJwks = JSON.parse(services.realtime.environment?.API_JWT_JWKS);
  } catch {
    throw new Error('Rendered asymmetric JWT/JWKS values are invalid');
  }
  assert(Array.isArray(privateKeys) && privateKeys.length > 0 &&
    Array.isArray(publicJwks?.keys) && publicJwks.keys.length > 0,
  'Rendered asymmetric JWT/JWKS values are empty');
  const jwksString = JSON.stringify(publicJwks);
  for (const [service, key] of [
    ['storage', 'JWT_JWKS'],
    ['functions', 'SUPABASE_JWKS'],
  ]) {
    let rendered;
    try { rendered = JSON.stringify(JSON.parse(services[service].environment?.[key])); }
    catch { throw new Error(`${service} ${key} is invalid JSON`); }
    assert(rendered === jwksString, `${service} ${key} differs from Realtime JWKS`);
  }
  let restJwks;
  try { restJwks = JSON.stringify(JSON.parse(services.rest.environment?.PGRST_JWT_SECRET)); }
  catch { throw new Error('PostgREST JWKS is invalid JSON'); }
  assert(restJwks === jwksString, 'PostgREST JWKS differs from Realtime JWKS');
  for (const key of ['SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY',
    'ANON_KEY_ASYMMETRIC', 'SERVICE_ROLE_KEY_ASYMMETRIC']) {
    assert(typeof services['api-gw'].environment?.[key] === 'string' &&
      services['api-gw'].environment[key].length > 0,
    `Gateway ${key} must be populated privately`);
  }
  return { serviceCount: EXPECTED_SERVICES.length, totalMemoryBytes: totalMemory };
}

function run(command, args, env) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 ** 2, env });
  assert(!result.error && result.status === 0, `${command} failed (exit ${result.status ?? 'unknown'})`);
  return result.stdout.trim();
}

function checkRuntimeCollisions(config, env) {
  // Docker commands below only inspect daemon metadata; they never create state.
  run('docker', ['info', '--format', '{{.ServerVersion}}'], env);
  const projectContainers = run('docker', ['ps', '-a', '--filter',
    `label=com.docker.compose.project=${PROJECT}`, '--format', '{{.Names}}'], env);
  for (const existingName of projectContainers.split('\n').filter(Boolean)) {
    assert(Object.values(EXPECTED_NAMES).includes(existingName),
      `Project ${PROJECT} already owns unrelated container ${existingName}`);
  }
  for (const service of Object.values(config.services)) {
    const result = spawnSync('docker', ['container', 'inspect', '--format',
      '{{ index .Config.Labels "com.docker.compose.project" }}', service.container_name],
    { encoding: 'utf8', env });
    if (result.status === 0) {
      assert(result.stdout.trim() === PROJECT,
        `Container name ${service.container_name} belongs to another project`);
    }
  }
  const network = config.networks.default.name;
  const networkResult = spawnSync('docker', ['network', 'inspect', '--format',
    '{{ index .Labels "com.docker.compose.project" }}', network],
  { encoding: 'utf8', env });
  if (networkResult.status === 0) {
    assert(networkResult.stdout.trim() === PROJECT,
      `Network ${network} belongs to another project`);
  }
  for (const volume of Object.values(config.volumes)) {
    const result = spawnSync('docker', ['volume', 'inspect', '--format',
      '{{ index .Labels "com.docker.compose.project" }}', volume.name],
    { encoding: 'utf8', env });
    if (result.status === 0) {
      assert(result.stdout.trim() === PROJECT,
        `Volume ${volume.name} belongs to another project`);
    }
  }
  const gatewayPort = spawnSync('docker', ['port', EXPECTED_NAMES['api-gw'], '8000/tcp'],
    { encoding: 'utf8', env });
  const listeners = run('ss', ['-H', '-ltn', '( sport = :18081 )'], env);
  assert(!listeners || (gatewayPort.status === 0 &&
    gatewayPort.stdout.trim() === '127.0.0.1:18081'),
  'Host port 18081 is already occupied by another service');
}

function cli() {
  const args = process.argv.slice(2);
  const valueAfter = (flag) => {
    const position = args.indexOf(flag);
    return position === -1 ? null : args[position + 1];
  };
  const upstreamRoot = valueAfter('--upstream');
  const envPathArg = valueAfter('--env');
  assert(upstreamRoot && envPathArg,
    'Usage: node validate-compose.mjs --upstream /private/path/supabase --env /private/path/supabase/docker/.env [--offline] [--compose-bin /path]');
  const root = resolve(upstreamRoot);
  const envPath = resolve(envPathArg);
  const baseCompose = join(root, 'docker/docker-compose.yml');
  const examplePath = join(root, 'docker/.env.example');
  const overlay = join(HERE, 'docker-compose.test.yml');
  const commit = run('git', ['-C', root, 'rev-parse', 'HEAD'], process.env);
  assert(commit === UPSTREAM_COMMIT, 'Official Supabase checkout is not the pinned release');
  const sha = createHash('sha256').update(readFileSync(baseCompose)).digest('hex');
  assert(sha === UPSTREAM_COMPOSE_SHA256, 'Official docker-compose.yml differs from pinned release');
  const envStat = statSync(envPath);
  assert(envStat.isFile() && (envStat.mode & 0o077) === 0,
    'Private .env must be a regular file readable only by its owner (chmod 600)');
  const privateEnv = parseEnv(readFileSync(envPath, 'utf8'));
  validatePrivateEnv(privateEnv, parseEnv(readFileSync(examplePath, 'utf8')));

  // Inherited shell variables must not override the private test .env.
  const allowedEnv = ['PATH', 'HOME', 'USER', 'DOCKER_HOST', 'DOCKER_CONTEXT',
    'DOCKER_CONFIG', 'SSH_AUTH_SOCK', 'XDG_RUNTIME_DIR', 'TMPDIR', 'LANG', 'LC_ALL'];
  const cleanEnv = Object.fromEntries(allowedEnv
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]));
  const customBinary = valueAfter('--compose-bin');
  const executable = customBinary ? resolve(customBinary) : 'docker';
  const prefix = customBinary ? [] : ['compose'];
  const version = run(executable, [...prefix, 'version', '--short'], cleanEnv);
  const versionMatch = version.match(/v?(\d+)\.(\d+)\.(\d+)/);
  assert(versionMatch, 'Cannot determine Docker Compose version');
  const [, major, minor, patch] = versionMatch.map(Number);
  assert(major > 2 || (major === 2 && (minor > 24 || (minor === 24 && patch >= 4))),
    'Docker Compose >= 2.24.4 is required for safe !override semantics');
  const configJson = run(executable, [...prefix, '--project-name', PROJECT,
    '--env-file', envPath, '-f', baseCompose, '-f', overlay,
    'config', '--format', 'json'], cleanEnv);
  // Deliberately never print configJson: it contains the test instance secrets.
  const config = JSON.parse(configJson);
  const result = validateRenderedConfig(config);
  for (const [service, setting, secret] of [
    ['auth', 'GOTRUE_JWT_KEYS', 'JWT_KEYS'],
    ['realtime', 'API_JWT_JWKS', 'JWT_JWKS'],
    ['storage', 'JWT_JWKS', 'JWT_JWKS'],
    ['rest', 'PGRST_JWT_SECRET', 'JWT_JWKS'],
    ['functions', 'SUPABASE_JWKS', 'JWT_JWKS'],
  ]) {
    assert(config.services[service].environment[setting] === privateEnv.get(secret),
      `${service} rendered ${setting} does not match private test .env`);
  }
  if (!args.includes('--offline')) checkRuntimeCollisions(config, cleanEnv);
  process.stdout.write(`PASS: pinned Supabase ${UPSTREAM_COMMIT.slice(0, 12)}, ${result.serviceCount} isolated services, gateway 127.0.0.1:18081, no other host ports; runtime collisions ${args.includes('--offline') ? 'not checked' : 'checked'}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { cli(); } catch (error) {
    // Error messages above contain key names and paths only; never values.
    process.stderr.write(`FAIL: ${error.message}\n`);
    process.exitCode = 1;
  }
}
