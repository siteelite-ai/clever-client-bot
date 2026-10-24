#!/usr/bin/env node
/**
 * Read-only attestation of the exact preview bundle and unchanged public
 * functions before route QA. The manifest is an out-of-band, local JSON file:
 * docs/qa/<name>.json. It pins the runtime source commit, not the manifest's
 * own HEAD (which would be self-referential). Later QA/docs-only commits are
 * allowed, but any runtime file difference fails closed.
 *
 * Usage (the token is never printed):
 *   SUPABASE_ACCESS_TOKEN=... node scripts/qa/verify-preview-bundles.mjs \
 *     --manifest=docs/qa/preview-bundles-candidate.json
 *
 * Only GET https://api.supabase.com/v1/projects/yngoixmvmxdfxokuafjp/functions
 * is performed. This script cannot deploy, set secrets, or change live state.
 */

import { execFile } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import process from 'node:process';
import { promisify, TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
export const PROJECT_REF = 'yngoixmvmxdfxokuafjp';
export const MANAGEMENT_URL = `https://api.supabase.com/v1/projects/${PROJECT_REF}/functions`;
export const PREVIEW_SLUGS = Object.freeze([
  'chat-consultant-closure-preview',
  'chat-consultant-v2-closure-preview',
  'chat-consultant-v3-closure-preview',
  'search-products-closure-preview',
]);
export const PUBLIC_SLUGS = Object.freeze([
  'chat-consultant',
  'chat-consultant-v2',
  'chat-consultant-v3',
  'search-products',
]);
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const WIDGET_VERSION = /^widget-[a-f0-9]{16}$/;
const MANIFEST_ARG = /^docs\/qa\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
// Adding a new function/root requires a deliberate attestation policy review.
const QA_TEST_ROOTS = new Set([
  ...PREVIEW_SLUGS, ...PUBLIC_SLUGS,
  'chat-consultant-beta-search', 'chat-consultant-v3-preview',
  'knowledge-process', 'admin-integration-secrets', 'admin-users',
  'widget-config', '_shared',
]);
const RUNTIME_PATHS = ['--', 'public', 'supabase/functions', 'supabase/config.toml'];
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export class AttestationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AttestationError';
    this.code = code;
  }
}

function fail(code) {
  throw new AttestationError(code);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expected) {
  return isRecord(value) &&
    Object.keys(value).sort().join('\u0000') === [...expected].sort().join('\u0000');
}

/** Parse and validate a deliberately narrow, no-extra-fields manifest. */
export function parseManifest(raw) {
  let manifest;
  try {
    manifest = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    fail('MANIFEST_INVALID_JSON');
  }
  if (!exactKeys(manifest, [
    'schemaVersion', 'projectRef', 'runtime_source_commit_sha', 'widgetVersion',
    'previewFunctions', 'publicFunctions',
  ]) || manifest.schemaVersion !== 1 || manifest.projectRef !== PROJECT_REF ||
    !GIT_SHA.test(manifest.runtime_source_commit_sha) || !WIDGET_VERSION.test(manifest.widgetVersion) ||
    !exactKeys(manifest.previewFunctions, PREVIEW_SLUGS) ||
    !exactKeys(manifest.publicFunctions, PUBLIC_SLUGS)) {
    fail('MANIFEST_SCHEMA_INVALID');
  }
  for (const slug of PREVIEW_SLUGS) {
    const expected = manifest.previewFunctions[slug];
    if (!exactKeys(expected, ['version', 'ezbr_sha256', 'verify_jwt']) ||
      !Number.isSafeInteger(expected.version) || expected.version < 1 ||
      !SHA256.test(expected.ezbr_sha256) || expected.verify_jwt !== true) {
      fail('MANIFEST_PREVIEW_INVALID');
    }
  }
  for (const slug of PUBLIC_SLUGS) {
    const expected = manifest.publicFunctions[slug];
    if (!exactKeys(expected, ['version', 'ezbr_sha256']) ||
      !Number.isSafeInteger(expected.version) || expected.version < 1 ||
      !SHA256.test(expected.ezbr_sha256)) {
      fail('MANIFEST_PUBLIC_INVALID');
    }
  }
  return manifest;
}

/** Reject arbitrary paths and symlinks; never print the supplied pathname. */
export async function readManifest(manifestArg, { root = REPO_ROOT } = {}) {
  if (typeof manifestArg !== 'string' || !MANIFEST_ARG.test(manifestArg)) {
    fail('MANIFEST_PATH_INVALID');
  }
  const path = resolve(root, manifestArg);
  if (path !== join(root, manifestArg)) fail('MANIFEST_PATH_INVALID');
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    fail('MANIFEST_UNAVAILABLE');
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_MANIFEST_BYTES) {
    fail('MANIFEST_FILE_INVALID');
  }
  try {
    return parseManifest(await readFile(path, 'utf8'));
  } catch (error) {
    if (error instanceof AttestationError) throw error;
    fail('MANIFEST_UNAVAILABLE');
  }
}

