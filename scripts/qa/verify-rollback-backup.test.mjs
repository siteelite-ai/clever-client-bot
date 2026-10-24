import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RollbackIntegrityError,
  hashSourceTree,
  verifyRollbackBackup,
} from './verify-rollback-backup.mjs';

const SLUGS = ['chat-consultant', 'chat-consultant-v2', 'chat-consultant-v3', 'search-products'];
const OVERLAY_RELATIVE = 'supabase/functions/_shared/v3-tools/types.ts';
const digest = (value) => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'volt-rollback-integrity-'));
  const bundles = {};
  const sourceTreeSha = {};
  const overlayBytes = 'export type RollbackFixture = true;\n';
  for (const [index, slug] of SLUGS.entries()) {
    const bundleBytes = `ESZIP-fixture-${slug}`;
    await writeFile(join(root, `${slug}.bundle`), bundleBytes);
    bundles[slug] = {
      version: 101 + index,
      ezbr: String(index + 1).repeat(64),
      sha: digest(bundleBytes),
    };
    const sourceRoot = join(root, `source-${slug}`);
    await mkdir(join(sourceRoot, 'supabase/functions', slug), { recursive: true });
    await mkdir(join(sourceRoot, 'supabase/functions/_shared'), { recursive: true });
    await mkdir(join(sourceRoot, 'supabase/.temp'), { recursive: true });
    await writeFile(join(sourceRoot, 'supabase/functions', slug, 'index.ts'), `export const fixture = '${slug}';\n`);
    await writeFile(join(sourceRoot, 'supabase/functions/_shared/shared.ts'), `export const slug = '${slug}';\n`);
    await writeFile(join(sourceRoot, 'supabase/.temp/linked-project.json'), '{}\n');
    sourceTreeSha[slug] = await hashSourceTree(sourceRoot);
  }
  const overlayRoot = join(root, 'source-chat-consultant-v3-overlay');
  await mkdir(join(overlayRoot, 'supabase/functions/_shared/v3-tools'), { recursive: true });
  await writeFile(join(overlayRoot, OVERLAY_RELATIVE), overlayBytes);
  const overlaySha = digest(overlayBytes);
  const rows = SLUGS.map((slug) => {
    const { version, ezbr, sha } = bundles[slug];
    return `| \`${slug}\` | ${version} | \`${ezbr}\` | false | \`${sha}\` |`;
  });
  const manifest = [
    '# Fixture manifest',
    '| Slug | Version | ezbr | JWT | Bundle SHA |',
    '|---|---:|---|---|---|',
    ...rows,
    `both have SHA-256 \`${overlaySha}\``,
  ].join('\n');
  await writeFile(join(root, 'ROLLBACK-MANIFEST.md'), manifest);
  return { root, expected: { bundles, sourceTreeSha, overlaySha, manifestSha: digest(manifest) } };
}

