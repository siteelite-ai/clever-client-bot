import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { JSDOM } from 'jsdom';

const widgetSource = await readFile(new URL('../../public/widget.js', import.meta.url), 'utf8');
const chatV3Source = await readFile(new URL('../../supabase/functions/chat-consultant-v3/index.ts', import.meta.url), 'utf8');
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

function bootWidget({ state, now, confirmResult = true, fetchImpl, source = widgetSource } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'outside-only',
    url: 'https://220volt.testdevops.ru/',
  });
  dom.window.HTMLElement.prototype.scrollIntoView = function() {};
  dom.window.confirm = () => confirmResult;
  if (Number.isFinite(now)) dom.window.Date.now = () => now;
  dom.window.TextEncoder = TextEncoder;
  dom.window.TextDecoder = TextDecoder;
  dom.window.fetch = fetchImpl ?? (async () => {
    throw new Error('Unexpected fetch in widget session-state test');
  });
  if (state) dom.window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  dom.window.eval(source);
  return dom;
}

function withTransportTimeouts({ connect = 20, accept = 200, idle = 35, total = 250 } = {}) {
  return widgetSource
    .replace('var STREAM_CONNECT_TIMEOUT_MS = 15000;', `var STREAM_CONNECT_TIMEOUT_MS = ${connect};`)
    .replace('var STREAM_ACCEPT_TIMEOUT_MS = 15000;', `var STREAM_ACCEPT_TIMEOUT_MS = ${accept};`)
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

function clarificationSse({ replies, slotReplies = replies, facetKey = 'power_phase', slotFacetKey = facetKey, slotQuestion = 'Какое питание у оборудования?', assistantText = slotQuestion, complete = true, boundary = null, duplicate = false } = {}) {
  const events = [
    { v3_event: { type: 'diagnostic', log_id: 'quick-reply-test-log', phase: 'start' } },
    { choices: [{ delta: { content: assistantText } }] },
    { v3_event: { type: 'quick_replies', facet_key: facetKey, replies } },
    ...(duplicate ? [{ v3_event: { type: 'quick_replies', facet_key: facetKey, replies } }] : []),
    ...(boundary ? [{ v3_event: { type: 'conversation_boundary', mode: 'new_task', session_id: boundary } }] : []),
    { v3_event: { type: 'slot_update', slots: {
      pending_clarification: {
        status: 'pending',
        slot_id: 'quick-reply-slot',
        facet_key: slotFacetKey,
        question: slotQuestion,
        options: slotReplies,
      },
    } } },
    ...(complete ? [{ v3_event: { type: 'diagnostic', log_id: 'quick-reply-test-log', phase: 'complete', products_count: 0 } }] : []),
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}`).concat('data: [DONE]', '').join('\n\n');
}

function freeformClarificationSse({ complete = true, includeSlot = true, slotId = 'freeform-slot-1' } = {}) {
  const events = [
    { v3_event: { type: 'diagnostic', log_id: 'freeform-clarification-log', phase: 'start' } },
    { choices: [{ delta: { content: 'Какова площадь двора в м²?' } }] },
    ...(includeSlot ? [{ v3_event: { type: 'slot_update', slots: {
      pending_clarification: {
        status: 'pending', slot_id: slotId, facet_key: 'yard_area',
        question: 'Укажите площадь двора.', options: [],
        scope: { kind: 'selection_readiness', token: 'yard-floodlight' },
      },
    } } }] : []),
    ...(complete ? [{ v3_event: {
      type: 'diagnostic', log_id: 'freeform-clarification-log', phase: 'complete', products_count: 0,
    } }] : []),
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}`).concat('data: [DONE]', '').join('\n\n');
}

async function waitForWidget(predicate, message, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), message);
}

test('an existing in-progress request is accepted before the backend waits for replay completion', () => {
  const existingBranch = chatV3Source.indexOf('if (claim.kind === "existing")');
  const replayAcceptance = chatV3Source.indexOf(
    'emit({ type: "diagnostic", log_id: claim.row.id, phase: "start" });',
    existingBranch,
  );
  const replayWait = chatV3Source.indexOf(
    'const replay = await waitForReplayCompletion(',
    existingBranch,
  );

  assert.ok(existingBranch >= 0, 'existing replay branch must remain present');
  assert.ok(replayAcceptance > existingBranch, 'existing request must emit protocol acceptance');
  assert.ok(replayAcceptance < replayWait, 'protocol acceptance must precede the potentially long replay wait');
});

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

test('a trailing user bubble without an acceptance marker is discarded after a crash reload', () => {
  const now = Date.now();
  const state = savedDialogue(now - 1_000);
  state.history.push({ role: 'user', content: 'реплика, оборванная до принятия сервером' });
  const dom = bootWidget({ state, now });

  assert.doesNotMatch(visibleMessages(dom), /оборванная до принятия/u);
  assert.match(visibleMessages(dom), /старый ответ про кабель/u);
  assert.equal(readState(dom).acceptedPendingTurn, undefined);
  dom.window.close();
});

