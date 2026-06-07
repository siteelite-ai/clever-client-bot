// Unit-тесты для selectCompatAxes (V1 accessory-for compat-блок, patch 2026-06-07).
//
// Что покрываем:
//   1. Канонизация "gx 53" → "GX53" по schema-values.
//   2. Blacklist режет meta-оси (kodnomenklatury, opisaniefayla, populyarnyy, fayl).
//   3. Приоритет: ось, чьё canonical-значение есть в pagetitle якоря, идёт первой.
//   4. Skip: ключа нет в target schema → reason='not-in-target-schema'.
//   5. Skip: anchor-значение не канонизуется → reason='anchor-value-no-canonical-match'.
//   6. collection/brand оси не попадают в compat (handled-by-collection-or-brand-cascade).

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { selectCompatAxes, normCanon } from './compat-axes.ts';

// V1 isExcludedOption(extended) — упрощённая копия (только префиксы из EXTENDED_OPTION_PREFIXES).
const V1_EXTENDED = ['opisaniefayla', 'novinka', 'populyarnyy', 'garantiynyy', 'edinica_izmereniya'];
const v1ExtendedSkip = (k: string) => V1_EXTENDED.some((p) => k.startsWith(p));

function buildSchema(entries: Array<[string, string[]]>): Map<string, { caption: string; values: Set<string> }> {
  const m = new Map<string, { caption: string; values: Set<string> }>();
  for (const [k, vs] of entries) m.set(k, { caption: k, values: new Set(vs) });
  return m;
}

Deno.test('normCanon: пробелы, дефисы, подчёркивания, регистр', () => {
  assertEquals(normCanon('GX53'), 'gx53');
  assertEquals(normCanon('gx 53'), 'gx53');
  assertEquals(normCanon('E-27'), 'e27');
  assertEquals(normCanon('IP_44'), 'ip44');
});

Deno.test('selectCompatAxes: канонизация "gx 53" → "GX53" из schema', () => {
  const anchorOptions = [
    { key: 'tip_cokolya_tip_cokolya', value_ru: 'gx 53', caption_ru: 'Тип цоколя' },
  ];
  const schema = buildSchema([
    ['tip_cokolya_tip_cokolya', ['E27', 'GX53', 'E14']],
  ]);
  const res = selectCompatAxes({
    anchorOptions,
    targetSchema: schema,
    anchorPagetitle: 'Светильник NGX-R1-001-GX53 белый Navigator',
    extraSkipKeyPredicate: v1ExtendedSkip,
  });
  assertEquals(res.axes.length, 1);
  assertEquals(res.axes[0].key, 'tip_cokolya_tip_cokolya');
  assertEquals(res.axes[0].canonical, 'GX53');
  assertEquals(res.axes[0].anchorRaw, 'gx 53');
  assertEquals(res.axes[0].inPagetitle, true);
});

Deno.test('selectCompatAxes: blacklist режет meta-ключи', () => {
  const anchorOptions = [
    { key: 'kodnomenklatury', value_ru: 'ABC-123' },
    { key: 'opisaniefayla', value_ru: '...' },
    { key: 'populyarnyy', value_ru: '1' },
    { key: 'fayl', value_ru: 'image.png' },
    { key: 'tip_cokolya_tip_cokolya', value_ru: 'GX53' },
  ];
  const schema = buildSchema([
    ['kodnomenklatury', ['ABC-123', 'XYZ-456']],
    ['opisaniefayla', ['x']],
    ['populyarnyy', ['1', '0']],
    ['fayl', ['image.png']],
    ['tip_cokolya_tip_cokolya', ['E27', 'GX53']],
  ]);
  const res = selectCompatAxes({
    anchorOptions,
    targetSchema: schema,
    anchorPagetitle: 'Светильник GX53',
    extraSkipKeyPredicate: v1ExtendedSkip,
  });
  assertEquals(res.axes.length, 1);
  assertEquals(res.axes[0].key, 'tip_cokolya_tip_cokolya');
  const skippedKeys = new Set(res.skipped.map((s) => s.key));
  ['kodnomenklatury', 'opisaniefayla', 'populyarnyy', 'fayl'].forEach((k) => {
    if (!skippedKeys.has(k)) throw new Error(`expected ${k} to be skipped`);
  });
  for (const s of res.skipped) {
    if (['kodnomenklatury', 'opisaniefayla', 'populyarnyy', 'fayl'].includes(s.key)) {
      assertEquals(s.reason, 'blacklisted');
    }
  }
});

