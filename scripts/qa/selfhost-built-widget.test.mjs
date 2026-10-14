import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

// The generic Edge QA job runs before any frontend build. Its environment has
// no isolated test credentials, so only the dedicated post-build CI step should
// load and exercise this generated artifact. If credentials are set, missing
// build files remain a hard failure rather than being silently skipped.
const hasBuildConfig = Boolean(process.env.SELFHOST_TEST_SUPABASE_URL &&
  process.env.SELFHOST_TEST_SUPABASE_PUBLIC_KEY);
const widget = hasBuildConfig
  ? await readFile(new URL('../../dist-selfhost-test/widget.js', import.meta.url), 'utf8') : null;
const manifest = hasBuildConfig
  ? await readFile(new URL('../../dist-selfhost-test/widget-version.js', import.meta.url), 'utf8') : null;
const html = hasBuildConfig
  ? await readFile(new URL('../../dist-selfhost-test/index.html', import.meta.url), 'utf8') : null;
const json = hasBuildConfig
  ? JSON.parse(await readFile(new URL('../../dist-selfhost-test/widget-version.json', import.meta.url), 'utf8')) : null;

test('synthetic selfhost widget sends only to the test backend using apikey',
  { skip: !hasBuildConfig }, async () => {
  const endpoint = `${process.env.SELFHOST_TEST_SUPABASE_URL}/functions/v1/chat-consultant-v3`;
  const publicKey = process.env.SELFHOST_TEST_SUPABASE_PUBLIC_KEY;
  assert.ok(endpoint.startsWith('https://'));
  assert.ok(publicKey?.startsWith('sb_publishable_'));

  const calls = [];
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'outside-only',
    url: 'https://220volt.testdevops.ru/',
  });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.TextEncoder = TextEncoder;
  dom.window.TextDecoder = TextDecoder;
  dom.window.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return new Response([
      `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'test', phase: 'start' } })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Тестовый ответ.' } }] })}`,
      `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'test', phase: 'complete', products_count: 0 } })}`,
      'data: [DONE]',
      '',
    ].join('\n\n'), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  dom.window.eval(widget);
  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'Тестовый вопрос';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();

  const deadline = Date.now() + 2000;
  while (calls.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, endpoint);
  assert.equal(calls[0].headers.apikey, publicKey);
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(dom.window.sessionStorage.getItem('volt_widget_state'), null);
  assert.ok(dom.window.sessionStorage.getItem('volt_widget_state_selfhost_test'));
  while ((!dom.window.document.querySelector('#volt-widget-messages')?.textContent.includes('Тестовый ответ.') ||
          dom.window.document.querySelector('#volt-widget-new-chat')?.disabled) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.match(dom.window.document.querySelector('#volt-widget-messages')?.textContent ?? '', /Тестовый ответ/u);
  dom.window.close();
});

test('selfhost loader bootstrap, manifest, and widget share one content version',
  { skip: !hasBuildConfig }, () => {
  const widgetVersion = widget.match(/var WIDGET_VERSION = '(widget-[a-f0-9]{16})';/)?.[1];
  assert.ok(widgetVersion);
  assert.equal(json.version, widgetVersion);
  assert.match(manifest, new RegExp(`window\\.__voltWidgetVersion = '${widgetVersion}'`));
  assert.match(html, new RegExp(`var version = '${widgetVersion}'`));
});
