/**
 * Replacement-branch traits extractor (Layers 1+2).
 *
 * Слой 1 (extractOriginalTraits): когда `is_replacement=true` и оригинал
 *   резолвлен через article/pagetitle — берём его реальные options[] из
 *   каталога и оставляем только те ключи, которые присутствуют в union-schema
 *   целевых replacement-категорий. Это даёт data-agnostic спецификацию
 *   аналога БЕЗ опоры на токенизированные search_modifiers пользователя.
 *
 * Слой 2 (extractMarkingTokens): из pagetitle оригинала извлекаем
 *   структурные маркировки изделий (ЩРН-П-12, ВВГнг-3х2.5, ВА47-29) по
 *   regex'у. Используются как пост-фильтр над выдачей: кандидат должен
 *   содержать хотя бы один маркировочный токен оригинала в своём pagetitle.
 *
 * Оба helper'а — pure функции, без сетевых вызовов, без зависимости от
 * конкретных категорий или брендов 220volt. Это позволяет тестировать их
 * изолированно и не нарушает Core правило «data-agnostic spec».
 */

export interface OriginalOption {
  key: string;
  caption_ru?: string;
  value_ru?: string;
  // другие поля игнорируются
}

export interface OriginalLike {
  pagetitle?: string | null;
  options?: OriginalOption[] | null;
}

export type UnionSchema = Map<string, { caption: string; values: Set<string> }>;

/** Max MUST-фильтров от оригинала. Сверх него — отбрасываем (могло бы
 *  схлопнуть выдачу до нуля). Совпадает с эвристикой similar-ветки V2 (8 traits). */
const MAX_MUST_TRAITS = 4;

/** Префиксы служебных facet keys, которые НЕ являются характеристиками товара.
 *  Не whitelist категорий (data-agnostic): это технические ключи каталога
 *  220volt-агностичные по форме (kod_*, fayl, opisanie_*, identifikator_*,
 *  poiskovyy_zapros и т.п.). */
const SERVICE_KEY_PREFIXES = [
  'kod_',
  'identifikator_',
  'fayl',
  'opisanie',
  'poiskovyy_',
  'kodnomenklatury',
  'klimaticheskoe_',
  'klass_elektrobezopasnosti',
  // Brand-like keys: must NEVER be MUST-trait in replacement branch.
  // Replacement = same characteristics, DIFFERENT brand. Adding original brand
  // as options[]-filter collapses pool to same-brand → brand-exclude empties
  // it → relaxation falls back to same-brand → user gets identical brand
  // instead of alternative. Data-agnostic: covers brend_*, vendor, proizvoditel_*.
  'brend',
  'vendor',
  'brand',
  'proizvoditel',
  'manufacturer',
  'torgovaya_marka',
  // Marketing / sales flags: not product characteristics for replacement selection.
  // Data-agnostic: covers novinka, hit, recommend, sale, popular, action, etc.
  'novinka',
  'hit',
  'recommend',
  'rasprodazha',
  'sale',
  'populyarnyy',
  'popular',
  'aktsiya',
  'action',
];

/**
 * Эвристика «структурный идентификатор линейки» (data-agnostic, без whitelist'ов ключей).
 * Значение опции считаем брендоспецифичной маркировкой модели/серии (не
 * характеристикой товара) если ВСЕ условия выполнены:
 *   1) value встречается в pagetitle оригинала (нормализованно);
 *   2) value содержит И буквы, И цифры (alphanumeric mix);
 *   3) длина value > 4 символов (отсекает функциональные «1P», «16А», «IP20», «C»).
 * Такие значения (напр. «ВА47-29», «NXB-63s», «HDB3w») схлопывают пул до
 * same-brand → brand-exclude обнуляет → relaxation возвращает same-brand.
 * Marking-guard над pagetitle при этом продолжает работать.
 */
function isStructuralModelMarking(value: string, pagetitle: string | null | undefined): boolean {
  if (!pagetitle) return false;
  const v = value.trim();
  if (v.length <= 4) return false;
  const hasLetter = /[A-Za-zА-Яа-я]/.test(v);
  const hasDigit = /\d/.test(v);
  if (!hasLetter || !hasDigit) return false;
  const normTitle = pagetitle.toLowerCase().replace(/\s+/g, ' ');
  const normVal = v.toLowerCase().replace(/\s+/g, ' ');
  return normTitle.includes(normVal);
}

/** Макс длина value, после которой считаем поле текстовым описанием, не атрибутом. */
const MAX_VALUE_LEN = 80;

function isServiceKey(key: string): boolean {
  const k = key.toLowerCase();
  return SERVICE_KEY_PREFIXES.some((p) => k.startsWith(p));
}

