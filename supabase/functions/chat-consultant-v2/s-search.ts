// chat-consultant-v2 / s-search.ts
// Stage 6D — Strict Search Multi-Attempt (over Query Expansion forms).
//
// Архитектурная роль (mem://search-pipeline):
//   Category Resolver → Query Expansion → Facet Matcher → ★ s-search ★ → Composer
//
// `s-search` = тонкая обёртка над `catalog/search.ts`. Catalog/search уже умеет:
//   • Word-boundary post-filter (K2)
//   • Soft Fallback с прогрессивным снятием фасетов (§4.8 + §4.8.1)
//   • HARD BAN price=0 (через api-client + double-filter)
//   • Recovery-then-degrade (Q3)
//   • Возврат softFallbackContext с droppedFacetCaption
//
// Что добавляет s-search:
//   • Перебор форм запроса от Query Expansion: as_is_ru → lexicon_canonical
//     → en_translation → kk_off. Останов на первой успешной (status='ok' или
//     'soft_fallback').
//   • Защитный shortcut для intent.domain_check === 'out_of_domain' (§4.7) —
//     возвращаем 'out_of_domain' без единого вызова API.
//   • Финальная агрегация: какая form победила, кумулятивные attempts,
//     суммарный zero_price_leak (метрика).
//
// Чего здесь НЕТ (других этапов):
//   ✗ price-sort / Scan-or-Clarify (§9.7) — Stage 6E
//   ✗ probe для price_clarify slot     — Stage 6E
//   ✗ multi-bucket / LLM resolveFiltersWithLLM (§4.5) — Stage 6E
//   ✗ Composer-вывод — Stage 6F
//
// Жёсткие правила (Core Memory):
//   • БОТ НЕ САМОСУЖАЕТ воронку. s-search НЕ выбирает фасеты сам — берёт от
//     Facet Matcher. Defect `auto_narrowing_attempts_total` = 0.
//   • V1 НЕ тронут.
//   • Data-agnostic: все значения — из живых API/state, ни одного хардкода.

import {
  search as catalogSearch,
  type SearchInput as CatalogSearchInput,
  type SearchOutcome as CatalogSearchOutcome,
} from "./catalog/search.ts";
import type { ApiClientDeps, RawProduct } from "./catalog/api-client.ts";
import type { FacetMatchResult } from "./catalog/facet-matcher.ts";
import type {
  ExpansionResult,
  QueryAttempt,
  QueryAttemptForm,
} from "./query-expansion.ts";
import type { Intent } from "./types.ts";

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Финальный статус search-этапа. Mapping в §5.6.1 soft404 state-machine:
 *   'ok'              → streak = 0, render cards
 *   'soft_fallback'   → streak = 0, render cards + tail-line
 *   'empty'           → streak += 1
 *   'all_zero_price'  → contactManager=true (scenario-path), streak не важен
 *   'error'           → contactManager=true (scenario-path)
 *   'out_of_domain'   → contactManager=true (scenario-path)
 */
export type SSearchStatus =
  | "ok"
  | "soft_fallback"
  | "empty"
  | "all_zero_price"
  | "error"
  | "out_of_domain";

export interface SSearchInput {
  /** pagetitle от Category Resolver. Обязателен — без категории search-этап не запускается. */
  pagetitle: string;
  /** Формы запроса от Query Expansion (как минимум as_is_ru). */
  expansion: ExpansionResult;
  /** Результат Facet Matcher (фильтры + aliases + captions). */
  facetMatch: FacetMatchResult;
  /**
   * Intent — для domain_check, article (SKU), и (в будущих этапах) price_intent.
   * В Stage 6D используем только domain_check + article.
   */
  intent: Intent;
  /** Pagination: 1-based, default 1. */
  page?: number;
  /** Default 12 (§7.2). */
  perPage?: number;
}

export interface SSearchAttemptTrace {
  /** Какая form Query Expansion. */
  form: QueryAttemptForm;
  /** Текст запроса, отправленный в catalog/search. */
  query: string;
  /** Outcome от catalog/search (внутренние strict + soft fallback attempts уже внутри). */
  outcome: CatalogSearchOutcome;
}

export interface SSearchOutcome {
  status: SSearchStatus;
  /** Уже отфильтрованные word-boundary товары (price>0). Пусто при non-ok/non-soft_fallback. */
  products: RawProduct[];
  totalFromApi: number;
  /** Заполнено ТОЛЬКО при status === 'soft_fallback' (инвариант §4.8.1). */
  softFallbackContext: { droppedFacetCaption: string } | null;
  /** Все попытки по формам (для логов и метрик query_expansion_*). */
  attempts: SSearchAttemptTrace[];
  /** Какая form в итоге дала ok/soft_fallback (null если ни одна). */
  winningForm: QueryAttemptForm | null;
  /** Сумма zeroPriceFiltered по всем attempts (метрика zero_price_leak). */
  zeroPriceLeak: number;
  /** Сумма postFilterDropped по всем attempts (метрика word-boundary эффективности). */
  postFilterDropped: number;
  pagination?: { page: number; perPage: number; totalPages: number };
  errorMessage?: string;
  ms: number;
}

export interface SSearchDeps {
  apiClient: ApiClientDeps;
  /** Optional logger; no-op by default. */
  log?: (event: string, data?: Record<string, unknown>) => void;
}

// ─── Main entry ─────────────────────────────────────────────────────────────

