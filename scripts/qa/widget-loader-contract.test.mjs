import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const loaderSource = await readFile(new URL('../../public/embed.js', import.meta.url), 'utf8');

function createHarness() {
  const listeners = new Map();
  const timers = [];
  const appended = [];
  const removed = [];

  const container = {
    appendChild(element) {
      element.parentNode = container;
      appended.push(element);
      return element;
    },
    removeChild(element) {
      element.parentNode = null;
      removed.push(element);
      return element;
    },
  };

  const document = {
    currentScript: { src: 'https://assets.example.test/embed.js?v=2026-09-04-loader-2' },
    body: container,
    head: container,
    documentElement: container,
    querySelectorAll() { return []; },
    createElement(tagName) {
      const element = {
        tagName: String(tagName).toUpperCase(),
        style: {},
        attributes: {},
        parentNode: null,
        setAttribute(name, value) { this.attributes[name] = String(value); },
      };
      if (tagName === 'iframe') element.contentWindow = {};
      return element;
    },
  };

  const window = {
    crypto: {
      getRandomValues(values) {
        values.set([0x11, 0x22, 0x33, 0x44]);
        return values;
      },
    },
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type, callback) {
      if (listeners.get(type) === callback) listeners.delete(type);
    },
  };

  const context = {
    Array,
    Date: { now: () => 1_788_525_000_000 },
    Math,
    String,
    Uint32Array,
    URL,
    clearTimeout(timer) { if (timer) timer.active = false; },
    console: { info() {}, error() {} },
    document,
    encodeURIComponent,
    location: {
      href: 'https://shop.example.test/catalog',
      origin: 'https://shop.example.test',
    },
    setTimeout(callback, delay) {
      const timer = { callback, delay, active: true };
      timers.push(timer);
      return timer;
    },
    window,
  };
  window.window = window;

  vm.runInNewContext(loaderSource, context, { filename: 'public/embed.js' });

  return {
    appended,
    context,
    listeners,
    removed,
    timers,
    iframe: appended.find((element) => element.tagName === 'IFRAME'),
    widgetScript() {
      return appended.find((element) => element.tagName === 'SCRIPT' && /\/widget\.js\?/.test(element.src || ''));
    },
    dispatch(data, source) {
      listeners.get('message')?.({ data, source });
    },
    runTimer(delay) {
      const timer = timers.find((entry) => entry.active && entry.delay === delay);
      assert.ok(timer, `Missing active ${delay} ms timer`);
      timer.active = false;
      timer.callback();
    },
  };
}

test('HTML bootstrap wins and loads the content-addressed widget', () => {
  const harness = createHarness();
  assert.equal(harness.iframe.attributes.sandbox, 'allow-scripts');
  assert.match(harness.iframe.src, /parentOrigin=https%3A%2F%2Fshop\.example\.test/);
  const channel = decodeURIComponent(new URL(harness.iframe.src).hash.slice(1));

  harness.dispatch({
    type: 'volt-widget-version',
    channel,
    version: 'widget-d8da5cc307f128a5',
  }, harness.iframe.contentWindow);

  assert.match(harness.widgetScript().src, /widget\.js\?v=widget-d8da5cc307f128a5$/);
  assert.equal(harness.context.window.__voltWidgetLoader.source, 'html-bootstrap');
  assert.ok(harness.removed.includes(harness.iframe));
});

test('loader rejects forged source, channel and malformed versions', () => {
  const harness = createHarness();
  const channel = decodeURIComponent(new URL(harness.iframe.src).hash.slice(1));
  harness.dispatch({ type: 'volt-widget-version', channel, version: 'widget-d8da5cc307f128a5' }, {});
  harness.dispatch({ type: 'volt-widget-version', channel: 'forged', version: 'widget-d8da5cc307f128a5' }, harness.iframe.contentWindow);
  harness.dispatch({ type: 'volt-widget-version', channel, version: 'javascript:alert(1)' }, harness.iframe.contentWindow);
  assert.equal(harness.widgetScript(), undefined);

  harness.dispatch({ type: 'volt-widget-version', channel, version: 'widget-d8da5cc307f128a5' }, harness.iframe.contentWindow);
  assert.ok(harness.widgetScript());
});

test('legacy manifest starts only after the bootstrap grace period', () => {
  const harness = createHarness();
  assert.equal(harness.appended.filter((element) => /widget-version\.js/.test(element.src || '')).length, 0);
  harness.runTimer(1800);
  const manifest = harness.appended.find((element) => /widget-version\.js/.test(element.src || ''));
  assert.ok(manifest);
  harness.context.window.__voltWidgetVersion = 'widget-aaaaaaaaaaaaaaaa';
  manifest.onload();
  assert.match(harness.widgetScript().src, /widget\.js\?v=widget-aaaaaaaaaaaaaaaa$/);
  assert.equal(harness.context.window.__voltWidgetLoader.source, 'manifest-fallback');
});

test('time-bucket fallback prevents a permanently frozen asset URL', () => {
  const harness = createHarness();
  harness.runTimer(4000);
  assert.match(harness.widgetScript().src, /widget\.js\?v=t5961750$/);
  assert.equal(harness.context.window.__voltWidgetLoader.source, 'timeout-fallback');
});
