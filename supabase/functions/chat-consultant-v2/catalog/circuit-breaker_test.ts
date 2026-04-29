// chat-consultant-v2 / catalog/circuit-breaker_test.ts
//
// Unit-тесты FSM. БЕЗ сети, без setTimeout — виртуальные часы через nowFn.
// Покрывают инварианты F.5.1:
//   1. CLOSED → OPEN после N ошибок в окне.
//   2. Окно ошибок — sliding (старые ошибки выпадают).
//   3. OPEN → HALF_OPEN после openDurationMs.
//   4. HALF_OPEN: пропускает halfOpenMaxProbes пробных, остальные — false.
//   5. HALF_OPEN + success → CLOSED (полный сброс).
//   6. HALF_OPEN + failure → OPEN (новый период).
//   7. CLOSED + success → сброс счётчика ошибок.
//   8. recordSuccess/recordFailure в OPEN — no-op (не ломает FSM).
//   9. Конструктор валидирует конфиг.

import {
  assertEquals,
  assertThrows,
  assert,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { CircuitBreaker, UpstreamUnavailableError, type BreakerConfig } from './circuit-breaker.ts';

const CFG: BreakerConfig = {
  failureThreshold: 5,
  failureWindowMs: 30_000,
  openDurationMs: 30_000,
  halfOpenMaxProbes: 1,
};

/** Виртуальные часы. */
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
    set: (v: number) => { t = v; },
  };
}

Deno.test('UpstreamUnavailableError имеет стабильный code и name', () => {
  const e = new UpstreamUnavailableError();
  assertEquals(e.code, 'upstream_unavailable');
  assertEquals(e.name, 'UpstreamUnavailableError');
  assert(e instanceof Error);
});

Deno.test('конструктор валидирует пороги', () => {
  assertThrows(() => new CircuitBreaker({ ...CFG, failureThreshold: 0 }));
  assertThrows(() => new CircuitBreaker({ ...CFG, failureWindowMs: 0 }));
  assertThrows(() => new CircuitBreaker({ ...CFG, openDurationMs: 0 }));
  assertThrows(() => new CircuitBreaker({ ...CFG, halfOpenMaxProbes: 0 }));
});

Deno.test('CLOSED по умолчанию, canPass=true', () => {
  const c = clock();
  const b = new CircuitBreaker(CFG, c.now);
  assertEquals(b.snapshot().state, 'CLOSED');
  assertEquals(b.canPass(), true);
});

Deno.test('CLOSED → OPEN после failureThreshold ошибок в окне', () => {
  const c = clock();
  const b = new CircuitBreaker(CFG, c.now);
  for (let i = 0; i < 4; i++) {
    assertEquals(b.canPass(), true);
    b.recordFailure();
  }
  assertEquals(b.snapshot().state, 'CLOSED');
  assertEquals(b.snapshot().recentFailures, 4);
  // 5-я → OPEN
  b.recordFailure();
  assertEquals(b.snapshot().state, 'OPEN');
  assertEquals(b.canPass(), false);
});

Deno.test('окно ошибок sliding: старые ошибки выпадают', () => {
  const c = clock();
  const b = new CircuitBreaker(CFG, c.now);
  // 4 ошибки, потом ждём весь window и ещё 1 — не должно открыть.
  for (let i = 0; i < 4; i++) b.recordFailure();
  c.advance(31_000); // вышли за окно
  // snapshot должен почистить (мы вызываем pruneOldFailures внутри snapshot для CLOSED)
  assertEquals(b.snapshot().recentFailures, 0);
  b.recordFailure();
  assertEquals(b.snapshot().state, 'CLOSED');
  assertEquals(b.snapshot().recentFailures, 1);
});

Deno.test('CLOSED + success сбрасывает счётчик ошибок', () => {
  const c = clock();
  const b = new CircuitBreaker(CFG, c.now);
  b.recordFailure();
  b.recordFailure();
  assertEquals(b.snapshot().recentFailures, 2);
  b.recordSuccess();
  assertEquals(b.snapshot().recentFailures, 0);
  assertEquals(b.snapshot().state, 'CLOSED');
});

