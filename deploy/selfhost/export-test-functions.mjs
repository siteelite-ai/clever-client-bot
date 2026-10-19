#!/usr/bin/env node

// Stage only the reviewed application Edge Functions for the isolated test
// Supabase. This does not connect to a server or alter the official router.
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const defaultFunctionsRoot = join(repoRoot, 'supabase', 'functions');
export const includedDirectories = Object.freeze([
  '_shared',
  'admin-settings',
  'admin-users',
  'chat-consultant-v3',
  'knowledge-process',
]);
const FORBIDDEN_LITERALS = [
  /yngoixmvmxdfxokuafjp/i, // Existing production Supabase project.
  /\bsb_(?:secret|publishable)_[a-z0-9_-]{8,}\b/i,
  /\bsk-(?:or-v1-)?[a-z0-9_-]{16,}\b/i,
  /\beyJ[a-z0-9_-]{20,}\.eyJ[a-z0-9_-]{20,}\.[a-z0-9_-]{12,}\b/i,
  /\b(?:LOVABLE_API_KEY|OPENROUTER_API_KEY|SUPABASE_SERVICE_ROLE_KEY|CATALOG_API_TOKEN)\s*[:=]\s*['"`][^'"`\s]{8,}/i,
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function assertNoSecretLiterals(bytes, path) {
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Non-UTF-8 function source: ${path}`);
  }
  if (FORBIDDEN_LITERALS.some((pattern) => pattern.test(source))) {
    throw new Error(`Credential or production project literal found in function source: ${path}`);
  }
}

async function assertRegularDirectory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Function directory must not be linked: ${path}`);
  }
}