export async function localGitHead() {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT, timeout: 3_000, maxBuffer: 4096,
    });
    const head = stdout.trim();
    if (GIT_SHA.test(head)) return head;
  } catch {
    // Only a stable error code is safe to surface from git/child processes.
  }
  fail('LOCAL_GIT_HEAD_UNAVAILABLE');
}

async function gitExitCode(args, root = REPO_ROOT) {
  try {
    await execFileAsync('git', args, {
      cwd: root, timeout: 5_000, maxBuffer: 16 * 1024,
    });
    return 0;
  } catch (error) {
    if (error?.code === 1) return 1;
    fail('LOCAL_RUNTIME_DIFF_UNAVAILABLE');
  }
}

async function gitBytes(args, root) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: root, timeout: 5_000, maxBuffer: 128 * 1024, encoding: 'buffer',
    });
    if (!Buffer.isBuffer(stdout)) fail('LOCAL_RUNTIME_DIFF_UNAVAILABLE');
    return stdout;
  } catch (error) {
    if (error instanceof AttestationError) throw error;
    fail('LOCAL_RUNTIME_DIFF_UNAVAILABLE');
  }
}

/** Git's -z format is unquoted: never split paths on whitespace/newlines. */
function nulFields(bytes) {
  if (bytes.length === 0) return [];
  if (bytes[bytes.length - 1] !== 0) fail('LOCAL_RUNTIME_DIFF_UNAVAILABLE');
  try {
    return UTF8.decode(bytes.subarray(0, -1)).split('\0');
  } catch {
    fail('LOCAL_RUNTIME_DIFF_UNAVAILABLE');
  }
}

function qaTestPath(path) {
  const parts = path.split('/');
  return parts.length >= 4 && parts[0] === 'supabase' && parts[1] === 'functions' &&
    QA_TEST_ROOTS.has(parts[2]) &&
    parts.slice(3, -1).every((part) => /^[A-Za-z0-9_-]+$/.test(part)) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*_test\.ts$/.test(parts.at(-1));
}

async function regularWorkingFile(path, root) {
  try {
    let current = root;
    const parts = path.split('/');
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      const stats = await lstat(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    }
    const stats = await lstat(join(current, parts.at(-1)));
    return stats.isFile() && !stats.isSymbolicLink() && (stats.mode & 0o111) === 0;
  } catch {
    return false;
  }
}

async function regularGitBlob(path, ref, root) {
  const fields = nulFields(await gitBytes(
    ref === ':index'
      ? ['ls-files', '--stage', '-z', '--', path]
      : ['ls-tree', '-z', ref, '--', path], root,
  ));
  if (fields.length !== 1) return false;
  const expected = ref === ':index'
    ? /^100644 [a-f0-9]{40} 0\t(.+)$/
    : /^100644 blob [a-f0-9]{40}\t(.+)$/;
  return expected.exec(fields[0])?.[1] === path;
}

/**
 * The pinned commit must be an ancestor. Only ordinary Deno *_test.ts files
 * under known function roots may differ; all runtime/config/unknown changes,
 * including staged, untracked, ignored and symlink changes, fail closed.
 */
export async function localRuntimeUnchanged(sourceCommit, head, { root = REPO_ROOT } = {}) {
  if (!GIT_SHA.test(sourceCommit) || !GIT_SHA.test(head)) {
    fail('LOCAL_RUNTIME_DIFF_UNAVAILABLE');
  }
  if (await gitExitCode(['merge-base', '--is-ancestor', sourceCommit, head], root) !== 0) return false;

  const committed = nulFields(await gitBytes([
    'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z',
    sourceCommit, head, ...RUNTIME_PATHS,
  ], root));
  if (committed.length % 2 !== 0) fail('LOCAL_RUNTIME_DIFF_UNAVAILABLE');
  for (let i = 0; i < committed.length; i += 2) {
    const [status, path] = committed.slice(i, i + 2);
    if (!['A', 'M'].includes(status) || !qaTestPath(path) ||
      !await regularGitBlob(path, head, root)) return false;
  }

  const dirty = nulFields(await gitBytes([
    'status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all',
    '--ignored', ...RUNTIME_PATHS,
  ], root));
  for (const record of dirty) {
    if (record.length < 5 || record[2] !== ' ') fail('LOCAL_RUNTIME_DIFF_UNAVAILABLE');
    const status = record.slice(0, 2);
    const path = record.slice(3);
    // --no-renames keeps both halves of a rename visible; no runtime source
    // may be hidden by renaming it to a test-looking pathname.
    if (!/^(?:\?\?|[ MA][ MA])$/.test(status) || status === '  ' ||
      !qaTestPath(path) || !await regularWorkingFile(path, root) ||
      (status !== '??' && !await regularGitBlob(path, ':index', root))) return false;
  }
  return true;
}

export async function localWidgetVersion() {
  let source;
  try {
    source = await readFile(join(REPO_ROOT, 'public/widget.js'), 'utf8');
  } catch {
    fail('LOCAL_WIDGET_UNAVAILABLE');
  }
  const versions = [...source.matchAll(/^\s*var WIDGET_VERSION = '(widget-[a-f0-9]{16})';\s*$/gm)];
  if (versions.length !== 1) fail('LOCAL_WIDGET_VERSION_INVALID');
  return versions[0][1];
}

