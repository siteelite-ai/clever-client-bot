#!/usr/bin/env node
/**
 * Offline, read-only integrity check for the owner-only 2026-10-22 public
 * Supabase Edge rollback archive. It never executes or deploys archived code.
 *
 * Usage: node scripts/qa/verify-rollback-backup.mjs --archive-dir=/absolute/path
 * A PASS is NOT an isolated restore rehearsal or a production rollback proof.
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SHA256 = /^[a-f0-9]{64}$/;
const SLUGS = Object.freeze([
  'chat-consultant',
  'chat-consultant-v2',
  'chat-consultant-v3',
  'search-products',
]);
const OVERLAY_RELATIVE = 'supabase/functions/_shared/v3-tools/types.ts';
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

// Pin the independently captured baseline outside the owner-only manifest.
// Source-tree hashes cover paths, types, and bytes (including CLI .temp files).
export const BASELINE = Object.freeze({
  manifestSha: 'df96627c976d7d510e5027f0a3918aeb84fd5583c80c481dfa6836a39ea0d49b',
  bundles: Object.freeze({
    'chat-consultant': Object.freeze({ version: 1075, ezbr: '8f56525d4b7de1f58f62b911ffc598f2c1294ac1ab5f45ec718c1cd40645856e', sha: 'daea347aaf8e907bf4897d9c43a8206c1386da8b0d94333d4321e14c5cb805ac' }),
    'chat-consultant-v2': Object.freeze({ version: 503, ezbr: 'd29c59e18d6fc955a33635d42d282e5398bd369243de846aa8d79e165a748abe', sha: '3c7a57e207dbbcfc5b1958a71a3c7591b26d3a9e28aa3eead63eb08a730155fd' }),
    'chat-consultant-v3': Object.freeze({ version: 575, ezbr: '3ef4a7c24b1ec22e5f1504f127de8e8d39c5696be3f28d68bd8ac8e8291f47f0', sha: '9060c530c7a0fba91066d69b8cb0ac6818790abde070625165b21c08c5639d4b' }),
    'search-products': Object.freeze({ version: 705, ezbr: 'b6b7ffabee5dd15c909bc2b35cd7b7805c992e27d0ef87e46a37b03b1b4ada03', sha: '0d4b9dde207778ea1e00d3e727396990f1e53eb6414a39418ad86c936482266b' }),
  }),
  overlaySha: '9c6004452fae1a8d192bbacab18c8ef27475e188523b2877cb0d34c9608ff7f6',
  // Determined from the captured archive; a different extract must be reviewed.
  sourceTreeSha: Object.freeze({
    'chat-consultant': 'e67056ad3075f6f1f0fa63f9fa6fec4650b48a32950ac0fb233bbc377b73e69c',
    'chat-consultant-v2': 'b9b1b2f2a43656e30c6f0aef38ced5560857872b86fefbccc11246eab8492e42',
    'chat-consultant-v3': 'a068a0b4d9d77d9a2498480d472955b299321364feb9c21c4da49e78e74ab2f8',
    'search-products': 'a9072eba44c26a67a8cc107fc4850ac77cf5091e247d43413c67817d46184a1c',
  }),
});

export class RollbackIntegrityError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RollbackIntegrityError';
    this.code = code;
  }
}

function fail(code) {
  throw new RollbackIntegrityError(code);
}

async function statExact(path, kind) {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    fail('ARCHIVE_LAYOUT_INVALID');
  }
  if (stat.isSymbolicLink() || !(kind === 'file' ? stat.isFile() : stat.isDirectory())) {
    fail('ARCHIVE_LAYOUT_INVALID');
  }
  return stat;
}

async function hashFile(path, maxBytes = MAX_FILE_BYTES) {
  const before = await statExact(path, 'file');
  if (before.size > maxBytes) fail('ARCHIVE_FILE_TOO_LARGE');
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
      opened.size !== before.size) fail('ARCHIVE_FILE_CHANGED');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest('hex');
  } catch (error) {
    if (error instanceof RollbackIntegrityError) throw error;
    fail('ARCHIVE_FILE_UNREADABLE');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readManifest(path) {
  const before = await statExact(path, 'file');
  if (before.size > MAX_MANIFEST_BYTES) fail('MANIFEST_INVALID');
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
      opened.size !== before.size) fail('ARCHIVE_FILE_CHANGED');
    return await handle.readFile();
  } catch (error) {
    if (error instanceof RollbackIntegrityError) throw error;
    fail('MANIFEST_INVALID');
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parseManifest(raw, expected) {
  const rows = [...raw.matchAll(/^\|\s*`([a-z0-9-]+)`\s*\|\s*(\d+)\s*\|\s*`([a-f0-9]{64})`\s*\|\s*(true|false)\s*\|\s*`([a-f0-9]{64})`\s*\|\s*$/gm)];
  if (rows.length !== SLUGS.length) fail('MANIFEST_INVALID');
  const seen = new Set();
  for (const [, slug, version, ezbr, verifyJwt, sha] of rows) {
    const pinned = expected.bundles[slug];
    if (!pinned || seen.has(slug) || Number(version) !== pinned.version ||
      ezbr !== pinned.ezbr || verifyJwt !== 'false' || sha !== pinned.sha) {
      fail('MANIFEST_BASELINE_MISMATCH');
    }
    seen.add(slug);
  }
  if (seen.size !== SLUGS.length) fail('MANIFEST_BASELINE_MISMATCH');
  const overlayMatch = raw.match(/both have\s+SHA-256\s+`([a-f0-9]{64})`/);
  if (!overlayMatch || overlayMatch[1] !== expected.overlaySha) {
    fail('MANIFEST_OVERLAY_MISMATCH');
  }
}

async function scanTree(root) {
  await statExact(root, 'directory');
  const entries = [];
  async function walk(dir) {
    let names;
    try {
      names = (await readdir(dir)).sort();
    } catch {
      fail('ARCHIVE_LAYOUT_INVALID');
    }
    for (const name of names) {
      const path = join(dir, name);
      const rel = relative(root, path).split('\\').join('/');
      let stat;
      try {
        stat = await lstat(path);
      } catch {
        fail('ARCHIVE_LAYOUT_INVALID');
      }
      if (stat.isDirectory()) {
        entries.push(['d', rel]);
        await walk(path);
      } else if (stat.isFile()) {
        entries.push(['f', rel, await hashFile(path)]);
      } else {
        // Includes symlinks, sockets, devices, and named pipes.
        fail('ARCHIVE_LAYOUT_INVALID');
      }
    }
  }
  await walk(root);
  entries.sort((a, b) => Buffer.compare(Buffer.from(a[1]), Buffer.from(b[1])));
  const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return { digest, entries };
}

/** For synthetic tests and explicit baseline capture; returns hashes only. */
export async function hashSourceTree(path) {
  return (await scanTree(path)).digest;
}

