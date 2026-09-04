import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { JSDOM } from 'jsdom';

const widgetSource = await readFile(new URL('../../public/widget.js', import.meta.url), 'utf8');
const STORAGE_KEY = 'volt_widget_state';
const SESSION_TTL_MS = 30 * 60 * 1000;
const GREETING_FRAGMENT = 'Я AI-консультант 220volt.kz';

function savedDialogue(updatedAt) {
  return {
    sessionId: 'session_saved_customer_test',
    history: [
      { role: 'assistant', content: 'Здравствуйте! Старое приветствие.' },
      { role: 'user', content: 'старый вопрос про кабель' },
      { role: 'assistant', content: 'старый ответ про кабель' },
    ],
    dialogSlots: {
      cable: { status: 'pending', value: '2*1,5' },
    },
    updatedAt,
  };
}

function bootWidget({ state, now = Date.now(), confirmResult = true, fetchImpl } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'outside-only',
    url: 'https://220volt.testdevops.ru/',
  });
  dom.window.HTMLElement.prototype.scrollIntoView = function() {};
  dom.window.confirm = () => confirmResult;
  dom.window.Date.now = () => now;
  dom.window.TextDecoder = TextDecoder;
  dom.window.fetch = fetchImpl ?? (async () => {
    throw new Error('Unexpected fetch in widget session-state test');
  });
  if (state) dom.window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  dom.window.eval(widgetSource);
  return dom;
}

function readState(dom) {
  const raw = dom.window.sessionStorage.getItem(STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
}

function visibleMessages(dom) {
  return dom.window.document.querySelector('#volt-widget-messages')?.textContent ?? '';
}

test('recent stored dialogue is restored visibly instead of becoming hidden model context', () => {
  const now = 1_800_000_000_000;
  const dom = bootWidget({ state: savedDialogue(now - 1_000), now });

  assert.match(visibleMessages(dom), /старый вопрос про кабель/u);
  assert.match(visibleMessages(dom), /старый ответ про кабель/u);
  assert.equal(readState(dom).sessionId, 'session_saved_customer_test');
  assert.equal(dom.window.document.querySelectorAll('[aria-label="Новый диалог"]').length, 1);
  dom.window.close();
});

test('expired dialogue is discarded on initialization', () => {
  const now = 1_800_000_000_000;
  const dom = bootWidget({ state: savedDialogue(now - SESSION_TTL_MS - 1), now });

  assert.doesNotMatch(visibleMessages(dom), /старый вопрос/u);
  assert.match(visibleMessages(dom), new RegExp(GREETING_FRAGMENT, 'u'));
  assert.equal(readState(dom), null);
  dom.window.close();
});

test('legacy dialogue without updatedAt is discarded', () => {
  const state = savedDialogue(Date.now());
  delete state.updatedAt;
  const dom = bootWidget({ state });

  assert.doesNotMatch(visibleMessages(dom), /старый вопрос/u);
  assert.match(visibleMessages(dom), new RegExp(GREETING_FRAGMENT, 'u'));
  assert.equal(readState(dom), null);
  dom.window.close();
});

test('new dialogue control rotates session and clears history and slots', () => {
  const now = 1_800_000_000_000;
  const dom = bootWidget({ state: savedDialogue(now - 1_000), now, confirmResult: true });
  dom.window.document.querySelector('[aria-label="Новый диалог"]').click();

  const state = readState(dom);
  assert.notEqual(state.sessionId, 'session_saved_customer_test');
  assert.deepEqual(state.dialogSlots, {});
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].role, 'assistant');
  assert.equal(state.updatedAt, now);
  assert.doesNotMatch(visibleMessages(dom), /старый вопрос/u);
  assert.match(visibleMessages(dom), new RegExp(GREETING_FRAGMENT, 'u'));
  dom.window.close();
});

test('canceling new dialogue keeps the current visible context', () => {
  const now = 1_800_000_000_000;
  const dom = bootWidget({ state: savedDialogue(now - 1_000), now, confirmResult: false });
  dom.window.document.querySelector('[aria-label="Новый диалог"]').click();

  assert.equal(readState(dom).sessionId, 'session_saved_customer_test');
  assert.match(visibleMessages(dom), /старый вопрос про кабель/u);
  dom.window.close();
});

test('an open tab expires its dialogue after inactivity', () => {
  const now = 1_800_000_000_000;
  const dom = bootWidget({ state: savedDialogue(now - 1_000), now });
  dom.window.Date.now = () => now + SESSION_TTL_MS + 1;
  dom.window.document.querySelector('[aria-label="Открыть чат"]').click();

  const state = readState(dom);
  assert.notEqual(state.sessionId, 'session_saved_customer_test');
  assert.deepEqual(state.dialogSlots, {});
  assert.doesNotMatch(visibleMessages(dom), /старый вопрос/u);
  dom.window.close();
});

