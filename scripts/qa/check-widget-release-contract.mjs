import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const widgetPath = new URL('../../public/widget.js', import.meta.url);
const manifestPath = new URL('../../public/widget-version.js', import.meta.url);
const [widget, manifest] = await Promise.all([
  readFile(widgetPath, 'utf8'),
  readFile(manifestPath, 'utf8'),
]);

const widgetMatch = widget.match(/var WIDGET_VERSION = '([^']+)'/);
const manifestMatch = manifest.match(/window\.__voltWidgetVersion = '([^']+)'/);
if (!widgetMatch || !manifestMatch) {
  throw new Error('Widget version is missing from widget.js or widget-version.js');
}

const normalizedWidget = widget.replace(
  /var WIDGET_VERSION = '[^']+';/,
  "var WIDGET_VERSION = 'widget-CONTENT_HASH';",
);
const digest = createHash('sha256').update(normalizedWidget).digest('hex').slice(0, 16);
const expectedVersion = `widget-${digest}`;

if (widgetMatch[1] !== manifestMatch[1]) {
  throw new Error(`Widget and manifest versions differ: ${widgetMatch[1]} != ${manifestMatch[1]}`);
}
if (widgetMatch[1] !== expectedVersion) {
  throw new Error(
    `Stale widget cache key: expected ${expectedVersion}, got ${widgetMatch[1]}. ` +
      'Update both public/widget.js and public/widget-version.js.',
  );
}
if (!widget.includes("typeof window.crypto.randomUUID === 'function'")) {
  throw new Error('Widget must generate UUID messageId values');
}

console.log(`Widget release contract OK: ${expectedVersion}`);
