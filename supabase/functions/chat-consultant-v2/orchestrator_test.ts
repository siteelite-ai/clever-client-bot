/**
 * Stage 2 — Step 6 integration tests for Pipeline Orchestrator.
 * Запуск: supabase--test_edge_functions { functions: ["chat-consultant-v2"], pattern: "orch:" }
 */

import { assert, assertEquals, assertNotEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { runPipeline, type OrchestratorDeps } from './orchestrator.ts';
import { createSlot } from './s1-slot-resolver.ts';
import type { ChatRequest, ConversationState, Intent } from './types.ts';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeIntent(over: Partial<Intent> = {}): Intent {
  return {
    intent: 'catalog',
    has_sku: false,
    sku_candidate: null,
    price_intent: null,
    category_hint: null,
    search_modifiers: [],
    critical_modifiers: [],
    is_replacement: false,
    domain_check: 'in_domain',
    ...over,
  };
}

function emptyState(): ConversationState {
  return { conversation_id: 'cnv_test', slots: [] };
}

function makeReq(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    message: '',
    history: [],
    state: emptyState(),
    client_meta: {},
    ...over,
  };
}

interface MockLLM {
  calls: number;
  response: Intent | (() => Intent | Promise<Intent>);
}

function makeDeps(llm: MockLLM, fixedTraceId = 'tr_test'): OrchestratorDeps {
  return {
    newTraceId: () => fixedTraceId,
    classifier: {
      // Чистый in-memory кэш (пустой, чтобы LLM всегда вызывался когда дойдёт)
      getFromCache: async () => null,
      putInCache: async () => {},
      callLLM: async () => {
        llm.calls += 1;
        const r = llm.response;
        return typeof r === 'function' ? await (r as () => Intent)() : r;
      },
    },
  };
}

// ─── 1. Pure greeting → S_GREETING, S2 НЕ вызывается ─────────────────────────

Deno.test('orch: чистое приветствие → S_GREETING, без S2 (LLM не вызван)', async () => {
  const llm: MockLLM = { calls: 0, response: makeIntent() };
  const r = await runPipeline(
    makeReq({ message: 'Здравствуйте!' }),
    makeDeps(llm),
  );
  assertEquals(r.route, 'S_GREETING');
  assertEquals(r.intent.intent, 'greeting');
  assertEquals(llm.calls, 0, 'S2 НЕ должен вызываться при pure greeting');
  assertEquals(r.s2_used_fallback, false);
  assertEquals(r.trace.s3_router?.route, 'greeting');
  assertEquals(r.trace.s2_intent_classifier, undefined);
});

// ─── 2. Greeting + сообщение → S2 вызван на cleaned_message ──────────────────

Deno.test('orch: «Привет, нужна розетка» → S2 на «нужна розетка»', async () => {
  const llm: MockLLM = {
    calls: 0,
    response: makeIntent({ intent: 'catalog', category_hint: 'розетка' }),
  };
  const r = await runPipeline(
    makeReq({ message: 'Привет, нужна розетка' }),
    makeDeps(llm),
  );
  assertEquals(r.route, 'S_CATALOG');
  assertEquals(llm.calls, 1);
  assertEquals(r.effective_message, 'нужна розетка');
  assertEquals(r.trace.s0_preprocess?.stripped_greeting, true);
});

// ─── 3. Slot match → S2 ПРОПУСКАЕТСЯ, intent синтезируется из слота ──────────

Deno.test('orch: slot match → S2 пропущен, intent синтезирован из слота', async () => {
  const slot = createSlot({
    type: 'category_disambiguation',
    pending_query: 'розетка чёрная',
    options: [
      { label: 'настенные', value: 'wall' },
      { label: 'накладные', value: 'surface' },
    ],
    now: 1_000_000,
  });
  const state: ConversationState = {
    conversation_id: 'cnv',
    slots: [slot],
  };
  const llm: MockLLM = { calls: 0, response: makeIntent({ intent: 'knowledge' }) };
  const r = await runPipeline(
    makeReq({ message: 'настенные', state }),
    {
      ...makeDeps(llm),
      now: () => 1_000_001,
    },
  );

  assertEquals(r.route, 'S_CATALOG');
  assertEquals(r.intent.intent, 'catalog');
  assertEquals(r.slot_match?.matched_option.value, 'wall');
  assertEquals(llm.calls, 0, 'при slot match S2 НЕ вызывается');
  assertEquals(r.next_state.slots.length, 0, 'matched slot должен быть удалён из state');
  assertEquals(r.trace.s1_slot_resolver?.matched_slot_id, slot.id);
});

// ─── 4. Slot miss → S2 вызывается, slot НЕ закрыт сразу (turn 1 < TTL_TURNS) ─

