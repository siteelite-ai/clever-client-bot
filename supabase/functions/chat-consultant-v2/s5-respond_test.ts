/**
 * Stage 2 — Step 10: S5 RESPOND unit tests
 * Источник: spec §5.1, §5.2, §7.2, §9.4 + контракт composeKnowledgeAnswer.
 *
 * Все тесты — без сети: streamLLM мокается через DI.
 */

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  composeKnowledgeAnswer,
  trimHistory,
  buildKnowledgeContext,
  stripGreeting,
  type RespondDeps,
} from './s5-respond.ts';
import type { KnowledgeChunk } from './s-knowledge.ts';
import type { ChatHistoryMessage } from './types.ts';

function makeChunk(overrides: Partial<KnowledgeChunk> = {}): KnowledgeChunk {
  return {
    entry_id: 'e1',
    chunk_id: 'c1',
    title: 'Гарантия',
    content: 'Гарантия на электроинструмент 12 месяцев.',
    type: 'policy',
    source_url: 'https://220volt.kz/garantia',
    score: 0.9,
    chunk_index: 0,
    ...overrides,
  };
}

function fakeDeps(reply: string): RespondDeps {
  return {
    streamLLM: async ({ onDelta }) => {
      // Эмулируем стрим по символам
      for (const ch of reply) onDelta(ch);
      return {
        output_text: reply,
        input_tokens: 100,
        output_tokens: reply.length,
        model: 'google/gemini-2.5-flash',
      };
    },
  };
}

// ─── trimHistory ─────────────────────────────────────────────────────────────
Deno.test('trimHistory: режет до 8 последних сообщений', () => {
  const hist: ChatHistoryMessage[] = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `msg ${i}`,
  }));
  const out = trimHistory(hist);
  assertEquals(out.length, 8);
  assertEquals(out[0].content, 'msg 12');
  assertEquals(out[7].content, 'msg 19');
});

Deno.test('trimHistory: режет по символам, если они > 2400', () => {
  const hist: ChatHistoryMessage[] = Array.from({ length: 8 }, () => ({
    role: 'user',
    content: 'x'.repeat(1000),
  }));
  const out = trimHistory(hist);
  // 1000 + 1000 = 2000 ≤ 2400, +1000 = 3000 > 2400 → стоп на 2-х
  assert(out.length <= 3);
  assert(out.length >= 1);
});

// ─── buildKnowledgeContext ───────────────────────────────────────────────────
Deno.test('buildKnowledgeContext: пустой массив → явное «пусто»', () => {
  const ctx = buildKnowledgeContext([]);
  assert(ctx.includes('пусто'));
});

Deno.test('buildKnowledgeContext: chunk → структурированный блок с url', () => {
  const ctx = buildKnowledgeContext([makeChunk({ title: 'T1' })]);
  assert(ctx.includes('Справка из базы знаний'));
  assert(ctx.includes('T1'));
  assert(ctx.includes('https://220volt.kz/garantia'));
});

Deno.test('buildKnowledgeContext: chunk без url → не падает', () => {
  const ctx = buildKnowledgeContext([makeChunk({ source_url: null })]);
  assert(ctx.includes('Гарантия'));
  assert(!ctx.includes('null'));
});

// ─── stripGreeting (Greetings Guard L2) ──────────────────────────────────────
Deno.test('stripGreeting: «Здравствуйте, ...» вырезается', () => {
  const r = stripGreeting('Здравствуйте, на электроинструмент действует гарантия 12 мес.');
  assertEquals(r.stripped !== null, true);
  assert(r.text.startsWith('на электроинструмент'));
});

Deno.test('stripGreeting: «Добрый день! ...» вырезается', () => {
  const r = stripGreeting('Добрый день! Гарантия 12 месяцев.');
  assertEquals(r.stripped !== null, true);
  assert(r.text.startsWith('Гарантия'));
});

Deno.test('stripGreeting: чистый ответ без приветствия — не меняется', () => {
  const r = stripGreeting('Гарантия на электроинструмент составляет 12 месяцев.');
  assertEquals(r.stripped, null);
  assertEquals(r.text, 'Гарантия на электроинструмент составляет 12 месяцев.');
});

Deno.test('stripGreeting: приветствие глубже 100 chars — не трогаем', () => {
  const longPrefix = 'Гарантия зависит от категории товара. ';
  const text = longPrefix.repeat(3) + 'Здравствуйте, дополнительно...';
  const r = stripGreeting(text);
  assertEquals(r.stripped, null);
});

// ─── composeKnowledgeAnswer (главная) ────────────────────────────────────────
Deno.test('composeKnowledgeAnswer: чистый ответ → onDelta получает финальный текст', async () => {
  const reply = 'Гарантия на электроинструмент составляет 12 месяцев.';
  const deps = fakeDeps(reply);
  const chunks = [makeChunk()];
  const collected: string[] = [];

  const out = await composeKnowledgeAnswer(
    {
      query: 'какая гарантия',
      chunks,
      history: [],
      onDelta: (s) => collected.push(s),
    },
    deps,
  );

  assertEquals(out.text, reply);
  assertEquals(out.greeting_stripped, null);
  // Финальный onDelta вызывается ровно один раз (буферизация L2)
  assertEquals(collected.length, 1);
  assertEquals(collected[0], reply);
});

Deno.test('composeKnowledgeAnswer: ответ с приветствием → стрипается перед onDelta', async () => {
  const reply = 'Здравствуйте! Гарантия 12 месяцев.';
  const deps = fakeDeps(reply);
  const collected: string[] = [];

  const out = await composeKnowledgeAnswer(
    {
      query: 'гарантия',
      chunks: [makeChunk()],
      history: [],
      onDelta: (s) => collected.push(s),
    },
    deps,
  );

  assertEquals(out.greeting_stripped, 'Здравствуйте! ');
  assertEquals(out.text, 'Гарантия 12 месяцев.');
  assertEquals(collected[0], 'Гарантия 12 месяцев.');
  assert(!collected[0].includes('Здравствуйте'));
});

Deno.test('composeKnowledgeAnswer: usage возвращается из streamLLM', async () => {
  const deps = fakeDeps('Ответ.');
  const out = await composeKnowledgeAnswer(
    { query: 'q', chunks: [], history: [], onDelta: () => {} },
    deps,
  );
  assertEquals(out.usage.input_tokens, 100);
  assertEquals(out.usage.total_tokens, 100 + 6);
  assertEquals(out.usage.model, 'google/gemini-2.5-flash');
});

Deno.test('composeKnowledgeAnswer: history передаётся в streamLLM (после trim)', async () => {
  let capturedHistory: ChatHistoryMessage[] = [];
  const deps: RespondDeps = {
    streamLLM: async ({ history, onDelta }) => {
      capturedHistory = history;
      onDelta('ok');
      return { output_text: 'ok', input_tokens: 1, output_tokens: 1, model: 'm' };
    },
  };
  const longHist: ChatHistoryMessage[] = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `m${i}`,
  }));
  await composeKnowledgeAnswer(
    { query: 'q', chunks: [], history: longHist, onDelta: () => {} },
    deps,
  );
  assertEquals(capturedHistory.length, 8);
});