test('server boundary automatically isolates a self-contained new topic without a user reset', async () => {
  const now = 1_800_000_000_000;
  const boundarySessionId = 'session_automatic_new_topic';
  const sse = [
    `data: ${JSON.stringify({ v3_event: { type: 'conversation_boundary', mode: 'new_task', session_id: boundarySessionId } })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'Нашёл лампы.' } }] })}`,
    `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'test-log', phase: 'complete', products_count: 0 } })}`,
    'data: [DONE]',
    '',
  ].join('\n\n');
  const dom = bootWidget({
    state: savedDialogue(now - 1_000),
    now,
    fetchImpl: async () => new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }),
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'а у тебя есть лампы кукуруза?';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();

  const deadline = Date.now() + 2_000;
  while (readState(dom)?.history?.at(-1)?.content !== 'Нашёл лампы.' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const state = readState(dom);
  assert.equal(state.sessionId, boundarySessionId);
  assert.deepEqual(state.dialogSlots, {});
  assert.deepEqual(state.history.map((message) => message.content), [
    'Здравствуйте! 👋 Я AI-консультант 220volt.kz. Помогу подобрать электроинструменты, расскажу о доставке и оплате. Что вас интересует?',
    'а у тебя есть лампы кукуруза?',
    'Нашёл лампы.',
  ]);
  assert.match(visibleMessages(dom), /старый вопрос про кабель/u);
  assert.equal(dom.window.document.querySelectorAll('.volt-topic-divider').length, 1);
  assert.match(visibleMessages(dom), /Новая тема/u);
  dom.window.close();
});

test('widget renders user and assistant HTML as inert text', async () => {
  const maliciousAssistant = '<img src=x onerror=alert(1)> [click](javascript:alert(2))';
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: maliciousAssistant } }] })}`,
    `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'xss-test', phase: 'complete', products_count: 0 } })}`,
    'data: [DONE]',
    '',
  ].join('\n\n');
  const dom = bootWidget({
    fetchImpl: async () => new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }),
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = '<svg onload=alert(3)>найди лампу</svg>';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();

  const deadline = Date.now() + 2_000;
  while (readState(dom)?.history?.at(-1)?.content !== maliciousAssistant && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const messages = dom.window.document.querySelector('#volt-widget-messages');
  assert.equal(messages.querySelectorAll('img, svg').length, 0);
  assert.equal(messages.querySelectorAll('a[href^="javascript:"]').length, 0);
  assert.match(messages.textContent, /<svg onload=alert\(3\)>найди лампу<\/svg>/u);
  assert.match(messages.textContent, /<img src=x onerror=alert\(1\)>/u);
  dom.window.close();
});

test('accepted request is never executed again when its SSE connection breaks', async () => {
  let fetchCount = 0;
  let executionCount = 0;
  let firstMessageId = null;
  const logId = 'accepted-request-log';
  const dom = bootWidget({
    fetchImpl: async (_url, init) => {
      fetchCount += 1;
      const payload = JSON.parse(init.body);
      if (!payload.resumeOnly) {
        executionCount += 1;
        firstMessageId = payload.messageId;
      } else {
        assert.equal(payload.messageId, firstMessageId);
        const replay = [
          `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'start' } })}`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'Восстановленный ответ.' } }] })}`,
          `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'complete', products_count: 0 } })}`,
          'data: [DONE]',
          '',
        ].join('\n\n');
        return new Response(replay, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      let pullCount = 0;
      const body = new ReadableStream({
        pull(controller) {
          pullCount += 1;
          if (pullCount === 1) {
            controller.enqueue(new TextEncoder().encode(
              `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'start' } })}\n\n`,
            ));
            return;
          }
          controller.error(new Error('simulated transport break'));
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'Какой ИБП подойдет для газового котла мощностью 250 ватт?';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();

  const deadline = Date.now() + 2_000;
  while (!visibleMessages(dom).includes('Восстановленный ответ.') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(fetchCount, 2, 'one execution plus one replay-only transport request is expected');
  assert.equal(executionCount, 1, 'an accepted message must have exactly one server execution');
  assert.match(visibleMessages(dom), /Восстановленный ответ\./u);
  assert.match(visibleMessages(dom), new RegExp(logId, 'u'));
  assert.doesNotMatch(visibleMessages(dom), /произошла ошибка соединения/iu);
  dom.window.close();
});

test('SSE is parsed by payload when an intermediary rewrites content-type', async () => {
  let fetchCount = 0;
  const sse = [
    `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'proxy-sse-log', phase: 'start' } })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'Подходящий ответ.' } }] })}`,
    `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'proxy-sse-log', phase: 'complete', products_count: 0 } })}`,
    'data: [DONE]',
    '',
  ].join('\n\n');
  const dom = bootWidget({
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response(sse, { headers: { 'Content-Type': 'text/plain' } });
    },
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'Тест ответа через посредника';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();

  const deadline = Date.now() + 2_000;
  while (!visibleMessages(dom).includes('Подходящий ответ.') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(fetchCount, 1);
  assert.match(visibleMessages(dom), /Подходящий ответ\./u);
  dom.window.close();
});
