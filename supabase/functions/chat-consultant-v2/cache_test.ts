/**
 * Tests for cache.ts — изолированные unit-тесты.
 * Сетевых вызовов в Supabase здесь нет: проверяем только чистые функции
 * (`normalize`, `hashKey`). Интеграция с БД покрывается в orchestrator_test.
 */

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { normalize, hashKey } from './cache.ts';

Deno.test('normalize: lowercase + trim + collapse spaces + strip punctuation', () => {
  assertEquals(normalize('  Привет, МИР!!! '), 'привет мир');
  assertEquals(normalize('Power-Bank   20000mAh'), 'power bank 20000mah');
  assertEquals(normalize('!!!'), '');
});

Deno.test('normalize: keeps unicode letters (ru/kk) and digits', () => {
  assertEquals(normalize('Қазақстан 2026'), 'қазақстан 2026');
});

Deno.test('hashKey: deterministic and namespaced', async () => {
  const a = await hashKey('intent', 'Привет, мир');
  const b = await hashKey('intent', '  привет  МИР!! ');
  assertEquals(a, b, 'normalize должен делать ключи идентичными');
  assert(a.startsWith('intent:'));
  assertEquals(a.split(':')[1].length, 16);
});

Deno.test('hashKey: different namespaces → different keys', async () => {
  const a = await hashKey('intent', 'розетка');
  const b = await hashKey('search', 'розетка');
  assert(a !== b);
});

Deno.test('hashKey: locale влияет на ключ', async () => {
  const ru = await hashKey('kb', 'розетка', 'ru-KZ');
  const kk = await hashKey('kb', 'розетка', 'kk-KZ');
  assert(ru !== kk);
});

// ─── §4.11 Stale-on-error: чистое ядро (без Supabase) ────────────────────────
import { getOrComputeWithStaleCore, type StaleSource } from './cache.ts';

function makeMemStore() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async <U,>(k: string): Promise<U | null> =>
      (store.has(k) ? (store.get(k) as U) : null),
    set: async <U,>(k: string, v: U, _ttl: number): Promise<void> => {
      store.set(k, v);
    },
  };
}

type Outcome = { ok: boolean; data?: string; transport?: boolean };
const isTransport = (o: Outcome) => o.transport === true;

Deno.test('stale: HOT hit → source=hot, compute не вызывается', async () => {
  const m = makeMemStore();
  m.store.set('K', { ok: true, data: 'cached' });
  let computed = 0;
  const r = await getOrComputeWithStaleCore<Outcome>(
    'K', 60, 3600,
    async () => { computed++; return { ok: true, data: 'fresh' }; },
    isTransport, m.get, m.set,
  );
  assertEquals(r.source, 'hot');
  assertEquals(r.value.data, 'cached');
  assertEquals(computed, 0);
});

Deno.test('stale: HOT miss + compute success → fresh + пишет HOT и STALE', async () => {
  const m = makeMemStore();
  const r = await getOrComputeWithStaleCore<Outcome>(
    'K', 60, 3600,
    async () => ({ ok: true, data: 'fresh' }),
    isTransport, m.get, m.set,
  );
  assertEquals(r.source, 'fresh');
  // даём fire-and-forget сетам отработать
  await new Promise((r) => setTimeout(r, 0));
  assertEquals((m.store.get('K') as Outcome).data, 'fresh');
  assertEquals((m.store.get('K:stale') as Outcome).data, 'fresh');
});

Deno.test('stale: HOT miss + transport-fail + STALE есть → source=stale', async () => {
  const m = makeMemStore();
  m.store.set('K:stale', { ok: true, data: 'old-success' });
  const r = await getOrComputeWithStaleCore<Outcome>(
    'K', 60, 3600,
    async () => ({ ok: false, transport: true }),
    isTransport, m.get, m.set,
  );
  assertEquals(r.source, 'stale');
  assertEquals(r.value.data, 'old-success');
});

Deno.test('stale: HOT miss + transport-fail + STALE пуст → пробрасывает fail', async () => {
  const m = makeMemStore();
  const r = await getOrComputeWithStaleCore<Outcome>(
    'K', 60, 3600,
    async () => ({ ok: false, transport: true }),
    isTransport, m.get, m.set,
  );
  assertEquals(r.source, 'fresh');
  assertEquals(r.value.transport, true);
});

Deno.test('stale: compute throws + STALE есть → source=stale', async () => {
  const m = makeMemStore();
  m.store.set('K:stale', { ok: true, data: 'survived' });
  const r = await getOrComputeWithStaleCore<Outcome>(
    'K', 60, 3600,
    async () => { throw new Error('boom'); },
    isTransport, m.get, m.set,
  );
  assertEquals(r.source, 'stale');
  assertEquals(r.value.data, 'survived');
});

Deno.test('stale: compute throws + STALE пуст → бросает оригинальную ошибку', async () => {
  const m = makeMemStore();
  let caught: unknown = null;
  try {
    await getOrComputeWithStaleCore<Outcome>(
      'K', 60, 3600,
      async () => { throw new Error('boom'); },
      isTransport, m.get, m.set,
    );
  } catch (e) { caught = e; }
  assert(caught instanceof Error);
  assertEquals((caught as Error).message, 'boom');
});

Deno.test('stale: «нормальный» empty НЕ считается transport — НЕ отдаёт stale', async () => {
  const m = makeMemStore();
  m.store.set('K:stale', { ok: true, data: 'old' });
  const r = await getOrComputeWithStaleCore<Outcome>(
    'K', 60, 3600,
    async () => ({ ok: true, data: '' }), // пусто, но не transport
    isTransport, m.get, m.set,
  );
  assertEquals(r.source, 'fresh');
  assertEquals(r.value.data, '');
});

Deno.test('stale: source типизирован', () => {
  const ok: StaleSource[] = ['hot', 'fresh', 'stale'];
  assertEquals(ok.length, 3);
});
