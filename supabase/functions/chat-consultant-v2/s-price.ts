// chat-consultant-v2 / s-price.ts
// Stage 6E — Price Branch (probe-then-fetch, §4.4 + §9.3 спецификации).
//
// АРХИТЕКТУРНАЯ РОЛЬ (по аудит-вердикту 6E):
//   s3-router → priceBranch (для intent.price_intent !== null)
//                 │
//                 ├─ probe (легковесный) → total + facets
//                 ├─ total ≤ 7  → fetch all,    sort,    return 'ok'
//                 ├─ 7 < t ≤ 50 → fetch top 10, sort,    return 'ok' (totalCount=t)
//                 ├─ total > 50 → CREATE price_clarify slot, return 'clarify'
//                 ├─ total = 0  → return 'empty'
//                 └─ all_zero_price/error/out_of_domain → scenario-path
//
// КОНТРАКТЫ (Core Memory + Spec):
//   • §4.4 пороги 7/50 — фиксированные, никаких самовольных N=12.
//   • §9.3 сценарий: probe.total=705 → price_clarify slot из top-5 facet values.
//   • §5.6.1 soft404_streak: 'clarify' НЕ меняет streak (новое состояние, не empty).
//   • Core: «Bot NEVER self-narrows funnel» — для price_intent='range' те же
//     пороги, без принудительного clarify.
//   • Core: «HARD BAN price=0» — двойной фильтр (api-client + здесь).
//   • Q1: ?sort= игнорируется API → локальная сортировка после fetch.
//   • Источник facets для clarify slot — РАНЕЕ полученный matchFacets() (live из
//     /categories/options через кеш). НЕ делаем отдельный запрос. Если facets
//     не пришли (status≠'ok') — fallback на пустой slot.options[] (composer
//     рендерит fallback-формулировку).
//
// ЧТО НЕТ (другие этапы):
//   ✗ Postgres-кэш probe (Stage 6H — §3.2)
//   ✗ Композер-рендер clarify-режима (Stage 6F редактирует s-catalog-composer)
//   ✗ Подключение к runPipeline (Stage 7)
//
// V1 НЕ ТРОНУТ.

import {
  searchProducts,
  type ApiClientDeps,
  type RawProduct,
  type SearchProductsInput,
  type SearchProductsResult,
  type RawOption,
} from "./catalog/api-client.ts";
import type { Intent, Slot, SlotOption } from "./types.ts";

// ─── Константы (§4.4) ───────────────────────────────────────────────────────

/** Порог «показать всё» — fetch all, sort, return ≤7 карточек. */
export const PRICE_THRESHOLD_SHOW_ALL = 7;
/** Порог clarify — > N → создаём price_clarify slot. */
export const PRICE_THRESHOLD_CLARIFY = 50;
/** Сколько top-карточек показываем при 7 < total ≤ 50. */
export const PRICE_TOP_COUNT_PARTIAL = 3;
/** Лимит fetch top для 7 < total ≤ 50 (берём с запасом из-за price=0 ban). */
export const PRICE_FETCH_TOP_LIMIT = 10;
/** Сколько option-значений показываем в price_clarify slot (§4.4 «топ-5»). */
export const PRICE_CLARIFY_OPTIONS_LIMIT = 5;

// ─── Public types ───────────────────────────────────────────────────────────

export type SPriceStatus =
  | "ok"               // products готовы (отсортированы, price>0), показать
  | "clarify"          // создан price_clarify slot, products = []
  | "empty"            // probe.total === 0
  | "all_zero_price"   // probe нашёл, но все price=0 → contactManager (scenario-path)
  | "error"            // HTTP/timeout/network — escalation, streak не меняем
  | "out_of_domain";   // shortcut: intent.domain_check === 'out_of_domain'

