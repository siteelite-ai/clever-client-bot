/**
 * Stage 2 — Step 9: S_KNOWLEDGE unit tests
 * Источник: spec §3.2, §7.1, §7.2, §9.4 + контракт runKnowledge.
 *
 * Тесты не ходят в сеть/БД: всё через инжектируемые deps.
 */

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  runKnowledge,
  type KnowledgeChunk,
  type KnowledgeDeps,
} from './s-knowledge.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────
function makeChunk(overrides: Partial<KnowledgeChunk> = {}): KnowledgeChunk {
  return {
    entry_id: 'e1',
    chunk_id: 'c1',
    title: 'Гарантия',
    content: 'На электроинструмент действует гарантия 12 месяцев.',
    type: 'policy',
    source_url: 'https://220volt.kz/garantia',
    score: 0.9,
    chunk_index: 0,
    ...overrides,
  };
}

function fakeDeps(chunks: KnowledgeChunk[], opts: { throws?: boolean } = {}): {
  deps: KnowledgeDeps;
  calls: number;
} {
  let calls = 0;
  const deps: KnowledgeDeps = {
    searchChunks: async () => {
      calls++;
      if (opts.throws) throw new Error('boom');
      return chunks;
    },
  };
  return { deps, get calls() { return calls; } } as { deps: KnowledgeDeps; calls: number };
}

// ─── Tests ───────────────────────────────────────────────────────────────────
Deno.test('runKnowledge: пустой запрос → fallback без вызова searchChunks', async () => {
  const tracker = fakeDeps([]);
  const out = await runKnowledge('   ', tracker.deps);
  assertEquals(out.has_results, false);
  assertEquals(out.chunks.length, 0);
  assertEquals(out.branch, 'S_KNOWLEDGE');
  assertEquals(tracker.calls, 0, 'searchChunks не должен вызываться на пустом запросе');
});

Deno.test('runKnowledge: успешный поиск → chunks возвращаются и has_results=true', async () => {
  const chunks = [
    makeChunk({ chunk_id: 'c1', title: 'Гарантия' }),
    makeChunk({ chunk_id: 'c2', title: 'Возврат', entry_id: 'e2' }),
  ];
  const { deps } = fakeDeps(chunks);
  const out = await runKnowledge('какая гарантия на электроинструмент', deps);
  assertEquals(out.has_results, true);
  assertEquals(out.chunks.length, 2);
  assert(out.text.includes('Гарантия'), 'fallback-текст должен содержать заголовок');
});

Deno.test('runKnowledge: пустой результат → fallback-текст без results', async () => {
  const { deps } = fakeDeps([]);
  const out = await runKnowledge('абракадабра 12345', deps);
  assertEquals(out.has_results, false);
  assert(out.text.length > 0);
  assert(!out.text.includes('Нашёл'), 'на 0 chunks не должно быть «Нашёл»');
});

Deno.test('runKnowledge: ошибка RPC → soft-fallback, наружу не пробрасывается', async () => {
  const { deps } = fakeDeps([], { throws: true });
  const out = await runKnowledge('гарантия', deps);
  assertEquals(out.has_results, false);
  assertEquals(out.chunks.length, 0);
  assertEquals(out.branch, 'S_KNOWLEDGE');
});

Deno.test('runKnowledge: trimToBudget — режет при превышении 6000 символов', async () => {
  const big = 'x'.repeat(4000);
  const chunks = [
    makeChunk({ chunk_id: 'c1', content: big }),
    makeChunk({ chunk_id: 'c2', content: big, entry_id: 'e2' }),
    makeChunk({ chunk_id: 'c3', content: big, entry_id: 'e3' }),
  ];
  const { deps } = fakeDeps(chunks);
  const out = await runKnowledge('тест', deps);
  // Первый влезает (4000), второй превышает потолок (4000+4000>6000) → стоп.
  assertEquals(out.chunks.length, 1);
});

Deno.test('runKnowledge: cache_hit поле присутствует в выводе', async () => {
  const { deps } = fakeDeps([makeChunk()]);
  const out = await runKnowledge('гарантия unique-' + Date.now(), deps);
  // На первом вызове кеш-мисс (cache_hit=false). Не проверяем хит, потому что
  // в тестовой среде нет SUPABASE_URL → кэш молча no-op'ит.
  assertEquals(typeof out.cache_hit, 'boolean');
});