/** No network, no writes, no source execution. `expected` is test-only injection. */
export async function verifyRollbackBackup(archiveDir, { expected = BASELINE } = {}) {
  if (typeof archiveDir !== 'string' || !isAbsolute(archiveDir)) fail('ARCHIVE_PATH_INVALID');
  await statExact(archiveDir, 'directory');
  const rootNames = (await readdir(archiveDir)).sort();
  const expectedNames = [
    'ROLLBACK-MANIFEST.md',
    ...SLUGS.map((slug) => `${slug}.bundle`),
    ...SLUGS.map((slug) => `source-${slug}`),
    'source-chat-consultant-v3-overlay',
  ].sort();
  if (JSON.stringify(rootNames) !== JSON.stringify(expectedNames)) fail('ARCHIVE_LAYOUT_INVALID');

  const manifest = await readManifest(join(archiveDir, 'ROLLBACK-MANIFEST.md'));
  if (createHash('sha256').update(manifest).digest('hex') !== expected.manifestSha) {
    fail('MANIFEST_SHA_MISMATCH');
  }
  parseManifest(manifest.toString('utf8'), expected);
  for (const slug of SLUGS) {
    const bundleSha = await hashFile(join(archiveDir, `${slug}.bundle`));
    if (bundleSha !== expected.bundles[slug].sha) fail('BUNDLE_SHA_MISMATCH');
    const sourceRoot = join(archiveDir, `source-${slug}`);
    await statExact(join(sourceRoot, 'supabase/functions', slug, 'index.ts'), 'file');
    const sourceSha = await hashSourceTree(sourceRoot);
    if (!SHA256.test(expected.sourceTreeSha[slug]) || sourceSha !== expected.sourceTreeSha[slug]) {
      fail('SOURCE_TREE_MISMATCH');
    }
  }

  const overlayRoot = join(archiveDir, 'source-chat-consultant-v3-overlay');
  const overlay = await scanTree(overlayRoot);
  const overlayFiles = overlay.entries.filter(([kind]) => kind === 'f');
  if (overlayFiles.length !== 1 || overlayFiles[0][1] !== OVERLAY_RELATIVE ||
    overlayFiles[0][2] !== expected.overlaySha) fail('OVERLAY_MISMATCH');
  const overlayDirs = overlay.entries.filter(([kind]) => kind === 'd').map(([, path]) => path);
  if (JSON.stringify(overlayDirs.sort()) !== JSON.stringify([
    'supabase', 'supabase/functions', 'supabase/functions/_shared',
    'supabase/functions/_shared/v3-tools',
  ].sort())) fail('ARCHIVE_LAYOUT_INVALID');
  return { ok: true, status: 'INTEGRITY_ONLY_NOT_RESTORE_REHEARSAL' };
}

async function main(args) {
  if (args.length !== 1 || !args[0].startsWith('--archive-dir=') ||
    args[0].slice('--archive-dir='.length).length === 0) fail('USAGE_INVALID');
  await verifyRollbackBackup(args[0].slice('--archive-dir='.length));
  process.stdout.write('PASS: pinned manifest, bundle and source-tree integrity; V3 overlay verified. NOT A RESTORE REHEARSAL.\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`FAIL: ${error instanceof RollbackIntegrityError ? error.code : 'UNEXPECTED_ERROR'}. NOT A RESTORE REHEARSAL.\n`);
    process.exitCode = 1;
  });
}
