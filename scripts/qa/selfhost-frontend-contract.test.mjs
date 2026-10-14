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

test('public widget assets do not require the Lovable host', async () => {
  const [loader, widget, html] = await Promise.all([
    source('public/embed.js'),
    source('public/widget.js'),
    source('index.html'),
  ]);
  assert.doesNotMatch(loader + widget + html, /https:\/\/[^"'\s]*lovable\.app/);
  assert.match(widget, /new URL\('logo-220volt-widget\.svg', document\.currentScript\.src\)/);
});

test('the private cabinet asks crawlers not to index it', async () => {
  const robots = await source('public/robots.txt');
  assert.match(robots, /^User-agent: \*\nDisallow: \/\n$/);
});
