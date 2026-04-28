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
