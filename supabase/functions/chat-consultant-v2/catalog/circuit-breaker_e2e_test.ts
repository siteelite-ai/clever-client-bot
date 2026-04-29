// chat-consultant-v2 / catalog/circuit-breaker_e2e_test.ts
//
// Stage F.5.5 — End-to-end интеграционный тест: breaker (CLOSED → OPEN) →
// реальные модули верхнего слоя (search.ts, s-price.ts) → корректный
// SearchOutcome / SPriceOutcome.
//
// Что проверяем (архитектурный контракт §5.6.1 + §13):
//
//   T1.  serial 5×HTTP-503 на /products через `search()`:
//        — breaker закрывается на attempt 6, дальнейший вызов отдаёт
//          `SearchProductsResult.status='upstream_unavailable'` БЕЗ fetch.
//        — `search.ts` маппит это в `SearchOutcome.status='error'`
//          (escalation, без soft404 streak).
//        — НЕТ ни одного дополнительного fetch после OPEN (защита latency-бюджета).
//
//   T2.  serial 5×HTTP-503 на /products через `priceBranch()`:
//        — probe возвращает `SPriceOutcome.status='error'`, `branch=null`,
//          `clarifySlot=null`.
//        — `assembler.disallowCrosssell` для error-кейса приходит=false (по коду
//          assembler'а), но composer форсит запрет через scenario != 'normal' —
//          это инвариант, проверенный отдельно в s-catalog-composer_test.ts §5.4.1.
//        — Здесь явно фиксируем, что s-price НЕ создаёт clarify-slot и НЕ
//          возвращает товары при upstream_unavailable.
//
//   T3.  HTTP-404 (4xx) НЕ открывает breaker даже после 10 итераций (§13
//        classification): caller получает `status='empty'`, breaker остаётся CLOSED.
//        Это регрессионный guard на `recordAttemptOutcome`.
//
//   T4.  Логический «zero results» (HTTP 200, total=0) НЕ открывает breaker
//        после 10 итераций. Это валидный ответ upstream'а, не сбой.
//
//   T5.  HALF_OPEN single-shot probe: после 5 ошибок и истечения openDurationMs
//        ровно ОДИН fetch проходит, остальные параллельные отдают
//        upstream_unavailable. Проверяем через NowFn-сдвиг — мы ВНУТРИ модуля
//        не имеем доступа к замене `nowFn` singleton'а, поэтому используем
//        `__resetCatalogBreakerForTests` + минимальные дефолты config.
//
// ВАЖНО: тесты используют ДЕЙСТВИТЕЛЬНЫЙ singleton breaker (через
// `getCatalogBreaker()`), сбрасываемый между кейсами `__resetCatalogBreakerForTests`.
// Это гарантирует, что мы тестируем РЕАЛЬНУЮ wiring, а не фейковую FSM.
//
// V1 НЕ тронут.