async function walkSource(dir, relativeDir, files) {
  await assertRegularDirectory(dir);
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    const relPath = `${relativeDir}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Linked function source is forbidden: ${relPath}`);
    if (entry.isDirectory()) {
      await walkSource(path, relPath, files);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Non-regular function source is forbidden: ${relPath}`);
    if (entry.name.endsWith('_test.ts')) continue;
    if (!entry.name.endsWith('.ts')) {
      throw new Error(`Unexpected non-TypeScript function source; review before export: ${relPath}`);
    }
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error(`Function source changed type during audit: ${relPath}`);
    }
    const bytes = await readFile(path);
    const after = await lstat(path);
    if (!after.isFile() || after.isSymbolicLink() || before.ino !== after.ino || before.size !== after.size) {
      throw new Error(`Function source changed during audit: ${relPath}`);
    }
    assertNoSecretLiterals(bytes, relPath);
    files.set(relPath, bytes);
  }
}

export async function auditTestFunctionSources(options = {}) {
  const functionsRoot = options.functionsRoot ?? defaultFunctionsRoot;
  await assertRegularDirectory(functionsRoot);
  const files = new Map();
  for (const name of includedDirectories) {
    await walkSource(join(functionsRoot, name), name, files);
  }
  for (const name of includedDirectories.filter((entry) => entry !== '_shared')) {
    if (!files.has(`${name}/index.ts`)) throw new Error(`Missing Edge entrypoint: ${name}/index.ts`);
  }
  if (files.size === 0) throw new Error('No Edge Function sources found');
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b, 'en')));
}

async function assertOutputParent(outputDir) {
  if (!isAbsolute(outputDir)) throw new Error('Output path must be absolute');
  const target = resolve(outputDir);
  const parent = dirname(target);
  await assertRegularDirectory(parent);
  const realParent = await realpath(parent);
  const realRepo = await realpath(repoRoot);
  if (isWithin(realRepo, realParent)) {
    throw new Error('Output must stay outside the source repository');
  }
  return target;
}

function manifestFor(files) {
  return {
    format: 1,
    purpose: 'isolated-test-edge-functions',
    directories: includedDirectories,
    files: [...files].map(([path, bytes]) => ({ path, sha256: sha256(bytes), bytes: bytes.length })),
  };
}

function manifestsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function exportTestFunctions(outputDir, options = {}) {
  const target = await assertOutputParent(outputDir);
  // Read and scan every source before creating even a private output folder.
  const sources = await auditTestFunctionSources(options);
  const manifest = manifestFor(sources);
  await mkdir(target, { mode: 0o700 }); // No overwrite, including a dangling symlink.
  try {
    await chmod(target, 0o700);
    const stage = join(target, '.staging');
    const functions = join(stage, 'functions');
    await mkdir(stage, { mode: 0o700 });
    await mkdir(functions, { mode: 0o700 });
    for (const name of includedDirectories) await mkdir(join(functions, name), { mode: 0o700 });
    for (const [path, bytes] of sources) {
      const destination = join(functions, path);
      const parent = dirname(destination);
      if (!includedDirectories.some((name) => path.startsWith(`${name}/`))) {
        throw new Error('Unexpected function path');
      }
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
      if (sha256(await readFile(destination)) !== sha256(bytes)) {
        throw new Error(`Function copy checksum mismatch: ${path}`);
      }
    }
    // Test-only hook simulates a concurrent admin-users edit during export.
    if (options.afterCopy) await options.afterCopy();
    const current = await auditTestFunctionSources(options);
    if (!manifestsEqual(manifestFor(current), manifest)) {
      throw new Error('Function source changed during copy; rebuild after code review');
    }
    await writeFile(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx', mode: 0o600,
    });
    await rename(functions, join(target, 'functions'));
    await rename(join(stage, 'manifest.json'), join(target, 'manifest.json'));
    await rm(stage, { recursive: true });
    return { bundleDir: target, fileCount: manifest.files.length, directories: includedDirectories };
  } catch (error) {
    // The directory was reserved by this invocation and is private; remove
    // only that newly created incomplete bundle, never an existing target.
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

async function walkBundle(dir, relativeDir, files) {
  const directory = await lstat(dir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) {
    throw new Error(`Bundle directory must be private and regular: ${relativeDir}`);
  }
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    const relPath = `${relativeDir}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Linked bundle entry is forbidden: ${relPath}`);
    if (entry.isDirectory()) {
      await walkBundle(path, relPath, files);
      continue;
    }
    const stat = await lstat(path);
    if (!entry.isFile() || !stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw new Error(`Bundle file must be private and regular: ${relPath}`);
    }
    files.set(relPath, await readFile(path));
  }
}

export async function verifyTestFunctionBundle(outputDir, options = {}) {
  if (!isAbsolute(outputDir)) throw new Error('Bundle path must be absolute');
  const target = resolve(outputDir);
  for (const dir of [target, join(target, 'functions')]) {
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error('Bundle directory is linked or not private');
    }
  }
  const top = (await readdir(target)).sort();
  if (top.join('\n') !== ['functions', 'manifest.json'].join('\n')) {
    throw new Error('Bundle has unexpected top-level files');
  }
  const functionDirs = (await readdir(join(target, 'functions'))).sort();
  if (functionDirs.join('\n') !== [...includedDirectories].sort().join('\n')) {
    throw new Error('Bundle has unexpected function directories');
  }
  const sources = await auditTestFunctionSources(options);
  const expected = manifestFor(sources);
  const manifestStat = await lstat(join(target, 'manifest.json'));
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || (manifestStat.mode & 0o077) !== 0) {
    throw new Error('Bundle manifest must be private and regular');
  }
  const actualManifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'));
  if (!manifestsEqual(actualManifest, expected)) throw new Error('Bundle manifest/source mismatch');
  const bundleFiles = new Map();
  for (const name of includedDirectories) {
    await walkBundle(join(target, 'functions', name), name, bundleFiles);
  }
  if (bundleFiles.size !== sources.size || [...bundleFiles.keys()].some((name) => !sources.has(name))) {
    throw new Error('Bundle contains missing or extra function files');
  }
  for (const [path, bytes] of bundleFiles) {
    if (sha256(bytes) !== sha256(sources.get(path))) {
      throw new Error(`Bundle function checksum mismatch: ${path}`);
    }
    assertNoSecretLiterals(bytes, path);
  }
  return { bundleDir: target, fileCount: sources.size, directories: includedDirectories };
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--check') return { check: true };
  if (args.length === 2 && args[0] === '--out') return { outputDir: args[1] };
  if (args.length === 2 && args[0] === '--verify') return { verifyDir: args[1] };
  throw new Error('Usage: export-test-functions.mjs --check | --out /absolute/private/new-directory | --verify /absolute/private/bundle');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.check) {
      const files = await auditTestFunctionSources();
      process.stdout.write(`Reviewed ${files.size} test Edge source files; no bundle created.\n`);
    } else if (args.verifyDir) {
      const result = await verifyTestFunctionBundle(args.verifyDir);
      process.stdout.write(`Verified ${result.fileCount} Edge source files in private bundle.\n`);
    } else {
      const result = await exportTestFunctions(args.outputDir);
      process.stdout.write(`Staged ${result.fileCount} Edge source files in private bundle.\n`);
    }
  } catch {
    process.stderr.write('Function export failed: source, privacy, or bundle verification changed. No source or secrets were printed.\n');
    process.exitCode = 1;
  }
}