async function withFixture(run) {
  const data = await fixture();
  try {
    await run(data);
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
}

async function rejectsCode(run, code) {
  await assert.rejects(run, (error) => {
    assert.ok(error instanceof RollbackIntegrityError);
    assert.equal(error.code, code);
    assert.equal(error.message, code); // No archive path or source text is leaked.
    return true;
  });
}

test('four separate source trees, four bundles, and the overlay pass without writes', () => withFixture(async ({ root, expected }) => {
  const before = await readdir(root);
  assert.deepEqual(await verifyRollbackBackup(root, { expected }), {
    ok: true,
    status: 'INTEGRITY_ONLY_NOT_RESTORE_REHEARSAL',
  });
  assert.deepEqual(await readdir(root), before);
}));

test('bundle bytes differing from the pinned manifest fail', () => withFixture(async ({ root, expected }) => {
  await writeFile(join(root, 'chat-consultant-v2.bundle'), 'tampered');
  await rejectsCode(() => verifyRollbackBackup(root, { expected }), 'BUNDLE_SHA_MISMATCH');
}));

test('edited manifest digest cannot bless modified bundle bytes', () => withFixture(async ({ root, expected }) => {
  const file = join(root, 'ROLLBACK-MANIFEST.md');
  const raw = await readFile(file, 'utf8');
  const edited = raw.replace(expected.bundles['chat-consultant'].sha, 'f'.repeat(64));
  await writeFile(file, edited);
  await rejectsCode(() => verifyRollbackBackup(root, { expected }), 'MANIFEST_SHA_MISMATCH');
  await rejectsCode(() => verifyRollbackBackup(root, { expected: { ...expected, manifestSha: digest(edited) } }),
    'MANIFEST_BASELINE_MISMATCH');
}));

test('changed manifest prose is rejected even when its table rows still match', () => withFixture(async ({ root, expected }) => {
  const file = join(root, 'ROLLBACK-MANIFEST.md');
  const raw = await readFile(file, 'utf8');
  await writeFile(file, `${raw}\nunsafe restore instruction`);
  await rejectsCode(() => verifyRollbackBackup(root, { expected }), 'MANIFEST_SHA_MISMATCH');
}));

test('missing and extra root entries are rejected', () => withFixture(async ({ root, expected }) => {
  await writeFile(join(root, 'extra.txt'), 'ignored?');
  await rejectsCode(() => verifyRollbackBackup(root, { expected }), 'ARCHIVE_LAYOUT_INVALID');
  await unlink(join(root, 'extra.txt'));
  await unlink(join(root, 'search-products.bundle'));
  await rejectsCode(() => verifyRollbackBackup(root, { expected }), 'ARCHIVE_LAYOUT_INVALID');
}));

test('a symlink in a source tree is rejected, not followed', () => withFixture(async ({ root, expected }) => {
  await symlink(join(root, 'chat-consultant.bundle'),
    join(root, 'source-chat-consultant/supabase/functions/_shared/link.ts'));
  await rejectsCode(() => verifyRollbackBackup(root, { expected }), 'ARCHIVE_LAYOUT_INVALID');
}));

test('missing, extra, and changed source files fail the separate tree digest', () => withFixture(async ({ root, expected }) => {
  const sourceRoot = join(root, 'source-chat-consultant-v3/supabase/functions/_shared');
  await writeFile(join(sourceRoot, 'shared.ts'), 'changed bytes');
  await rejectsCode(() => verifyRollbackBackup(root, { expected }), 'SOURCE_TREE_MISMATCH');
  await writeFile(join(sourceRoot, 'shared.ts'), `export const slug = 'chat-consultant-v3';\n`);
  await writeFile(join(sourceRoot, 'extra.ts'), 'extra');
  await rejectsCode(() => verifyRollbackBackup(root, { expected }), 'SOURCE_TREE_MISMATCH');
  await unlink(join(sourceRoot, 'extra.ts'));
  await unlink(join(sourceRoot, 'shared.ts'));
  await rejectsCode(() => verifyRollbackBackup(root, { expected }), 'SOURCE_TREE_MISMATCH');
}));

test('V3 overlay bytes and layout are separately pinned', () => withFixture(async ({ root, expected }) => {
  const path = join(root, 'source-chat-consultant-v3-overlay', OVERLAY_RELATIVE);
  await writeFile(path, 'changed overlay');
  await rejectsCode(() => verifyRollbackBackup(root, { expected }), 'OVERLAY_MISMATCH');
  await writeFile(path, 'export type RollbackFixture = true;\n');
  await writeFile(join(root, 'source-chat-consultant-v3-overlay/extra.ts'), 'extra');
  await rejectsCode(() => verifyRollbackBackup(root, { expected }), 'OVERLAY_MISMATCH');
}));

test('absolute path is required', async () => {
  await rejectsCode(() => verifyRollbackBackup('relative/archive'), 'ARCHIVE_PATH_INVALID');
});
