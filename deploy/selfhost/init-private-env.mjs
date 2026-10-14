#!/usr/bin/env node
// One-time, test-only private .env creation. No secrets are printed or passed
// through child-process arguments. This is a faithful in-process port of the
// *pinned* official key-generation scripts; their hashes are verified below.
import { spawnSync } from 'node:child_process';
import {
  createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign,
} from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, linkSync, lstatSync, openSync,
  readFileSync, realpathSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPECTED_SETTINGS, UPSTREAM_COMMIT, UPSTREAM_COMPOSE_SHA256,
  parseEnv, validatePrivateEnv,
} from './validate-compose.mjs';

const EXPECTED_ROOT = '/var/lib/volt220-test-supabase/upstream';
const VENDOR_SCRIPT_SHA256 = {
  'generate-keys.sh': '6299efc24ce94d771ca4abb8ac96b67624cc4ac9a4b13ee0c2a8f0071aa3d619',
  'add-new-auth-keys.sh': 'afeddcb0c4e2f6a4ee5775a357d90ae7e804a6ff3e5160725468ce7ac0daad0f',
};

function safeAssert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function jwtSegment(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function legacyJwt(role, jwtSecret, iat, exp) {
  const body = `${jwtSegment({ alg: 'HS256', typ: 'JWT' })}.${jwtSegment({ role, iss: 'supabase', iat, exp })}`;
  const mac = createHmac('sha256', jwtSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function asymmetricJwt(role, key, kid, iat, exp) {
  const body = `${jwtSegment({ alg: 'ES256', typ: 'JWT', kid })}.${jwtSegment({ role, iss: 'supabase', iat, exp })}`;
  const signature = sign('SHA256', Buffer.from(body), {
    key, dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${body}.${signature}`;
}

function opaqueKey(prefix) {
  const random = randomBytes(17).toString('base64url').slice(0, 22);
  const intermediate = `${prefix}${random}`;
  const checksum = createHash('sha256')
    .update(`supabase-self-hosted|${intermediate}`)
    .digest('base64url').slice(0, 8);
  return `${intermediate}_${checksum}`;
}

export function generateSecrets(nowSeconds = Math.floor(Date.now() / 1000)) {
  const iat = nowSeconds;
  const exp = iat + 5 * 365 * 24 * 3600;
  const jwtSecret = randomBytes(30).toString('base64');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const kid = randomUUID();
  const octKey = {
    kty: 'oct', k: Buffer.from(jwtSecret).toString('base64url'), alg: 'HS256',
  };
  const privateEc = {
    kty: 'EC', kid, use: 'sig', key_ops: ['sign', 'verify'], alg: 'ES256',
    ext: true, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d,
  };
  const publicEc = {
    kty: 'EC', kid, use: 'sig', key_ops: ['verify'], alg: 'ES256',
    ext: true, crv: jwk.crv, x: jwk.x, y: jwk.y,
  };
  return new Map(Object.entries({
    POSTGRES_PASSWORD: randomBytes(16).toString('hex'),
    JWT_SECRET: jwtSecret,
    ANON_KEY: legacyJwt('anon', jwtSecret, iat, exp),
    SERVICE_ROLE_KEY: legacyJwt('service_role', jwtSecret, iat, exp),
    SECRET_KEY_BASE: randomBytes(48).toString('base64'),
    REALTIME_DB_ENC_KEY: randomBytes(8).toString('hex'),
    VAULT_ENC_KEY: randomBytes(16).toString('hex'),
    PG_META_CRYPTO_KEY: randomBytes(24).toString('base64'),
    LOGFLARE_PUBLIC_ACCESS_TOKEN: randomBytes(24).toString('base64'),
    LOGFLARE_PRIVATE_ACCESS_TOKEN: randomBytes(24).toString('base64'),
    S3_PROTOCOL_ACCESS_KEY_ID: randomBytes(16).toString('hex'),
    S3_PROTOCOL_ACCESS_KEY_SECRET: randomBytes(32).toString('hex'),
    MINIO_ROOT_PASSWORD: randomBytes(16).toString('hex'),
    DASHBOARD_PASSWORD: randomBytes(16).toString('hex'),
    SUPABASE_PUBLISHABLE_KEY: opaqueKey('sb_publishable_'),
    SUPABASE_SECRET_KEY: opaqueKey('sb_secret_'),
    ANON_KEY_ASYMMETRIC: asymmetricJwt('anon', privateKey, kid, iat, exp),
    SERVICE_ROLE_KEY_ASYMMETRIC: asymmetricJwt('service_role', privateKey, kid, iat, exp),
    JWT_KEYS: JSON.stringify([privateEc, octKey]),
    JWT_JWKS: JSON.stringify({ keys: [publicEc, octKey] }),
  }));
}

export function renderPrivateEnv(exampleText, generated, settings = EXPECTED_SETTINGS) {
  const updates = new Map([...Object.entries(settings), ...generated]);
  for (const [key, value] of updates) {
    safeAssert(/^[A-Z][A-Z0-9_]*$/.test(key) && typeof value === 'string' &&
      !/[\r\n\0]/.test(value), `Unsafe private .env field: ${key}`);
  }
  const seen = new Set();
  let rendered = exampleText.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (!match || !updates.has(match[1])) return line;
    const key = match[1];
    safeAssert(!seen.has(key), `Duplicate upstream .env field: ${key}`);
    seen.add(key);
    return `${key}=${updates.get(key)}`;
  }).join('\n');
  const appSettings = [];
  for (const key of updates.keys()) {
    if (seen.has(key)) continue;
    // Application-specific test switches do not exist in the vendor example;
    // append only explicit non-secret settings, never a missing secret field.
    safeAssert(Object.prototype.hasOwnProperty.call(settings, key),
      `Missing upstream .env field: ${key}`);
    appSettings.push(`${key}=${updates.get(key)}`);
  }
  if (appSettings.length > 0) {
    rendered = `${rendered.trimEnd()}\n\n# 220volt isolated test settings\n${appSettings.join('\n')}\n`;
  }
  return rendered;
}

function verifyPinnedSource(root) {
  const compose = join(root, 'docker/docker-compose.yml');
  const tracked = [compose, ...Object.keys(VENDOR_SCRIPT_SHA256).map((name) =>
    join(root, 'docker/utils', name))];
  for (const path of tracked) {
    const stat = lstatSync(path);
    safeAssert(stat.isFile() && !stat.isSymbolicLink(), 'Pinned source contains a non-regular file');
  }
  const git = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  safeAssert(git.status === 0 && git.stdout.trim() === UPSTREAM_COMMIT,
    'Supabase checkout is not the pinned release');
  safeAssert(sha256(compose) === UPSTREAM_COMPOSE_SHA256,
    'Pinned docker-compose.yml was changed');
  for (const [name, expected] of Object.entries(VENDOR_SCRIPT_SHA256)) {
    safeAssert(sha256(join(root, 'docker/utils', name)) === expected,
      `Pinned official key script changed: ${name}`);
  }
}

function createPrivateEnv(root) {
  safeAssert(process.getuid?.() === 0, 'Run the one-time initializer as root');
  safeAssert(resolve(root) === EXPECTED_ROOT && realpathSync(root) === EXPECTED_ROOT,
    'Initializer is restricted to the dedicated test path');
  const dockerDir = join(root, 'docker');
  safeAssert(lstatSync(dockerDir).uid === 0, 'Test stack directory must be root-owned');
  const envPath = join(dockerDir, '.env');
  safeAssert(!existsSync(envPath) && !existsSync(`${envPath}.old`),
    'Private .env or .env.old already exists; refusing to overwrite');
  verifyPinnedSource(root);
  const examplePath = join(dockerDir, '.env.example');
  const exampleStat = lstatSync(examplePath);
  safeAssert(exampleStat.isFile() && !exampleStat.isSymbolicLink(),
    'Pinned .env.example is not a regular file');
  const exampleText = readFileSync(examplePath, 'utf8');
  const generated = generateSecrets();
  const rendered = renderPrivateEnv(exampleText, generated);
  const privateEnv = parseEnv(rendered);
  safeAssert(!privateEnv.has('LOVABLE_API_KEY'), 'Lovable key must not be present');
  validatePrivateEnv(privateEnv, parseEnv(exampleText));
  verifyPinnedSource(root);

  // Create a private file on the same filesystem, then link it into place
  // atomically without replacing an existing .env. No .old files are made.
  const pending = join(dockerDir, `.env.pending.${process.pid}.${randomBytes(8).toString('hex')}`);
  let descriptor;
  try {
    process.umask(0o077);
    descriptor = openSync(pending, 'wx', 0o600);
    writeFileSync(descriptor, rendered, { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(pending, envPath);
    unlinkSync(pending);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(pending)) unlinkSync(pending);
  }
  safeAssert(sha256(join(root, 'docker/docker-compose.yml')) === UPSTREAM_COMPOSE_SHA256,
    'Pinned docker-compose.yml changed during initialization');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    safeAssert(process.argv.length === 4 && process.argv[2] === '--upstream',
      'Usage: node init-private-env.mjs --upstream /var/lib/volt220-test-supabase/upstream');
    createPrivateEnv(process.argv[3]);
    process.stdout.write('PASS: isolated test .env created privately; pinned upstream unchanged\n');
  } catch (error) {
    // Only our own value-free errors are surfaced; unexpected errors are kept
    // generic so no generated key can reach logs or a terminal transcript.
    const safeMessage = error instanceof Error && /^(Run the|Initializer|Test stack|Private \.env|Supabase checkout|Pinned |Unsafe private|Duplicate upstream|Missing upstream|Lovable key|Usage:)/.test(error.message)
      ? error.message : 'private env creation failed; inspect permissions and pinned source';
    process.stderr.write(`FAIL: ${safeMessage}\n`);
    process.exitCode = 1;
  }
}
