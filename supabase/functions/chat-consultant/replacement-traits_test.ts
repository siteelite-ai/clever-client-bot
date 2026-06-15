import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  applyBrandExclude,
  applyBrandExcludeWithRelaxation,
  applyMarkingGuard,
  extractMarkingTokens,
  extractOriginalBrand,
  extractOriginalTraits,
  filterStructuralMarkings,
  isOriginalByTitle,
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

// ─── filterStructuralMarkings ───────────────────────────────────────────────

Deno.test('filterStructuralMarkings: drops IP41 when "41" is a facet value', () => {
  const raw = ['ЩРН-П-12', 'IP41'];
  const s = schema({
    'stepeny_zaschity__Қorғau_dәreghesі': ['20', '41', '54', '65'],
  });
  const { kept, droppedFacetValues } = filterStructuralMarkings(raw, s);
  assertEquals(kept, ['ЩРН-П-12']);
  assertEquals(droppedFacetValues, ['IP41']);
});

Deno.test('filterStructuralMarkings: drops brand-like token present in facet values', () => {
  const raw = ['GENERICA', 'ВВГНГ-3Х2.5'];
  const s = schema({ 'brend__brend': ['GENERICA', 'IEK', 'ABB'] });
  const { kept } = filterStructuralMarkings(raw, s);
  assertEquals(kept, ['ВВГНГ-3Х2.5']);
});

Deno.test('filterStructuralMarkings: keeps SKU when no schema overlap', () => {
  const { kept } = filterStructuralMarkings(['ЩРН-П-12'], new Map());
  assertEquals(kept, ['ЩРН-П-12']);
});

// ─── marking guard ALL-of semantics ─────────────────────────────────────────

Deno.test('marking guard ALL: ЩРВ candidate fails even if shares IP41 with original', () => {
  // После filterStructuralMarkings IP41 уже отброшен, но проверяем что ALL-of
  // строго требует наличия КАЖДОГО структурного токена.
  const candidates = [
    { pagetitle: 'Бокс ЩРВ-П-12 IP41 GENERICA' }, // нет ЩРН — должен отсеяться
    { pagetitle: 'TEKFOR ЩРН-П-12 IP41' },        // есть ЩРН — пройти
  ];
  const { filtered, mismatch } = applyMarkingGuard(candidates, ['ЩРН-П-12']);
  assertEquals(mismatch, false);
  assertEquals(filtered.length, 1);
  assertEquals(filtered[0].pagetitle.includes('ЩРН-П-12'), true);
});

Deno.test('marking guard ALL: candidate missing one of two required markings is filtered', () => {
  const candidates = [
    { pagetitle: 'ЩРН-П-12 без второй маркировки' },
    { pagetitle: 'ЩРН-П-12 и ВА47-29 оба здесь' },
  ];
  const { filtered } = applyMarkingGuard(candidates, ['ЩРН-П-12', 'ВА47-29']);
  assertEquals(filtered.length, 1);
  assertEquals(filtered[0].pagetitle.includes('ВА47-29'), true);
});

// ─── numeric recovery (C4 Шаг 1) ────────────────────────────────────────────

Deno.test('marking: physical numeric units kept (16А, 50Вт, 2.5мм², IP65)', () => {
  const t = extractMarkingTokens('Автомат 16А 230В однополюсный');
  assertEquals(t.includes('16А'), true, `expected 16А, got ${t.join(',')}`);
  assertEquals(t.includes('230В'), true, `expected 230В, got ${t.join(',')}`);

  const t2 = extractMarkingTokens('Прожектор 50Вт IP65 6500К');
  assertEquals(t2.includes('50ВТ'), true);
  assertEquals(t2.includes('IP65'), true);

  const t3 = extractMarkingTokens('Кабель ВВГнг 3х2.5мм²');
  assertEquals(t3.some((x) => x.includes('2.5ММ²') || x.includes('2,5ММ²')), true, `got ${t3.join(',')}`);
});

Deno.test('marking: trade units dropped (10м, 5кг, 12шт, 1.5л, 10упак)', () => {
  const t = extractMarkingTokens('Бухта кабеля 10м 5кг 12шт 1.5л 10упак');
  assertEquals(t.length, 0, `expected nothing kept, got: ${t.join(',')}`);
});

// ─── brand extract / exclude (C4 Шаг 2) ────────────────────────────────────

Deno.test('extractOriginalBrand: from options[brend__*]', () => {
  const b = extractOriginalBrand({
    options: [{ key: 'brend__brend', value_ru: 'IEK' }],
  });
  assertEquals(b, 'IEK');
});

