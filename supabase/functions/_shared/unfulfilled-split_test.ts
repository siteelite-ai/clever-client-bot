// Регресс на probeUnfulfilledCombination. Кейс-источник: «лампа кукуруза е27» —
// LLM-translation даёт corn lamp (≥1 товар), e27 даёт обычные E27-лампы (≥1),
// но «corn lamp + e27» (combined) = 0 → hasSplit=true → caller должен split-рендерить.

import { assertEquals, assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { probeUnfulfilledCombination } from './unfulfilled-split.ts';

type P = { price?: number | null; pagetitle?: string | null };

const mk = (n: number, prefix: string, price = 1000): P[] =>
  Array.from({ length: n }, (_, i) => ({ pagetitle: `${prefix}-${i}`, price }));

Deno.test('probe.split: классика «лампа кукуруза е27» → combined=0, оба компонента >0 → hasSplit', async () => {
  const calls: string[] = [];
  const r = await probeUnfulfilledCombination({
    noun: 'лампа',
    modifiers: ['кукуруза', 'е27'],
    searchFn: (q) => {
      calls.push(q);
      if (q === 'лампа кукуруза е27') return Promise.resolve([] as P[]);
      if (q === 'лампа кукуруза') return Promise.resolve(mk(5, 'corn'));
      if (q === 'лампа е27') return Promise.resolve(mk(30, 'e27'));
      return Promise.resolve([]);
    },
  });
  assertEquals(r.hasSplit, true);
  assertEquals(r.combined.total, 0);
  assertEquals(r.perModifier.length, 2);
  assertEquals(r.presentModifiers, ['кукуруза', 'е27']);
  assertEquals(r.perModifier[0].sample.length, 3);  // top-3 capped
  assertEquals(calls.length, 3); // 1 combined + 2 per-modifier
});

Deno.test('probe.split: < 2 модификаторов → skip без сетевых вызовов', async () => {
  let called = 0;
  const r = await probeUnfulfilledCombination({
    noun: 'лампа',
    modifiers: ['е27'],
    searchFn: () => { called++; return Promise.resolve([]); },
  });
  assertEquals(r.hasSplit, false);
  assertEquals(called, 0);
});

Deno.test('probe.split: все per-modifier пусты → hasSplit=false (это честный Soft-404)', async () => {
  const r = await probeUnfulfilledCombination({
    noun: 'лампа',
    modifiers: ['xyz', 'qwe'],
    searchFn: () => Promise.resolve([] as P[]),
  });
  assertEquals(r.hasSplit, false);
  assertEquals(r.presentModifiers, []);
});

Deno.test('probe.split: один компонент пуст, другой нет → hasSplit=false (caller покажет один пул с дисклеймером)', async () => {
  const r = await probeUnfulfilledCombination({
    noun: 'лампа',
    modifiers: ['кукуруза', 'е27'],
    searchFn: (q) => Promise.resolve(q.endsWith('е27') ? mk(10, 'e27') : []),
  });
  assertEquals(r.hasSplit, false);
  assertEquals(r.presentModifiers, ['е27']);
});

Deno.test('probe.split: combined >0 → hasSplit=false даже если per-modifier >0 (комбинация найдена, split не нужен)', async () => {
  const r = await probeUnfulfilledCombination({
    noun: 'лампа',
    modifiers: ['e27', 'led'],
    searchFn: () => Promise.resolve(mk(5, 'x')),
  });
  assertEquals(r.hasSplit, false);
  assertEquals(r.combined.total, 5);
});

Deno.test('probe.split: HARD BAN price=0 — товары с price=0 НЕ попадают в sample', async () => {
  const r = await probeUnfulfilledCombination({
    noun: 'лампа',
    modifiers: ['кукуруза', 'е27'],
    searchFn: (q) => {
      if (q === 'лампа кукуруза е27') return Promise.resolve([]);
      // Half zero-priced, half real
      return Promise.resolve([
        { pagetitle: 'free-1', price: 0 },
        { pagetitle: 'free-2', price: 0 },
        { pagetitle: 'real-1', price: 500 },
        { pagetitle: 'real-2', price: 700 },
      ] as P[]);
    },
  });
  assertEquals(r.hasSplit, true);
  for (const p of r.perModifier) {
    assertEquals(p.total, 4); // total включает все
    assertEquals(p.sample.length, 2); // но в sample только price>0
    for (const s of p.sample) {
      assertExists(s.price);
      if (typeof s.price === 'number') assertEquals(s.price > 0, true);
    }
  }
});

Deno.test('probe.split: дедуп модификаторов — повтор не делает лишний запрос', async () => {
  let calls = 0;
  await probeUnfulfilledCombination({
    noun: 'лампа',
    modifiers: ['е27', 'е27', 'кукуруза'],
    searchFn: () => { calls++; return Promise.resolve([]); },
  });
  // 1 combined + 2 уникальных модификатора (е27, кукуруза)
  assertEquals(calls, 3);
});