function isUsableValue(v: string | undefined | null): v is string {
  if (!v || typeof v !== 'string') return false;
  const trimmed = v.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > MAX_VALUE_LEN) return false;
  // URL-подобные значения
  if (/^(https?:|\/uploads\/|\/files\/)/i.test(trimmed)) return false;
  // Списки файлов через запятую с расширениями
  if (/\.(pdf|jpg|jpeg|png|webp|docx?|xlsx?)\b/i.test(trimmed)) return false;
  return true;
}

export interface ExtractTraitsResult {
  /** facet_key → value_ru, готовый для передачи в searchProductsByCandidate(..., options=...) */
  must: Record<string, string>;
  /** ключи оригинала, отсечённые на разных стадиях (для логирования) */
  droppedServiceKeys: string[];
  droppedNotInSchema: string[];
  droppedOverflow: string[];
}

/**
 * Нормализатор для матчинга user-token ↔ option value_ru.
 * - lower-case, trim, collapse whitespace.
 * - Никакой семантики/синонимов: data-agnostic.
 */
function normForMatch(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Проверяет, «соответствует» ли user-token значению фасета.
 * Совпадение по любому из:
 *   1) exact CI (после normForMatch);
 *   2) CI substring в любую сторону (token «16А» содержит value «16»);
 *   3) digit-prefix: числовая часть в начале совпадает с числовой частью value
 *      (token «16А» → 16; value «16» → 16; token «2,5мм²» → 2.5; value «2.5» → 2.5).
 * Возвращает true при первом совпадении.
 */
function tokenMatchesValue(token: string, value: string): boolean {
  const t = normForMatch(token);
  const v = normForMatch(value);
  if (!t || !v) return false;
  if (t === v) return true;
  if (t.includes(v) || v.includes(t)) return true;
  const numRe = /^(\d+(?:[.,]\d+)?)/;
  const tn = t.match(numRe)?.[1]?.replace(',', '.');
  const vn = v.match(numRe)?.[1]?.replace(',', '.');
  if (tn && vn && tn === vn) return true;
  return false;
}

/**
 * Слой 1. Из original.options[] формируем MUST-фильтры, оставляя только те
 * ключи, которые присутствуют в union-schema целевых replacement-категорий.
 *
 * Зачем пересечение со схемой: если ключ есть у оригинала, но отсутствует в
 * целевых категориях — его нельзя применить как `options[key][]=...` (API
 * вернёт пусто). Например, у оригинала может быть редкая опция, которой нет
 * у альтернативных линеек. Лучше отбросить, чем обнулить выдачу.
 *
 * `userTokens` (опционально) — токены из исходного запроса
 * (critical_modifiers ∪ search_modifiers). Если переданы, опции, чьи значения
 * матчатся хотя бы с одним токеном, получают приоритет при отборе в must
 * (важно при cap=MAX_MUST_TRAITS, чтобы критичные для пользователя оси —
 * например «16А» для автомата — не теснились шумовыми ключами вроде
 * «частота 50Гц» / «единица измерения шт»). Семантики нет: совпадение чисто
 * строковое + digit-prefix. Backward-compat: без userTokens поведение 1:1
 * со старой версией (исходный порядок original.options, cap=MAX_MUST_TRAITS).
 */
export function extractOriginalTraits(
  original: OriginalLike | null | undefined,
  unionSchema: UnionSchema,
  userTokens?: string[] | null,
): ExtractTraitsResult {
  const result: ExtractTraitsResult = {
    must: {},
    droppedServiceKeys: [],
    droppedNotInSchema: [],
    droppedOverflow: [],
  };
  if (!original?.options || original.options.length === 0) return result;

  // ── Pass 1: фильтрация без cap, сохраняем исходный порядок ──
  type Eligible = { opt: OriginalOption; value: string };
  const eligible: Eligible[] = [];
  for (const opt of original.options) {
    if (!opt?.key) continue;
    if (isServiceKey(opt.key)) {
      result.droppedServiceKeys.push(opt.key);
      continue;
    }
    if (!isUsableValue(opt.value_ru)) continue;
    if (!unionSchema.has(opt.key)) {
      result.droppedNotInSchema.push(opt.key);
      continue;
    }
    const schemaEntry = unionSchema.get(opt.key)!;
    const valueTrimmed = opt.value_ru!.trim();
    if (schemaEntry.values.size > 0 && !schemaEntry.values.has(valueTrimmed)) {
      result.droppedNotInSchema.push(`${opt.key}:value_missing`);
      continue;
    }
    eligible.push({ opt, value: valueTrimmed });
  }

  // ── Pass 2: stable-приоритизация по userTokens (если переданы) ──
  const tokens = Array.isArray(userTokens)
    ? userTokens.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : [];
  let ordered: Eligible[] = eligible;
  if (tokens.length > 0) {
    const indexed = eligible.map((e, i) => ({
      e,
      i,
      matched: tokens.some((tok) => tokenMatchesValue(tok, e.value)),
    }));
    indexed.sort((a, b) => {
      if (a.matched !== b.matched) return a.matched ? -1 : 1;
      return a.i - b.i;
    });
    ordered = indexed.map((x) => x.e);
  }

  // ── Pass 3: cap, лишнее → droppedOverflow ──
  for (const { opt, value } of ordered) {
    if (Object.keys(result.must).length >= MAX_MUST_TRAITS) {
      result.droppedOverflow.push(opt.key);
      continue;
    }
    result.must[opt.key] = value;
  }

  return result;
}