Deno.test('extractOriginalBrand: fallback to vendor', () => {
  const b = extractOriginalBrand({ options: [], vendor: 'Schneider' } as any);
  assertEquals(b, 'SCHNEIDER');
});

Deno.test('extractOriginalBrand: null when nothing', () => {
  assertEquals(extractOriginalBrand(null), null);
  assertEquals(extractOriginalBrand({ options: [] }), null);
});

Deno.test('applyBrandExclude: filters candidates of same brand (via options)', () => {
  const candidates = [
    { pagetitle: 'A', options: [{ key: 'brend__brend', value_ru: 'IEK' }] },
    { pagetitle: 'B', options: [{ key: 'brend__brend', value_ru: 'ABB' }] },
  ];
  const { filtered, excluded } = applyBrandExclude(candidates as any, 'IEK');
  assertEquals(filtered.length, 1);
  assertEquals(excluded, 1);
  assertEquals(filtered[0].pagetitle, 'B');
});

Deno.test('applyBrandExclude: filters via pagetitle when options empty', () => {
  const candidates = [
    { pagetitle: 'IEK автомат 16А', options: [] },
    { pagetitle: 'ABB автомат 16А', options: [] },
  ];
  const { filtered } = applyBrandExclude(candidates as any, 'IEK');
  assertEquals(filtered.length, 1);
  assertEquals(filtered[0].pagetitle, 'ABB автомат 16А');
});

Deno.test('applyBrandExclude: no-op when brand null', () => {
  const cs = [{ pagetitle: 'a' }, { pagetitle: 'b' }];
  const { filtered, excluded } = applyBrandExclude(cs as any, null);
  assertEquals(filtered.length, 2);
  assertEquals(excluded, 0);
});

// ─── isOriginalByTitle (C4 Шаг 3) ──────────────────────────────────────────

Deno.test('isOriginalByTitle: exact match (case + whitespace insensitive)', () => {
  assertEquals(isOriginalByTitle('ЩРН-П-12  IEK', 'щрн-п-12 iek'), true);
  assertEquals(isOriginalByTitle('ЩРН-П-12 IEK', 'ЩРВ-П-12 IEK'), false);
  assertEquals(isOriginalByTitle(null, 'x'), false);
});

// ─── applyBrandExcludeWithRelaxation (Wave A4) ────────────────────────────

Deno.test('applyBrandExcludeWithRelaxation: relaxes when all candidates same brand', () => {
  const candidates = [
    { pagetitle: 'A IEK', options: [{ key: 'brend__brend', value_ru: 'IEK' }] },
    { pagetitle: 'B IEK', options: [{ key: 'brend__brend', value_ru: 'IEK' }] },
    { pagetitle: 'C IEK', options: [{ key: 'brend__brend', value_ru: 'IEK' }] },
  ];
  const r = applyBrandExcludeWithRelaxation(candidates as any, 'IEK');
  assertEquals(r.relaxed, true);
  assertEquals(r.filtered.length, 3);
  assertEquals(r.excluded, 0);
});

Deno.test('applyBrandExcludeWithRelaxation: applies exclude when other brands exist', () => {
  const candidates = [
    { pagetitle: 'A IEK', options: [{ key: 'brend__brend', value_ru: 'IEK' }] },
    { pagetitle: 'B Schneider', options: [{ key: 'brend__brend', value_ru: 'Schneider' }] },
    { pagetitle: 'C ABB', options: [{ key: 'brend__brend', value_ru: 'ABB' }] },
  ];
  const r = applyBrandExcludeWithRelaxation(candidates as any, 'IEK');
  assertEquals(r.relaxed, false);
  assertEquals(r.filtered.length, 2);
  assertEquals(r.excluded, 1);
});

Deno.test('applyBrandExcludeWithRelaxation: no-op when candidates empty', () => {
  const r = applyBrandExcludeWithRelaxation([] as any, 'IEK');
  assertEquals(r.relaxed, false);
  assertEquals(r.filtered.length, 0);
  assertEquals(r.excluded, 0);
});

Deno.test('applyBrandExcludeWithRelaxation: no-op when brand null', () => {
  const candidates = [{ pagetitle: 'A', options: [] }];
  const r = applyBrandExcludeWithRelaxation(candidates as any, null);
  assertEquals(r.relaxed, false);
  assertEquals(r.filtered.length, 1);
});
