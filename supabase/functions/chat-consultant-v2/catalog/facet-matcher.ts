// chat-consultant-v2 / catalog/facet-matcher.ts
// Stage 6C — Facet Matcher.
//
// Контракт (§3.1 catalog/facets.ts, §4.5 Category-First Branch, §9.2 Сценарий B,
// §6.3 кэш facets:<pagetitle> 1ч, §4.8.1 droppedFacetCaption, mem://search-pipeline):
//
//   • ВХОД: pagetitle (из Category Resolver) + modifiers (Intent.search_modifiers).
//   • ВЫХОД: optionFilters + optionAliases (для searchProducts) + facetCaptions
//     (для droppedFacetCaption в Soft Fallback).
//   • Data-agnostic: НИ ОДНОГО hardcoded ключа/значения 220volt. Всё — из живого
//     /categories/options через инъецируемый api-client.
//   • Кэш: facets:<pagetitle>, TTL 1ч. Ключ — pagetitle (НЕ модификаторы), §6.3.
//   • Alias collapse (Q3): опции с одинаковым нормализованным caption_ru
//     группируются в canonical_key + aliases[]. canonical = первый ASCII-only ключ
//     или первый по порядку, если все не-ASCII.
//   • Матчинг: точное совпадение normalize(modifier) с normalize(value_ru/value_kz/value).
//     Никакого fuzzy/substring (это Stage 6E с LLM resolveFiltersWithLLM).
//   • Никаких хардкод-стоп-слов: пустые/невалидные модификаторы скипаем тихо.
//
// V1 НЕ ТРОГАЕТСЯ. Этот файл живёт ТОЛЬКО внутри chat-consultant-v2/catalog/.

import {
  type ApiClientDeps,
  type CategoryOptionsResult,
  type RawOption,
  type RawOptionValue,
  getCategoryOptions,
} from './api-client.ts';

// ─── Public types ───────────────────────────────────────────────────────────

export type FacetMatchStatus =
  | 'ok'                    // ≥1 модификатор замэтчился, optionFilters непуст
  | 'no_matches'            // facets есть, но ни один modifier не совпал
  | 'no_facets'             // /categories/options вернул пустой список (ok-empty)
  | 'category_unavailable'; // API: timeout/network_error/http_error

export interface FacetMatchResult {
  status: FacetMatchStatus;
  /** canonical_key → matched values (для searchProducts.optionFilters). */
  optionFilters: Record<string, string[]>;
  /** canonical_key → [alias_key1, alias_key2, ...] (для searchProducts.optionAliases, Q3). */
  optionAliases: Record<string, string[]>;
  /** canonical_key → human caption (для droppedFacetCaption §4.8.1). */
  facetCaptions: Record<string, string>;
  /** Какие модификаторы реально замэтчились (для дебага). */
  matchedModifiers: string[];
  /** Какие — нет (для Soft Fallback / диагностики). */
  unmatchedModifiers: string[];
  /** Откуда пришёл результат facets-вызова. */
  source: 'cache' | 'live' | 'unavailable';
  ms: number;
}

/**
 * Зависимости. Полностью инъецируемы — позволяет тестировать без сети и кэша.
 *
 * `cacheGetOrCompute` — обёртка cache.getOrCompute, специализированная под
 * CategoryOptionsResult: facet-matcher НЕ должен знать о sha256/normalize.
 * В тестах подсовываем in-memory мап.
 */
export interface FacetMatcherDeps {
  apiClient: ApiClientDeps;
  cacheGetOrCompute: <T>(
    namespace: string,
    rawKey: string,
    ttlSec: number,
    compute: () => Promise<T>,
  ) => Promise<{ value: T; cacheHit: boolean }>;
  /** TTL для facets:<pagetitle>, секундах. Default — 3600 (§6.3). */
  facetsTtlSec?: number;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Нормализация для сравнения модификаторов и значений фасетов.
 * Unicode-aware: lowercase + trim + collapse spaces + remove punctuation.
 * Та же семантика, что cache.normalize, но локальная копия — facet-matcher.ts
 * НЕ должен зависеть от cache.ts (data-agnostic, тестируемо).
 */
function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) return false;
  }
  return true;
}

/**
 * Получить human caption для опции. Приоритет: caption_ru → caption → key.
 * key — fallback последней инстанции (НЕ должен попадать в droppedFacetCaption,
 * но защищаемся от пустых caption).
 */