export interface SPriceInput {
  /** pagetitle от Category Resolver. Может быть null (без категории — общий поиск по query). */
  pagetitle: string | null;
  /** Очищенный текст (cleaned_message); используется как query, если есть. */
  query: string;
  /** Intent — обязательно с price_intent !== null (иначе вызов бессмысленен). */
  intent: Intent;
  /**
   * Уже разрешённые фасеты (от Facet Matcher, может быть пустой объект).
   * НЕ выбираются здесь — приходят на вход (K1 invariant).
   */
  optionFilters?: Record<string, string[]>;
  optionAliases?: Record<string, string[]>;
  /**
   * RawOption[] из /categories/options для построения price_clarify slot.
   * Источник: тот же matchFacets()/getCategoryOptions(), что вызывался ранее
   * в pipeline. Если undefined/[] — slot создаётся с пустыми options
   * (composer обработает как fallback).
   */
  facetOptions?: RawOption[];
}

export interface SPriceOutcome {
  status: SPriceStatus;
  /** Отсортированные карточки (price>0). [] при non-ok. */
  products: RawProduct[];
  /** Полное число товаров из probe. Для composer footer «всего N». */
  totalCount: number;
  /** Создан ТОЛЬКО при status='clarify'. */
  clarifySlot: Slot | null;
  /** Метрика zero_price_leak (должна быть 0 на проде). */
  zeroPriceLeak: number;
  /**
   * Метрика «бот сам сужал воронку». ВСЕГДА 0 для s-price (мы не самосужаем,
   * а спрашиваем). Поле оставлено для контракта/мониторинга.
   */
  autoNarrowingAttempts: number;
  /** Какая ветка сработала (для логов): 'show_all' | 'show_top' | 'clarify' | null. */
  branch: "show_all" | "show_top" | "clarify" | null;
  errorMessage?: string;
  ms: number;
}

export interface SPriceDeps {
  apiClient: ApiClientDeps;
  /** Опциональный логгер. */
  log?: (event: string, data?: Record<string, unknown>) => void;
  /** Источник времени (тесты). */
  now?: () => number;
  /** Источник uuid для slot.id (тесты). */
  newSlotId?: () => string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function defaultSlotId(): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `slot_${ts}_${rnd}`;
}

/**
 * Локальная сортировка по цене (Q1: API ?sort= игнорируется).
 * Стабильная: при равных ценах сохраняется исходный порядок.
 * Не мутирует входной массив.
 */
export function sortByPrice(
  products: RawProduct[],
  direction: "asc" | "desc",
): RawProduct[] {
  const sign = direction === "asc" ? 1 : -1;
  // map → [index, product] для стабильности.
  return products
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const diff = (a.p.price - b.p.price) * sign;
      if (diff !== 0) return diff;
      return a.i - b.i;
    })
    .map((x) => x.p);
}

/**
 * Двойной фильтр price=0 (Core: HARD BAN). api-client уже фильтрует, но
 * мы повторяем здесь для двойной защиты от leak'а (на случай edge-case
 * парсинга или будущих регрессий).
 *
 * Возвращает [filtered, leakCount].
 */
export function filterPriceZero(products: RawProduct[]): [RawProduct[], number] {
  const filtered = products.filter(
    (p) => typeof p?.price === "number" && p.price > 0,
  );
  return [filtered, products.length - filtered.length];
}

/**
 * Преобразование price_intent в направление сортировки.
 * 'range' с заданным диапазоном — ASC (показать дешёвые сначала).
 */
function sortDirection(intent: Intent): "asc" | "desc" {
  if (intent.price_intent === "expensive") return "desc";
  // 'cheapest' и 'range' — ASC.
  return "asc";
}

/**
 * Перевод Intent.price_range в minPrice/maxPrice для API.
 * Если range не задан — undefined (никакого хардкода диапазонов).
 */
function priceBoundsFromIntent(
  intent: Intent,
): { minPrice?: number; maxPrice?: number } {
  if (intent.price_intent !== "range" || !intent.price_range) return {};
  const out: { minPrice?: number; maxPrice?: number } = {};
  if (typeof intent.price_range.min === "number") out.minPrice = intent.price_range.min;
  if (typeof intent.price_range.max === "number") out.maxPrice = intent.price_range.max;
  return out;
}

/**
 * Построение SearchProductsInput из SPriceInput.
 * Все фасеты/aliases пробрасываем как есть (Q3 recovery работает в api-client).
 */
