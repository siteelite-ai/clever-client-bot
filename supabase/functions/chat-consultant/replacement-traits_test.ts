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

// ─── ВА47-29 split-token recognition (regression) ───────────────────────────

Deno.test('marking: ВА 47-29 (split by space) is compacted to ВА47-29', () => {
  const tokens = extractMarkingTokens('Автомат GENERICA ВА 47-29 16А');
  assertEquals(tokens.includes('ВА47-29') || tokens.includes('ВА47-29'.toUpperCase()), true,
    `expected ВА47-29 in tokens, got: ${tokens.join(', ')}`);
});

Deno.test('marking: ВА-47-29 (split by dashes) is compacted', () => {
  const tokens = extractMarkingTokens('Автомат ВА-47-29 С16');
  assertEquals(tokens.some((t) => t === 'ВА47-29' || t === 'ВА-47-29'), true,
    `expected ВА47-29 marking, got: ${tokens.join(', ')}`);
});

Deno.test('marking: ВА 47 - 29 (spaces around dashes) is recognized', () => {
  const tokens = extractMarkingTokens('Автомат ВА 47 - 29 16А ИЭК');
  assertEquals(tokens.includes('ВА47-29'), true,
    `expected compacted ВА47-29, got: ${tokens.join(', ')}`);
});

Deno.test('marking guard: separator-insensitive — token "ВА47-29" matches "ВА 47-29" in title', () => {
  const { filtered, mismatch } = applyMarkingGuard(
    [
      { pagetitle: 'Автомат 1Р ВА 47-29 16 А ИЭК' },     // space-separated marking
      { pagetitle: 'Автомат ВА-47-29 16А IEK' },         // dash-separated marking
      { pagetitle: 'Автомат NXB-63s 1P 16A Chint' },     // другая серия — отсеять
    ],
    ['ВА47-29'],
  );
  assertEquals(mismatch, false);
  assertEquals(filtered.length, 2, `expected 2 кандидата, got ${filtered.length}: ${filtered.map(c => c.pagetitle).join(' | ')}`);
});

