#!/usr/bin/env node

// Create a separately verified, test-only Edge Function bundle whose OpenRouter
// calls go through the isolated private relay. Production sources and the
// reviewed source bundle are never modified.
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
import { includedDirectories, verifyTestFunctionBundle } from './export-test-functions.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const relayBaseUrl = 'http://volt220test-relay-client:19084/api/v1';
const originalChatUrl = 'https://openrouter.ai/api/v1/chat/completions';
const originalEmbeddingsUrl = 'https://openrouter.ai/api/v1/embeddings';
const relayChatUrl = `${relayBaseUrl}/chat/completions`;
const relayEmbeddingsUrl = `${relayBaseUrl}/embeddings`;

// A source change that adds, removes or moves an OpenRouter route is a release
// review event. Do not silently route an unknown call or deploy a partial set.
export const expectedOpenRouterRoutes = Object.freeze({
  '_shared/advisor-intro.ts': [1, 0],
  '_shared/c5-broad-clarify.ts': [1, 0],
  '_shared/category-noun-extractor.ts': [1, 0],
  '_shared/expert-first.ts': [1, 0],
  '_shared/expert-interpretation.ts': [1, 0],
  '_shared/jargon-fallback.ts': [1, 0],
  '_shared/related-followup.ts': [2, 0],
  '_shared/v3-tools/conversation-boundary.ts': [1, 0],
  '_shared/v3-tools/discover-category.ts': [1, 0],
  '_shared/v3-tools/jargon-fallback.ts': [1, 0],
  '_shared/v3-tools/lookup-knowledge.ts': [0, 1],
  'admin-settings/index.ts': [1, 0],
  'chat-consultant-v3/index.ts': [3, 0],
  'knowledge-process/index.ts': [0, 1],
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function decode(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function occurrences(text, value) {
  return text.split(value).length - 1;
}

function normalizeExpectedRoutes(expected) {
  const entries = Object.entries(expected).sort(([a], [b]) => a.localeCompare(b, 'en'));
  for (const [path, counts] of entries) {
    if (!includedDirectories.some((name) => path.startsWith(`${name}/`)) ||
        !path.endsWith('.ts') ||
        !Array.isArray(counts) || counts.length !== 2 ||
        !counts.every((count) => Number.isSafeInteger(count) && count >= 0) ||
        counts[0] + counts[1] === 0) {
      throw new Error('Invalid reviewed OpenRouter route inventory');
    }
  }
  return Object.fromEntries(entries);
}

function routeSource(bytes, path) {
  const source = decode(bytes);
  // Audit every occurrence, not merely the two strings being replaced. This
  // rejects a new host/path, query string, dynamic URL, or a double-routed file.
  const urls = [...source.matchAll(/https?:\/\/openrouter\.ai[^\s"'`<>]*/gi)].map((match) => match[0]);
  const domainCount = [...source.matchAll(/openrouter\.ai/gi)].length;
  if (urls.length !== domainCount ||
      urls.some((url) => url !== originalChatUrl && url !== originalEmbeddingsUrl) ||
      source.includes('volt220test-relay-client')) {
    throw new Error(`Unreviewed OpenRouter endpoint in ${path}`);
  }
  const chatCompletions = occurrences(source, originalChatUrl);
  const embeddings = occurrences(source, originalEmbeddingsUrl);
  if (chatCompletions + embeddings !== urls.length) {
    throw new Error(`OpenRouter URL inventory mismatch in ${path}`);
  }
  const routed = source
    .replaceAll(originalChatUrl, relayChatUrl)
    .replaceAll(originalEmbeddingsUrl, relayEmbeddingsUrl);
  if (/openrouter\.ai/i.test(routed) ||
      occurrences(routed, relayChatUrl) !== chatCompletions ||
      occurrences(routed, relayEmbeddingsUrl) !== embeddings) {
    throw new Error(`OpenRouter routing incomplete in ${path}`);
  }
  return {
    bytes: Buffer.from(routed, 'utf8'),
    chatCompletions,
    embeddings,
  };
}

async function assertPrivateRegular(path, directory) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (stat.mode & 0o077) !== 0) {
    throw new Error('Routed bundle entry is linked, not regular, or not private');
  }
}

async function assertNewOutputParent(outputDir) {
  if (!isAbsolute(outputDir)) throw new Error('Output path must be absolute');
  const target = resolve(outputDir);
  const parent = dirname(target);
  const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Output parent must be a regular directory');
  if (isWithin(await realpath(repoRoot), await realpath(parent))) {
    throw new Error('Output must stay outside the source repository');
  }
  return target;
}

function expectedDirectories(filePaths) {
  const result = new Set(includedDirectories);
  for (const filePath of filePaths) {
    const parts = filePath.split('/');
    for (let i = 2; i < parts.length; i += 1) result.add(parts.slice(0, i).join('/'));
  }
  return [...result].sort();
}

async function walkOutput(dir, relativeDir, files, dirs) {
  await assertPrivateRegular(dir, true);
  dirs.add(relativeDir);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const relPath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      await walkOutput(path, relPath, files, dirs);
    } else {
      await assertPrivateRegular(path, false);
      files.set(relPath, await readFile(path));
    }
  }
}

async function auditInputBundle(inputDir, options = {}) {
  const input = resolve(inputDir);
  if (!isAbsolute(inputDir)) throw new Error('Input path must be absolute');
  const verified = await verifyTestFunctionBundle(input, options);
  const manifestBytes = await readFile(join(input, 'manifest.json'));
  const sourceManifest = JSON.parse(decode(manifestBytes));
  const expectedRoutes = normalizeExpectedRoutes(options.expectedRoutes ?? expectedOpenRouterRoutes);
  const actualRoutes = {};
  const files = [];
  let chatCompletions = 0;
  let embeddings = 0;
  for (const item of sourceManifest.files) {
    const sourceBytes = await readFile(join(input, 'functions', item.path));
    if (sha256(sourceBytes) !== item.sha256) throw new Error('Source bundle changed during routing');
    const routed = routeSource(sourceBytes, item.path);
    if (routed.chatCompletions + routed.embeddings > 0) {
      actualRoutes[item.path] = [routed.chatCompletions, routed.embeddings];
    }
    chatCompletions += routed.chatCompletions;
    embeddings += routed.embeddings;
    files.push({
      path: item.path,
      sourceSha256: item.sha256,
      sourceBytes: sourceBytes.length,
      outputSha256: sha256(routed.bytes),
      outputBytes: routed.bytes.length,
      chatCompletions: routed.chatCompletions,
      embeddings: routed.embeddings,
      bytes: routed.bytes,
    });
  }
  if (JSON.stringify(normalizeExpectedRoutes(actualRoutes)) !== JSON.stringify(expectedRoutes)) {
    throw new Error('OpenRouter route inventory changed; review the new source before routing');
  }
  // Check again in case the source or its manifest changed while read.
  await verifyTestFunctionBundle(input, options);
  if (sha256(await readFile(join(input, 'manifest.json'))) !== sha256(manifestBytes)) {
    throw new Error('Source bundle manifest changed during routing');
  }
  const manifest = {
    format: 1,
    purpose: 'isolated-test-openrouter-relay',
    sourceBundleManifestSha256: sha256(manifestBytes),
    relayBaseUrl,
    counts: { chatCompletions, embeddings },
    files: files.map(({ bytes: _bytes, ...file }) => file),
  };
  return { input, files, manifest, verified };
}

export async function routeTestOpenRouterBundle(inputDir, outputDir, options = {}) {
  const target = await assertNewOutputParent(outputDir);
  const audited = await auditInputBundle(inputDir, options);
  const realInput = await realpath(audited.input);
  const realOutputParent = await realpath(dirname(target));
  if (target === audited.input || isWithin(audited.input, target) ||
      isWithin(realInput, realOutputParent)) {
    throw new Error('Output must not replace or nest within the reviewed input bundle');
  }
  await mkdir(target, { mode: 0o700 }); // Exclusive: never overwrite a previous bundle.
  try {
    await chmod(target, 0o700);
    const stage = join(target, '.staging');
    const functionsDir = join(stage, 'functions');
    await mkdir(stage, { mode: 0o700 });
    await mkdir(functionsDir, { mode: 0o700 });
    for (const name of includedDirectories) await mkdir(join(functionsDir, name), { mode: 0o700 });
    for (const file of audited.files) {
      const destination = join(functionsDir, file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, file.bytes, { flag: 'wx', mode: 0o600 });
      if (sha256(await readFile(destination)) !== file.outputSha256) {
        throw new Error('Routed file checksum mismatch while staging');
      }
    }
    if (options.afterCopy) await options.afterCopy();
    const reaudited = await auditInputBundle(inputDir, options);
    if (JSON.stringify(reaudited.manifest) !== JSON.stringify(audited.manifest)) {
      throw new Error('Source bundle changed while staging the routed bundle');
    }
    await writeFile(join(stage, 'manifest.json'), `${JSON.stringify(audited.manifest, null, 2)}\n`, {
      flag: 'wx', mode: 0o600,
    });
    await rename(functionsDir, join(target, 'functions'));
    await rename(join(stage, 'manifest.json'), join(target, 'manifest.json'));
    await rm(stage, { recursive: true });
    await verifyRoutedTestOpenRouterBundle(inputDir, target, options);
    return {
      bundleDir: target,
      fileCount: audited.files.length,
      counts: audited.manifest.counts,
    };
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyRoutedTestOpenRouterBundle(inputDir, routedDir, options = {}) {
  if (!isAbsolute(routedDir)) throw new Error('Routed bundle path must be absolute');
  const target = resolve(routedDir);
  const audited = await auditInputBundle(inputDir, options);
  await assertPrivateRegular(target, true);
  await assertPrivateRegular(join(target, 'functions'), true);
  await assertPrivateRegular(join(target, 'manifest.json'), false);
  if ((await readdir(target)).sort().join('\n') !== 'functions\nmanifest.json') {
    throw new Error('Routed bundle has unexpected top-level entries');
  }
  const actualManifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'));
  if (JSON.stringify(actualManifest) !== JSON.stringify(audited.manifest)) {
    throw new Error('Routed bundle manifest/source mismatch');
  }
  const files = new Map();
  const dirs = new Set();
  for (const name of await readdir(join(target, 'functions'))) {
    if (!includedDirectories.includes(name)) throw new Error('Routed bundle has unexpected function directory');
    await walkOutput(join(target, 'functions', name), name, files, dirs);
  }
  const expectedPaths = audited.files.map((file) => file.path).sort();
  if ([...files.keys()].sort().join('\n') !== expectedPaths.join('\n') ||
      [...dirs].sort().join('\n') !== expectedDirectories(expectedPaths).join('\n')) {
    throw new Error('Routed bundle has missing or extra files/directories');
  }
  for (const file of audited.files) {
    if (sha256(files.get(file.path)) !== file.outputSha256) {
      throw new Error(`Routed checksum mismatch: ${file.path}`);
    }
  }
  return {
    bundleDir: target,
    fileCount: audited.files.length,
    counts: audited.manifest.counts,
  };
}

function parseArgs(args) {
  if (args.length === 3 && args[0] === '--out') return { inputDir: args[1], outputDir: args[2] };
  if (args.length === 3 && args[0] === '--verify') return { inputDir: args[1], verifyDir: args[2] };
  throw new Error('Usage: route-test-openrouter.mjs --out|--verify /absolute/reviewed-bundle /absolute/routed-bundle');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = args.verifyDir
      ? await verifyRoutedTestOpenRouterBundle(args.inputDir, args.verifyDir)
      : await routeTestOpenRouterBundle(args.inputDir, args.outputDir);
    process.stdout.write(`Verified ${result.fileCount} isolated Edge sources; routed ${result.counts.chatCompletions} chat and ${result.counts.embeddings} embedding calls.\n`);
  } catch {
    process.stderr.write('Isolated OpenRouter routing failed: source, route inventory, privacy, or checksum mismatch. No source or secrets were printed.\n');
    process.exitCode = 1;
  }
}