async function boundedResponseJson(response) {
  if (response?.status !== 200) fail('MANAGEMENT_READ_FAILED');
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) fail('MANAGEMENT_RESPONSE_TOO_LARGE');
  if (!response.headers?.get?.('content-type')?.toLowerCase().startsWith('application/json')) {
    fail('MANAGEMENT_RESPONSE_INVALID');
  }
  const reader = response.body?.getReader?.();
  if (!reader) fail('MANAGEMENT_RESPONSE_INVALID');
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail('MANAGEMENT_RESPONSE_INVALID');
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) fail('MANAGEMENT_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AttestationError) throw error;
    fail('MANAGEMENT_RESPONSE_INVALID');
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes).toString('utf8'));
  } catch {
    fail('MANAGEMENT_RESPONSE_INVALID');
  }
}

async function readRemoteFunctions(token, fetchImpl) {
  if (typeof token !== 'string' || !token.trim()) fail('MANAGEMENT_TOKEN_UNAVAILABLE');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(MANAGEMENT_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
    });
    return await boundedResponseJson(response);
  } catch (error) {
    if (error instanceof AttestationError) throw error;
    fail('MANAGEMENT_TRANSPORT_FAILED');
  } finally {
    clearTimeout(timer);
  }
}

function compareFunctions(manifest, remote) {
  if (!Array.isArray(remote)) fail('MANAGEMENT_RESPONSE_INVALID');
  const targetSlugs = new Set([...PREVIEW_SLUGS, ...PUBLIC_SLUGS]);
  const indexed = new Map();
  for (const item of remote) {
    if (!isRecord(item) || typeof item.slug !== 'string') fail('MANAGEMENT_RESPONSE_INVALID');
    if (!targetSlugs.has(item.slug)) continue;
    if (indexed.has(item.slug)) fail('MANAGEMENT_DUPLICATE_FUNCTION');
    indexed.set(item.slug, item);
  }
  const failures = [];
  for (const [kind, slugs, pinned] of [
    ['PREVIEW', PREVIEW_SLUGS, manifest.previewFunctions],
    ['PUBLIC', PUBLIC_SLUGS, manifest.publicFunctions],
  ]) {
    for (const slug of slugs) {
      const observed = indexed.get(slug);
      const expected = pinned[slug];
      if (!observed || observed.status !== 'ACTIVE') {
        failures.push({ code: `${kind}_NOT_ACTIVE`, slug });
        continue;
      }
      if (observed.version !== expected.version) {
        failures.push({ code: `${kind}_VERSION_MISMATCH`, slug });
      }
      if (observed.ezbr_sha256 !== expected.ezbr_sha256) {
        failures.push({ code: `${kind}_SHA_MISMATCH`, slug });
      }
      if (kind === 'PREVIEW' && observed.verify_jwt !== true) {
        failures.push({ code: 'PREVIEW_JWT_DISABLED', slug });
      }
    }
  }
  return failures;
}

/** Injectable local/transport dependencies allow full offline testing. */
export async function verifyPreviewBundles(manifestInput, {
  token,
  fetchImpl = fetch,
  getGitHead = localGitHead,
  isRuntimeUnchanged = localRuntimeUnchanged,
  getWidgetVersion = localWidgetVersion,
} = {}) {
  const manifest = parseManifest(manifestInput);
  let head;
  let widgetVersion;
  let runtimeUnchanged;
  try {
    head = await getGitHead();
    widgetVersion = await getWidgetVersion();
    runtimeUnchanged = await isRuntimeUnchanged(manifest.runtime_source_commit_sha, head);
  } catch (error) {
    if (error instanceof AttestationError) throw error;
    fail('LOCAL_EVIDENCE_UNAVAILABLE');
  }
  if (!GIT_SHA.test(head) || runtimeUnchanged !== true) fail('LOCAL_RUNTIME_DRIFT');
  if (widgetVersion !== manifest.widgetVersion) fail('LOCAL_WIDGET_VERSION_MISMATCH');
  const remote = await readRemoteFunctions(token, fetchImpl);
  const failures = compareFunctions(manifest, remote);
  return { ok: failures.length === 0, failures };
}

async function main() {
  if (process.argv.length !== 3 || !process.argv[2].startsWith('--manifest=')) {
    fail('USAGE');
  }
  const manifest = await readManifest(process.argv[2].slice('--manifest='.length));
  const result = await verifyPreviewBundles(manifest, {
    token: process.env.SUPABASE_ACCESS_TOKEN,
  });
  if (!result.ok) {
    for (const failure of result.failures) {
      process.stderr.write(`${failure.code} ${failure.slug}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write('PREVIEW_BUNDLES_MATCH: 4 preview, 4 public, runtime source and widget version\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof AttestationError ? error.code : 'ATTESTATION_FAILED'}\n`);
    process.exitCode = 1;
  });
}