test('crash reload drops an unaccepted duplicate retry without losing the accepted original', async () => {
  const repeatedQuery = 'найди кабель ввг 3*1,5 самый дешевый';
  const acceptedMessageId = '123e4567-e89b-42d3-a456-426614174010';
  const unacceptedMessageId = '123e4567-e89b-42d3-a456-426614174011';
  const payloads = [];
  const answer = 'Продолжаю исходный принятый запрос.';
  const dom = bootWidget({
    state: {
      sessionId: 'session_duplicate_retry_crash',
      history: [
        { role: 'assistant', content: 'Здравствуйте!' },
        { role: 'user', content: repeatedQuery, messageId: acceptedMessageId },
        { role: 'user', content: repeatedQuery, messageId: unacceptedMessageId },
      ],
      dialogSlots: {},
      acceptedPendingTurn: {
        messageId: acceptedMessageId,
        content: repeatedQuery,
      },
      updatedAt: Date.now(),
    },
    fetchImpl: async (_url, init) => {
      payloads.push(JSON.parse(init.body));
      const complete = [
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'duplicate-retry-crash-log', phase: 'start' } })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}`,
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'duplicate-retry-crash-log', phase: 'complete', products_count: 0 } })}`,
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(complete, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const restoredUsers = Array.from(dom.window.document.querySelectorAll('.volt-message.user'))
    .map((element) => element.textContent.trim());
  assert.deepEqual(restoredUsers, [repeatedQuery]);

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'продолжи этот подбор';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();
  const deadline = Date.now() + 500;
  while (!visibleMessages(dom).includes(answer) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.deepEqual(payloads[0].history, [{ role: 'user', content: repeatedQuery }]);
  const persistedRepeatedUsers = readState(dom).history.filter((message) =>
    message.role === 'user' && message.content === repeatedQuery);
  assert.equal(persistedRepeatedUsers.length, 1);
  assert.equal(persistedRepeatedUsers[0].messageId, acceptedMessageId);
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

test('replay keeps the request session immutable after a conversation boundary rotates the visible session', async () => {
  const originalSessionId = 'session_saved_customer_test';
  const boundarySessionId = 'session_boundary_during_partial';
  const logId = 'boundary-replay-log';
  const payloads = [];
  const dom = bootWidget({
    state: savedDialogue(Date.now() - 1_000),
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(init.body);
      payloads.push(payload);
      if (!payload.resumeOnly) {
        let pulls = 0;
        const body = new ReadableStream({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(new TextEncoder().encode([
                `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'start' } })}`,
                `data: ${JSON.stringify({ v3_event: { type: 'conversation_boundary', mode: 'new_task', session_id: boundarySessionId } })}`,
                `data: ${JSON.stringify({ choices: [{ delta: { content: 'Начинаю новую тему.' } }] })}`,
                '',
              ].join('\n\n')));
              return;
            }
            controller.error(new Error('boundary stream interruption'));
          },
        });
        return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      const replay = [
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'start' } })}`,
        `data: ${JSON.stringify({ v3_event: { type: 'conversation_boundary', mode: 'new_task', session_id: boundarySessionId } })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Новая тема восстановлена.' } }] })}`,
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'complete', products_count: 0 } })}`,
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(replay, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'Новый самостоятельный вопрос';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();

  const deadline = Date.now() + 2_000;
  while (!visibleMessages(dom).includes('Новая тема восстановлена.') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].sessionId, originalSessionId);
  assert.equal(payloads[1].sessionId, originalSessionId, 'same messageId must replay against its claiming session');
  assert.equal(payloads[1].messageId, payloads[0].messageId);
  assert.equal(readState(dom).sessionId, boundarySessionId, 'new session remains active for the next user turn');
  assert.match(visibleMessages(dom), /Новая тема восстановлена\./u);
  assert.doesNotMatch(visibleMessages(dom), /request_conflict|ошибка соединения/iu);
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
  const urls = [];
  const logId = 'accepted-request-log';
  const dom = bootWidget({
    fetchImpl: async (url, init) => {
      fetchCount += 1;
      urls.push(String(url));
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
  assert.match(urls[0], /supabase-proxy\.bold-dawn-058f\.workers\.dev/u);
  assert.match(urls[1], /yngoixmvmxdfxokuafjp\.supabase\.co/u, 'replay should start on the alternative route');
  assert.match(visibleMessages(dom), /Восстановленный ответ\./u);
  assert.match(visibleMessages(dom), new RegExp(logId, 'u'));
  assert.doesNotMatch(visibleMessages(dom), /произошла ошибка соединения/iu);
  dom.window.close();
});

test('request_pending replay continues on the next route instead of replacing the answer', async () => {
  let fetchCount = 0;
  let executionCount = 0;
  const urls = [];
  const logId = 'pending-then-complete-log';
  const dom = bootWidget({
    fetchImpl: async (url, init) => {
      fetchCount += 1;
      urls.push(String(url));
      const payload = JSON.parse(init.body);
      if (!payload.resumeOnly) {
        executionCount += 1;
        let pulls = 0;
        const body = new ReadableStream({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(new TextEncoder().encode([
                `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'start' } })}`,
                `data: ${JSON.stringify({ choices: [{ delta: { content: 'Начинаю подбор.' } }] })}`,
                '',
              ].join('\n\n')));
              return;
            }
            controller.error(new Error('initial transport interruption'));
          },
        });
        return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (fetchCount === 2) {
        const pending = [
          `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'start' } })}`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'Запрос ещё обрабатывается.' } }] })}`,
          `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'complete', products_count: 0, error: 'request_pending' } })}`,
          'data: [DONE]',
          '',
        ].join('\n\n');
        return new Response(pending, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      const complete = [
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'start' } })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Канонический завершённый ответ.' } }] })}`,
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'complete', products_count: 0 } })}`,
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(complete, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'Проверка восстановления незавершённого запроса';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();

  const deadline = Date.now() + 2_000;
  while (!visibleMessages(dom).includes('Канонический завершённый ответ.') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const visible = visibleMessages(dom);
  assert.equal(fetchCount, 3);
  assert.equal(executionCount, 1);
  assert.match(urls[0], /supabase-proxy\.bold-dawn-058f\.workers\.dev/u);
  assert.match(urls[1], /yngoixmvmxdfxokuafjp\.supabase\.co/u);
  assert.match(urls[2], /supabase-proxy\.bold-dawn-058f\.workers\.dev/u);
  assert.match(visible, /Канонический завершённый ответ\./u);
  assert.doesNotMatch(visible, /Запрос ещё обрабатывается|Ответ получен не полностью|ошибка соединения/iu);
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

test('two resume routes commit only the complete replay and never duplicate product cards', async () => {
  let fetchCount = 0;
  let executionCount = 0;
  const logId = 'multi-resume-log';
  const productName = 'UNIQUE PRODUCT CARD';
  const productMarkdown = `- **[${productName}](https://220volt.kz/product)**\n  Цена: *999* ₸`;

  function interruptedStream(events, delay = 0) {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(events));
        setTimeout(() => controller.error(new Error('simulated partial resume')), delay);
      },
    });
  }

  const dom = bootWidget({
    fetchImpl: async (_url, init) => {
      fetchCount += 1;
      const payload = JSON.parse(init.body);
      const partial = [
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'start' } })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Проверяю каталог.' } }] })}`,
        `data: ${JSON.stringify({ v3_event: { type: 'products_block', markdown: productMarkdown, count: 1 } })}`,
        '',
      ].join('\n\n');

      if (!payload.resumeOnly) {
        executionCount += 1;
        return new Response(interruptedStream(partial), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (fetchCount === 2) {
        // Longer than the public 350 ms card insertion delay: the previous
        // implementation visibly committed this partial replay, then appended
        // the second route's canonical card as a duplicate.
        return new Response(interruptedStream(partial, 380), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      const complete = [
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'start' } })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Проверяю каталог.' } }] })}`,
        `data: ${JSON.stringify({ v3_event: { type: 'products_block', markdown: productMarkdown, count: 1 } })}`,
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'complete', products_count: 1 } })}`,
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(complete, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'Проверка нескольких маршрутов восстановления';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();

  const deadline = Date.now() + 2_000;
  while (fetchCount < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));

  const visible = visibleMessages(dom);
  assert.equal(fetchCount, 3, 'one execution and two resume routes are expected');
  assert.equal(executionCount, 1, 'resume routes must never execute product search again');
  assert.equal(visible.split(productName).length - 1, 1, 'only the canonical product card may be visible');
  assert.doesNotMatch(visible, /Ответ получен не полностью|ошибка соединения|Соединение прервалось/iu);
  dom.window.close();
});

test('best partial replay is preserved when no route reaches diagnostic complete', async () => {
  let fetchCount = 0;
  let executionCount = 0;
  const logId = 'best-partial-replay-log';
  const productName = 'RECOVERED PARTIAL PRODUCT';
  const productMarkdown = `- **[${productName}](https://220volt.kz/recovered)**\n  Цена: *777* ₸`;
  const dom = bootWidget({
    fetchImpl: async (_url, init) => {
      fetchCount += 1;
      const payload = JSON.parse(init.body);
      if (!payload.resumeOnly) {
        executionCount += 1;
        let pulls = 0;
        const body = new ReadableStream({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(new TextEncoder().encode(
                `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'start' } })}\n\n`,
              ));
              return;
            }
            controller.error(new Error('ack-only interruption'));
          },
        });
        return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (fetchCount === 2) {
        let pulls = 0;
        const body = new ReadableStream({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(new TextEncoder().encode([
                `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'start' } })}`,
                `data: ${JSON.stringify({ choices: [{ delta: { content: 'Удалось восстановить часть ответа.' } }] })}`,
                `data: ${JSON.stringify({ v3_event: { type: 'products_block', markdown: productMarkdown, count: 1 } })}`,
                '',
              ].join('\n\n')));
              return;
            }
            controller.error(new Error('partial replay interruption'));
          },
        });
        return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      throw new Error('second resume route unavailable');
    },
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'Проверка сохранения частично восстановленных карточек';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();

  const deadline = Date.now() + 2_000;
  while (!visibleMessages(dom).includes(productName) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const visible = visibleMessages(dom);
  assert.equal(fetchCount, 3);
  assert.equal(executionCount, 1);
  assert.equal(visible.split(productName).length - 1, 1);
  assert.match(visible, /Ответ получен не полностью|Соединение прервалось/iu);
  assert.doesNotMatch(visible, /Сервер принял запрос, но соединение прервалось до получения ответа/iu);
  dom.window.close();
});

test('an accepted unanswered turn remains available to the next follow-up', async () => {
  let fetchCount = 0;
  const firstQuery = 'покажи бытовые светильники с датчиком';
  const followUp = 'а есть другие варианты?';
  const followUpAnswer = 'Проверяю альтернативы по предыдущему запросу.';
  const dom = bootWidget({
    fetchImpl: async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        let pulls = 0;
        const body = new ReadableStream({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(new TextEncoder().encode(
                `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'accepted-unanswered-log', phase: 'start' } })}\n\n`,
              ));
              return;
            }
            controller.error(new Error('accepted response became unavailable'));
          },
        });
        return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      throw new Error('replay route unavailable');
    },
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = firstQuery;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();

  let deadline = Date.now() + 500;
  while ((dom.window.document.querySelector('#volt-widget-send').disabled || fetchCount < 3) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const persisted = readState(dom);
  assert.equal(persisted.acceptedPendingTurn.content, firstQuery);
  dom.window.close();

  const followUpPayloads = [];
  const followUpDom = bootWidget({
    state: persisted,
    fetchImpl: async (_url, init) => {
      followUpPayloads.push(JSON.parse(init.body));
      const complete = [
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'follow-up-log', phase: 'start' } })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: followUpAnswer } }] })}`,
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'follow-up-log', phase: 'complete', products_count: 0 } })}`,
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(complete, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const followUpInput = followUpDom.window.document.querySelector('#volt-widget-input');
  followUpInput.value = followUp;
  followUpInput.dispatchEvent(new followUpDom.window.Event('input', { bubbles: true }));
  followUpDom.window.document.querySelector('#volt-widget-send').click();
  deadline = Date.now() + 500;
  while (!visibleMessages(followUpDom).includes(followUpAnswer) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(followUpPayloads.length, 1);
  assert.equal(followUpPayloads[0].resumeOnly, false);
  assert.deepEqual(followUpPayloads[0].history, [{ role: 'user', content: firstQuery }]);
  assert.equal(followUpPayloads[0].history.some((item) => item.content === followUp), false);
  assert.match(visibleMessages(followUpDom), new RegExp(followUpAnswer, 'u'));
  assert.equal(readState(followUpDom).acceptedPendingTurn, null);
  followUpDom.window.close();
});

