// chat-consultant-v2 / lexicon-resolver_test.ts
// §9.2b шаг 1 — каноническая норм.

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { norm, normForCompare } from './lexicon-resolver.ts';

Deno.test('norm: lowercase + NFKC + ё→е + trim', () => {
  assertEquals(norm('  Чёрный  '), 'черный');
  assertEquals(norm('ABC'), 'abc');
  assertEquals(norm('Ёлка'), 'елка');
  assertEquals(norm('тёплый Пол'), 'теплый пол');
});

Deno.test('norm: идемпотентна', () => {
  const s = '  Двухгнёздная Розетка ';
  assertEquals(norm(norm(s)), norm(s));
});

Deno.test('norm: безопасно к null/undefined/non-string', () => {
  assertEquals(norm(null), '');
  assertEquals(norm(undefined), '');
  // @ts-expect-error namespace contract test
  assertEquals(norm(123), '');
});

Deno.test('norm: НЕ удаляет внутренние пробелы и пунктуацию', () => {
  // §9.2b явно: только lowercase + NFKC + ё→е + trim. Никакой пунктуации.
  assertEquals(norm('a  b!'), 'a  b!');
});

Deno.test('normForCompare: добавляет collapse-spaces и удаляет пунктуацию', () => {
  assertEquals(normForCompare('  Acme  Pro!  '), 'acme pro');
  assertEquals(normForCompare('Чёрный, матовый'), 'черный матовый');
});

Deno.test('normForCompare: NFKC композитные → совместимые', () => {
  // Ｆｕｌｌｗｉｄｔｈ → fullwidth (NFKC).
  assertEquals(normForCompare('ＡＢＣ'), 'abc');
});