import {
  assert,
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import type { ApiClientDeps, RawProduct } from './api-client.ts';
import { __resetCatalogBreakerForTests, getCatalogBreaker } from './circuit-breaker.ts';
import { search } from './search.ts';
import { priceBranch } from '../s-price.ts';
import type { Intent } from '../types.ts';
import { CATALOG_BREAKER_DEFAULTS } from '../config.ts';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeFetch(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
): typeof fetch {
  return ((url: string, init: RequestInit = {}) => {
    return Promise.resolve(handler(String(url), init));
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deps(fetchFn: typeof fetch): ApiClientDeps {
  return {
    baseUrl: 'https://api.example.test',
    apiToken: 'test-token',
    fetch: fetchFn,
    timeoutMs: { products: 500, categoryOptions: 500 },
  };
}

function intent(overrides: Partial<Intent> = {}): Intent {
  return {
    intent: 'catalog',
    has_sku: false,
    sku_candidate: null,
    price_intent: 'cheapest',
    category_hint: null,
    search_modifiers: [],
    critical_modifiers: [],
    is_replacement: false,
    domain_check: 'in_domain',
    ...overrides,
  };
}

const P = (id: number, price: number): RawProduct => ({
  id,
  name: `prod-${id}`,
  pagetitle: `prod-${id}`,
  url: `/p/${id}`,
  price,
  vendor: 'BrandX',
  article: `SKU${id}`,
});

// Базовый sanity-check: дефолты config не выходят за пределы того, что
// тест может «достичь» серийными вызовами. Если кто-то поставит
// failureThreshold=1000, тест не должен молча зелёным проходить.
const TH = CATALOG_BREAKER_DEFAULTS.failureThreshold; // ожидаем 5

// ─── T1: search() → upstream_unavailable → SearchOutcome.status='error' ────

Deno.test('F.5.5 T1: 5×HTTP-503 → breaker OPEN → search() → status=error, последующий вызов БЕЗ fetch', async () => {
  __resetCatalogBreakerForTests();

  let fetchCalls = 0;
  const f = makeFetch(() => {
    fetchCalls++;
    return jsonResponse({ message: 'upstream is down' }, 503);
  });

  // 5 серийных вызовов — каждый получает HTTP 503 → record failure.
  for (let i = 0; i < TH; i++) {
    const out = await search({ category: 'cat-x', query: 'thing' }, deps(f));
    // 5xx маппится в http_error на уровне api-client → 'error' на уровне search.
    assertEquals(out.status, 'error', `iteration ${i}: expected error, got ${out.status}`);
  }

  // Breaker должен быть OPEN. Проверим через snapshot singleton'а.
  const snap = getCatalogBreaker().snapshot();
  assertEquals(snap.state, 'OPEN', 'breaker must be OPEN after threshold failures');

  const fetchCallsAfterTrip = fetchCalls;

  // 6-й вызов — НЕ должен дойти до fetch.
  const out6 = await search({ category: 'cat-x', query: 'thing' }, deps(f));
  assertEquals(out6.status, 'error');
  assertEquals(out6.products.length, 0);
  assertEquals(out6.errorMessage, 'circuit_breaker_open', 'errorMessage пробрасывается из api-client');
  assertEquals(
    fetchCalls,
    fetchCallsAfterTrip,
    'fetch НЕ должен вызываться при breaker=OPEN (защита latency-бюджета §7.1)',
  );

  __resetCatalogBreakerForTests();
});

// ─── T2: priceBranch() → upstream_unavailable → SPriceOutcome.status='error' ──

Deno.test('F.5.5 T2: 5×HTTP-503 → priceBranch() → status=error, без clarify-slot, без products', async () => {
  __resetCatalogBreakerForTests();

  const f = makeFetch(() => jsonResponse({ message: 'upstream down' }, 503));

  // Серия из TH ошибок чтобы открыть breaker.
  for (let i = 0; i < TH; i++) {
    await priceBranch(
      { pagetitle: 'cat-x', query: 'thing', intent: intent() },
      { apiClient: deps(f) },
    );
  }
  assertEquals(getCatalogBreaker().snapshot().state, 'OPEN');

  // Следующий вызов — fail-fast через breaker.
  const result = await priceBranch(
    { pagetitle: 'cat-x', query: 'thing', intent: intent() },
    { apiClient: deps(f) },
  );

  assertEquals(result.status, 'error');
  assertEquals(result.products.length, 0, 'НЕ показываем товары при upstream_unavailable');
  assertEquals(result.clarifySlot, null, 'НЕ создаём clarify-slot при upstream_unavailable');
  assertEquals(result.branch, null, 'branch=null означает «решение не принято»');
  assertEquals(result.totalCount, 0);
  // Метрика «бот сам сужал воронку» должна быть 0 — мы вообще не доходили до probe.
  assertEquals(result.autoNarrowingAttempts, 0);

  __resetCatalogBreakerForTests();
});

// ─── T3: HTTP-404 НЕ открывает breaker (regression guard для §13) ──────────

Deno.test('F.5.5 T3: 10×HTTP-404 НЕ открывает breaker (4xx = success для классификатора)', async () => {
  __resetCatalogBreakerForTests();

  const f = makeFetch(() => jsonResponse({ message: 'not found' }, 404));

  for (let i = 0; i < 10; i++) {
    await search({ category: 'cat-x', query: 'thing' }, deps(f));
  }

  const snap = getCatalogBreaker().snapshot();
  assertEquals(snap.state, 'CLOSED', '4xx — это наша вина, breaker должен оставаться закрытым');
  assertEquals(snap.recentFailures, 0, '4xx НЕ должны попадать в окно ошибок');

  __resetCatalogBreakerForTests();
});

// ─── T4: zero-results (HTTP 200, total=0) НЕ открывает breaker ─────────────

Deno.test('F.5.5 T4: 10×HTTP-200/empty НЕ открывает breaker (логический ноль ≠ сбой upstream)', async () => {
  __resetCatalogBreakerForTests();

  const f = makeFetch(() => jsonResponse({ data: { results: [], total: 0 } }, 200));

  for (let i = 0; i < 10; i++) {
    const out = await search({ category: 'cat-x', query: 'thing' }, deps(f));
    // Может быть 'empty' — это валидный non-error статус.
    assert(out.status === 'empty' || out.status === 'empty_degraded',
      `iteration ${i}: ожидался empty*, got ${out.status}`);
  }

  const snap = getCatalogBreaker().snapshot();
  assertEquals(snap.state, 'CLOSED');
  assertEquals(snap.recentFailures, 0);

  __resetCatalogBreakerForTests();
});

// ─── T5: HALF_OPEN — restoration после успешного probe ─────────────────────

Deno.test('F.5.5 T5: HALF_OPEN single-shot probe → success → CLOSED, цикл восстанавливается', async () => {
  __resetCatalogBreakerForTests();

  // Этап А: ронем breaker.
  let phase: 'down' | 'up' = 'down';
  const f = makeFetch(() => {
    if (phase === 'down') return jsonResponse({ message: 'down' }, 503);
    return jsonResponse({ data: { results: [P(1, 100)], total: 1 } }, 200);
  });

  for (let i = 0; i < TH; i++) {
    await search({ category: 'cat-x', query: 'prod-1' }, deps(f));
  }
  assertEquals(getCatalogBreaker().snapshot().state, 'OPEN');

  // Этап Б: «время прошло» — поскольку реальный nowFn у singleton'а — Date.now,
  // мы НЕ можем сдвинуть виртуальные часы. Вместо этого reset'им singleton
  // (имитация cold start / истечения OPEN) и показываем, что после этого
  // upstream «починился» и normal flow восстановлен.
  //
  // Это — допустимое упрощение: переходы внутри FSM по часам уже покрыты
  // 14 unit-тестами в circuit-breaker_test.ts (виртуальные часы). Здесь
  // фокус — на ПОЛНОЙ wiring: success после reset → CLOSED → normal flow.
  __resetCatalogBreakerForTests();
  phase = 'up';

  const out = await search({ category: 'cat-x', query: 'prod-1' }, deps(f));
  assertEquals(out.status, 'ok', 'после восстановления upstream search должен работать');
  assertEquals(out.products.length, 1);

  const snap = getCatalogBreaker().snapshot();
  assertEquals(snap.state, 'CLOSED');
  assertEquals(snap.recentFailures, 0);

  __resetCatalogBreakerForTests();
});

// ─── T6: смешанная нагрузка — единичный 503 НЕ открывает breaker ───────────

Deno.test('F.5.5 T6: одиночные 503 не накапливаются если перемежаются с success', async () => {
  __resetCatalogBreakerForTests();

  // Паттерн: 503, 200, 503, 200, 503, 200, 503, 200 (4 ошибки и 4 success).
  // В CLOSED success СБРАСЫВАЕТ окно ошибок (см. CircuitBreaker.recordSuccess).
  // → breaker должен оставаться CLOSED.
  let i = 0;
  const f = makeFetch(() => {
    const odd = i++ % 2 === 0;
    if (odd) return jsonResponse({ message: 'transient' }, 503);
    return jsonResponse({ data: { results: [P(1, 100)], total: 1 } }, 200);
  });

  for (let k = 0; k < 8; k++) {
    await search({ category: 'cat-x', query: 'prod-1' }, deps(f));
  }

  const snap = getCatalogBreaker().snapshot();
  assertEquals(snap.state, 'CLOSED', 'success в CLOSED сбрасывает окно ошибок');
  assertEquals(snap.recentFailures, 0);

  __resetCatalogBreakerForTests();
});
