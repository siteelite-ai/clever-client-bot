// Stage F.5.7 — observability tests для CircuitBreaker:
// (1) state-transition logging через инжектируемый BreakerLogger;
// (2) монотонный счётчик `upstreamUnavailableCount` в snapshot.
//
// Проверяем КОНТРАКТ, а не реализацию: фиксируем какие события и в каком
// порядке должны попадать в Supabase Edge Function logs (spec §13.1) и
// гарантируем, что метрика `upstream_unavailable_count` (spec §13) считается
// корректно.

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  CircuitBreaker,
  type BreakerConfig,
  type BreakerLogger,
  type BreakerTransitionEvent,
} from './circuit-breaker.ts';

const config: BreakerConfig = {
  failureThreshold: 3,
  failureWindowMs: 10_000,
  openDurationMs: 5_000,
  halfOpenMaxProbes: 1,
};

function makeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function makeSpyLogger() {
  const events: BreakerTransitionEvent[] = [];
  const logger: BreakerLogger = {
    onTransition(e) {
      events.push(e);
    },
  };
  return { logger, events };
}

Deno.test('observability: CLOSED → OPEN logs transition with recentFailures snapshot', () => {
  const clock = makeClock();
  const { logger, events } = makeSpyLogger();
  const b = new CircuitBreaker(config, clock.now, logger);

  b.recordFailure();
  b.recordFailure();
  assertEquals(events.length, 0, 'no transition until threshold');

  b.recordFailure(); // тройной → trip
  assertEquals(events.length, 1);
  assertEquals(events[0].event, 'breaker_transition');
  assertEquals(events[0].from, 'CLOSED');
  assertEquals(events[0].to, 'OPEN');
  assertEquals(events[0].ts, clock.now());
  // recentFailures фиксируется ПОСЛЕ tripOpen (failures очищены) — это документированное поведение
  assertEquals(events[0].recentFailures, 0);
});

Deno.test('observability: OPEN → HALF_OPEN → CLOSED full recovery cycle logs 2 transitions', () => {
  const clock = makeClock();
  const { logger, events } = makeSpyLogger();
  const b = new CircuitBreaker(config, clock.now, logger);

  // Trip → OPEN
  b.recordFailure();
  b.recordFailure();
  b.recordFailure();
  assertEquals(events.length, 1);

  // Истекает openDurationMs → canPass triggers OPEN→HALF_OPEN
  clock.advance(5_000);
  assertEquals(b.canPass(), true);
  assertEquals(events.length, 2);
  assertEquals(events[1].from, 'OPEN');
  assertEquals(events[1].to, 'HALF_OPEN');

  // Probe success → HALF_OPEN→CLOSED
  b.recordSuccess();
  assertEquals(events.length, 3);
  assertEquals(events[2].from, 'HALF_OPEN');
  assertEquals(events[2].to, 'CLOSED');
});

Deno.test('observability: HALF_OPEN probe failure logs HALF_OPEN→OPEN', () => {
  const clock = makeClock();
  const { logger, events } = makeSpyLogger();
  const b = new CircuitBreaker(config, clock.now, logger);

  b.recordFailure();
  b.recordFailure();
  b.recordFailure();
  clock.advance(5_000);
  b.canPass(); // OPEN→HALF_OPEN
  b.recordFailure(); // probe fail → HALF_OPEN→OPEN

  const transitions = events.map((e) => `${e.from}→${e.to}`);
  assertEquals(transitions, ['CLOSED→OPEN', 'OPEN→HALF_OPEN', 'HALF_OPEN→OPEN']);
});

Deno.test('observability: upstreamUnavailableCount increments on canPass()===false in OPEN', () => {
  const clock = makeClock();
  const { logger } = makeSpyLogger();
  const b = new CircuitBreaker(config, clock.now, logger);

  b.recordFailure();
  b.recordFailure();
  b.recordFailure();
  // OPEN, в окне openDurationMs

  for (let i = 0; i < 7; i++) {
    assertEquals(b.canPass(), false);
  }
  const snap = b.snapshot();
  assertEquals(snap.upstreamUnavailableCount, 7);
  assertEquals(snap.state, 'OPEN');
});

Deno.test('observability: upstreamUnavailableCount increments on HALF_OPEN concurrent probe overflow', () => {
  const clock = makeClock();
  const { logger } = makeSpyLogger();
  const b = new CircuitBreaker(config, clock.now, logger);

  b.recordFailure();
  b.recordFailure();
  b.recordFailure();
  clock.advance(5_000);

  // Первый probe — пропускается (HALF_OPEN, inFlight=1).
  assertEquals(b.canPass(), true);
  // Параллельный — отклоняется и инкрементирует счётчик.
  assertEquals(b.canPass(), false);
  assertEquals(b.canPass(), false);

  assertEquals(b.snapshot().upstreamUnavailableCount, 2);
});

Deno.test('observability: upstreamUnavailableCount NOT incremented in CLOSED state', () => {
  const clock = makeClock();
  const { logger } = makeSpyLogger();
  const b = new CircuitBreaker(config, clock.now, logger);

  for (let i = 0; i < 100; i++) assertEquals(b.canPass(), true);
  assertEquals(b.snapshot().upstreamUnavailableCount, 0);
});

Deno.test('observability: reset() zeroes upstreamUnavailableCount', () => {
  const clock = makeClock();
  const { logger } = makeSpyLogger();
  const b = new CircuitBreaker(config, clock.now, logger);

  b.recordFailure();
  b.recordFailure();
  b.recordFailure();
  b.canPass();
  b.canPass();
  assert(b.snapshot().upstreamUnavailableCount > 0);

  b.reset();
  assertEquals(b.snapshot().upstreamUnavailableCount, 0);
  assertEquals(b.snapshot().state, 'CLOSED');
});

Deno.test('observability: logger throwing does NOT break FSM', () => {
  const clock = makeClock();
  const throwingLogger: BreakerLogger = {
    onTransition() {
      throw new Error('logging backend down');
    },
  };
  const b = new CircuitBreaker(config, clock.now, throwingLogger);

  // Не должно бросить наружу.
  b.recordFailure();
  b.recordFailure();
  b.recordFailure();
  assertEquals(b.snapshot().state, 'OPEN');
});

Deno.test('observability: idempotent transitionTo — same state does not re-log', () => {
  const clock = makeClock();
  const { logger, events } = makeSpyLogger();
  const b = new CircuitBreaker(config, clock.now, logger);

  // CLOSED + recordSuccess в CLOSED — не должно логироваться (нет смены state).
  b.recordSuccess();
  b.recordSuccess();
  assertEquals(events.length, 0);
});