Deno.test('orch: slot miss → S2 вызывается, слот доживает (turns < ttl)', async () => {
  const slot = createSlot({
    type: 'category_disambiguation',
    pending_query: 'розетка',
    options: [
      { label: 'настенные', value: 'wall' },
    ],
    now: 1_000_000,
  });
  const state: ConversationState = { conversation_id: 'cnv', slots: [slot] };
  const llm: MockLLM = {
    calls: 0,
    response: makeIntent({ intent: 'catalog', category_hint: 'провода' }),
  };
  const r = await runPipeline(
    makeReq({ message: 'нужны провода 220В', state }),
    { ...makeDeps(llm), now: () => 1_000_500 },
  );

  assertEquals(r.route, 'S_CATALOG');
  assertEquals(llm.calls, 1, 'S2 должен быть вызван при slot miss');
  // Слот после первого miss-хода должен ещё жить (turns_since_created=1 < 2)
  assertEquals(r.next_state.slots.length, 1);
  assertEquals(r.next_state.slots[0].turns_since_created, 1);
});

// ─── 5. catalog + out_of_domain → S_CATALOG_OOD (без вызова Catalog API) ─────

Deno.test('orch: catalog + out_of_domain → S_CATALOG_OOD', async () => {
  const llm: MockLLM = {
    calls: 0,
    response: makeIntent({ intent: 'catalog', domain_check: 'out_of_domain' }),
  };
  const r = await runPipeline(
    makeReq({ message: 'автомобильные шины' }),
    makeDeps(llm),
  );
  assertEquals(r.route, 'S_CATALOG_OOD');
  assertEquals(r.intent.domain_check, 'out_of_domain');
});

// ─── 6. S2 LLM падает → safe fallback, route всё равно валиден ───────────────

Deno.test('orch: S2 LLM throws → safe fallback intent + валидный route', async () => {
  const llm: MockLLM = {
    calls: 0,
    response: () => { throw new Error('OpenRouter 500'); },
  };
  const r = await runPipeline(
    makeReq({ message: 'хочу что-то купить' }),
    makeDeps(llm),
  );
  assert(r.s2_used_fallback, 'должен поднять флаг fallback');
  assertEquals(r.route, 'S_CATALOG'); // safe fallback intent='catalog'/in_domain
});

// ─── 7. Knowledge intent → S_KNOWLEDGE ───────────────────────────────────────

Deno.test('orch: knowledge intent → S_KNOWLEDGE', async () => {
  const llm: MockLLM = { calls: 0, response: makeIntent({ intent: 'knowledge' }) };
  const r = await runPipeline(makeReq({ message: 'как работает доставка?' }), makeDeps(llm));
  assertEquals(r.route, 'S_KNOWLEDGE');
  assertEquals(r.next_state.last_intent, 'knowledge');
});

// ─── 8. trace целостность: traceId + все четыре стадии заполнены, кроме pure greeting ─

Deno.test('orch: trace заполнен на полном пути S0→S1→S2→S3', async () => {
  const llm: MockLLM = { calls: 0, response: makeIntent({ category_hint: 'кабель' }) };
  const r = await runPipeline(
    makeReq({ message: 'кабель ввгнг' }),
    { ...makeDeps(llm, 'tr_X'), now: () => 1_000_000 },
  );
  assertEquals(r.trace.traceId, 'tr_X');
  assert(r.trace.s0_preprocess);
  assert(r.trace.s1_slot_resolver);
  assert(r.trace.s2_intent_classifier);
  assert(r.trace.s3_router);
  assertEquals(r.trace.s3_router?.route, 'catalog');
});

// ─── 9. last_category_hint мигрирует в next_state ────────────────────────────

Deno.test('orch: last_category_hint обновляется в next_state', async () => {
  const llm: MockLLM = { calls: 0, response: makeIntent({ category_hint: 'светильник' }) };
  const prev: ConversationState = {
    conversation_id: 'cnv',
    slots: [],
    last_category_hint: 'розетка',
  };
  const r = await runPipeline(
    makeReq({ message: 'светильник потолочный', state: prev }),
    makeDeps(llm),
  );
  assertEquals(r.next_state.last_category_hint, 'светильник');
  assertNotEquals(r.next_state.last_category_hint, 'розетка');
});

// ─── 10. Empty message → S2 вызван (он сам решит), без падения ───────────────

Deno.test('orch: пустое сообщение не падает, проходит весь pipeline', async () => {
  const llm: MockLLM = { calls: 0, response: makeIntent({ intent: 'smalltalk' }) };
  const r = await runPipeline(makeReq({ message: '' }), makeDeps(llm));
  // Пустое сообщение — НЕ pure greeting (нет stripped), идёт в S2
  assertEquals(r.route, 'S_PERSONA');
  assertEquals(llm.calls, 1);
});
