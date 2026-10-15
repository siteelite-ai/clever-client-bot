import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('the self-hosted admin does not advertise a Lovable embed URL', async () => {
  const integration = await source('src/pages/Integration.tsx');
  assert.match(integration, /window\.location\.origin/);
  assert.doesNotMatch(integration, /https:\/\/[^"'\s]*lovable\.app/);
});

test('source loader preserves the published fallback while widget assets remain portable', async () => {
  const [loader, widget, html] = await Promise.all([
    source('public/embed.js'),
    source('public/widget.js'),
    source('index.html'),
  ]);
  assert.match(loader, /var base = 'https:\/\/clever-client-bot\.lovable\.app';/);
  assert.match(loader, /new URL\(self\.src, location\.href\)\.origin/);
  assert.doesNotMatch(widget + html, /https:\/\/[^"'\s]*lovable\.app/);
  assert.match(widget, /new URL\('logo-220volt-widget\.svg', document\.currentScript\.src\)/);
});

test('the private cabinet asks crawlers not to index it', async () => {
  const robots = await source('public/robots.txt');
  assert.match(robots, /^User-agent: \*\nDisallow: \/\n$/);
});