/**
 * Слой 2. Маркировочные токены из pagetitle.
 *
 * Regex покрывает кириллические/латинские артикулы вида ЩРН-П-12, ВВГнг,
 * ВА47-29, IP65 и т.п. Требования:
 *   - буквенная часть ≥ 2 символов (отсеивает одиночные цифры/буквы);
 *   - может быть составной через `-` или слитной (ВВГнг);
 *   - финальная часть может содержать цифры/знаки `х * . - /`.
 *
 * Возвращаем уникальный список в верхнем регистре.
 */
export function extractMarkingTokens(pagetitle: string | null | undefined): string[] {
  if (!pagetitle || typeof pagetitle !== 'string') return [];
  const tokens = new Set<string>();
  const parts = pagetitle.split(/[\s()«»"',;:!?]+/u).filter(Boolean);
  for (const raw of parts) {
    const cleaned = raw.replace(/^[.\-/]+|[.\-/]+$/g, '');
    if (cleaned.length < 2) continue;
    const hasDigit = /\d/.test(cleaned);
    const hasInnerSep = /[A-Za-zА-Яа-яЁё][-/][A-Za-zА-Яа-яЁё0-9]/.test(cleaned);
    if (!hasDigit && !hasInnerSep) continue;
    // Отсекаем чисто-торговые единицы (количество/габариты/масса/объём): 12шт, 10м, 5кг, 1.5л.
    // Физические единицы (А, Вт, В, кВт, Гц, Ом) С ЦИФРОЙ — КЕЕП: это trait товара,
    // критичный для подбора аналога (16А автомат ≠ 25А автомат). Универсальный SI-список,
    // не зависит от ассортимента 220volt.
    if (/^\d+(?:[.,]\d+)?(?:шт|пар|компл|упак|уп|м|см|мм|км|дм|мг|кг|г|т|л|мл|м[23²³])$/iu.test(cleaned)) continue;
    // Допускаем токен если: (a) есть буквенная серия ≥2 (артикул ВВГнг, ЩРН), либо
    // (b) цифра + 1-4 буквы (физединица: 16А, 50Вт, IP65, 2.5мм²).
    const hasMultiLetter = /[A-Za-zА-Яа-яЁё]{2,}/.test(cleaned);
    const isPhysical = /^\d+(?:[.,]\d+)?[A-Za-zА-Яа-яЁё²³]{1,4}$/u.test(cleaned)
      || /^IP\d{2,3}$/i.test(cleaned);
    if (!hasMultiLetter && !isPhysical) continue;
    tokens.add(cleaned.toUpperCase());
  }
  return Array.from(tokens);
}

// ─── Layer 3: brand / title leak guards ─────────────────────────────────────

/** Извлекает бренд оригинала: сначала options[] с ключом, начинающимся на `brend`,
 *  затем поле `vendor`. Возвращает trimmed UPPER-CASE или null.
 *  Data-agnostic: НЕ словарь, читает рантайм-данные. */
export function extractOriginalBrand(
  original: (OriginalLike & { vendor?: string | null }) | null | undefined,
): string | null {
  if (!original) return null;
  if (Array.isArray(original.options)) {
    for (const opt of original.options) {
      if (!opt?.key) continue;
      const k = opt.key.toLowerCase();
      if (k.startsWith('brend') || k === 'vendor' || k === 'brand') {
        const v = (opt.value_ru || '').trim();
        if (v.length > 0 && v.length < 80) return v.toUpperCase();
      }
    }
  }
  const v = (original.vendor || '').trim();
  return v.length > 0 ? v.toUpperCase() : null;
}

/** Отсекает кандидатов того же бренда что и оригинал. Замена = другой бренд при
 *  тех же характеристиках. Если бренд неизвестен → no-op. */
export function applyBrandExclude<T extends { vendor?: string | null; options?: OriginalOption[] | null; pagetitle?: string | null }>(
  candidates: T[],
  originalBrand: string | null,
): { filtered: T[]; excluded: number } {
  if (!originalBrand) return { filtered: candidates, excluded: 0 };
  const target = originalBrand.toUpperCase();
  let excluded = 0;
  const filtered = candidates.filter((c) => {
    const cBrand = extractOriginalBrand(c as any);
    if (cBrand && cBrand === target) { excluded++; return false; }
    // fallback: бренд в pagetitle если options пустые.
    if (!cBrand && c.pagetitle && c.pagetitle.toUpperCase().includes(target)) {
      excluded++;
      return false;
    }
    return true;
  });
  return { filtered, excluded };
}

/** Graceful обёртка над `applyBrandExclude`: если exclude обнулил пул (категория
 *  моно-брендовая) — откатываем к исходным кандидатам и помечаем `relaxed=true`.
 *  Систем­но: «другой бренд» — желаемое, но не обязательное; лучше показать
 *  same-brand аналоги с честным disclaimer'ом, чем уйти в Soft-404.
 *  Data-agnostic: нет whitelist'ов брендов/категорий. */
export function applyBrandExcludeWithRelaxation<T extends { vendor?: string | null; options?: OriginalOption[] | null; pagetitle?: string | null }>(
  candidates: T[],
  originalBrand: string | null,
): { filtered: T[]; excluded: number; relaxed: boolean } {
  const be = applyBrandExclude(candidates, originalBrand);
  if (be.filtered.length === 0 && be.excluded > 0 && candidates.length > 0) {
    return { filtered: candidates, excluded: 0, relaxed: true };
  }
  return { filtered: be.filtered, excluded: be.excluded, relaxed: false };
}

/** Pagetitle-leak guard: когда id оригинала неизвестен, кандидат с exact-совпадением
 *  pagetitle = сам оригинал. Сравнение case-insensitive, trim, collapse spaces. */
export function isOriginalByTitle(
  candidatePagetitle: string | null | undefined,
  markingSource: string | null | undefined,
): boolean {
  if (!candidatePagetitle || !markingSource) return false;
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  return norm(candidatePagetitle) === norm(markingSource);
}

/**
 * Применяет marking-guard к кандидатам. Если у оригинала есть marking-токены,
 * кандидат должен содержать хотя бы один из них в своём pagetitle (case-insensitive).
 *
 * Возвращает `{ filtered, mismatch }`:
 *   - `filtered` — отфильтрованный список;
 *   - `mismatch=true` если после фильтра 0, что сигналит вызывающему о
 *     необходимости отката к pre-guard выдаче + установке weakened=true.
 */
export function applyMarkingGuard<T extends { pagetitle?: string | null }>(
  candidates: T[],
  originalMarkings: string[],
): { filtered: T[]; mismatch: boolean } {
  if (originalMarkings.length === 0) return { filtered: candidates, mismatch: false };
  // ALL-of semantics: кандидат должен содержать КАЖДЫЙ структурный токен оригинала.
  // ANY-of слишком слабо: общий токен (IP41) пропускает кандидата с другим
  // SKU (ЩРВ vs ЩРН). Поэтому marking-set нужно предварительно сузить через
  // filterStructuralMarkings — оставить только токены, не покрытые фасетами.
  const filtered = candidates.filter((c) => {
    const pt = (c.pagetitle || '').toUpperCase();
    return originalMarkings.every((tok) => pt.includes(tok));
  });
  return { filtered, mismatch: filtered.length === 0 };
}

/**
 * Сужает список маркировочных токенов до структурных (SKU-подобных), отбрасывая
 * те, что уже распознаются как значения фасетов union-schema (IP41 →
 * stepeny_zaschity=41) либо как любые brand/option-значения. Такие токены и так
 * применяются как `options[]` фильтры через Layer 1 — дублировать их в guard
 * избыточно и приводит к ложным ANY-совпадениям при общих токенах.
 *
 * Data-agnostic: словарей нет, источник истины — live unionSchema из API.
 */
export function filterStructuralMarkings(
  markings: string[],
  unionSchema: UnionSchema,
): { kept: string[]; droppedFacetValues: string[] } {
  if (markings.length === 0) return { kept: [], droppedFacetValues: [] };
  const facetValuesUC = new Set<string>();
  for (const entry of unionSchema.values()) {
    for (const v of entry.values) {
      const u = v.trim().toUpperCase();
      if (u.length > 0) facetValuesUC.add(u);
    }
  }
  const kept: string[] = [];
  const droppedFacetValues: string[] = [];
  for (const tok of markings) {
    if (facetValuesUC.has(tok)) { droppedFacetValues.push(tok); continue; }
    // IP-классы: "IP41" обычно лежит в фасете как "41". Снимаем префикс и
    // сверяемся (IEC 60529, не привязано к 220volt).
    const ipMatch = tok.match(/^IP(\d{2,3})$/);
    if (ipMatch && facetValuesUC.has(ipMatch[1])) { droppedFacetValues.push(tok); continue; }
    kept.push(tok);
  }
  return { kept, droppedFacetValues };
}