test('a resolved accepted-pending chain remains intact for the following turn', async () => {
  const firstQuery = 'покажи светильники с датчиком движения до 4000 тенге';
  const followUp = 'а есть другие варианты?';
  const followUpAnswer = 'Нашёл ещё два подходящих варианта.';
  const nextQuestion = 'а какой из них самый дешёвый?';
  const nextAnswer = 'Самый дешёвый — первый вариант.';
  const payloads = [];
  let fetchCount = 0;
  const dom = bootWidget({
    state: {
      sessionId: 'session_resolved_pending_chain',
      history: [
        { role: 'assistant', content: 'Здравствуйте!' },
        { role: 'user', content: firstQuery, messageId: '123e4567-e89b-42d3-a456-426614174002' },
      ],
      dialogSlots: {},
      acceptedPendingTurn: {
        messageId: '123e4567-e89b-42d3-a456-426614174002',
        content: firstQuery,
      },
      updatedAt: Date.now(),
    },
    fetchImpl: async (_url, init) => {
      fetchCount += 1;
      payloads.push(JSON.parse(init.body));
      const answer = fetchCount === 1 ? followUpAnswer : nextAnswer;
      const logId = fetchCount === 1 ? 'resolved-pending-follow-up-log' : 'resolved-pending-next-log';
      const complete = [
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'start' } })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}`,
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'complete', products_count: 0 } })}`,
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(complete, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = followUp;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();

  let deadline = Date.now() + 500;
  while ((dom.window.document.querySelector('#volt-widget-send').disabled ||
      !visibleMessages(dom).includes(followUpAnswer)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  input.value = nextQuestion;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();
  deadline = Date.now() + 500;
  while ((payloads.length < 2 || dom.window.document.querySelector('#volt-widget-send').disabled ||
      !visibleMessages(dom).includes(nextAnswer)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.deepEqual(payloads[0].history, [{ role: 'user', content: firstQuery }]);
  assert.deepEqual(payloads[1].history, [
    { role: 'user', content: firstQuery },
    { role: 'user', content: followUp },
    { role: 'assistant', content: followUpAnswer },
  ]);
  dom.window.close();
});

test('a later pre-acceptance failure does not erase the earlier accepted pending context', async () => {
  const acceptedQuery = 'покажи светильники с датчиком движения';
  const state = {
    sessionId: 'session_accepted_then_failed',
    history: [
      { role: 'assistant', content: 'Здравствуйте!' },
      { role: 'user', content: acceptedQuery, messageId: '123e4567-e89b-42d3-a456-426614174000' },
    ],
    dialogSlots: {},
    acceptedPendingTurn: {
      messageId: '123e4567-e89b-42d3-a456-426614174000',
      content: acceptedQuery,
    },
    updatedAt: Date.now(),
  };
  const payloads = [];
  let fetchCount = 0;
  const finalAnswer = 'Предыдущий принятый контекст сохранён.';
  const dom = bootWidget({
    state,
    fetchImpl: async (_url, init) => {
      fetchCount += 1;
      payloads.push(JSON.parse(init.body));
      if (fetchCount <= 2) {
        return new Response(JSON.stringify({ error: 'temporary_failure' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const complete = [
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'accepted-context-log', phase: 'start' } })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: finalAnswer } }] })}`,
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'accepted-context-log', phase: 'complete', products_count: 0 } })}`,
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(complete, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'промежуточный запрос без принятия';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();
  let deadline = Date.now() + 500;
  while (!/ошибка соединения/iu.test(visibleMessages(dom)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(readState(dom).acceptedPendingTurn.content, acceptedQuery);
  input.value = 'можешь продолжить исходный подбор?';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();
  deadline = Date.now() + 500;
  while (!visibleMessages(dom).includes(finalAnswer) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(fetchCount, 3);
  assert.deepEqual(payloads[2].history, [{ role: 'user', content: acceptedQuery }]);
  assert.match(visibleMessages(dom), new RegExp(finalAnswer, 'u'));
  dom.window.close();
});

test('consecutive accepted unanswered questions stay together as one pending context chain', async () => {
  const first = 'покажи светильники с датчиком';
  const second = 'а есть другие варианты?';
  const payloads = [];
  const state = {
    sessionId: 'session_pending_chain',
    history: [
      { role: 'assistant', content: 'Здравствуйте!' },
      { role: 'user', content: first, messageId: '123e4567-e89b-42d3-a456-426614174003' },
      { role: 'user', content: second, messageId: '123e4567-e89b-42d3-a456-426614174001' },
    ],
    dialogSlots: {},
    acceptedPendingTurn: {
      messageId: '123e4567-e89b-42d3-a456-426614174001',
      content: second,
    },
    updatedAt: Date.now(),
  };
  const answer = 'Цепочка уточнений сохранена.';
  const dom = bootWidget({
    state,
    fetchImpl: async (_url, init) => {
      payloads.push(JSON.parse(init.body));
      const complete = [
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'pending-chain-log', phase: 'start' } })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}`,
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'pending-chain-log', phase: 'complete', products_count: 0 } })}`,
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(complete, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'продолжи, пожалуйста';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();
  const deadline = Date.now() + 500;
  while (!visibleMessages(dom).includes(answer) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.deepEqual(payloads[0].history, [
    { role: 'user', content: first },
    { role: 'user', content: second },
  ]);
  dom.window.close();
});

test('a user-only semantic block is not serialized after an oversized assistant is rejected', async () => {
  const acceptedQuery = 'покажи светильники с датчиком движения';
  const followUp = 'а есть другие варианты?';
  const oversizedAssistant = `Начинаю ответ. ${'я'.repeat(8_100)}`;
  const finalAnswer = 'Новый ответ без ложного контекста.';
  const payloads = [];
  let fetchCount = 0;
  const dom = bootWidget({
    state: {
      sessionId: 'session_oversized_assistant',
      history: [
        { role: 'assistant', content: 'Здравствуйте!' },
        {
          role: 'user',
          content: acceptedQuery,
          messageId: '123e4567-e89b-42d3-a456-426614174012',
        },
      ],
      dialogSlots: {},
      acceptedPendingTurn: {
        messageId: '123e4567-e89b-42d3-a456-426614174012',
        content: acceptedQuery,
      },
      updatedAt: Date.now(),
    },
    fetchImpl: async (_url, init) => {
      fetchCount += 1;
      payloads.push(JSON.parse(init.body));
      const content = fetchCount === 1 ? oversizedAssistant : finalAnswer;
      const logId = fetchCount === 1 ? 'oversized-assistant-log' : 'post-oversized-log';
      const complete = [
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'start' } })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`,
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'complete', products_count: 0 } })}`,
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(complete, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = followUp;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();
  let deadline = Date.now() + 500;
  while (dom.window.document.querySelector('#volt-widget-send').disabled && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  input.value = 'начни новый поиск';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();
  deadline = Date.now() + 500;
  while ((payloads.length < 2 || dom.window.document.querySelector('#volt-widget-send').disabled ||
      !visibleMessages(dom).includes(finalAnswer)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.deepEqual(payloads[0].history, [{ role: 'user', content: acceptedQuery }]);
  assert.deepEqual(payloads[1].history, [], 'user-only history must never be serialized as a completed semantic block');
  dom.window.close();
});

test('a server pending clarification is carried into the next browser request', async () => {
  const payloads = [];
  let fetchCount = 0;
  const legacyPendingSlot = {
    pending_clarification: {
      slot_id: 'clarification-slot-1',
      facet_key: 'catalog_section',
      question: 'Какой раздел показать?',
      options: [
        { value: 'Раздел А', label: 'Раздел А' },
        { value: 'Раздел Б', label: 'Раздел Б' },
      ],
      scope: { kind: 'broad_assortment', token: 'SERIESX' },
    },
  };
  const dom = bootWidget({
    fetchImpl: async (_url, init) => {
      fetchCount += 1;
      payloads.push(JSON.parse(init.body));
      const logId = `pending-slot-log-${fetchCount}`;
      const events = fetchCount === 1
        ? [
            { v3_event: { type: 'diagnostic', log_id: logId, phase: 'start' } },
            { choices: [{ delta: { content: 'Какой раздел показать?' } }] },
            { v3_event: { type: 'slot_update', slots: legacyPendingSlot } },
            { v3_event: { type: 'diagnostic', log_id: logId, phase: 'complete', products_count: 0 } },
          ]
        : [
            { v3_event: { type: 'diagnostic', log_id: logId, phase: 'start' } },
            { choices: [{ delta: { content: 'Уточнение принято.' } }] },
            { v3_event: { type: 'diagnostic', log_id: logId, phase: 'complete', products_count: 0 } },
          ];
      const sse = events.map((event) => `data: ${JSON.stringify(event)}`).concat('data: [DONE]', '').join('\n\n');
      return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'покажи ассортимент SERIESX';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();
  let deadline = Date.now() + 500;
  while (dom.window.document.querySelector('#volt-widget-send').disabled && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  input.value = 'Раздел А';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();
  deadline = Date.now() + 500;
  while ((payloads.length < 2 || dom.window.document.querySelector('#volt-widget-send').disabled) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[1].dialogSlots, legacyPendingSlot);
  assert.equal(readState(dom).dialogSlots.pending_clarification.scope.token, 'SERIESX');
  dom.window.close();
});

test('request payload is bounded by UTF-8 bytes and keeps only recent complete turns', async () => {
  const now = Date.now();
  const history = [{ role: 'assistant', content: 'Здравствуйте! Старый диалог.' }];
  for (let index = 1; index <= 5; index += 1) {
    history.push({ role: 'user', content: `пользователь-${index} ${'у'.repeat(980)}` });
    history.push({ role: 'assistant', content: `ответ-${index} ${'я'.repeat(4_980)}` });
  }
  const state = {
    sessionId: 'session_large_utf8_history',
    history,
    dialogSlots: {
      cable: { status: 'pending', value: `уточнение ${'щ'.repeat(5_000)}` },
    },
    updatedAt: now,
  };
  const payloads = [];
  const bodySizes = [];
  const answer = 'Контекст принят без переполнения запроса.';
  const dom = bootWidget({
    state,
    now,
    fetchImpl: async (_url, init) => {
      const size = new TextEncoder().encode(init.body).byteLength;
      bodySizes.push(size);
      const payload = JSON.parse(init.body);
      payloads.push(payload);
      if (size > 64 * 1_024) {
        return new Response(JSON.stringify({ error: 'payload_too_large' }), {
          status: 413,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const sse = [
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'utf8-budget-log', phase: 'start' } })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}`,
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'utf8-budget-log', phase: 'complete', products_count: 0 } })}`,
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const query = 'найди кабель ввг 3*1,5 самый дешевый';
  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = query;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();

  const deadline = Date.now() + 2_000;
  while (!visibleMessages(dom).includes(answer) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(payloads.length, 1, 'a locally bounded request must not need a 413 route retry');
  assert.ok(bodySizes.every((size) => size <= 56 * 1_024), `payload sizes: ${bodySizes.join(', ')}`);
  assert.equal(payloads[0].message, query);
  assert.equal(payloads[0].history.some((item) => item.content === query), false, 'current user message must not be duplicated in history');
  assert.equal(payloads[0].history.length % 2, 0, 'request history contains complete user/assistant turns');
  for (let index = 0; index < payloads[0].history.length; index += 2) {
    assert.equal(payloads[0].history[index].role, 'user');
    assert.equal(payloads[0].history[index + 1].role, 'assistant');
  }
  assert.match(payloads[0].history.at(-2).content, /^пользователь-5 /u);
  assert.match(payloads[0].history.at(-1).content, /^ответ-5 /u);
  assert.match(visibleMessages(dom), new RegExp(answer, 'u'));
  assert.doesNotMatch(visibleMessages(dom), /ошибка соединения/iu);
  dom.window.close();
});

test('character-budget eviction never separates a user message from its assistant answer', async () => {
  const history = [
    { role: 'user', content: `evicted-user ${'u'.repeat(990)}` },
    { role: 'assistant', content: `ORPHAN_ASSISTANT ${'a'.repeat(85)}` },
  ];
  for (let index = 1; index <= 5; index += 1) {
    history.push({ role: 'user', content: `kept-user-${index} ${'u'.repeat(1_484)}` });
    history.push({ role: 'assistant', content: `kept-answer-${index} ${'a'.repeat(4_784)}` });
  }
  const payloads = [];
  const dom = bootWidget({
    state: {
      sessionId: 'session_atomic_history',
      history,
      dialogSlots: {},
      updatedAt: Date.now(),
    },
    fetchImpl: async (_url, init) => {
      payloads.push(JSON.parse(init.body));
      const complete = [
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'atomic-history-log', phase: 'start' } })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'История целостна.' } }] })}`,
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'atomic-history-log', phase: 'complete', products_count: 0 } })}`,
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(complete, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'новый вопрос';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();
  const deadline = Date.now() + 500;
  while (!visibleMessages(dom).includes('История целостна.') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const sent = payloads[0].history.map((item) => item.content.split(' ')[0]);
  assert.equal(sent.includes('evicted-user'), false);
  assert.equal(sent.includes('ORPHAN_ASSISTANT'), false);
  assert.deepEqual(sent, [
    'kept-user-1', 'kept-answer-1',
    'kept-user-2', 'kept-answer-2',
    'kept-user-3', 'kept-answer-3',
    'kept-user-4', 'kept-answer-4',
    'kept-user-5', 'kept-answer-5',
  ]);
  dom.window.close();
});

test('a large pending slot cannot evict the latest semantic turn', async () => {
  const payloads = [];
  const bodySizes = [];
  const lastUser = `последний-вопрос ${'у'.repeat(1_780)}`;
  const lastAssistant = `последний-ответ ${'я'.repeat(6_480)}`;
  const dom = bootWidget({
    state: {
      sessionId: 'session_large_slot',
      history: [
        { role: 'assistant', content: 'Здравствуйте!' },
        { role: 'user', content: lastUser },
        { role: 'assistant', content: lastAssistant },
      ],
      dialogSlots: {
        oversized: { status: 'pending', value: '界'.repeat(15_000) },
      },
      updatedAt: Date.now(),
    },
    fetchImpl: async (_url, init) => {
      payloads.push(JSON.parse(init.body));
      bodySizes.push(new TextEncoder().encode(init.body).byteLength);
      const complete = [
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'large-slot-log', phase: 'start' } })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Последний ход сохранён.' } }] })}`,
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'large-slot-log', phase: 'complete', products_count: 0 } })}`,
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(complete, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'уточнение';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();
  const deadline = Date.now() + 500;
  while (!visibleMessages(dom).includes('Последний ход сохранён.') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.deepEqual(payloads[0].history, [
    { role: 'user', content: lastUser },
    { role: 'assistant', content: lastAssistant },
  ]);
  assert.deepEqual(payloads[0].dialogSlots, {});
  assert.ok(bodySizes[0] <= 56 * 1_024);
  dom.window.close();
});

test('heartbeat comments without protocol acceptance fail over to the direct route', async () => {
  const urls = [];
  const payloads = [];
  let heartbeatInterval = null;
  let proxyAborted = false;
  const answer = 'Ответ восстановлен через резервный маршрут.';
  const dom = bootWidget({
    source: withTransportTimeouts({ connect: 20, accept: 45, idle: 35, total: 220 }),
    fetchImpl: async (url, init) => {
      urls.push(String(url));
      payloads.push(JSON.parse(init.body));
      if (urls.length === 1) {
        let streamController = null;
        const body = new ReadableStream({
          start(controller) {
            streamController = controller;
            controller.enqueue(new TextEncoder().encode(': stream-open\n\n'));
            controller.enqueue(new TextEncoder().encode('data: {"unexpected":true}\n\n'));
            heartbeatInterval = setInterval(() => {
              controller.enqueue(new TextEncoder().encode(': keep-alive\n\n'));
            }, 10);
          },
          cancel() {
            if (heartbeatInterval) clearInterval(heartbeatInterval);
          },
        });
        init.signal.addEventListener('abort', () => {
          proxyAborted = true;
          if (heartbeatInterval) clearInterval(heartbeatInterval);
          try { streamController?.error(new DOMException('Aborted', 'AbortError')); } catch {}
        }, { once: true });
        return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      const sse = [
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'direct-failover-log', phase: 'start' } })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}`,
        `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'direct-failover-log', phase: 'complete', products_count: 0 } })}`,
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const started = Date.now();
  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'Проверка зависшего подтверждения';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();

  const deadline = Date.now() + 500;
  while (!visibleMessages(dom).includes(answer) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(urls.length, 2);
  assert.match(urls[0], /supabase-proxy\.bold-dawn-058f\.workers\.dev/u);
  assert.match(urls[1], /yngoixmvmxdfxokuafjp\.supabase\.co/u);
  assert.equal(proxyAborted, true);
  assert.equal(payloads[0].messageId, payloads[1].messageId);
  assert.equal(payloads[0].sessionId, payloads[1].sessionId);
  assert.equal(payloads[0].resumeOnly, false);
  assert.equal(payloads[1].resumeOnly, false);
  assert.ok(Date.now() - started < 180, 'comments-only route must not consume the whole turn deadline');
  assert.match(visibleMessages(dom), new RegExp(answer, 'u'));
  assert.doesNotMatch(visibleMessages(dom), /ошибка соединения|Ответ получен не полностью/iu);
  dom.window.close();
});

test('duplicate acceptance keeps fallback alive until the single in-progress execution can be replayed', async () => {
  const urls = [];
  const payloads = [];
  const intervals = new Set();
  let backendExecutions = 0;
  let finishExecution;
  const executionFinished = new Promise((resolve) => { finishExecution = resolve; });
  const answer = 'Единственный серверный ответ восстановлен после ожидания.';
  const logId = 'existing-in-progress-replay-log';
  const completionTimer = setTimeout(() => finishExecution(), 115);

  const dom = bootWidget({
    source: withTransportTimeouts({ connect: 20, accept: 40, idle: 35, total: 280 }),
    fetchImpl: async (url, init) => {
      urls.push(String(url));
      const payload = JSON.parse(init.body);
      payloads.push(payload);

      if (urls.length === 1) {
        backendExecutions += 1;
        let streamController = null;
        const body = new ReadableStream({
          start(controller) {
            streamController = controller;
            controller.enqueue(new TextEncoder().encode(': stream-open\n\n'));
            const interval = setInterval(() => {
              try { controller.enqueue(new TextEncoder().encode(': keep-alive\n\n')); } catch {}
            }, 10);
            intervals.add(interval);
          },
          cancel() {
            for (const interval of intervals) clearInterval(interval);
            intervals.clear();
          },
        });
        init.signal.addEventListener('abort', () => {
          for (const interval of intervals) clearInterval(interval);
          intervals.clear();
          try { streamController?.error(new DOMException('Aborted', 'AbortError')); } catch {}
        }, { once: true });
        return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
      }

      // This is the real duplicate-claim shape: the second normal route must
      // acknowledge the existing messageId immediately, then wait while the
      // original execution continues independently of the abandoned stream.
      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode([
            ': stream-open',
            `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'start' } })}`,
            '',
          ].join('\n\n')));
          const interval = setInterval(() => {
            try { controller.enqueue(new TextEncoder().encode(': keep-alive\n\n')); } catch {}
          }, 10);
          intervals.add(interval);
          await executionFinished;
          clearInterval(interval);
          intervals.delete(interval);
          controller.enqueue(new TextEncoder().encode([
            `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'start' } })}`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}`,
            `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: logId, phase: 'complete', products_count: 0 } })}`,
            'data: [DONE]',
            '',
          ].join('\n\n')));
        },
        cancel() {
          for (const interval of intervals) clearInterval(interval);
          intervals.clear();
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'Проверка долгого существующего запроса';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();

  const deadline = Date.now() + 500;
  while (!visibleMessages(dom).includes(answer) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  clearTimeout(completionTimer);
  for (const interval of intervals) clearInterval(interval);
  assert.equal(urls.length, 2);
  assert.equal(backendExecutions, 1);
  assert.equal(payloads[0].messageId, payloads[1].messageId);
  assert.equal(payloads[0].resumeOnly, false);
  assert.equal(payloads[1].resumeOnly, false);
  assert.match(visibleMessages(dom), new RegExp(answer, 'u'));
  assert.doesNotMatch(visibleMessages(dom), /ошибка соединения|Ответ получен не полностью/iu);
  dom.window.close();
});

test('generic transport failures remain traceable and do not persist an orphan user turn', async () => {
  const query = 'Запрос при временной недоступности сети';
  const dom = bootWidget({
    fetchImpl: async () => new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }),
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = query;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();

  const deadline = Date.now() + 500;
  while (!/ошибка соединения/iu.test(visibleMessages(dom)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const visible = visibleMessages(dom);
  assert.match(visible, /Версия: widget-/u);
  assert.match(visible, /Код попытки: [0-9a-f-]{36}/u);
  assert.equal(readState(dom).history.some((item) => item.content === query), false);
  dom.window.close();
});

test('late cleanup from a completed turn cannot remove the next turn typing indicator', async () => {
  let fetchCount = 0;
  let secondTimer = null;
  const dom = bootWidget({
    source: withTransportTimeouts({ connect: 50, accept: 100, idle: 700, total: 1_000 }),
    fetchImpl: async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        const first = [
          `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'first-fast-log', phase: 'start' } })}`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'Первый ответ готов.' } }] })}`,
          `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'first-fast-log', phase: 'complete', products_count: 0 } })}`,
          'data: [DONE]',
          '',
        ].join('\n\n');
        return new Response(first, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode([
            `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'second-slow-log', phase: 'start' } })}`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'Второй ответ начался.' } }] })}`,
            '',
          ].join('\n\n')));
          secondTimer = setTimeout(() => {
            controller.enqueue(new TextEncoder().encode([
              `data: ${JSON.stringify({ choices: [{ delta: { content: ' Второй ответ готов.' } }] })}`,
              `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'second-slow-log', phase: 'complete', products_count: 0 } })}`,
              'data: [DONE]',
              '',
            ].join('\n\n')));
          }, 600);
        },
        cancel() {
          if (secondTimer) clearTimeout(secondTimer);
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'Первый запрос';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();

  let deadline = Date.now() + 500;
  while ((dom.window.document.querySelector('#volt-widget-send').disabled || !visibleMessages(dom).includes('Первый ответ готов.')) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  input.value = 'Второй запрос';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();
  deadline = Date.now() + 300;
  while (!visibleMessages(dom).includes('Второй ответ начался.') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 430));

  assert.ok(dom.window.document.getElementById('volt-live-typing'), 'the active turn must retain its own progress indicator');

  deadline = Date.now() + 500;
  while (!visibleMessages(dom).includes('Второй ответ готов.') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(fetchCount, 2);
  assert.match(visibleMessages(dom), /Второй ответ готов\./u);
  dom.window.close();
});

test('SSE heartbeats keep a healthy response alive beyond one idle interval', async () => {
  const logId = 'heartbeat-long-stream-log';
  let interval = null;
  const dom = bootWidget({
    source: withTransportTimeouts({ connect: 15, idle: 30, total: 250 }),
    fetchImpl: async (_url, init) => {
      let streamController = null;
      const body = new ReadableStream({
        start(controller) {
          streamController = controller;
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
      init.signal.addEventListener('abort', () => {
        if (interval) clearInterval(interval);
        try { streamController?.error(new DOMException('Aborted', 'AbortError')); } catch {}
      }, { once: true });
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

test('heartbeats also refresh idle timeout when a proxy rewrites SSE as text/plain', async () => {
  let interval = null;
  const dom = bootWidget({
    source: withTransportTimeouts({ connect: 15, idle: 30, total: 250 }),
    fetchImpl: async (_url, init) => {
      let streamController = null;
      const body = new ReadableStream({
        start(controller) {
          streamController = controller;
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
              `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'text-plain-heartbeat-log', phase: 'start' } })}`,
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'Ответ через переписанный Content-Type.' } }] })}`,
              `data: ${JSON.stringify({ v3_event: { type: 'diagnostic', log_id: 'text-plain-heartbeat-log', phase: 'complete', products_count: 0 } })}`,
              'data: [DONE]',
              '',
            ].join('\n\n')));
          }, 15);
        },
        cancel() {
          if (interval) clearInterval(interval);
        },
      });
      init.signal.addEventListener('abort', () => {
        if (interval) clearInterval(interval);
        try { streamController?.error(new DOMException('Aborted', 'AbortError')); } catch {}
      }, { once: true });
      return new Response(body, { headers: { 'Content-Type': 'text/plain' } });
    },
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'Проверка прокси с text/plain';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();

  const deadline = Date.now() + 1_000;
  while (!visibleMessages(dom).includes('Ответ через переписанный Content-Type.') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.match(visibleMessages(dom), /Ответ через переписанный Content-Type\./u);
  assert.doesNotMatch(visibleMessages(dom), /ошибка соединения|Соединение прервалось/iu);
  dom.window.close();
});