function pickCaption(opt: RawOption): string {
  const c = opt.caption_ru ?? opt.caption ?? null;
  if (c && c.trim().length > 0) return c.trim();
  return opt.key;
}

/**
 * Извлечь все строковые представления значения опции (RU + KZ + value).
 * Возвращает массив непустых строк.
 */
function valueStrings(v: RawOptionValue): string[] {
  const arr: string[] = [];
  for (const candidate of [v.value_ru, v.value_kz, v.value]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      arr.push(candidate.trim());
    }
  }
  return arr;
}

/**
 * Группа коллапса: набор RawOption с одинаковым нормализованным caption.
 */
interface CollapsedGroup {
  canonicalKey: string;        // ASCII-only key, либо первый по порядку
  aliasKeys: string[];         // ВСЕ ключи группы (включая canonical)
  caption: string;             // human caption для droppedFacetCaption
  /** value_ru/kz/value (нормализованное) → исходный value для API. */
  valueIndex: Map<string, string>;
}

/**
 * Alias collapse (§3.1 facets.ts, Q3):
 * 1. Группируем опции по нормализованному caption_ru.
 * 2. В каждой группе canonical = первый ASCII-only ключ; если все не-ASCII —
 *    первый по порядку.
 * 3. Все ключи группы → aliasKeys[].
 * 4. valueIndex объединяет все значения всех опций группы (на случай, если
 *    дубль-опции имеют чуть разные value_ru — мы их все принимаем как валидные).
 */
function collapseOptions(options: RawOption[]): CollapsedGroup[] {
  const byCaption = new Map<string, RawOption[]>();

  for (const opt of options) {
    if (!opt || typeof opt.key !== 'string' || opt.key.length === 0) continue;
    const captionNorm = normalizeForMatch(pickCaption(opt));
    if (captionNorm.length === 0) continue;
    const arr = byCaption.get(captionNorm) ?? [];
    arr.push(opt);
    byCaption.set(captionNorm, arr);
  }

  const groups: CollapsedGroup[] = [];
  for (const opts of byCaption.values()) {
    // canonical: первый ASCII-only key, иначе первый по порядку.
    let canonical = opts.find((o) => isAscii(o.key))?.key ?? opts[0].key;
    const aliasKeys: string[] = [];
    for (const o of opts) {
      if (!aliasKeys.includes(o.key)) aliasKeys.push(o.key);
    }
    // canonical всегда первым в aliasKeys (для предсказуемого порядка запросов).
    if (aliasKeys[0] !== canonical) {
      const idx = aliasKeys.indexOf(canonical);
      if (idx > 0) {
        aliasKeys.splice(idx, 1);
        aliasKeys.unshift(canonical);
      }
    }

    const valueIndex = new Map<string, string>();
    for (const o of opts) {
      const values = Array.isArray(o.values) ? o.values : [];
      for (const v of values) {
        for (const s of valueStrings(v)) {
          const norm = normalizeForMatch(s);
          if (norm.length === 0) continue;
          // Первое попавшееся значение для нормализованного ключа — выигрывает
          // (детерминизм; обычно это value_ru первой опции).
          if (!valueIndex.has(norm)) valueIndex.set(norm, s);
        }
      }
    }

    groups.push({
      canonicalKey: canonical,
      aliasKeys,
      caption: pickCaption(opts[0]),
      valueIndex,
    });
  }

  return groups;
}

// ─── Main entry ─────────────────────────────────────────────────────────────

