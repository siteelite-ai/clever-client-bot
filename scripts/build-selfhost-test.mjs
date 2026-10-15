import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, readdir, rename, rm, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { productionPublicKey, validateSelfhostTestConfig } from './selfhost-test-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist-selfhost-test');
const pending = path.join(root, 'dist-selfhost-test.pending');

// A failed invocation must not leave a deployable stale release. These are
// fixed generated directories immediately below this checkout, never paths
// sourced from arguments or environment. Delete before even reading config.
async function clearGenerated(target, expectedName) {
  if (root === path.parse(root).root || path.dirname(target) !== root || path.basename(target) !== expectedName) {
    throw new Error('Refusing to remove an unexpected build output path');
  }
  let stat;
  try { stat = await lstat(target); } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    await unlink(target); // Remove the link itself, never its target.
  } else if (stat.isDirectory()) {
    await rm(target, { recursive: true });
  } else {
    throw new Error('Refusing to replace a non-directory build output');
  }
}

await clearGenerated(output, 'dist-selfhost-test');
await clearGenerated(pending, 'dist-selfhost-test.pending');

try {
const originalPublicKey = productionPublicKey();
const config = validateSelfhostTestConfig({
  url: process.env.SELFHOST_TEST_SUPABASE_URL,
  publicKey: process.env.SELFHOST_TEST_SUPABASE_PUBLIC_KEY,
  backendKind: process.env.SELFHOST_TEST_BACKEND_KIND,
  originalPublicKey,
});

const child = spawnSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', pending], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    SELFHOST_TEST_ARTIFACT_BUILDER: '1',
    VITE_DEPLOY_TARGET: 'selfhost-test',
    VITE_SELFHOST_TEST_SUPABASE_URL: config.url,
    VITE_SELFHOST_TEST_SUPABASE_PUBLIC_KEY: config.publicKey,
    VITE_SELFHOST_TEST_BACKEND_KIND: config.backendKind,
  },
});
if (child.error) throw child.error;
if (child.status !== 0) throw new Error('The self-hosted Vite build failed');

function replaceExactlyOnce(value, marker, replacement, label) {
  const count = value.split(marker).length - 1;
  if (count !== 1) throw new Error(`Widget build marker ${label} must occur exactly once (got ${count})`);
  return value.replace(marker, replacement);
}

const widgetPath = path.join(pending, 'widget.js');
const manifestPath = path.join(pending, 'widget-version.js');
const jsonPath = path.join(pending, 'widget-version.json');
const htmlPath = path.join(pending, 'index.html');
const loaderPath = path.join(pending, 'embed.js');
let widget = await readFile(widgetPath, 'utf8');
let manifest = await readFile(manifestPath, 'utf8');
let html = await readFile(htmlPath, 'utf8');
let loader = await readFile(loaderPath, 'utf8');
const json = JSON.parse(await readFile(jsonPath, 'utf8'));

// These exact source markers are intentionally narrow. A changed widget must
// be reviewed and this transform updated, never silently patched by a broad
// production-key search. The checked-in public/widget.js remains untouched.
widget = replaceExactlyOnce(
  widget,
  "    supabaseUrl: 'https://supabase-proxy.bold-dawn-058f.workers.dev',",
  `    supabaseUrl: ${JSON.stringify(config.url)},`,
  'proxy URL',
);
widget = replaceExactlyOnce(
  widget,
  `    supabaseKey: '${originalPublicKey}',`,
  `    supabaseKey: ${JSON.stringify(config.publicKey)},`,
  'public key',
);
widget = replaceExactlyOnce(
  widget,
  "    directOrigin: 'https://yngoixmvmxdfxokuafjp.supabase.co'",
  `    directOrigin: ${JSON.stringify(config.url)}`,
  'direct origin',
);
widget = replaceExactlyOnce(
  widget,
  `    var proxyEndpoint = { url: CONFIG.supabaseUrl, label: 'proxy' };\n` +
    `    var directEndpoint = { url: CONFIG.directOrigin, label: 'direct' };\n` +
    `    var streamEndpoints = Date.now() < proxyDirectFirstUntil\n` +
    `      ? [directEndpoint, proxyEndpoint]\n` +
    `      : [proxyEndpoint, directEndpoint];`,
  `    var streamEndpoints = [{ url: CONFIG.directOrigin, label: 'direct' }];`,
  'test-only direct transport',
);
widget = replaceExactlyOnce(
  widget,
  "  const STORAGE_KEY = 'volt_widget_state';",
  "  const STORAGE_KEY = 'volt_widget_state_selfhost_test';",
  'isolated browser session storage',
);
if (config.publicKey.startsWith('sb_publishable_')) {
  widget = replaceExactlyOnce(
    widget,
    `        'Content-Type': 'application/json',\n` +
      `        'Authorization': 'Bearer ' + CONFIG.supabaseKey,\n` +
      `        'apikey': CONFIG.supabaseKey`,
    `        'Content-Type': 'application/json',\n` +
      `        'apikey': CONFIG.supabaseKey`,
    'publishable-key request headers',
  );
}

