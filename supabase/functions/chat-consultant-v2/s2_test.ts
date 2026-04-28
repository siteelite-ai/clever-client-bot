/**
 * Stage 2 — Step 4 unit tests for S2 Intent Classifier.
 * Запуск: supabase--test_edge_functions { functions: ["chat-consultant-v2"], pattern: "s2:" }
 */

import { assertEquals, assertNotEquals, assert, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  classifyIntent,
  computeQueryHash,
  normalizeQuery,
  validateIntent,
  safeFallbackIntent,
  CLASSIFIER_VERSION_TAG,
  type ClassifierDeps,
  type ClassifierCacheRow,
} from './s2-intent-classifier.ts';
import type { Intent } from './types.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

interface MockState {
  cache: Map<string, ClassifierCacheRow>;
  llmCalls: number;
  llmResponse: unknown | (() => unknown | Promise<unknown>);
  cacheReadError?: Error;
  cacheWriteError?: Error;
  nowMs?: number;
}

function makeDeps(state: MockState): ClassifierDeps {
  return {
    now: () => state.nowMs ?? Date.now(),
    getFromCache: async (hash) => {
      if (state.cacheReadError) throw state.cacheReadError;
      return state.cache.get(hash) ?? null;
    },
    putInCache: async (hash, intent) => {
      if (state.cacheWriteError) throw state.cacheWriteError;
      const expiresAt = new Date((state.nowMs ?? Date.now()) + 24 * 60 * 60 * 1000).toISOString();
      state.cache.set(hash, { intent, expires_at: expiresAt });
    },
    callLLM: async () => {
      state.llmCalls += 1;
      const r = state.llmResponse;
      return typeof r === 'function' ? await (r as () => unknown)() : r;
    },
  };
}

// ─── normalizeQuery / computeQueryHash ───────────────────────────────────────

Deno.test('s2: normalizeQuery — lowercase + collapse + strip punctuation', () => {
  assertEquals(normalizeQuery('  Розетка,   ЧЁРНАЯ!! '), 'розетка чёрная');
  assertEquals(normalizeQuery('LED-лампа\tE27'), 'led лампа e27');
  assertEquals(normalizeQuery(''), '');
});

Deno.test('s2: computeQueryHash — стабильный, 16 hex, чувствителен к locale и version', async () => {
  const a = await computeQueryHash('розетка', 'ru');
  const b = await computeQueryHash('  Розетка!! ', 'ru');
  const c = await computeQueryHash('розетка', 'kk');
  const d = await computeQueryHash('розетка', 'ru', 'OTHER_TAG');

  assertEquals(a.length, 16);
  assert(/^[0-9a-f]{16}$/.test(a));
  assertEquals(a, b, 'normalize должен сделать запросы эквивалентными');
  assertNotEquals(a, c, 'разные locale → разные хеши');
  assertNotEquals(a, d, 'разные version_tag → разные хеши');
});

// ─── validateIntent ──────────────────────────────────────────────────────────

Deno.test('s2: validateIntent — пропускает корректный Intent', () => {
  const ok = makeIntent({ intent: 'knowledge' });
  const out = validateIntent(ok);
  assertEquals(out.intent, 'knowledge');
});

Deno.test('s2: validateIntent — режет невалидный intent enum', () => {
  const bad = { ...makeIntent(), intent: 'wat' };
  let threw = false;
  try { validateIntent(bad); } catch { threw = true; }
  assert(threw, 'должен бросить на невалидном enum');
});

Deno.test('s2: validateIntent — режет нестроковые modifiers', () => {
  const bad = { ...makeIntent(), search_modifiers: [1, 2, 3] as unknown as string[] };
  let threw = false;
  try { validateIntent(bad); } catch { threw = true; }
  assert(threw);
});

// ─── classifyIntent: cache miss → LLM → cache write ──────────────────────────

