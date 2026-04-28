/**
 * Unit tests для Stage 2 / Step 3.
 * Источник требований: spec §3.2 (S0, S1), §3.3 (Slot), §5.2 (Greetings Guard уровень 1).
 *
 * Запуск: supabase--test_edge_functions с functions=["chat-consultant-v2"].
 */

import {
  assertEquals,
  assert,
  assertExists,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { s0Preprocess, stripGreeting, trimHistory } from './s0-preprocess.ts';
import {
  s1SlotResolver,
  createSlot,
  matchOption,
  SLOT_HARD_TTL_MS,
  SLOT_TTL_TURNS,
} from './s1-slot-resolver.ts';
import type { ChatHistoryMessage } from './types.ts';

// ─── S0 — Greetings Strip (test 1) ───────────────────────────────────────────
Deno.test('S0: stripGreeting срезает приветственный префикс, оставляя суть запроса', () => {
  const cases: Array<[string, string]> = [
    ['Здравствуйте, нужна розетка',         'нужна розетка'],
    ['Привет! у вас есть автоматы?',        'у вас есть автоматы?'],
    ['Добрый день, подскажите по кабелю',   'подскажите по кабелю'],
    ['  hi   нужен щиток',                   'нужен щиток'],
    ['Салем, есть лампы?',                   'есть лампы?'],
    ['нужна розетка',                        'нужна розетка'], // нет greeting → как есть
  ];
  for (const [input, expected] of cases) {
    const { text } = stripGreeting(input);
    assertEquals(text, expected, `failed for: "${input}"`);
  }

  // Pure greeting → cleaned пуст, флаг is_pure_greeting=true
  const r = s0Preprocess('Здравствуйте!', []);
  assertEquals(r.cleaned_message, '');
  assertEquals(r.stripped_greeting, true);
  assertEquals(r.is_pure_greeting, true);
});

// ─── S0 — History truncate (test 2) ──────────────────────────────────────────
Deno.test('S0: trimHistory обрезает историю до 8 последних сообщений', () => {
  const mk = (n: number): ChatHistoryMessage[] =>
    Array.from({ length: n }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `msg-${i}`,
    }));

  assertEquals(trimHistory([]).length, 0);
  assertEquals(trimHistory(undefined).length, 0);
  assertEquals(trimHistory(mk(5)).length, 5);
  assertEquals(trimHistory(mk(8)).length, 8);

  const trimmed = trimHistory(mk(20));
  assertEquals(trimmed.length, 8);
  // Должны остаться ПОСЛЕДНИЕ 8 (msg-12 … msg-19)
  assertEquals(trimmed[0].content, 'msg-12');
  assertEquals(trimmed[7].content, 'msg-19');
});

// ─── S1 — Slot match (test 3) ────────────────────────────────────────────────
Deno.test('S1: matched slot consumed, cleaned_query сохраняет модификаторы', () => {
  const now = 1_700_000_000_000;
  const slot = createSlot({
    type: 'category_disambiguation',
    options: [
      { label: 'Розетки', value: 'rozetki', payload: { categoryId: 10 } },
      { label: 'Выключатели', value: 'vyklyuchateli', payload: { categoryId: 20 } },
    ],
    pending_query: 'чёрные двухгнездовые',
    pending_modifiers: ['чёрные', 'двухгнездовые'],
    now,
    id: 'slot_test_1',
  });

  const res = s1SlotResolver('розетки', [slot], now + 1000);
  assertExists(res.match, 'expected a match');
  assertEquals(res.match!.matched_option.value, 'rozetki');
  assertEquals(res.match!.matched_slot.consumed, true);
  assertEquals(res.match!.matched_slot.closed_reason, 'matched');
  assertEquals(res.remaining_slots.length, 0);
  // cleaned_query содержит исходный pending_query + модификаторы
  assert(res.match!.cleaned_query.includes('чёрные'));
  assert(res.match!.cleaned_query.includes('двухгнездовые'));
  // и НЕ содержит текст самой опции «розетки» как лишнего токена-дубля
  // (он уже не дублируется поверх pending_query)
  assertEquals(
    res.match!.cleaned_query.split(' ').filter((t) => t === 'розетки').length,
    0,
  );
});