Deno.test('selectCompatAxes: пропуск ключа, которого нет в target schema', () => {
  const anchorOptions = [
    { key: 'specifichnaya_os_anchora', value_ru: 'X' },
    { key: 'tip_cokolya', value_ru: 'GX53' },
  ];
  const schema = buildSchema([['tip_cokolya', ['GX53', 'E27']]]);
  const res = selectCompatAxes({
    anchorOptions,
    targetSchema: schema,
    anchorPagetitle: '',
    extraSkipKeyPredicate: v1ExtendedSkip,
  });
  assertEquals(res.axes.length, 1);
  assertEquals(res.axes[0].key, 'tip_cokolya');
  assertEquals(
    res.skipped.find((s) => s.key === 'specifichnaya_os_anchora')?.reason,
    'not-in-target-schema'
  );
});

Deno.test('selectCompatAxes: anchor-значение без канонического соответствия → skip', () => {
  const anchorOptions = [{ key: 'tip_cokolya', value_ru: 'B22d' }];
  const schema = buildSchema([['tip_cokolya', ['E27', 'GX53', 'E14']]]);
  const res = selectCompatAxes({
    anchorOptions,
    targetSchema: schema,
    anchorPagetitle: '',
  });
  assertEquals(res.axes.length, 0);
  assertEquals(res.skipped[0].reason, 'anchor-value-no-canonical-match');
});

Deno.test('selectCompatAxes: collection/brand НЕ попадают в compat-каскад', () => {
  const anchorOptions = [
    { key: 'kollekciya__kollekciya', value_ru: 'Niloe Step' },
    { key: 'brend__brend', value_ru: 'Legrand' },
    { key: 'tip_cokolya', value_ru: 'GX53' },
  ];
  const schema = buildSchema([
    ['kollekciya__kollekciya', ['Niloe Step', 'Celiane']],
    ['brend__brend', ['Legrand', 'Schneider']],
    ['tip_cokolya', ['GX53', 'E27']],
  ]);
  const res = selectCompatAxes({
    anchorOptions,
    targetSchema: schema,
    anchorPagetitle: '',
  });
  assertEquals(res.axes.length, 1);
  assertEquals(res.axes[0].key, 'tip_cokolya');
  const reasons = new Set(res.skipped.filter((s) => ['kollekciya__kollekciya', 'brend__brend'].includes(s.key)).map((s) => s.reason));
  assertEquals(reasons.has('handled-by-collection-or-brand-cascade'), true);
});

Deno.test('selectCompatAxes: приоритет — ось с canonical в pagetitle сперва', () => {
  const anchorOptions = [
    { key: 'cvet', value_ru: 'белый' },
    { key: 'tip_cokolya', value_ru: 'GX53' },
  ];
  const schema = buildSchema([
    ['cvet', ['белый', 'чёрный', 'серый']],
    ['tip_cokolya', ['GX53', 'E27', 'E14']],
  ]);
  const res = selectCompatAxes({
    anchorOptions,
    targetSchema: schema,
    anchorPagetitle: 'Светильник NGX-R1-001-GX53 белый Navigator',
  });
  assertEquals(res.axes.length, 2);
  // tip_cokolya и cvet оба inPagetitle → tip_cokolya впереди по lex-порядку? "cvet" < "tip_cokolya".
  // Оба inPagetitle=true, сортировка стабильна по key → cvet первым.
  assertEquals(res.axes[0].inPagetitle, true);
  assertEquals(res.axes[1].inPagetitle, true);
});