test('a stream with no bytes is aborted by the idle timeout on both routes', async () => {
  let fetchCount = 0;
  const dom = bootWidget({
    source: withTransportTimeouts({ connect: 15, idle: 25, total: 120 }),
    fetchImpl: async (_url, init) => {
      fetchCount += 1;
      let streamController = null;
      const body = new ReadableStream({
        start(controller) { streamController = controller; },
      });
      init.signal.addEventListener('abort', () => {
        try { streamController?.error(new DOMException('Aborted', 'AbortError')); } catch {}
      }, { once: true });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const started = Date.now();
  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'Проверка зависшего потока';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();

  const deadline = Date.now() + 500;
  while (!/ошибка соединения/iu.test(visibleMessages(dom)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(fetchCount, 2);
  assert.ok(Date.now() - started < 110, 'idle failures should not consume the whole turn budget');
  assert.match(visibleMessages(dom), /ошибка соединения/iu);
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

test('complete server clarification renders keyboard-accessible chips and sends the exact option once', async () => {
  const replies = [
    { value: 'Однофазное 220 В', label: '220 В · 1 фаза' },
    { value: 'Трёхфазное 380 В', label: '380 В · 3 фазы' },
  ];
  const payloads = [];
  const dom = bootWidget({
    fetchImpl: async (_url, init) => {
      payloads.push(JSON.parse(init.body));
      const sse = payloads.length === 1
        ? clarificationSse({ replies, duplicate: true })
        : [
            { v3_event: { type: 'diagnostic', log_id: 'quick-reply-answer-log', phase: 'start' } },
            { choices: [{ delta: { content: 'Питание уточнено.' } }] },
            { v3_event: { type: 'slot_update', slots: {} } },
            { v3_event: { type: 'diagnostic', log_id: 'quick-reply-answer-log', phase: 'complete', products_count: 0 } },
          ].map((event) => `data: ${JSON.stringify(event)}`).concat('data: [DONE]', '').join('\n\n');
      return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  dom.window.document.querySelector('[aria-label="Открыть чат"]').click();
  assert.equal(dom.window.document.activeElement, input);
  input.value = 'Нужен кабель для кондиционера';
  dom.window.document.querySelector('#volt-widget-send').click();
  await waitForWidget(() => dom.window.document.querySelectorAll('.volt-quick-reply').length === 2 &&
    !dom.window.document.querySelector('#volt-widget-new-chat').disabled,
    'complete clarification should show exactly two chips');

  const chips = [...dom.window.document.querySelectorAll('.volt-quick-reply')];
  assert.equal(dom.window.document.querySelectorAll('[role="group"][aria-label="Варианты ответа"]').length, 1);
  assert.deepEqual(chips.map((chip) => chip.textContent), replies.map((reply) => reply.label));
  assert.ok(chips.every((chip) => chip.tagName === 'BUTTON' && chip.type === 'button'));
  assert.equal(dom.window.document.activeElement, chips[0],
    'first choice should receive focus after a complete clarification');
  assert.ok(chips[0].compareDocumentPosition(input) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    'Tab order must reach both chips before free text');
  assert.equal(chips[0].tabIndex, 0);
  assert.equal(chips[1].tabIndex, 0);
  assert.equal(input.disabled, false, 'free text must remain available');
  const customReply = dom.window.document.querySelector('.volt-custom-reply');
  assert.equal(customReply.textContent, 'Напишу свой вариант');
  assert.ok(chips[1].compareDocumentPosition(customReply) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(customReply.compareDocumentPosition(input) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  const slotBeforeFocus = structuredClone(readState(dom).dialogSlots.pending_clarification);
  customReply.click();
  assert.equal(dom.window.document.activeElement, input, 'free text remains keyboard-accessible');
  assert.equal(payloads.length, 1, 'custom answer focus action must not send a request');
  assert.equal(input.value, '', 'focus action must not invent an answer');
  assert.deepEqual(readState(dom).dialogSlots.pending_clarification, slotBeforeFocus,
    'focus action must not mutate server-issued options');
  chips[0].click();
  chips[0].click();
  chips[1].click();
  await waitForWidget(() => payloads.length === 2 && visibleMessages(dom).includes('Питание уточнено.'),
    'a selected option should complete one follow-up request');

  assert.equal(payloads[1].message, replies[0].value);
  assert.equal(payloads[1].dialogSlots.pending_clarification.facet_key, 'power_phase');
  assert.equal(dom.window.document.querySelectorAll('.volt-quick-reply').length, 0);
  assert.equal(payloads.length, 2, 'duplicate clicks must not produce duplicate requests');
  dom.window.close();
});

test('quick-reply labels are inert text and free-text follow-up removes the chips', async () => {
  const attackLabel = '<img src=x onerror="globalThis.__widgetChipXss = true">';
  const replies = [
    { value: 'Однофазное', label: attackLabel },
    { value: 'Трёхфазное', label: 'Трёхфазное' },
  ];
  const payloads = [];
  const dom = bootWidget({
    fetchImpl: async (_url, init) => {
      payloads.push(JSON.parse(init.body));
      const sse = payloads.length === 1
        ? clarificationSse({ replies })
        : [
            { v3_event: { type: 'diagnostic', log_id: 'free-text-answer-log', phase: 'start' } },
            { choices: [{ delta: { content: 'Ответ свободным текстом принят.' } }] },
            { v3_event: { type: 'diagnostic', log_id: 'free-text-answer-log', phase: 'complete', products_count: 0 } },
          ].map((event) => `data: ${JSON.stringify(event)}`).concat('data: [DONE]', '').join('\n\n');
      return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'Какой кабель выбрать?';
  dom.window.document.querySelector('#volt-widget-send').click();
  await waitForWidget(() => dom.window.document.querySelectorAll('.volt-quick-reply').length === 2,
    'server options should render');
  assert.equal(dom.window.document.querySelector('.volt-quick-reply').textContent, attackLabel);
  assert.equal(dom.window.document.querySelector('.volt-quick-reply img'), null);
  assert.equal(dom.window.__widgetChipXss, undefined);

  input.value = 'Другая конфигурация';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();
  assert.equal(dom.window.document.querySelectorAll('.volt-quick-reply').length, 0);
  await waitForWidget(() => payloads.length === 2 &&
    visibleMessages(dom).includes('Ответ свободным текстом принят.') &&
    !dom.window.document.querySelector('#volt-widget-new-chat').disabled,
  'free-text request should complete');
  assert.equal(payloads[1].message, 'Другая конфигурация');
  dom.window.close();
});

test('quick replies require a matching active pending slot and are hidden on partial turns', async () => {
  const replies = [
    { value: 'Однофазное', label: 'Однофазное' },
    { value: 'Трёхфазное', label: 'Трёхфазное' },
  ];
  const mismatches = [
    { facetKey: 'other_phase', slotFacetKey: 'power_phase' },
    { slotReplies: [replies[0], { value: 'Другое', label: 'Другое' }] },
    { replies: [{ value: 'Однофазное', label: 'Первый' }, { value: 'Однофазное', label: 'Повтор' }] },
    { replies: [{ value: 'Однофазное', label: 'Первый' }] },
  ];
  for (const mismatch of mismatches) {
    const dom = bootWidget({
      fetchImpl: async () => new Response(clarificationSse({ replies, ...mismatch }), {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    });
    dom.window.document.querySelector('#volt-widget-input').value = 'Уточнить питание';
    dom.window.document.querySelector('#volt-widget-send').click();
    await waitForWidget(() => visibleMessages(dom).includes('Какое питание у оборудования?') &&
      !dom.window.document.querySelector('#volt-widget-new-chat').disabled,
    'mismatched clarification should complete');
    assert.equal(dom.window.document.querySelectorAll('.volt-quick-reply').length, 0);
    dom.window.close();
  }

  const partialDom = bootWidget({
    fetchImpl: async () => new Response(clarificationSse({ replies, complete: false }), {
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  });
  partialDom.window.document.querySelector('#volt-widget-input').value = 'Уточнить питание';
  partialDom.window.document.querySelector('#volt-widget-send').click();
  await waitForWidget(() => visibleMessages(partialDom).includes('Ответ получен не полностью') &&
    !partialDom.window.document.querySelector('#volt-widget-new-chat').disabled,
  'partial answer and replay should settle');
  assert.equal(partialDom.window.document.querySelectorAll('.volt-quick-reply').length, 0);
  partialDom.window.close();
});

test('replay commits one canonical chip group; reset, topic boundary and TTL remove stale choices', async () => {
  const replies = [
    { value: 'До 20 м²', label: 'До 20 м²' },
    { value: 'Больше 20 м²', label: 'Больше 20 м²' },
  ];
  let fetchCount = 0;
  const now = 1_800_000_000_000;
  const dom = bootWidget({
    now,
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response(clarificationSse({ replies, complete: fetchCount !== 1 }), {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  });
  const input = dom.window.document.querySelector('#volt-widget-input');
  input.value = 'Нужен прожектор';
  dom.window.document.querySelector('#volt-widget-send').click();
  await waitForWidget(() => dom.window.document.querySelectorAll('.volt-quick-reply').length === 2,
    'complete replay should show one group');
  await waitForWidget(() => !dom.window.document.querySelector('#volt-widget-new-chat').disabled,
    'replay turn should be idle before reset');
  assert.equal(fetchCount, 2, 'accepted partial turn should be replayed once');
  assert.equal(dom.window.document.querySelectorAll('.volt-quick-replies').length, 1);

  const staleChip = dom.window.document.querySelector('.volt-quick-reply');
  dom.window.document.querySelector('[aria-label="Новый диалог"]').click();
  staleChip.click();
  assert.equal(dom.window.document.querySelectorAll('.volt-quick-reply').length, 0);
  assert.equal(fetchCount, 2, 'detached chip must not send after reset');

  input.value = 'Нужен другой прожектор';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-send').click();
  await waitForWidget(() => dom.window.document.querySelectorAll('.volt-quick-reply').length === 2,
    'new dialogue may show fresh options');
  dom.window.Date.now = () => now + SESSION_TTL_MS + 1;
  dom.window.document.querySelector('[aria-label="Открыть чат"]').click();
  assert.equal(dom.window.document.querySelectorAll('.volt-quick-reply').length, 0,
    'expired dialogue must remove choices');
  dom.window.close();

  const boundaryDom = bootWidget({
    fetchImpl: async () => new Response(clarificationSse({ replies, boundary: 'session_new_topic_quick_reply' }), {
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  });
  boundaryDom.window.document.querySelector('#volt-widget-input').value = 'Новая тема';
  boundaryDom.window.document.querySelector('#volt-widget-send').click();
  await waitForWidget(() => visibleMessages(boundaryDom).includes('Новая тема') &&
    !boundaryDom.window.document.querySelector('#volt-widget-new-chat').disabled,
  'boundary turn should complete');
  assert.equal(boundaryDom.window.document.querySelectorAll('.volt-quick-reply').length, 0,
    'choices emitted before a topic boundary must not leak into the new topic');
  boundaryDom.window.close();
});

test('reload restores chips only for the same visible question and active server slot', async () => {
  const replies = [
    { value: 'Накладной', label: 'Накладной монтаж' },
    { value: 'Подвесной', label: 'Подвесной монтаж' },
  ];
  const firstDom = bootWidget({
    fetchImpl: async () => new Response(clarificationSse({
      replies,
      slotQuestion: 'Укажите тип монтажа.',
      assistantText: 'Как будем крепить светильник?',
    }), {
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  });
  firstDom.window.document.querySelector('#volt-widget-input').value = 'Подберите светильник';
  firstDom.window.document.querySelector('#volt-widget-send').click();
  await waitForWidget(() => firstDom.window.document.querySelectorAll('.volt-quick-reply').length === 2 &&
    !firstDom.window.document.querySelector('#volt-widget-new-chat').disabled,
  'first turn should finish with chips');
  const persisted = readState(firstDom);
  assert.equal(persisted.quickReplyState.slotId, 'quick-reply-slot');
  firstDom.window.close();

  const payloads = [];
  const restoredDom = bootWidget({
    state: persisted,
    fetchImpl: async (_url, init) => {
      payloads.push(JSON.parse(init.body));
      const events = [
        { v3_event: { type: 'diagnostic', log_id: 'restored-chip-answer-log', phase: 'start' } },
        { choices: [{ delta: { content: 'Монтаж уточнён.' } }] },
        { v3_event: { type: 'diagnostic', log_id: 'restored-chip-answer-log', phase: 'complete', products_count: 0 } },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}`)
        .concat('data: [DONE]', '').join('\n\n'), {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  });
  assert.deepEqual([...restoredDom.window.document.querySelectorAll('.volt-quick-reply')]
    .map((chip) => chip.textContent), replies.map((reply) => reply.label));
  assert.equal(readState(restoredDom).updatedAt, persisted.updatedAt,
    'restoring chips must not prolong the 30-minute session lifetime');
  restoredDom.window.document.querySelectorAll('.volt-quick-reply')[1].click();
  await waitForWidget(() => payloads.length === 1 && visibleMessages(restoredDom).includes('Монтаж уточнён.'),
    'restored chip should send a follow-up');
  assert.equal(payloads[0].message, 'Подвесной');
  assert.equal(payloads[0].dialogSlots.pending_clarification.slot_id, 'quick-reply-slot');
  restoredDom.window.close();

  for (const tamper of [
    (state) => { state.quickReplyState.assistantContent = 'Другой ответ'; },
    (state) => { state.dialogSlots.pending_clarification.slot_id = 'different-slot'; },
    (state) => { state.dialogSlots.pending_clarification.options[0].value = 'Подмена'; },
  ]) {
    const changed = structuredClone(persisted);
    tamper(changed);
    const dom = bootWidget({ state: changed });
    assert.equal(dom.window.document.querySelectorAll('.volt-quick-reply').length, 0,
      'saved chips must not outlive their exact visible turn and pending slot');
    assert.equal(dom.window.document.querySelector('#volt-widget-input').disabled, false);
    dom.window.close();
  }
});

test('quick replies in a final unterminated SSE line use the same validation path', async () => {
  const replies = [
    { value: 'Накладной', label: 'Накладной' },
    { value: 'Подвесной', label: 'Подвесной' },
  ];
  const events = [
    { v3_event: { type: 'diagnostic', log_id: 'final-flush-quick-reply', phase: 'start' } },
    { choices: [{ delta: { content: 'Какое питание у оборудования?' } }] },
    { v3_event: { type: 'slot_update', slots: { pending_clarification: {
      status: 'pending', slot_id: 'final-flush-slot', facet_key: 'mounting',
      question: 'Какое питание у оборудования?', options: replies,
    } } } },
    { v3_event: { type: 'diagnostic', log_id: 'final-flush-quick-reply', phase: 'complete', products_count: 0 } },
    { v3_event: { type: 'quick_replies', facet_key: 'mounting', replies } },
  ];
  const sse = events.map((event) => `data: ${JSON.stringify(event)}`).join('\n');
  const dom = bootWidget({
    fetchImpl: async () => new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }),
  });
  dom.window.document.querySelector('#volt-widget-input').value = 'Уточнить монтаж';
  dom.window.document.querySelector('#volt-widget-send').click();
  await waitForWidget(() => dom.window.document.querySelectorAll('.volt-quick-reply').length === 2,
    'final flush should recognize the valid server choices');
  dom.window.close();
});

test('visible chips expire while an open tab is idle and cannot be clicked afterward', async () => {
  const replies = [
    { value: 'Однофазное', label: 'Однофазное' },
    { value: 'Трёхфазное', label: 'Трёхфазное' },
  ];
  let fetchCount = 0;
  const source = widgetSource.replace('const SESSION_TTL_MS = 30 * 60 * 1000;',
    'const SESSION_TTL_MS = 120;');
  assert.notEqual(source, widgetSource, 'test must shorten the real session TTL');
  const dom = bootWidget({
    source,
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response(clarificationSse({ replies }), {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  });
  dom.window.document.querySelector('#volt-widget-input').value = 'Уточнить питание';
  dom.window.document.querySelector('#volt-widget-send').click();
  await waitForWidget(() => dom.window.document.querySelectorAll('.volt-quick-reply').length === 2,
    'fresh chips should first become visible');
  const staleChip = dom.window.document.querySelector('.volt-quick-reply');
  await waitForWidget(() => dom.window.document.querySelectorAll('.volt-quick-reply').length === 0,
    'idle chips should disappear at the session TTL', 500);
  staleChip.click();
  assert.equal(fetchCount, 1);
  dom.window.close();
});

test('two pre-acceptance 503 failures restore the same pending choices, including after reload', async () => {
  const replies = [
    { value: 'Накладной', label: 'Накладной монтаж' },
    { value: 'Подвесной', label: 'Подвесной монтаж' },
  ];
  let fetchCount = 0;
  const dom = bootWidget({
    fetchImpl: async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Response(clarificationSse({ replies }), {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      return new Response(JSON.stringify({ error: 'temporary_failure' }), {
        status: 503, headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  dom.window.document.querySelector('[aria-label="Открыть чат"]').click();
  dom.window.document.querySelector('#volt-widget-input').value = 'Нужен светильник';
  dom.window.document.querySelector('#volt-widget-send').click();
  await waitForWidget(() => dom.window.document.querySelectorAll('.volt-quick-reply').length === 2 &&
    !dom.window.document.querySelector('#volt-widget-new-chat').disabled,
  'first clarification should complete');
  const originalState = readState(dom).quickReplyState;
  assert.equal(dom.window.document.activeElement,
    dom.window.document.querySelector('.volt-quick-reply'));
  dom.window.document.querySelector('.volt-quick-reply').click();
  await waitForWidget(() => fetchCount === 3 && /ошибка соединения/iu.test(visibleMessages(dom)) &&
    dom.window.document.querySelectorAll('.volt-quick-reply').length === 2 &&
    !dom.window.document.querySelector('#volt-widget-new-chat').disabled,
  'two failed routes should restore still-valid choices');
  assert.equal(dom.window.document.activeElement,
    dom.window.document.querySelector('.volt-quick-reply'),
    'restored choices should receive focus after transient failure');
  const persisted = readState(dom);
  assert.equal(persisted.history.at(-1).content, originalState.assistantContent);
  assert.equal(persisted.history.some((item) => item.content === 'Накладной'), false,
    'unaccepted answer must be rolled back from request history');
  assert.equal(persisted.quickReplyState.slotId, originalState.slotId);
  assert.deepEqual(persisted.quickReplyState.replies, replies);
  dom.window.close();

  const reloaded = bootWidget({ state: persisted });
  assert.deepEqual([...reloaded.window.document.querySelectorAll('.volt-quick-reply')]
    .map((chip) => chip.textContent), replies.map((reply) => reply.label));
  assert.notEqual(reloaded.window.document.activeElement,
    reloaded.window.document.querySelector('.volt-quick-reply'),
    'closed widget must not focus a restored choice');
  reloaded.window.document.querySelector('[aria-label="Открыть чат"]').click();
  assert.equal(reloaded.window.document.activeElement,
    reloaded.window.document.querySelector('.volt-quick-reply'),
    'opening a restored dialogue should focus the first choice');
  reloaded.window.close();
});

test('a clarification finishing after chat closes never focuses hidden chips', async () => {
  const replies = [
    { value: 'Накладной', label: 'Накладной монтаж' },
    { value: 'Подвесной', label: 'Подвесной монтаж' },
  ];
  let finishFetch;
  const dom = bootWidget({
    fetchImpl: () => new Promise((resolve) => { finishFetch = resolve; }),
  });
  const launcher = dom.window.document.querySelector('[aria-label="Открыть чат"]');
  launcher.click();
  dom.window.document.querySelector('#volt-widget-input').value = 'Нужен светильник';
  dom.window.document.querySelector('#volt-widget-send').click();
  await waitForWidget(() => typeof finishFetch === 'function', 'request should be pending');
  dom.window.document.querySelector('#volt-widget-close').click();
  assert.equal(dom.window.document.activeElement, launcher);

  finishFetch(new Response(clarificationSse({ replies }), {
    headers: { 'Content-Type': 'text/event-stream' },
  }));
  await waitForWidget(() => dom.window.document.querySelectorAll('.volt-quick-reply').length === 2 &&
    !dom.window.document.querySelector('#volt-widget-new-chat').disabled,
  'closed turn should still finish and store choices');
  assert.equal(dom.window.document.activeElement, launcher,
    'hidden choices must not steal focus');
  launcher.click();
  assert.equal(dom.window.document.activeElement,
    dom.window.document.querySelector('.volt-quick-reply'));
  dom.window.close();
});

test('stale 400 dialog state and accepted partial errors never restore previous chips', async () => {
  const replies = [
    { value: 'Накладной', label: 'Накладной монтаж' },
    { value: 'Подвесной', label: 'Подвесной монтаж' },
  ];
  for (const failureMode of ['stale_400', 'accepted_partial']) {
    let fetchCount = 0;
    const dom = bootWidget({
      fetchImpl: async () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          return new Response(clarificationSse({ replies }), {
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }
        if (failureMode === 'stale_400' && fetchCount === 2) {
          return new Response(JSON.stringify({ error: 'invalid_request' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
          });
        }
        if (failureMode === 'accepted_partial' && fetchCount === 2) {
          const events = [
            { v3_event: { type: 'diagnostic', log_id: 'accepted-partial-after-chip', phase: 'start' } },
            { choices: [{ delta: { content: 'Проверяю наличие.' } }] },
          ];
          return new Response(events.map((event) => `data: ${JSON.stringify(event)}`)
            .concat('data: [DONE]', '').join('\n\n'), {
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }
        return new Response(JSON.stringify({ error: 'temporary_failure' }), {
          status: 503, headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    dom.window.document.querySelector('#volt-widget-input').value = 'Нужен светильник';
    dom.window.document.querySelector('#volt-widget-send').click();
    await waitForWidget(() => dom.window.document.querySelectorAll('.volt-quick-reply').length === 2 &&
      !dom.window.document.querySelector('#volt-widget-new-chat').disabled,
    'initial clarification should complete');
    dom.window.document.querySelector('.volt-quick-reply').click();
    await waitForWidget(() => fetchCount >= 3 &&
      !dom.window.document.querySelector('#volt-widget-new-chat').disabled,
    'failed follow-up should settle');
    assert.equal(dom.window.document.querySelectorAll('.volt-quick-reply').length, 0,
      `${failureMode} must not revive old choices`);
    assert.equal(readState(dom).quickReplyState, null);
    dom.window.close();
  }
});

test('a server topic boundary or expired original choice prevents restoration after failed routes', async () => {
  const replies = [
    { value: 'Накладной', label: 'Накладной монтаж' },
    { value: 'Подвесной', label: 'Подвесной монтаж' },
  ];
  for (const failureMode of ['new_topic', 'expired']) {
    let fetchCount = 0;
    let now = 1_800_000_000_000;
    const dom = bootWidget({
      now,
      fetchImpl: async () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          return new Response(clarificationSse({ replies }), {
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }
        if (fetchCount === 2 && failureMode === 'new_topic') {
          const boundary = `data: ${JSON.stringify({ v3_event: {
            type: 'conversation_boundary', mode: 'new_task', session_id: 'session_changed_during_failure',
          } })}\n\ndata: [DONE]\n\n`;
          return new Response(boundary, { headers: { 'Content-Type': 'text/event-stream' } });
        }
        if (fetchCount === 2 && failureMode === 'expired') {
          now += SESSION_TTL_MS + 1;
          dom.window.Date.now = () => now;
        }
        return new Response(JSON.stringify({ error: 'temporary_failure' }), {
          status: 503, headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    dom.window.document.querySelector('#volt-widget-input').value = 'Нужен светильник';
    dom.window.document.querySelector('#volt-widget-send').click();
    await waitForWidget(() => dom.window.document.querySelectorAll('.volt-quick-reply').length === 2 &&
      !dom.window.document.querySelector('#volt-widget-new-chat').disabled,
    'initial clarification should complete');
    dom.window.document.querySelector('.volt-quick-reply').click();
    await waitForWidget(() => fetchCount >= (failureMode === 'expired' ? 2 : 3) &&
      !dom.window.document.querySelector('#volt-widget-new-chat').disabled,
    'failed request should settle');
    assert.equal(dom.window.document.querySelectorAll('.volt-quick-reply').length, 0,
      `${failureMode} must not revive stale choices`);
    assert.equal(readState(dom).quickReplyState, null);
    dom.window.close();
  }
});

test('server-issued freeform clarification offers focus-only action, survives reload, and preserves text input', async () => {
  const payloads = [];
  const dom = bootWidget({
    fetchImpl: async (_url, init) => {
      payloads.push(JSON.parse(init.body));
      const sse = payloads.length === 1
        ? freeformClarificationSse()
        : [
            { v3_event: { type: 'diagnostic', log_id: 'freeform-answer-log', phase: 'start' } },
            { choices: [{ delta: { content: 'Площадь уточнена.' } }] },
            { v3_event: { type: 'slot_update', slots: {} } },
            { v3_event: { type: 'diagnostic', log_id: 'freeform-answer-log', phase: 'complete', products_count: 0 } },
          ].map((event) => `data: ${JSON.stringify(event)}`).concat('data: [DONE]', '').join('\n\n');
      return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  const launcher = dom.window.document.querySelector('[aria-label="Открыть чат"]');
  const input = dom.window.document.querySelector('#volt-widget-input');
  launcher.click();
  input.value = 'Нужен прожектор во двор';
  dom.window.document.querySelector('#volt-widget-send').click();
  await waitForWidget(() => dom.window.document.querySelectorAll('.volt-custom-reply').length === 1 &&
    !dom.window.document.querySelector('#volt-widget-new-chat').disabled,
  'complete freeform slot should offer one action');
  const customReply = dom.window.document.querySelector('.volt-custom-reply');
  assert.equal(customReply.textContent, 'Напишу свой вариант');
  assert.equal(dom.window.document.querySelectorAll('.volt-quick-reply').length, 0);
  assert.equal(dom.window.document.activeElement, customReply);
  assert.ok(customReply.compareDocumentPosition(input) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(readState(dom).quickReplyState.mode, 'freeform');
  assert.deepEqual(readState(dom).dialogSlots.pending_clarification.options, []);
  const persisted = readState(dom);
  customReply.click();
  assert.equal(dom.window.document.activeElement, input);
  assert.equal(payloads.length, 1, 'focus-only action must not call the backend');
  assert.equal(input.value, '');
  assert.deepEqual(readState(dom).dialogSlots.pending_clarification.options, []);

  input.value = '35 м²';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('#volt-widget-close').click();
  assert.equal(dom.window.document.activeElement, launcher);
  launcher.click();
  assert.equal(dom.window.document.activeElement, input,
    'reopening with a draft must focus the editor instead of the available action');
  assert.equal(input.value, '35 м²');
  assert.equal(dom.window.document.querySelectorAll('.volt-custom-reply').length, 1);
  dom.window.document.querySelector('#volt-widget-send').click();
  await waitForWidget(() => payloads.length === 2 &&
    visibleMessages(dom).includes('Площадь уточнена.') &&
    !dom.window.document.querySelector('#volt-widget-new-chat').disabled,
  'typed freeform answer should complete');
  assert.equal(payloads[1].message, '35 м²');
  assert.equal(payloads[1].dialogSlots.pending_clarification.slot_id, 'freeform-slot-1');
  assert.equal(dom.window.document.querySelectorAll('.volt-custom-reply').length, 0);
  dom.window.close();

  const reloaded = bootWidget({ state: persisted });
  const reloadedAction = reloaded.window.document.querySelector('.volt-custom-reply');
  assert.ok(reloadedAction);
  assert.notEqual(reloaded.window.document.activeElement, reloadedAction);
  reloaded.window.document.querySelector('[aria-label="Открыть чат"]').click();
  assert.equal(reloaded.window.document.activeElement, reloadedAction);
  reloadedAction.click();
  assert.equal(reloaded.window.document.activeElement,
    reloaded.window.document.querySelector('#volt-widget-input'));
  assert.deepEqual(readState(reloaded).dialogSlots.pending_clarification.options, []);
  reloaded.window.close();
});

test('freeform action returns after two unaccepted 503 routes but not a stale 400', async () => {
  for (const failureStatus of [503, 400]) {
    let fetchCount = 0;
    const dom = bootWidget({
      fetchImpl: async () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          return new Response(freeformClarificationSse(), {
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }
        return new Response(JSON.stringify({ error: 'temporary_failure' }), {
          status: failureStatus, headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    dom.window.document.querySelector('[aria-label="Открыть чат"]').click();
    const input = dom.window.document.querySelector('#volt-widget-input');
    input.value = 'Нужен прожектор во двор';
    dom.window.document.querySelector('#volt-widget-send').click();
    await waitForWidget(() => dom.window.document.querySelectorAll('.volt-custom-reply').length === 1 &&
      !dom.window.document.querySelector('#volt-widget-new-chat').disabled,
    'first freeform clarification should complete');
    dom.window.document.querySelector('.volt-custom-reply').click();
    assert.equal(dom.window.document.activeElement, input);
    input.value = '35 м²';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    dom.window.document.querySelector('#volt-widget-send').click();
    await waitForWidget(() => fetchCount === 3 &&
      /ошибка соединения|устаревших данных/iu.test(visibleMessages(dom)) &&
      !dom.window.document.querySelector('#volt-widget-new-chat').disabled,
    `${failureStatus} follow-up should settle after both routes`);

    if (failureStatus === 503) {
      const restored = dom.window.document.querySelector('.volt-custom-reply');
      assert.ok(restored, 'transient transport failure must restore the unanswered choice');
      assert.equal(dom.window.document.activeElement, restored);
      assert.equal(readState(dom).history.at(-1).content, 'Какова площадь двора в м²?');
      assert.equal(readState(dom).history.some((turn) => turn.content === '35 м²'), false);
      assert.deepEqual(readState(dom).dialogSlots.pending_clarification.options, []);
      const reloaded = bootWidget({ state: readState(dom) });
      assert.ok(reloaded.window.document.querySelector('.volt-custom-reply'));
      reloaded.window.close();
    } else {
      assert.equal(dom.window.document.querySelectorAll('.volt-custom-reply').length, 0,
        'invalid dialog state must not revive the freeform action');
      assert.equal(readState(dom).quickReplyState, null);
    }
    dom.window.close();
  }
});

test('stale pending freeform slot and incomplete response never produce a custom-answer chip', async () => {
  const now = Date.now();
  const staleState = {
    sessionId: 'session_stale_freeform',
    history: [
      { role: 'assistant', content: 'Здравствуйте!' },
      { role: 'user', content: 'Нужен прожектор' },
      { role: 'assistant', content: 'Какова площадь двора в м²?' },
    ],
    dialogSlots: { pending_clarification: {
      status: 'pending', slot_id: 'old-freeform-slot', facet_key: 'yard_area',
      question: 'Какова площадь двора в м²?', options: [],
    } },
    updatedAt: now,
  };
  const noSlotDom = bootWidget({
    state: staleState,
    fetchImpl: async () => new Response(freeformClarificationSse({ includeSlot: false }), {
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  });
  assert.equal(noSlotDom.window.document.querySelectorAll('.volt-custom-reply').length, 0);
  const staleInput = noSlotDom.window.document.querySelector('#volt-widget-input');
  staleInput.value = 'Продолжи подбор';
  staleInput.dispatchEvent(new noSlotDom.window.Event('input', { bubbles: true }));
  noSlotDom.window.document.querySelector('#volt-widget-send').click();
  await waitForWidget(() => !noSlotDom.window.document.querySelector('#volt-widget-new-chat').disabled &&
    readState(noSlotDom).history.at(-1).content === 'Какова площадь двора в м²?',
  'text-only turn without a fresh slot should complete');
  assert.equal(noSlotDom.window.document.querySelectorAll('.volt-custom-reply').length, 0,
    'old pending slot alone cannot authorize a chip');
  noSlotDom.window.close();

  const partialDom = bootWidget({
    fetchImpl: async () => new Response(freeformClarificationSse({ complete: false }), {
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  });
  partialDom.window.document.querySelector('#volt-widget-input').value = 'Нужен прожектор';
  partialDom.window.document.querySelector('#volt-widget-send').click();
  await waitForWidget(() => visibleMessages(partialDom).includes('Ответ получен не полностью') &&
    !partialDom.window.document.querySelector('#volt-widget-new-chat').disabled,
  'partial freeform answer should settle after replay');
  assert.equal(partialDom.window.document.querySelectorAll('.volt-custom-reply').length, 0);
  partialDom.window.close();
});

test('freeform action expires while idle and is removed on new topic', async () => {
  const source = widgetSource.replace('const SESSION_TTL_MS = 30 * 60 * 1000;',
    'const SESSION_TTL_MS = 120;');
  let fetchCount = 0;
  const expiryDom = bootWidget({
    source,
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response(freeformClarificationSse(), {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  });
  expiryDom.window.document.querySelector('#volt-widget-input').value = 'Нужен прожектор';
  expiryDom.window.document.querySelector('#volt-widget-send').click();
  await waitForWidget(() => expiryDom.window.document.querySelectorAll('.volt-custom-reply').length === 1,
    'fresh freeform action should appear');
  const staleAction = expiryDom.window.document.querySelector('.volt-custom-reply');
  await waitForWidget(() => expiryDom.window.document.querySelectorAll('.volt-custom-reply').length === 0,
    'freeform action should expire with session TTL', 500);
  staleAction.click();
  assert.equal(fetchCount, 1);
  expiryDom.window.close();

  let topicFetchCount = 0;
  const topicDom = bootWidget({
    fetchImpl: async () => {
      topicFetchCount += 1;
      const sse = topicFetchCount === 1 ? freeformClarificationSse() : [
        { v3_event: { type: 'diagnostic', log_id: 'new-topic-freeform-log', phase: 'start' } },
        { v3_event: { type: 'conversation_boundary', mode: 'new_task', session_id: 'session_new_freeform_topic' } },
        { choices: [{ delta: { content: 'Ищу лампы в каталоге.' } }] },
        { v3_event: { type: 'diagnostic', log_id: 'new-topic-freeform-log', phase: 'complete', products_count: 0 } },
      ].map((event) => `data: ${JSON.stringify(event)}`).concat('data: [DONE]', '').join('\n\n');
      return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  const input = topicDom.window.document.querySelector('#volt-widget-input');
  input.value = 'Нужен прожектор';
  topicDom.window.document.querySelector('#volt-widget-send').click();
  await waitForWidget(() => topicDom.window.document.querySelectorAll('.volt-custom-reply').length === 1 &&
    !topicDom.window.document.querySelector('#volt-widget-new-chat').disabled,
  'first freeform turn should complete');
  input.value = 'А у вас есть лампы?';
  input.dispatchEvent(new topicDom.window.Event('input', { bubbles: true }));
  topicDom.window.document.querySelector('#volt-widget-send').click();
  await waitForWidget(() => topicFetchCount === 2 && visibleMessages(topicDom).includes('Ищу лампы в каталоге.') &&
    !topicDom.window.document.querySelector('#volt-widget-new-chat').disabled,
  'new topic should complete');
  assert.equal(topicDom.window.document.querySelectorAll('.volt-custom-reply').length, 0);
  assert.equal(readState(topicDom).quickReplyState, null);
  topicDom.window.close();
});