export async function matchFacets(
  pagetitle: string,
  modifiers: string[],
  deps: FacetMatcherDeps,
): Promise<FacetMatchResult> {
  const t0 = Date.now();
  const ttl = deps.facetsTtlSec ?? 3600;

  console.info(`[v2.catalog.facet_matcher.input] ${JSON.stringify({
    pagetitle,
    modifiers,
    modifiers_count: modifiers.length,
  })}`);

  // ── 1. Загрузка facets через кэш. ──────────────────────────────────────
  let facetsResult: CategoryOptionsResult;
  let source: 'cache' | 'live' | 'unavailable' = 'live';
  try {
    const cached = await deps.cacheGetOrCompute<CategoryOptionsResult>(
      'facets',
      pagetitle,
      ttl,
      () => getCategoryOptions(pagetitle, deps.apiClient),
    );
    facetsResult = cached.value;
    source = cached.cacheHit ? 'cache' : 'live';
  } catch (_e) {
    // Кэш-ошибки не должны валить пайплайн — defensive.
    source = 'unavailable';
    facetsResult = await getCategoryOptions(pagetitle, deps.apiClient);
  }

  // ── 2. Обработка статуса API. ───────────────────────────────────────────
  if (
    facetsResult.status === 'http_error' ||
    facetsResult.status === 'timeout' ||
    facetsResult.status === 'network_error' ||
    facetsResult.status === 'upstream_unavailable'
  ) {
    return {
      status: 'category_unavailable',
      optionFilters: {},
      optionAliases: {},
      facetCaptions: {},
      matchedModifiers: [],
      unmatchedModifiers: modifiers.filter((m) => typeof m === 'string' && m.trim().length > 0),
      source: 'unavailable',
      ms: Date.now() - t0,
    };
  }

  if (facetsResult.status === 'empty' || facetsResult.options.length === 0) {
    return {
      status: 'no_facets',
      optionFilters: {},
      optionAliases: {},
      facetCaptions: {},
      matchedModifiers: [],
      unmatchedModifiers: modifiers.filter((m) => typeof m === 'string' && m.trim().length > 0),
      source,
      ms: Date.now() - t0,
    };
  }

  // ── 3. Alias collapse. ─────────────────────────────────────────────────
  const groups = collapseOptions(facetsResult.options);

  // ── 4. Матчинг модификаторов. ───────────────────────────────────────────
  const optionFilters: Record<string, string[]> = {};
  const optionAliases: Record<string, string[]> = {};
  const facetCaptions: Record<string, string> = {};
  const matched: string[] = [];
  const unmatched: string[] = [];

  for (const rawMod of modifiers) {
    if (typeof rawMod !== 'string') continue;
    const modNorm = normalizeForMatch(rawMod);
    if (modNorm.length === 0) continue;

    let hit = false;
    for (const g of groups) {
      const original = g.valueIndex.get(modNorm);
      if (original === undefined) continue;
      hit = true;

      if (!optionFilters[g.canonicalKey]) {
        optionFilters[g.canonicalKey] = [];
        optionAliases[g.canonicalKey] = g.aliasKeys.slice();
        facetCaptions[g.canonicalKey] = g.caption;
      }
      if (!optionFilters[g.canonicalKey].includes(original)) {
        optionFilters[g.canonicalKey].push(original);
      }
      // Один модификатор может матчиться в разных опциях (редко) — допускаем
      // мультифасетное применение, это безопасно для searchProducts.
    }

    if (hit) matched.push(rawMod);
    else unmatched.push(rawMod);
  }

  const hasAny = Object.keys(optionFilters).length > 0;
  const result: FacetMatchResult = {
    status: hasAny ? 'ok' : 'no_matches',
    optionFilters,
    optionAliases,
    facetCaptions,
    matchedModifiers: matched,
    unmatchedModifiers: unmatched,
    source,
    ms: Date.now() - t0,
  };

  console.info(`[v2.catalog.facet_matcher.result] ${JSON.stringify({
    pagetitle,
    status: result.status,
    source: result.source,
    optionFilters: result.optionFilters,
    matchedModifiers: result.matchedModifiers,
    unmatchedModifiers: result.unmatchedModifiers,
    available_facets: groups.map((g) => ({
      canonicalKey: g.canonicalKey,
      caption: g.caption,
      values_count: g.valueIndex.size,
      sample_values: Array.from(g.valueIndex.values()).slice(0, 8),
    })),
    ms: result.ms,
  })}`);

  return result;
}

// ─── Production factory ─────────────────────────────────────────────────────

/**
 * Production-ready FacetMatcherDeps. Инъектирует cache.getOrCompute и TTL.facets
 * без хардкода — facet-matcher.ts остаётся data-agnostic.
 */
export function createProductionFacetMatcherDeps(args: {
  apiClient: ApiClientDeps;
  cacheGetOrCompute: FacetMatcherDeps['cacheGetOrCompute'];
  facetsTtlSec?: number;
}): FacetMatcherDeps {
  return {
    apiClient: args.apiClient,
    cacheGetOrCompute: args.cacheGetOrCompute,
    facetsTtlSec: args.facetsTtlSec ?? 3600,
  };
}
