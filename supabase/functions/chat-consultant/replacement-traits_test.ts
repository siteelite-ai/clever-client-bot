import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  applyMarkingGuard,
  extractMarkingTokens,
  extractOriginalTraits,
  type UnionSchema,
} from './replacement-traits.ts';

function schema(entries: Record<string, string[]>): UnionSchema {
  const m: UnionSchema = new Map();
  for (const [k, vals] of Object.entries(entries)) {
    m.set(k, { caption: k, values: new Set(vals) });
  }
  return m;
}

// ─── extractMarkingTokens ───────────────────────────────────────────────────

Deno.test('marking: ЩРН-П-12 detected from box title', () => {
  const tokens = extractMarkingTokens('Бокс ЩРН-П-12 модулей навесной пластик IP41 GENERICA ИЭК');
  // Должны поймать саму маркировку. IP41 тоже валидно (буквы+цифры).
  const upper = tokens.map((t) => t.toUpperCase());
  const hasShrn = upper.some((t) => t.includes('ЩРН'));
  const hasIp41 = upper.some((t) => t.includes('IP41'));
  assertEquals(hasShrn, true, `expected ЩРН-* marking, got: ${tokens.join(', ')}`);
  assertEquals(hasIp41, true, `expected IP41 marking, got: ${tokens.join(', ')}`);
});

Deno.test('marking: ЩРН ≠ ЩРВ guard discriminates mount type', () => {
  const origTokens = extractMarkingTokens('Бокс ЩРН-П-12 модулей');
  const candidates = [
    { pagetitle: 'Бокс ЩРВ-П-12 модулей встр. пластик' }, // встраиваемый — должен отсеяться
    { pagetitle: 'TEKFOR Корпус пластиковый ЩРН-П-12 IP41' }, // навесной — пройти
  ];
  // Берём только ЩРН-маркировку (без IP), чтобы изолировать тест монтажа.
  const onlyShrn = origTokens.filter((t) => t.startsWith('ЩРН'));
  const { filtered, mismatch } = applyMarkingGuard(candidates, onlyShrn);
  assertEquals(mismatch, false);
  assertEquals(filtered.length, 1);
  assertEquals(filtered[0].pagetitle.includes('ЩРН'), true);
});

Deno.test('marking: empty input returns []', () => {
  assertEquals(extractMarkingTokens(''), []);
  assertEquals(extractMarkingTokens(null), []);
  assertEquals(extractMarkingTokens('просто текст без маркировок'), []);
});

Deno.test('marking guard: no markings → all candidates pass', () => {
  const { filtered, mismatch } = applyMarkingGuard(
    [{ pagetitle: 'a' }, { pagetitle: 'b' }],
    [],
  );
  assertEquals(filtered.length, 2);
  assertEquals(mismatch, false);
});

Deno.test('marking guard: all mismatch → mismatch=true, filtered=[]', () => {
  const { filtered, mismatch } = applyMarkingGuard(
    [{ pagetitle: 'Совсем другое изделие' }],
    ['ЩРН-П-12'],
  );
  assertEquals(filtered.length, 0);
  assertEquals(mismatch, true);
});

// ─── extractOriginalTraits ──────────────────────────────────────────────────

Deno.test('traits: takes only keys present in union schema', () => {
  const original = {
    pagetitle: 'X',
    options: [
      { key: 'material__material', value_ru: 'пластик', caption_ru: 'Материал' },
      { key: 'cvet__tүs', value_ru: 'белый', caption_ru: 'Цвет' },
      { key: 'rare_key_not_in_schema', value_ru: 'foo', caption_ru: 'Rare' },
    ],
  };
  const s = schema({
    'material__material': ['пластик', 'металл'],
    'cvet__tүs': ['белый', 'чёрный'],
  });
  const res = extractOriginalTraits(original, s);
  assertEquals(res.must, { material__material: 'пластик', 'cvet__tүs': 'белый' });
  assertEquals(res.droppedNotInSchema.includes('rare_key_not_in_schema'), true);
});

Deno.test('traits: drops service keys (kod_*, fayl, identifikator_*, opisanie*)', () => {
  const original = {
    options: [
      { key: 'kod_tn_ved__seҚ_tn_kody', value_ru: '9403700008' },
      { key: 'identifikator_sayta__sayt_identifikatory', value_ru: 'Ем000021942' },
      { key: 'fayl', value_ru: '/uploads/x.pdf' },
      { key: 'opisanie_na_kazahskom', value_ru: 'desc' },
      { key: 'kodnomenklatury', value_ru: 'Ем000021942' },
      { key: 'material__material', value_ru: 'пластик' },
    ],
  };
  const s = schema({ 'material__material': ['пластик'] });
  const res = extractOriginalTraits(original, s);
  assertEquals(Object.keys(res.must), ['material__material']);
  assertEquals(res.droppedServiceKeys.length >= 4, true);
});

Deno.test('traits: rejects URL / file-list values even if key is in schema', () => {
  const original = {
    options: [
      { key: 'fayl_link', value_ru: 'https://example.com/a.pdf' },
      { key: 'normal', value_ru: 'normal value' },
    ],
  };
  const s = schema({ 'fayl_link': [], 'normal': ['normal value'] });
  const res = extractOriginalTraits(original, s);
  assertEquals(res.must, { normal: 'normal value' });
});

Deno.test('traits: cap at MAX_MUST_TRAITS=4, overflow tracked', () => {
  const opts = Array.from({ length: 7 }, (_, i) => ({
    key: `k${i}`,
    value_ru: `v${i}`,
  }));
  const original = { options: opts };
  const s = schema(Object.fromEntries(opts.map((o) => [o.key, [o.value_ru]])));
  const res = extractOriginalTraits(original, s);
  assertEquals(Object.keys(res.must).length, 4);
  assertEquals(res.droppedOverflow.length, 3);
});

Deno.test('traits: empty/null original returns empty must', () => {
  assertEquals(extractOriginalTraits(null, new Map()).must, {});
  assertEquals(extractOriginalTraits({ options: [] }, new Map()).must, {});
});

Deno.test('traits: drops keys whose value is missing in union schema values', () => {
  const original = {
    options: [{ key: 'material__material', value_ru: 'дерево' }],
  };
  // В целевых категориях у material нет 'дерево' — отбрасываем, чтобы не обнулить выдачу.
  const s = schema({ 'material__material': ['пластик', 'металл'] });
  const res = extractOriginalTraits(original, s);
  assertEquals(res.must, {});
  assertEquals(res.droppedNotInSchema.some((k) => k.startsWith('material__material')), true);
});
