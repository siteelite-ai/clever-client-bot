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

function bootWidget({ state, now = Date.now(), confirmResult = true, fetchImpl, source = widgetSource } = {}) {
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
  dom.window.eval(source);
  return dom;
}

function withTransportTimeouts({ connect = 20, idle = 35, total = 250 } = {}) {
  return widgetSource
    .replace('var STREAM_CONNECT_TIMEOUT_MS = 15000;', `var STREAM_CONNECT_TIMEOUT_MS = ${connect};`)
    .replace('var STREAM_IDLE_TIMEOUT_MS = 30000;', `var STREAM_IDLE_TIMEOUT_MS = ${idle};`)
    .replace('var STREAM_TOTAL_TIMEOUT_MS = 155000;', `var STREAM_TOTAL_TIMEOUT_MS = ${total};`);
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

test('accepted request is replayed after an intro was delivered but products were interrupted', async () => {
  let fetchCount = 0;
  let executionCount = 0;
  let firstMessageId = null;
  const logId = 'accepted-after-intro-log';
  const productMarkdown = '- **[Кабель ВВГ нг LS 3*1,5 ЕА](https://220volt.kz/cable)**\n  Цена: *391* ₸/м';
  const dom = bootWidget({
    fetchImpl: async (_url, init) => {
      fetchCount += 1;
      const payload = JSON.parse(init.body);
      if (!payload.resumeOnly) {
        executionCount += 1;
        firstMessageId = payload.messageId;
        let pullCount = 0;
        const interrupted = new ReadableStream({
          pull(controller) {
            pullCount += 1;
            if (pullCount === 1) {
              controller.enqueue(new TextEncoder().encode([
                `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'start' } })}`,
                `data: ${JSON.stringify({ choices: [{ delta: { content: 'Ищу точную маркировку.' } }] })}`,
                '',
              ].join('\n\n')));
              return;
            }
            controller.error(new Error('simulated interruption after intro'));
          },
        });
        return new Response(interrupted, { headers: { 'Content-Type': 'text/event-stream' } });
      }

      assert.equal(payload.messageId, firstMessageId);
      const replay = [
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'start' } })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Ищу точную маркировку.' } }] })}`,
        `data: ${JSON.stringify({ v3_event: { type: 'products_block', markdown: productMarkdown, count: 1 } })}`,
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'complete', products_count: 1 } })}`,
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(replay, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'найди кабель ввг 3*1,5 самый дешевый';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();

  const deadline = Date.now() + 2_000;
  while (!visibleMessages(dom).includes('Кабель ВВГ нг LS 3*1,5 ЕА') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(fetchCount, 2, 'one execution plus one replay is expected');
  assert.equal(executionCount, 1, 'replay must not execute catalog search again');
  assert.match(visibleMessages(dom), /Кабель ВВГ нг LS 3\*1,5 ЕА/u);
  assert.doesNotMatch(visibleMessages(dom), /Ответ получен не полностью|ошибка соединения|Соединение прервалось/iu);
  dom.window.close();
});

test('SSE heartbeats keep a healthy response alive beyond one idle interval', async () => {
  const logId = 'heartbeat-long-stream-log';
  let interval = null;
  const dom = bootWidget({
    source: withTransportTimeouts({ connect: 15, idle: 30, total: 250 }),
    fetchImpl: async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(': stream-open\n\n'));
          let ticks = 0;
          interval = setInterval(() => {
            ticks += 1;
            if (ticks < 6) {
              controller.enqueue(new TextEncoder().encode(': keep-alive\n\n'));
              return;
            }
            clearInterval(interval);
            controller.enqueue(new TextEncoder().encode([
              `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'start' } })}`,
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'Долгий ответ завершён.' } }] })}`,
              `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'complete', products_count: 0 } })}`,
              'data: [DONE]',
              '',
            ].join('\n\n')));
          }, 15);
        },
        cancel() {
          if (interval) clearInterval(interval);
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'Долгий запрос';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();

  const deadline = Date.now() + 1_000;
  while (!visibleMessages(dom).includes('Долгий ответ завершён.') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.match(visibleMessages(dom), /Долгий ответ завершён\./u);
  assert.doesNotMatch(visibleMessages(dom), /ошибка соединения|Соединение прервалось/iu);
  dom.window.close();
});

test('[DONE] completes immediately even when the HTTP connection stays open', async () => {
  let cancelled = false;
  const dom = bootWidget({
    source: withTransportTimeouts({ connect: 20, idle: 80, total: 200 }),
    fetchImpl: async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode([
            `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'logical-done-log', phase: 'start' } })}`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'Готово без ожидания закрытия сокета.' } }] })}`,
            `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'logical-done-log', phase: 'complete', products_count: 0 } })}`,
            'data: [DONE]',
            '',
          ].join('\n\n')));
          // Intentionally keep the transport open. The logical SSE terminator
          // must be sufficient for the UI to finish and cancel the reader.
        },
        cancel() { cancelled = true; },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'Проверка логического завершения';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();

  const deadline = Date.now() + 300;
  while (dom.window.document.querySelector('#volt-widget-send').disabled && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(dom.window.document.querySelector('#volt-widget-send').disabled, false);
  assert.equal(cancelled, true, 'reader should be cancelled after logical completion');
  assert.match(visibleMessages(dom), /Готово без ожидания закрытия сокета\./u);
  assert.doesNotMatch(visibleMessages(dom), /Ответ получен не полностью|ошибка соединения/iu);
  dom.window.close();
});

test('an unreachable proxy fails over quickly to direct Supabase', async () => {
  const urls = [];
  const dom = bootWidget({
    source: withTransportTimeouts({ connect: 20, idle: 50, total: 150 }),
    fetchImpl: async (url, init) => {
      urls.push(String(url));
      if (urls.length === 1) {
        return new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      const sse = [
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'direct-fallback-log', phase: 'start' } })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Ответ через резервный маршрут.' } }] })}`,
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'direct-fallback-log', phase: 'complete', products_count: 0 } })}`,
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const started = Date.now();
  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'Проверка быстрого переключения';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();

  const deadline = Date.now() + 500;
  while (!visibleMessages(dom).includes('Ответ через резервный маршрут.') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(urls.length, 2);
  assert.match(urls[0], /supabase-proxy\.bold-dawn-058f\.workers\.dev/u);
  assert.match(urls[1], /yngoixmvmxdfxokuafjp\.supabase\.co/u);
  assert.ok(Date.now() - started < 150, 'failover must use the short connection timeout');
  assert.match(visibleMessages(dom), /Ответ через резервный маршрут\./u);
  assert.doesNotMatch(visibleMessages(dom), /ошибка соединения/iu);
  dom.window.close();
});

test('all routes share one deadline instead of waiting a full timeout each', async () => {
  let fetchCount = 0;
  const dom = bootWidget({
    source: withTransportTimeouts({ connect: 25, idle: 50, total: 35 }),
    fetchImpl: async (_url, init) => {
      fetchCount += 1;
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    },
  });

  const started = Date.now();
  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'Проверка общего дедлайна';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();

  const deadline = Date.now() + 300;
  while (!/ошибка соединения/iu.test(visibleMessages(dom)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(fetchCount, 2);
  assert.ok(Date.now() - started < 90, 'the second route must receive only the shared remaining budget');
  assert.match(visibleMessages(dom), /ошибка соединения/iu);
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