function toApiInput(
  input: SPriceInput,
  perPage: number,
): SearchProductsInput {
  const { minPrice, maxPrice } = priceBoundsFromIntent(input.intent);
  const apiInput: SearchProductsInput = {
    perPage,
    page: 1,
  };
  if (input.pagetitle) apiInput.pagetitle = input.pagetitle;
  if (input.query) apiInput.query = input.query;
  if (typeof minPrice === "number") apiInput.minPrice = minPrice;
  if (typeof maxPrice === "number") apiInput.maxPrice = maxPrice;
  if (input.optionFilters && Object.keys(input.optionFilters).length > 0) {
    apiInput.optionFilters = input.optionFilters;
  }
  if (input.optionAliases && Object.keys(input.optionAliases).length > 0) {
    apiInput.optionAliases = input.optionAliases;
  }
  return apiInput;
}

/**
 * Выбор «самого разделяющего» facet для price_clarify slot.
 *
 * Правило (по плану 6E v2):
 *   • Берём группу с максимальным числом значений, у которых count > 0
 *     И count < totalProducts (т.е. фасет реально делит выдачу).
 *   • Внутри группы — top-N значений по count DESC.
 *   • Если ни одна группа не годится — возвращаем null (composer покажет
 *     fallback-формулировку «уточните запрос»).
 *
 * Data-agnostic: никаких приоритетов «category > vendor > ...». Решает только
 * сама структура facets из живого API.
 */
export function pickBestFacetForClarify(
  options: RawOption[],
  totalProducts: number,
  topN: number = PRICE_CLARIFY_OPTIONS_LIMIT,
): { option: RawOption; values: Array<{ raw: string; caption: string; count: number }> } | null {
  if (!Array.isArray(options) || options.length === 0) return null;

  type Scored = {
    opt: RawOption;
    splittingValues: Array<{ raw: string; caption: string; count: number }>;
  };
  const scored: Scored[] = [];

  for (const opt of options) {
    if (!opt || typeof opt.key !== "string" || opt.key.length === 0) continue;
    const values = Array.isArray(opt.values) ? opt.values : [];
    const splitting: Array<{ raw: string; caption: string; count: number }> = [];
    for (const v of values) {
      const count = typeof v?.count === "number" ? v.count : 0;
      if (count <= 0) continue;
      if (totalProducts > 0 && count >= totalProducts) continue; // не разделяет
      const raw = (v.value_ru ?? v.value_kz ?? v.value ?? "").toString().trim();
      if (raw.length === 0) continue;
      const caption = raw; // value_ru = human caption; для UI этого достаточно
      splitting.push({ raw, caption, count });
    }
    if (splitting.length >= 2) {
      // Сортируем по count DESC, берём top-N.
      splitting.sort((a, b) => b.count - a.count);
      scored.push({ opt, splittingValues: splitting.slice(0, topN) });
    }
  }

  if (scored.length === 0) return null;

  // Выбираем группу с наибольшим числом разделяющих значений (max coverage).
  scored.sort((a, b) => b.splittingValues.length - a.splittingValues.length);
  const winner = scored[0];
  return { option: winner.opt, values: winner.splittingValues };
}

/**
 * Построение price_clarify Slot из выбранного facet.
 * Контракт SlotOption.value: lowercase facet caption (для substring/lemma матчинга
 * в s1-slot-resolver). payload содержит API-ключи для следующего хода.
 */
function buildClarifySlot(
  input: SPriceInput,
  totalCount: number,
  facetPick: ReturnType<typeof pickBestFacetForClarify>,
  deps: SPriceDeps,
): Slot {
  const now = (deps.now ?? Date.now)();
  const id = (deps.newSlotId ?? defaultSlotId)();

  const options: SlotOption[] = [];
  let facetKey = "";
  let facetCaption = "";
  if (facetPick) {
    facetKey = facetPick.option.key;
    facetCaption = (
      facetPick.option.caption_ru ||
      facetPick.option.caption ||
      facetKey
    ).toString().trim();
    for (const v of facetPick.values) {
      options.push({
        label: v.caption,
        value: v.caption.toLowerCase().trim(),
        payload: {
          facetKey,
          facetValue: v.raw,
        },
      });
    }
  }

  return {
    id,
    type: "price_clarify",
    created_at: now,
    expires_at: now + 5 * 60 * 1000, // §3.3: hard TTL 5 мин
    ttl_turns: 2,
    turns_since_created: 0,
    options,
    pending_query: input.query,
    pending_modifiers: input.intent.search_modifiers ?? [],
    pending_filters: input.optionFilters && Object.keys(input.optionFilters).length > 0
      ? { ...input.optionFilters }
      : null,
    metadata: facetKey
      ? { facetKey, facetCaption, totalCount }
      : { totalCount },
    consumed: false,
  };
}