// The checked-in loader keeps the Lovable fallback for the existing deployment.
// Only the isolated self-hosted artifact redirects this one literal fallback;
// src-derived origins continue to win unchanged in both environments.
loader = replaceExactlyOnce(
  loader,
  "  var base = 'https://clever-client-bot.lovable.app';",
  "  var base = 'https://chat-volt-next.testdevops.ru';",
  'self-hosted loader fallback',
);

const versionMatch = widget.match(/var WIDGET_VERSION = '(widget-[a-f0-9]{16})';/g);
if (!versionMatch || versionMatch.length !== 1) throw new Error('Widget version marker must occur exactly once');
const originalVersion = versionMatch[0].slice("var WIDGET_VERSION = '".length, -2);
if (!manifest.includes(originalVersion) || !html.includes(originalVersion) || json.version !== originalVersion) {
  throw new Error('Widget release markers disagree before test build');
}
const normalized = replaceExactlyOnce(
  widget,
  `var WIDGET_VERSION = '${originalVersion}';`,
  "var WIDGET_VERSION = 'widget-CONTENT_HASH';",
  'normalized widget version',
);
const version = `widget-${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;
widget = replaceExactlyOnce(widget, `var WIDGET_VERSION = '${originalVersion}';`, `var WIDGET_VERSION = '${version}';`, 'widget version');
manifest = replaceExactlyOnce(manifest, `window.__voltWidgetVersion = '${originalVersion}';`, `window.__voltWidgetVersion = '${version}';`, 'JS manifest version');
html = replaceExactlyOnce(html, `var version = '${originalVersion}';`, `var version = '${version}';`, 'HTML bootstrap version');
json.version = version;
json.updated = new Date().toISOString();

await Promise.all([
  writeFile(widgetPath, widget),
  writeFile(manifestPath, manifest),
  writeFile(htmlPath, html),
  writeFile(loaderPath, loader),
  writeFile(jsonPath, `${JSON.stringify(json, null, 2)}\n`),
]);

async function filesBelow(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const paths = await Promise.all(entries.map(async entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesBelow(full) : [full];
  }));
  return paths.flat();
}

const files = await filesBelow(pending);
const forbidden = [
  'yngoixmvmxdfxokuafjp',
  'supabase-proxy.bold-dawn-058f.workers.dev',
  'clever-client-bot.lovable.app',
  originalPublicKey,
];
for (const file of files) {
  const data = await readFile(file);
  if (forbidden.some(value => data.includes(value))) {
    throw new Error(`Production backend reference survived in ${path.relative(pending, file)}`);
  }
  if (file.endsWith('.map')) throw new Error('Source maps must not be shipped with the test cabinet');
}

const appAssets = files.filter(file => file.includes(`${path.sep}assets${path.sep}`) && file.endsWith('.js'));
const appUsesTestBackend = (await Promise.all(appAssets.map(file => readFile(file, 'utf8'))))
  .some(data => data.includes(config.url) && data.includes(config.publicKey));
if (!widget.includes(config.url) || !widget.includes(config.publicKey) || !appUsesTestBackend) {
  throw new Error('The widget or cabinet does not use the explicit test backend');
}
if (config.publicKey.startsWith('sb_publishable_') &&
    widget.includes("'Authorization': 'Bearer ' + CONFIG.supabaseKey")) {
  throw new Error('Publishable keys must not be sent as JWT bearer tokens');
}
if (!manifest.includes(version) || !html.includes(version) || json.version !== version) {
  throw new Error('Self-hosted widget release versions disagree');
}
if (!loader.includes("bootstrapFrame.setAttribute('sandbox', 'allow-scripts')") ||
    !loader.includes("encodeURIComponent(location.origin)") ||
    !loader.includes("'/widget.js?v=' + encodeURIComponent(version)")) {
  throw new Error('Self-hosted iframe loader no longer accepts the versioned widget contract');
}
await rename(pending, output);
console.log(`Self-hosted test artifact verified: dist-selfhost-test (${version})`);
} catch (error) {
  await clearGenerated(pending, 'dist-selfhost-test.pending');
  await clearGenerated(output, 'dist-selfhost-test');
  throw error;
}