Deno.test('OPEN блокирует canPass до истечения openDurationMs', () => {
  const c = clock();
  const b = new CircuitBreaker(CFG, c.now);
  for (let i = 0; i < 5; i++) b.recordFailure();
  assertEquals(b.snapshot().state, 'OPEN');
  // Через 10s — всё ещё OPEN
  c.advance(10_000);
  assertEquals(b.canPass(), false);
  // Через ещё 25s (итого 35s > 30s) — переход в HALF_OPEN
  c.advance(25_000);
  assertEquals(b.canPass(), true);
  assertEquals(b.snapshot().state, 'HALF_OPEN');
});

Deno.test('HALF_OPEN пропускает ровно halfOpenMaxProbes пробных', () => {
  const c = clock();
  const b = new CircuitBreaker({ ...CFG, halfOpenMaxProbes: 1 }, c.now);
  for (let i = 0; i < 5; i++) b.recordFailure();
  c.advance(31_000);
  assertEquals(b.canPass(), true);  // probe 1 разрешён
  assertEquals(b.canPass(), false); // probe 2 отклонён (in-flight=1)
  assertEquals(b.snapshot().inFlightProbes, 1);
});

Deno.test('HALF_OPEN + success → CLOSED, счётчики чистые', () => {
  const c = clock();
  const b = new CircuitBreaker(CFG, c.now);
  for (let i = 0; i < 5; i++) b.recordFailure();
  c.advance(31_000);
  assert(b.canPass());
  b.recordSuccess();
  const s = b.snapshot();
  assertEquals(s.state, 'CLOSED');
  assertEquals(s.recentFailures, 0);
  assertEquals(s.inFlightProbes, 0);
  assertEquals(s.openedAt, null);
});

Deno.test('HALF_OPEN + failure → OPEN на новый период', () => {
  const c = clock();
  const b = new CircuitBreaker(CFG, c.now);
  for (let i = 0; i < 5; i++) b.recordFailure();
  c.advance(31_000);
  assert(b.canPass());
  b.recordFailure();
  assertEquals(b.snapshot().state, 'OPEN');
  // Новый период начался от текущего now, не от первоначального.
  assertEquals(b.canPass(), false);
  c.advance(31_000);
  assertEquals(b.canPass(), true); // снова HALF_OPEN
});

Deno.test('recordFailure/Success в OPEN — defensive no-op', () => {
  const c = clock();
  const b = new CircuitBreaker(CFG, c.now);
  for (let i = 0; i < 5; i++) b.recordFailure();
  assertEquals(b.snapshot().state, 'OPEN');
  // Такого быть не должно (caller не вызывал canPass), но FSM не должна сломаться.
  b.recordFailure();
  b.recordSuccess();
  assertEquals(b.snapshot().state, 'OPEN');
});

Deno.test('reset() возвращает FSM в CLOSED', () => {
  const c = clock();
  const b = new CircuitBreaker(CFG, c.now);
  for (let i = 0; i < 5; i++) b.recordFailure();
  assertEquals(b.snapshot().state, 'OPEN');
  b.reset();
  const s = b.snapshot();
  assertEquals(s.state, 'CLOSED');
  assertEquals(s.recentFailures, 0);
  assertEquals(s.inFlightProbes, 0);
  assertEquals(s.openedAt, null);
});

Deno.test('конкурентные пробные в HALF_OPEN при halfOpenMaxProbes=2', () => {
  const c = clock();
  const b = new CircuitBreaker({ ...CFG, halfOpenMaxProbes: 2 }, c.now);
  for (let i = 0; i < 5; i++) b.recordFailure();
  c.advance(31_000);
  assertEquals(b.canPass(), true);
  assertEquals(b.canPass(), true);
  assertEquals(b.canPass(), false); // лимит исчерпан
  // Один из пробных успешен → CLOSED, остальные in-flight игнорируются.
  b.recordSuccess();
  assertEquals(b.snapshot().state, 'CLOSED');
});

Deno.test('пограничный случай: ошибка ровно на границе окна остаётся учтённой', () => {
  const c = clock();
  const b = new CircuitBreaker(CFG, c.now);
  b.recordFailure();
  // Ровно в момент cutoff (failureWindowMs позже) ошибка должна ещё считаться:
  // pruneOldFailures использует `t >= cutoff` (включительно).
  c.advance(30_000);
  assertEquals(b.snapshot().recentFailures, 1);
  // Через миллисекунду — выпадает.
  c.advance(1);
  assertEquals(b.snapshot().recentFailures, 0);
});