// ─── S1 — No-match closes slot after TTL_TURNS (test 4) ──────────────────────
Deno.test('S1: no-match — слот закрывается с reason=ttl_turns после 2 ходов', () => {
  const now = 1_700_000_000_000;
  const slot = createSlot({
    type: 'category_disambiguation',
    options: [
      { label: 'Розетки', value: 'rozetki' },
      { label: 'Выключатели', value: 'vyklyuchateli' },
    ],
    pending_query: 'чёрные',
    now,
    id: 'slot_test_2',
  });
  // Симулируем: уже один ход прошёл без матча
  slot.turns_since_created = 1;

  const res = s1SlotResolver('а сколько стоит доставка?', [slot], now + 1000);
  assertEquals(res.match, null);
  assertEquals(res.remaining_slots.length, 0, 'slot must be closed');
  assertEquals(res.closed_slots.length, 1);
  assertEquals(res.closed_slots[0].reason, 'ttl_turns');
  assertEquals(res.closed_slots[0].slot.consumed, true);
});

// ─── S1 — turns_since_created increments every turn (test 5) ────────────────
Deno.test('S1: turns_since_created инкрементируется на каждом запросе', () => {
  const now = 1_700_000_000_000;
  const slot = createSlot({
    type: 'category_disambiguation',
    options: [{ label: 'Розетки', value: 'rozetki' }],
    pending_query: 'чёрные',
    now,
    id: 'slot_test_3',
  });
  assertEquals(slot.turns_since_created, 0);

  // Ход 1: не матчится, не должен закрыться (1 < TTL_TURNS=2)
  const r1 = s1SlotResolver('погода завтра', [slot], now + 1000);
  assertEquals(r1.match, null);
  assertEquals(r1.remaining_slots.length, 1);
  assertEquals(r1.remaining_slots[0].turns_since_created, 1);
  assertEquals(r1.closed_slots.length, 0);

  // Ход 2: снова не матчится — turns достигает TTL_TURNS → закрывается
  const r2 = s1SlotResolver('и снова мимо', r1.remaining_slots, now + 2000);
  assertEquals(r2.match, null);
  assertEquals(r2.remaining_slots.length, 0);
  assertEquals(r2.closed_slots.length, 1);
  assertEquals(r2.closed_slots[0].reason, 'ttl_turns');
});

// ─── S1 — Hard TTL by time (bonus, проверяет §3.3 expires_at) ────────────────
Deno.test('S1: hard TTL по времени → reason=ttl_time, без матча', () => {
  const now = 1_700_000_000_000;
  const slot = createSlot({
    type: 'price_clarify',
    options: [{ label: 'до 10000', value: 'lt_10000' }],
    pending_query: 'лампы дешёвые',
    now,
  });
  // Сдвигаемся за hard TTL
  const later = now + SLOT_HARD_TTL_MS + 1;
  // Даже если сообщение МОГЛО бы заматчиться — слот мёртв по времени
  const res = s1SlotResolver('до 10000', [slot], later);
  assertEquals(res.match, null);
  assertEquals(res.remaining_slots.length, 0);
  assertEquals(res.closed_slots.length, 1);
  assertEquals(res.closed_slots[0].reason, 'ttl_time');
});

// ─── S1 — matchOption по порядковому номеру ──────────────────────────────────
Deno.test('S1: matchOption распознаёт ответ цифрой/порядковым', () => {
  const opts = [
    { label: 'Розетки', value: 'rozetki' },
    { label: 'Выключатели', value: 'vyklyuchateli' },
    { label: 'Удлинители', value: 'udliniteli' },
  ];
  assertEquals(matchOption('1', opts)?.value, 'rozetki');
  assertEquals(matchOption('второй', opts)?.value, 'vyklyuchateli');
  assertEquals(matchOption('3', opts)?.value, 'udliniteli');
  assertEquals(matchOption('пятый', opts), null);
});

// Sanity: TTL constants
Deno.test('S1: константы TTL соответствуют спеке §3.3', () => {
  assertEquals(SLOT_HARD_TTL_MS, 5 * 60 * 1000);
  assertEquals(SLOT_TTL_TURNS, 2);
});
