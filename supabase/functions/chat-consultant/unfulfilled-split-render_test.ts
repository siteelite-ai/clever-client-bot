// Регресс: split-рендер «комбинации нет, но компоненты есть» в
// buildDeterministicShortCircuitContent. Кейс: «лампа кукуруза е27» — после
// jargon-fallback находим corn lamp И E27 лампы по отдельности, вместе — 0.
// Composer должен выдать 2 секции с шаблонным дисклеймером, без LLM-стрима.

import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildDeterministicShortCircuitContent } from './index.ts';

// deno-lint-ignore no-explicit-any
const mkProduct = (i: number, name: string): any => ({
  id: i,
  pagetitle: name,
  url: `https://220volt.kz/p/${i}`,
  price: 1000 + i * 100,
  vendor: 'TestBrand',
  category: { pagetitle: 'лампы', id: 1, url: '/cat' },
  options: [],
});

Deno.test('split-рендер: 2 непустые секции → intro «вместе не нашлось» + 2 заголовка + карточки', () => {
  const out = buildDeterministicShortCircuitContent({
    products: [],
    reason: 'unfulfilled-split',
    userMessage: 'лампа кукуруза е27',
    unfulfilledSplit: {
      noun: 'лампа',
      sections: [
        { label: 'corn lamp', products: [mkProduct(1, 'Corn Lamp 15W E40'), mkProduct(2, 'Corn 24W E40')] as never[] },
        { label: 'е27', products: [mkProduct(3, 'LED A60 7W E27'), mkProduct(4, 'LED A60 12W E27')] as never[] },
      ],
    },
  });
  assertStringIncludes(out, 'вместе');
  assertStringIncludes(out, 'не нашлось');
  assertStringIncludes(out, '«лампа»');
  assertStringIncludes(out, '«corn lamp»');
  assertStringIncludes(out, '«е27»');
  assertStringIncludes(out, '**лампа — corn lamp:**');
  assertStringIncludes(out, '**лампа — е27:**');
  assertStringIncludes(out, 'Corn Lamp 15W E40');
  assertStringIncludes(out, 'LED A60 7W E27');
  assertStringIncludes(out, 'https://220volt.kz/p/1');
  assertStringIncludes(out, 'https://220volt.kz/p/3');
});

Deno.test('split-рендер: одна секция пуста → fallthrough в обычный рендер (когда products непуст)', () => {
  const out = buildDeterministicShortCircuitContent({
    products: [mkProduct(99, 'Fallback Product')] as never[],
    reason: 'jargon-fallback',
    userMessage: 'q',
    unfulfilledSplit: {
      noun: 'лампа',
      sections: [
        { label: 'corn', products: [mkProduct(1, 'Corn 1')] as never[] },
        { label: 'е27', products: [] },
      ],
    },
  });
  assertStringIncludes(out, 'Fallback Product');
});

Deno.test('split-рендер: без unfulfilledSplit обычный путь не меняется', () => {
  const out = buildDeterministicShortCircuitContent({
    products: [mkProduct(1, 'Lamp One')] as never[],
    reason: 'pass2-shortcircuit',
    userMessage: 'q',
  });
  assertStringIncludes(out, 'Lamp One');
  // НЕ должно быть split-дисклеймера
  assertEquals(out.includes('вместе не нашлось'), false);
});

Deno.test('split-рендер: максимум 3 карточки на секцию (slice)', () => {
  const many = Array.from({ length: 5 }, (_, i) => mkProduct(i + 1, `P${i + 1}`));
  const out = buildDeterministicShortCircuitContent({
    products: [],
    reason: 'unfulfilled-split',
    userMessage: 'q',
    unfulfilledSplit: {
      noun: 'лампа',
      sections: [
        { label: 'a', products: many as never[] },
        { label: 'b', products: many as never[] },
      ],
    },
  });
  assertStringIncludes(out, 'P1');
  assertStringIncludes(out, 'P3');
  assertEquals(out.includes('P4'), false);  // 4-й и 5-й товары не должны попасть
});