Deno.test('marking: GENERICA 16 не ложно-срабатывает как маркировка серии', () => {
  // Buffer-проверка: «слово + одиночное число» НЕ должно эмититься как составная маркировка.
  const tokens = extractMarkingTokens('Светильник GENERICA 16 Вт');
  assertEquals(tokens.includes('GENERICA16'), false,
    `false-positive: GENERICA16 не должен быть маркировкой, got: ${tokens.join(', ')}`);
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

Deno.test('traits: brand-like keys are dropped as service (replacement ≠ same brand)', () => {
  // C01 regression: brend__brend=GENERICA must NOT become MUST-filter,
  // otherwise pool collapses to same-brand and brand-exclude empties it.
  const original = {
    options: [
      { key: 'brend__brend', value_ru: 'GENERICA' },
      { key: 'vendor', value_ru: 'GENERICA' },
      { key: 'proizvoditel_strana', value_ru: 'Россия' },
      { key: 'torgovaya_marka', value_ru: 'GENERICA' },
      { key: 'nominalnyy_tok', value_ru: '16' },
    ],
  };
  const s = schema({
    'brend__brend': ['GENERICA', 'IEK', 'ABB'],
    'vendor': ['GENERICA'],
    'proizvoditel_strana': ['Россия'],
    'torgovaya_marka': ['GENERICA'],
    'nominalnyy_tok': ['16'],
  });
  const res = extractOriginalTraits(original, s);
  assertEquals(res.must, { 'nominalnyy_tok': '16' });
  assertEquals(res.droppedServiceKeys.includes('brend__brend'), true);
  assertEquals(res.droppedServiceKeys.includes('vendor'), true);
  assertEquals(res.droppedServiceKeys.includes('proizvoditel_strana'), true);
  assertEquals(res.droppedServiceKeys.includes('torgovaya_marka'), true);
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

Deno.test('traits: drops structural series marking separator-insensitive', () => {
  const original = {
    pagetitle: 'Автомат GENERICA ВА 47-29 16А',
    options: [
      { key: 'seriya__seriya', value_ru: 'ВА47-29' },
      { key: 'nominalynyy_tok__nominaldy_toқ', value_ru: '16' },
      { key: 'kolichestvo_polyusov__polyuster_sany', value_ru: '1' },
      { key: 'harakteristika_srabatyvaniya__Іske_қosylu_sipattamasy', value_ru: 'C' },
    ],
  };
  const s = schema({
    'seriya__seriya': ['ВА47-29', 'NXB-63s'],
    'nominalynyy_tok__nominaldy_toқ': ['6', '10', '16', '25'],
    'kolichestvo_polyusov__polyuster_sany': ['1', '2', '3'],
    'harakteristika_srabatyvaniya__Іske_қosylu_sipattamasy': ['B', 'C', 'D'],
  });
  const res = extractOriginalTraits(original, s, ['GENERICA', 'ВА', '47-29', '16А']);
  assertEquals('seriya__seriya' in res.must, false);
  assertEquals(res.droppedServiceKeys.includes('seriya__seriya:structural_marking'), true);
  assertEquals(res.must, {
    'nominalynyy_tok__nominaldy_toқ': '16',
    'kolichestvo_polyusov__polyuster_sany': '1',
    'harakteristika_srabatyvaniya__Іske_қosylu_sipattamasy': 'C',
  });
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

// ─── extractOriginalTraits: userTokens prioritization (B7 fix) ──────────────

/**
 * Контекст: до фикса replacement-matcher терял критичные оси (например
 * nominalynyy_tok=16 для автомата 16А) потому что cap=MAX_MUST_TRAITS=4
 * забивался первыми по порядку (частота 50Гц, температура, ед.изм, гарантия).
 * Фикс: при наличии userTokens опции, чьи value матчатся с токеном из запроса,
 * получают приоритет — без хардкода категорий/ключей. См. mem://features/...
 */

const noiseFirstOptions = [
  { key: 'chastota__gc', value_ru: '50' },
  { key: 'diapazon_temp', value_ru: '-40…50' },
  { key: 'edinica_izmereniya', value_ru: 'шт' },
  { key: 'garantiynyy_srok', value_ru: '60' },
  { key: 'nominalynyy_tok', value_ru: '16' },
  { key: 'kolichestvo_polyusov', value_ru: '1' },
  { key: 'harakteristika_srabatyvaniya', value_ru: 'C' },
];

const fullSchema = schema({
  chastota__gc: ['50'],
  diapazon_temp: ['-40…50'],
  edinica_izmereniya: ['шт'],
  garantiynyy_srok: ['60'],
  nominalynyy_tok: ['6', '10', '16', '25', '40'],
  kolichestvo_polyusov: ['1', '2', '3', '4'],
  harakteristika_srabatyvaniya: ['B', 'C', 'D'],
});

Deno.test('extractOriginalTraits: low-information constants do not consume cap', () => {
  const r = extractOriginalTraits({ options: noiseFirstOptions }, fullSchema);
  assertEquals(Object.keys(r.must), [
    'nominalynyy_tok',
    'kolichestvo_polyusov',
    'harakteristika_srabatyvaniya',
  ]);
  assertEquals(r.droppedServiceKeys.includes('chastota__gc:low_information_constant'), true);
  assertEquals(r.droppedServiceKeys.includes('edinica_izmereniya:low_information_constant'), true);
});

Deno.test('extractOriginalTraits: userTokens="16А" поднимает nominalynyy_tok=16 в must', () => {
  const r = extractOriginalTraits({ options: noiseFirstOptions }, fullSchema, ['16А']);
  // nominalynyy_tok должен быть в must (приоритет через digit-prefix match 16↔16).
  assertEquals('nominalynyy_tok' in r.must, true);
  assertEquals(r.must.nominalynyy_tok, '16');
  // Не должен быть в overflow.
  assertEquals(r.droppedOverflow.includes('nominalynyy_tok'), false);
});

Deno.test('extractOriginalTraits: userTokens с null/undefined → как без них', () => {
  const r1 = extractOriginalTraits({ options: noiseFirstOptions }, fullSchema, null);
  const r2 = extractOriginalTraits({ options: noiseFirstOptions }, fullSchema);
  assertEquals(Object.keys(r1.must), Object.keys(r2.must));
});

Deno.test('extractOriginalTraits: userTokens отфильтровывают пустые/невалидные', () => {
  const r = extractOriginalTraits({ options: noiseFirstOptions }, fullSchema, ['', '   ', '16А', null as any]);
  assertEquals(r.must.nominalynyy_tok, '16');
});

Deno.test('extractOriginalTraits: digit-prefix matching «2,5мм²» ↔ «2.5»', () => {
  const opts = [
    { key: 'noise1', value_ru: 'A' },
    { key: 'noise2', value_ru: 'B' },
    { key: 'noise3', value_ru: 'C' },
    { key: 'noise4', value_ru: 'D' },
    { key: 'sechenie', value_ru: '2.5' },
  ];
  const sch = schema({ noise1: ['A'], noise2: ['B'], noise3: ['C'], noise4: ['D'], sechenie: ['1.5', '2.5', '4'] });
  const r = extractOriginalTraits({ options: opts }, sch, ['2,5мм²']);
  assertEquals(r.must.sechenie, '2.5');
});

Deno.test('extractOriginalTraits: brand-токен НЕ приоритизирует brand-ключ (service-фильтр выше)', () => {
  const opts = [
    { key: 'chastota__gc', value_ru: '50' },
    { key: 'diapazon_temp', value_ru: '-40…50' },
    { key: 'edinica_izmereniya', value_ru: 'шт' },
    { key: 'garantiynyy_srok', value_ru: '60' },
    { key: 'brend__brend', value_ru: 'GENERICA' },
    { key: 'nominalynyy_tok', value_ru: '16' },
  ];
  const r = extractOriginalTraits({ options: opts }, fullSchema, ['GENERICA', '16А']);
  // Бренд отброшен на service-фильтре, не попадает в must даже с user-токеном.
  assertEquals('brend__brend' in r.must, false);
  assertEquals(r.droppedServiceKeys.includes('brend__brend'), true);
  // 16А всё равно приоритизировано.
  assertEquals(r.must.nominalynyy_tok, '16');
});

Deno.test('extractOriginalTraits: userTokens без матча → исходный порядок (стабильность)', () => {
  const r = extractOriginalTraits({ options: noiseFirstOptions }, fullSchema, ['blablabla', 'xyz999']);
  assertEquals(Object.keys(r.must), [
    'nominalynyy_tok',
    'kolichestvo_polyusov',
    'harakteristika_srabatyvaniya',
  ]);
});