Deno.test('s2: cache miss → LLM вызывается, результат кэшируется', async () => {
  const state: MockState = {
    cache: new Map(),
    llmCalls: 0,
    llmResponse: makeIntent({ intent: 'catalog', category_hint: 'розетка' }),
    nowMs: 1_000_000,
  };
  const deps = makeDeps(state);
  const r = await classifyIntent('розетка', 'ru', deps);

  assertEquals(r.cache_hit, false);
  assertEquals(r.used_fallback, false);
  assertEquals(r.intent.category_hint, 'розетка');
  assertEquals(state.llmCalls, 1);
  assertEquals(state.cache.size, 1, 'результат должен быть закэширован');
});

// ─── classifyIntent: cache hit → LLM НЕ вызывается ───────────────────────────

Deno.test('s2: cache hit → LLM НЕ вызывается', async () => {
  const hash = await computeQueryHash('розетка', 'ru', CLASSIFIER_VERSION_TAG);
  const state: MockState = {
    cache: new Map([[hash, {
      intent: makeIntent({ category_hint: 'cached-розетка' }),
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }]]),
    llmCalls: 0,
    llmResponse: makeIntent({ category_hint: 'NEW-FROM-LLM' }),
  };
  const deps = makeDeps(state);
  const r = await classifyIntent('розетка', 'ru', deps);

  assertEquals(r.cache_hit, true);
  assertEquals(r.intent.category_hint, 'cached-розетка');
  assertEquals(state.llmCalls, 0);
});

// ─── classifyIntent: expired cache → LLM вызывается ──────────────────────────

Deno.test('s2: expired cache (>24ч) → LLM вызывается заново', async () => {
  const hash = await computeQueryHash('розетка', 'ru', CLASSIFIER_VERSION_TAG);
  const state: MockState = {
    cache: new Map([[hash, {
      intent: makeIntent({ category_hint: 'STALE' }),
      expires_at: new Date(Date.now() - 1000).toISOString(), // в прошлом
    }]]),
    llmCalls: 0,
    llmResponse: makeIntent({ category_hint: 'FRESH' }),
  };
  const deps = makeDeps(state);
  const r = await classifyIntent('розетка', 'ru', deps);

  assertEquals(r.cache_hit, false);
  assertEquals(r.intent.category_hint, 'FRESH');
  assertEquals(state.llmCalls, 1);
});

// ─── classifyIntent: LLM падает → safe fallback, НЕ кэшируется ───────────────

Deno.test('s2: LLM throws → safe fallback, кэш НЕ заполняется', async () => {
  const state: MockState = {
    cache: new Map(),
    llmCalls: 0,
    llmResponse: () => { throw new Error('OpenRouter 500'); },
  };
  const deps = makeDeps(state);
  const r = await classifyIntent('розетка', 'ru', deps);

  assertEquals(r.used_fallback, true);
  assertEquals(r.intent.intent, 'catalog');
  assertEquals(r.intent.domain_check, 'in_domain');
  assertEquals(state.cache.size, 0, 'fallback НЕ должен попадать в кэш');
});

// ─── classifyIntent: невалидный JSON от LLM → safe fallback ──────────────────

Deno.test('s2: LLM возвращает мусор → validateIntent режет → safe fallback', async () => {
  const state: MockState = {
    cache: new Map(),
    llmCalls: 0,
    llmResponse: { intent: 'catalog', has_sku: 'maybe' /* не boolean */ },
  };
  const deps = makeDeps(state);
  const r = await classifyIntent('розетка', 'ru', deps);

  assertEquals(r.used_fallback, true);
  assertEquals(state.cache.size, 0);
});

// ─── safeFallbackIntent ──────────────────────────────────────────────────────

Deno.test('s2: safeFallbackIntent — катирует длинный query до 64 символов', () => {
  const long = 'a'.repeat(200);
  const f = safeFallbackIntent(long);
  assertEquals(f.intent, 'catalog');
  assertEquals(f.domain_check, 'in_domain');
  assertEquals((f.category_hint ?? '').length, 64);
});

// Smoke-тест rejects (для линтера, чтобы не было unused import)
Deno.test('s2: assertRejects smoke', async () => {
  await assertRejects(async () => { throw new Error('x'); });
});