// ─── Main entry ─────────────────────────────────────────────────────────────

export async function priceBranch(
  input: SPriceInput,
  deps: SPriceDeps,
): Promise<SPriceOutcome> {
  const t0 = Date.now();
  const log = deps.log ?? (() => {});

  // ── 0. Defensive: out_of_domain shortcut (§4.7). Без API. ─────────────
  if (input.intent.domain_check === "out_of_domain") {
    log("s_price.out_of_domain_shortcut", {});
    return {
      status: "out_of_domain",
      products: [],
      totalCount: 0,
      clarifySlot: null,
      zeroPriceLeak: 0,
      autoNarrowingAttempts: 0,
      branch: null,
      ms: Date.now() - t0,
    };
  }

  // ── 1. Probe (perPage=1, минимальный трафик). ─────────────────────────
  // Используем существующий searchProducts — он уже умеет recovery (Q3) и
  // фильтрует price=0. Нам нужно только totalFromApi + status.
  const probeApiInput = toApiInput(input, 1);
  const probe = await searchProducts(probeApiInput, deps.apiClient);
  const probeZeroLeak = probe.zeroPriceFiltered;

  log("s_price.probe", {
    status: probe.status,
    total: probe.totalFromApi,
    products_returned: probe.products.length,
  });

  // ── 2. Терминальные scenario-path статусы. ─────────────────────────────
  if (
    probe.status === "http_error" ||
    probe.status === "timeout" ||
    probe.status === "network_error"
  ) {
    return {
      status: "error",
      products: [],
      totalCount: 0,
      clarifySlot: null,
      zeroPriceLeak: probeZeroLeak,
      autoNarrowingAttempts: 0,
      branch: null,
      errorMessage: probe.errorMessage,
      ms: Date.now() - t0,
    };
  }

  if (probe.status === "all_zero_price") {
    return {
      status: "all_zero_price",
      products: [],
      totalCount: probe.totalFromApi,
      clarifySlot: null,
      zeroPriceLeak: probeZeroLeak,
      autoNarrowingAttempts: 0,
      branch: null,
      ms: Date.now() - t0,
    };
  }

  // empty / empty_degraded — оба означают «нет товаров». degraded мы не
  // обрабатываем по-особому в price-ветке: тут нет soft fallback (фасеты
  // никто не снимал — мы их не выбирали). Просто 'empty'.
  if (probe.status === "empty" || probe.status === "empty_degraded") {
    return {
      status: "empty",
      products: [],
      totalCount: 0,
      clarifySlot: null,
      zeroPriceLeak: probeZeroLeak,
      autoNarrowingAttempts: 0,
      branch: null,
      ms: Date.now() - t0,
    };
  }

  // probe.status === 'ok' — есть валидные товары.
  const total = probe.totalFromApi;

  // ── 3. Решение по порогам §4.4. ───────────────────────────────────────
  const direction = sortDirection(input.intent);

  // Ветка C: total > 50 → CREATE price_clarify slot.
  if (total > PRICE_THRESHOLD_CLARIFY) {
    const facetPick = pickBestFacetForClarify(input.facetOptions ?? [], total);
    const slot = buildClarifySlot(input, total, facetPick, deps);
    log("s_price.clarify", {
      total,
      facet_picked: facetPick?.option.key ?? null,
      options_count: slot.options.length,
    });
    return {
      status: "clarify",
      products: [],
      totalCount: total,
      clarifySlot: slot,
      zeroPriceLeak: probeZeroLeak,
      autoNarrowingAttempts: 0,
      branch: "clarify",
      ms: Date.now() - t0,
    };
  }

  // Ветка A: total ≤ 7 → fetch all (один page достаточно), sort, return.
  if (total <= PRICE_THRESHOLD_SHOW_ALL) {
    // Если probe уже вернул достаточно товаров (perPage=1, но total ≤ 1 …
    // может и нет — обычно нужен повторный fetch с per_page=total).
    // Берём с запасом до 10, чтобы покрыть price=0 leak.
    const fetchLimit = Math.max(total, PRICE_FETCH_TOP_LIMIT);
    const fullApiInput = toApiInput(input, fetchLimit);
    const full = await searchProducts(fullApiInput, deps.apiClient);
    let totalLeak = probeZeroLeak + full.zeroPriceFiltered;

    if (
      full.status === "http_error" ||
      full.status === "timeout" ||
      full.status === "network_error"
    ) {
      return {
        status: "error",
        products: [],
        totalCount: total,
        clarifySlot: null,
        zeroPriceLeak: totalLeak,
        autoNarrowingAttempts: 0,
        branch: null,
        errorMessage: full.errorMessage,
        ms: Date.now() - t0,
      };
    }
    if (full.status === "all_zero_price") {
      return {
        status: "all_zero_price",
        products: [],
        totalCount: total,
        clarifySlot: null,
        zeroPriceLeak: totalLeak,
        autoNarrowingAttempts: 0,
        branch: null,
        ms: Date.now() - t0,
      };
    }

    const [filtered, leak2] = filterPriceZero(full.products);
    totalLeak += leak2;
    const sorted = sortByPrice(filtered, direction);
    log("s_price.show_all", {
      total,
      shown: sorted.length,
    });
    return {
      status: sorted.length > 0 ? "ok" : "empty",
      products: sorted,
      totalCount: total,
      clarifySlot: null,
      zeroPriceLeak: totalLeak,
      autoNarrowingAttempts: 0,
      branch: sorted.length > 0 ? "show_all" : null,
      ms: Date.now() - t0,
    };
  }

  // Ветка B: 7 < total ≤ 50 → fetch top 10, sort, return top 3 (totalCount=total).
  const topApiInput = toApiInput(input, PRICE_FETCH_TOP_LIMIT);
  const top = await searchProducts(topApiInput, deps.apiClient);
  let totalLeak = probeZeroLeak + top.zeroPriceFiltered;

  if (
    top.status === "http_error" ||
    top.status === "timeout" ||
    top.status === "network_error"
  ) {
    return {
      status: "error",
      products: [],
      totalCount: total,
      clarifySlot: null,
      zeroPriceLeak: totalLeak,
      autoNarrowingAttempts: 0,
      branch: null,
      errorMessage: top.errorMessage,
      ms: Date.now() - t0,
    };
  }
  if (top.status === "all_zero_price") {
    return {
      status: "all_zero_price",
      products: [],
      totalCount: total,
      clarifySlot: null,
      zeroPriceLeak: totalLeak,
      autoNarrowingAttempts: 0,
      branch: null,
      ms: Date.now() - t0,
    };
  }

  const [topFiltered, leak3] = filterPriceZero(top.products);
  totalLeak += leak3;
  const topSorted = sortByPrice(topFiltered, direction).slice(0, PRICE_TOP_COUNT_PARTIAL);
  log("s_price.show_top", {
    total,
    fetched: top.products.length,
    shown: topSorted.length,
  });
  return {
    status: topSorted.length > 0 ? "ok" : "empty",
    products: topSorted,
    totalCount: total,
    clarifySlot: null,
    zeroPriceLeak: totalLeak,
    autoNarrowingAttempts: 0,
    branch: topSorted.length > 0 ? "show_top" : null,
    ms: Date.now() - t0,
  };
}

// ─── Не экспортируем — внутренняя проверка типов на этапе компиляции ──────
// (если SearchProductsResult API изменится — здесь словим ошибку).
// deno-lint-ignore no-unused-vars
const _typeGuard: SearchProductsResult["status"] | undefined = undefined;
