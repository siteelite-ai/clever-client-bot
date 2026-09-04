import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const widgetPath = new URL('../../public/widget.js', import.meta.url);
const manifestPath = new URL('../../public/widget-version.js', import.meta.url);
const jsonManifestPath = new URL('../../public/widget-version.json', import.meta.url);
const bootstrapPath = new URL('../../public/widget-bootstrap.html', import.meta.url);
const loaderPath = new URL('../../public/embed.js', import.meta.url);
const [widget, manifest, jsonManifestRaw, bootstrap, loader] = await Promise.all([
  readFile(widgetPath, 'utf8'),
  readFile(manifestPath, 'utf8'),
  readFile(jsonManifestPath, 'utf8'),
  readFile(bootstrapPath, 'utf8'),
  readFile(loaderPath, 'utf8'),
]);

const widgetMatch = widget.match(/var WIDGET_VERSION = '([^']+)'/);
const manifestMatch = manifest.match(/window\.__voltWidgetVersion = '([^']+)'/);
const bootstrapMatch = bootstrap.match(/var version = '([^']+)'/);
const jsonManifest = JSON.parse(jsonManifestRaw);
if (!widgetMatch || !manifestMatch || !bootstrapMatch || typeof jsonManifest.version !== 'string') {
  throw new Error('Widget version is missing from a release artifact');
}

const normalizedWidget = widget.replace(
  /var WIDGET_VERSION = '[^']+';/,
  "var WIDGET_VERSION = 'widget-CONTENT_HASH';",
);
const digest = createHash('sha256').update(normalizedWidget).digest('hex').slice(0, 16);
const expectedVersion = `widget-${digest}`;

const declaredVersions = [manifestMatch[1], bootstrapMatch[1], jsonManifest.version];
if (declaredVersions.some((version) => version !== widgetMatch[1])) {
  throw new Error(`Widget release artifacts differ: ${[widgetMatch[1], ...declaredVersions].join(' != ')}`);
}
if (widgetMatch[1] !== expectedVersion) {
  throw new Error(
    `Stale widget cache key: expected ${expectedVersion}, got ${widgetMatch[1]}. ` +
      'Update widget.js and every release manifest.',
  );
}
if (!widget.includes("typeof window.crypto.randomUUID === 'function'")) {
  throw new Error('Widget must generate UUID messageId values');
}
if (!loader.includes("bootstrapFrame.setAttribute('sandbox', 'allow-scripts')")) {
  throw new Error('Widget bootstrap iframe must remain sandboxed');
}
if (!loader.includes('event.source !== bootstrapFrame.contentWindow')) {
  throw new Error('Widget loader must authenticate the bootstrap window');
}
if (!loader.includes("data.channel !== channel")) {
  throw new Error('Widget loader must authenticate the bootstrap channel');
}
if (!loader.includes("encodeURIComponent(location.origin)")) {
  throw new Error('Widget loader must give the bootstrap an exact parent origin');
}
if (!bootstrap.includes("parent.postMessage") || !bootstrap.includes("new URL(targetOrigin).origin !== targetOrigin")) {
  throw new Error('Widget bootstrap must use a validated exact postMessage target origin');
}
if (!loader.includes("/^widget-[a-f0-9]{16}$/")) {
  throw new Error('Widget loader must validate content-hash release versions');
}
if (!loader.includes("setTimeout(loadLegacyManifest, 1800)")) {
  throw new Error('Cached JS manifest must not race the HTML bootstrap');
}

console.log(`Widget release contract OK: ${expectedVersion}`);