export async function runSearch(
  input: SSearchInput,
  deps: SSearchDeps,
): Promise<SSearchOutcome> {
  const t0 = Date.now();
  const log = deps.log ?? (() => {});

  // ── Defensive: out_of_domain shortcut (§4.7). ─────────────────────────
  if (input.intent.domain_check === "out_of_domain") {
    log("s_search.out_of_domain_shortcut", {});
    return {
      status: "out_of_domain",
      products: [],
      totalFromApi: 0,
      softFallbackContext: null,
      attempts: [],
      winningForm: null,
      zeroPriceLeak: 0,
      postFilterDropped: 0,
      ms: Date.now() - t0,
    };
  }

  // ── Подготовка форм. ──────────────────────────────────────────────────
  // Если есть SKU — multi-attempt не нужен (article-поиск точен), используем
  // только первую форму (or empty). API-клиент игнорирует query при наличии
  // article; текст формы пробрасываем как есть для consistency логов.
  const allAttempts = input.expansion.attempts.filter((a) => a.text.trim().length > 0);
  if (allAttempts.length === 0) {
    log("s_search.no_forms", {});
    return {
      status: "empty",
      products: [],
      totalFromApi: 0,
      softFallbackContext: null,
      attempts: [],
      winningForm: null,
      zeroPriceLeak: 0,
      postFilterDropped: 0,
      ms: Date.now() - t0,
    };
  }

  // Если есть SKU — пробуем только первую форму (or all_zero_price/error пробрасываем).
  const formsToTry: QueryAttempt[] = input.intent.has_sku && input.intent.sku_candidate
    ? [allAttempts[0]]
    : allAttempts;

  const traces: SSearchAttemptTrace[] = [];
  let zeroPriceLeak = 0;
  let postFilterDropped = 0;
  let lastTerminalOutcome: CatalogSearchOutcome | null = null;

  for (const attempt of formsToTry) {
    const catalogInput: CatalogSearchInput = {
      category: input.pagetitle,
      query: attempt.text,
      article: input.intent.has_sku && input.intent.sku_candidate
        ? input.intent.sku_candidate
        : undefined,
      optionFilters: Object.keys(input.facetMatch.optionFilters).length > 0
        ? input.facetMatch.optionFilters
        : undefined,
      optionAliases: Object.keys(input.facetMatch.optionAliases).length > 0
        ? input.facetMatch.optionAliases
        : undefined,
      optionFilterCaptions: input.facetMatch.facetCaptions,
      // Порядок снятия фасетов в Soft Fallback = порядок добавления в optionFilters
      // (canonical_keys в том порядке, как Facet Matcher их матчил). Catalog/search
      // снимает с конца → первым уйдёт последний добавленный фасет.
      optionFilterOrder: Object.keys(input.facetMatch.optionFilters),
      page: input.page ?? 1,
      perPage: input.perPage ?? 12,
      // minPrice/maxPrice — НЕ выставляем (K1: бот не самосужает).
    };

    const outcome = await catalogSearch(catalogInput, deps.apiClient);
    zeroPriceLeak += outcome.zeroPriceFiltered;
    postFilterDropped += outcome.postFilterDropped;
    traces.push({ form: attempt.form, query: attempt.text, outcome });
    lastTerminalOutcome = outcome;

    log("s_search.attempt", {
      form: attempt.form,
      status: outcome.status,
      products: outcome.products.length,
      totalFromApi: outcome.totalFromApi,
    });

    // Терминальные статусы scenario-path (§5.6.1): возвращаем сразу,
    // не пытаясь следующие формы — это не «empty», это особое состояние.
    if (outcome.status === "all_zero_price") {
      return {
        status: "all_zero_price",
        products: [],
        totalFromApi: outcome.totalFromApi,
        softFallbackContext: null,
        attempts: traces,
        winningForm: null,
        zeroPriceLeak,
        postFilterDropped,
        ms: Date.now() - t0,
      };
    }

    if (outcome.status === "error") {
      // ВАЖНО: не возвращаем 'error' немедленно — пробуем следующие формы
      // (catalog API мог временно подавиться на одной строке). Если ВСЕ
      // формы дали error — финализируем как 'error' после цикла.
      continue;
    }

    // Успех (ok / soft_fallback) — финализируем.
    if (outcome.status === "ok" || outcome.status === "soft_fallback") {
      return {
        status: outcome.status,
        products: outcome.products,
        totalFromApi: outcome.totalFromApi,
        softFallbackContext: outcome.softFallbackContext,
        attempts: traces,
        winningForm: attempt.form,
        zeroPriceLeak,
        postFilterDropped,
        pagination: outcome.pagination,
        ms: Date.now() - t0,
      };
    }

    // status === 'empty' → пробуем следующую форму.
  }

  // ── Все формы перебраны. Решаем финальный статус. ─────────────────────
  // Если все попытки были 'error' → финализируем как 'error'.
  const allErrors = traces.length > 0 && traces.every((t) => t.outcome.status === "error");
  if (allErrors) {
    return {
      status: "error",
      products: [],
      totalFromApi: 0,
      softFallbackContext: null,
      attempts: traces,
      winningForm: null,
      zeroPriceLeak,
      postFilterDropped,
      errorMessage: lastTerminalOutcome?.errorMessage,
      ms: Date.now() - t0,
    };
  }

  // Все формы дали empty → финальный empty.
  // Soft Fallback здесь НЕ запускаем повторно — catalog/search уже сделал его
  // внутри каждой формы (включая прогрессивное снятие всех фасетов).
  return {
    status: "empty",
    products: [],
    totalFromApi: lastTerminalOutcome?.totalFromApi ?? 0,
    softFallbackContext: null,
    attempts: traces,
    winningForm: null,
    zeroPriceLeak,
    postFilterDropped,
    ms: Date.now() - t0,
  };
}
