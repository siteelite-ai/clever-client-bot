import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const widgetSource = await readFile(new URL('../../public/widget.js', import.meta.url), 'utf8');
const storageKey = 'volt_widget_state';

function sse(events) {
  return events.map((event) => `data: ${JSON.stringify(event)}`)
    .concat('data: [DONE]', '').join('\n\n');
}

function bootWidget({ savedState, fetchImpl }) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'outside-only',
    url: 'https://220volt.testdevops.ru/',
  });
  dom.window.HTMLElement.prototype.scrollIntoView = function() {};
  dom.window.TextEncoder = TextEncoder;
  dom.window.TextDecoder = TextDecoder;
  dom.window.fetch = fetchImpl;
  if (savedState) {
    dom.window.sessionStorage.setItem(storageKey, JSON.stringify(savedState));
  }
  dom.window.eval(widgetSource);
  return dom;
}

function savedState(dom) {
  return JSON.parse(dom.window.sessionStorage.getItem(storageKey));
}

async function waitUntil(condition, label) {
  const deadline = Date.now() + 2_000;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(condition(), label);
}

function typeAndSend(dom, message) {
  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = message;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();
}

test('Gallant chip scope crosses reload as server-owned context, not a browser pending slot', async () => {
  const payloads = [];
  const replies = [
    { value: 'Выключатели', label: 'Выключатели' },
    { value: 'Розетки', label: 'Розетки' },
  ];
  const scope = {
    kind: 'named_series_section',
    entity: 'Gallant',
    leaf: 'Розетки',
    source_slot_id: 'catalog-slot-1',
  };
  const responses = [
    sse([
      { v3_event: { type: 'diagnostic', log_id: 'broad-turn', phase: 'start' } },
      { choices: [{ delta: { content: 'Какой раздел Gallant показать?' } }] },
      { v3_event: { type: 'quick_replies', facet_key: 'catalog_section', replies } },
      { v3_event: { type: 'slot_update', slots: { pending_clarification: {
        status: 'pending', slot_id: 'catalog-slot-1', facet_key: 'catalog_section',
        question: 'Какой раздел Gallant показать?', options: replies,
        scope: { kind: 'broad_assortment', token: 'Gallant' },
      } } } },
      { v3_event: { type: 'diagnostic', log_id: 'broad-turn', phase: 'complete', products_count: 0 } },
    ]),
    sse([
      { v3_event: { type: 'diagnostic', log_id: 'chip-turn', phase: 'start' } },
      { v3_event: { type: 'slot_update', slots: {} } },
      { choices: [{ delta: { content: 'Показываю товары серии Gallant в разделе «Розетки».' } }] },
      { v3_event: { type: 'products_block', count: 1,
        markdown: '- **[Розетка двойная Gallant](https://220volt.kz/catalog/example/gallant-double/)**\n  Цена: *4 595* ₸' } },
      { v3_event: { type: 'active_selection_scope', scope } },
      { v3_event: { type: 'diagnostic', log_id: 'chip-turn', phase: 'complete', products_count: 1 } },
    ]),
    sse([
      { v3_event: { type: 'diagnostic', log_id: 'refinement-turn', phase: 'start' } },
      { choices: [{ delta: { content: 'Уточнение принято.' } }] },
      { v3_event: { type: 'diagnostic', log_id: 'refinement-turn', phase: 'complete', products_count: 0 } },
    ]),
  ];
  const fetchImpl = async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    const body = responses[payloads.length - 1];
    assert.ok(body, 'unexpected extra widget request');
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  };

  const first = bootWidget({ fetchImpl });
  typeAndSend(first, 'покажи ассортимент Gallant на сайте');
  await waitUntil(() => first.window.document.querySelectorAll('.volt-quick-reply').length === 2,
    'server-bound section chips should appear');
  const socketsChip = [...first.window.document.querySelectorAll('.volt-quick-reply')]
    .find((button) => button.textContent === 'Розетки');
  socketsChip.click();
  await waitUntil(() => savedState(first)?.history?.at(-1)?.content?.includes('Розетка двойная Gallant'),
    'chip response and its card should be persisted');
  const persisted = savedState(first);
  assert.deepEqual(persisted.dialogSlots, {});
  assert.equal(payloads[1].dialogSlots.pending_clarification.slot_id, 'catalog-slot-1');
  first.window.close();

  const reloaded = bootWidget({ savedState: persisted, fetchImpl });
  assert.match(reloaded.window.document.querySelector('#volt-widget-messages').textContent,
    /Розетка двойная Gallant/u);
  typeAndSend(reloaded, 'двойные электрические розетки');
  await waitUntil(() => payloads.length === 3 &&
    savedState(reloaded)?.history?.at(-1)?.content === 'Уточнение принято.',
  'third request should complete after reload');

  assert.equal(payloads[2].sessionId, persisted.sessionId);
  assert.equal(payloads[2].message, 'двойные электрические розетки');
  assert.deepEqual(payloads[2].dialogSlots, {});
  assert.equal(payloads[2].history.some((turn) => turn.role === 'user' &&
    turn.content === 'покажи ассортимент Gallant на сайте'), true);
  assert.equal(payloads[2].history.some((turn) => turn.role === 'user' &&
    turn.content === 'Розетки'), true);
  assert.equal(payloads[2].history.some((turn) => turn.role === 'assistant' &&
    turn.content.includes('Розетка двойная Gallant')), true);
  assert.equal(payloads[2].history.some((turn) => turn.content === 'двойные электрические розетки'), false);
  reloaded.window.close();
});
