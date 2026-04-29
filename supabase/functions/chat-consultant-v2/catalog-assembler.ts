/**
 * Stage 7 — Step 4.1: Catalog Assembler (orchestrator E2E).
 *
 * Источник: spec §4 (Catalog flow), §4.4 (price branch), §4.7 (out_of_domain),
 *           §5.4 (composer scenarios), §5.6.1 (soft404 streak).
 *
 * Что делает:
 *   1. Разделяет маршрут по `decision.route ∈ {S_CATALOG, S_PRICE, S_CATALOG_OOD}`.
 *   2. Для S_CATALOG / S_PRICE прогоняет:
 *        Category Resolver → Query Expansion → Facet Matcher → S_search/S_price.
 *      Каждый под-шаг строго data-agnostic, использует DI.
 *   3. Возвращает `ComposerOutcome` (search | price), готовый к подаче
 *      в `composeCatalogAnswer`.
 *
 * Чистота: единственные побочные эффекты — это вызовы DI-функций
 * (api/openrouter/cache). Никаких глобальных Supabase-клиентов внутри.
 *
 * НЕ зависит от: index.ts, runtime config, Deno.env. Всё инъецируется.
 */

import type {
  ChatHistoryMessage,
  Intent,
  Slot,
  ConversationState,
} from "./types.ts";
import type { ComposerOutcome } from "./s-catalog-composer.ts";
import type { S1Match } from "./s1-slot-resolver.ts";
import type { Route } from "./s3-router.ts";
import type { ResolverDeps, ResolverIntent, ResolverResult } from "./category-resolver.ts";
import { resolveCategory } from "./category-resolver.ts";
import type { ExpansionDeps, ExpansionResult } from "./query-expansion.ts";
import { expandQuery } from "./query-expansion.ts";
import type { FacetMatcherDeps } from "./catalog/facet-matcher.ts";
import { matchFacets } from "./catalog/facet-matcher.ts";
import type { FacetMatchResult } from "./catalog/facet-matcher.ts";
import type { SSearchDeps, SSearchOutcome } from "./s-search.ts";
import { runSearch } from "./s-search.ts";
import type { SPriceDeps, SPriceOutcome } from "./s-price.ts";
import { priceBranch } from "./s-price.ts";
import type { ApiClientDeps, RawOption } from "./catalog/api-client.ts";
import { getCategoryOptions } from "./catalog/api-client.ts";
import type { SearchOutcome, SearchStatus } from "./catalog/search.ts";
import type { SSimilarDeps, SSimilarOutcome } from "./s-similar/index.ts";
import { runSimilarBranch } from "./s-similar/index.ts";

/**
 * Адаптер SSearchOutcome → SearchOutcome (тип, который ждёт composer).
 *
 * SSearchOutcome — обёртка с multi-attempt expansion (s-search.ts).
 * SearchOutcome — выход одной попытки strict+soft_fallback (catalog/search.ts).
 *
 * Маппинг status:
 *   ok / soft_fallback / empty / all_zero_price / error  → совпадают.
 *   out_of_domain (s-search defensive) → empty (composer обработает как soft_404).
 *
 * Поля: products / totalFromApi / softFallbackContext / postFilterDropped — 1:1.
 * zeroPriceFiltered ← zeroPriceLeak. attempts: пустой массив (внутренние
 * traces s-search не транслируются — composer их не использует).
 */
function adaptSSearchToSearchOutcome(s: SSearchOutcome): SearchOutcome {
  const status: SearchStatus = s.status === "out_of_domain" ? "empty" : (s.status as SearchStatus);
  return {
    status,
    products: s.products,
    totalFromApi: s.totalFromApi,
    zeroPriceFiltered: s.zeroPriceLeak,
    postFilterDropped: s.postFilterDropped,
    attempts: [],
    pagination: s.pagination,
    softFallbackContext: s.softFallbackContext,
    errorMessage: s.errorMessage,
    ms: s.ms,
  };
}

/**
 * §4.6: Адаптер SSimilarOutcome → SearchOutcome для composer.
 *
 * Маппинг status:
 *   - 'ok'                 → 'ok'             (composer scenario='normal',
 *                                              cards рендерятся; cross-sell
 *                                              запретится через disallowCrosssell=true)
 *   - 'clarify_anchor'     → 'empty'          (composer выдаст soft_404 — НО мы
 *                                              форсим контактный текст через
 *                                              отдельный путь: clarifyQuestion
 *                                              кладём в errorMessage для пробро-
 *                                              са, а composer будет уведомлён
 *                                              о specific сценарии через trace)
 *   - 'anchor_not_found'   → 'empty'          (soft_404)
 *   - 'all_zero_price'     → 'all_zero_price' (contactManager=true §5.6.1)
 *   - 'empty'              → 'empty'          (soft_404)
 *   - 'error'              → 'error'          (contactManager=true §5.6.1)
 *
 * NB: clarify_anchor — это разовый вопрос БЕЗ slot (INV-S3). Композер не имеет
 * специального scenario под него — мы пользуемся soft_404 веткой и инжектим
 * `clarifyQuestion` через `errorMessage`. Шаг 8.5 (отдельный композер для
 * similar) может это улучшить, но сейчас это data-agnostic минимум.
 */
function adaptSSimilarToSearchOutcome(s: SSimilarOutcome): SearchOutcome {
  let status: SearchStatus;
  switch (s.status) {
    case 'ok':              status = 'ok'; break;
    case 'all_zero_price':  status = 'all_zero_price'; break;
    case 'error':           status = 'error'; break;
    case 'clarify_anchor':
    case 'anchor_not_found':
    case 'empty':
    default:                status = 'empty'; break;
  }
  return {
    status,
    products: s.products,
    totalFromApi: s.products.length,
    zeroPriceFiltered: 0,
    postFilterDropped: 0,
    attempts: [],
    softFallbackContext: null,
    errorMessage: s.errorMessage ?? s.clarifyQuestion,
    ms: s.trace.ms,
  };
}

// ─── Public types ───────────────────────────────────────────────────────────

export type AssemblerStage =
  | "ood_shortcut"
  | "category_resolver"
  | "query_expansion"
  | "facet_matcher"
  | "s_search"
  | "s_price"
  | "s_similar";

export interface AssemblerTrace {
  route: Route;
  stages: Array<{ stage: AssemblerStage; ms: number; meta?: Record<string, unknown> }>;
  /** Итоговый pagetitle (если был выбран). null для OOD/unresolved. */
  pagetitle: string | null;
  /** Вид сборки (для метрик). */
  flavor: "catalog" | "price" | "ood" | "similar";
  /** Итоговый winning form (если search). */
  winningForm?: string | null;
  /** Резерв: ошибки на любой стадии. */
  errors: Array<{ stage: AssemblerStage; message: string }>;
}

export interface AssemblerResult {
  /** Готовый вход для composeCatalogAnswer. null для OOD (composer не нужен). */
  composerOutcome: ComposerOutcome | null;
  /** OOD shortcut: вместо composer показываем фиксированный fallback. */
  ood: boolean;
  trace: AssemblerTrace;
  /** Pagetitle, выбранный resolver-ом (для slot.pending_query / replay). */
  resolvedPagetitle: string | null;
  /**
   * §5.4.1 + §11.5b + Core Memory: внешний запрет cross-sell от оркестратора.
   * Источник правды для оркестратора — здесь, в assembler-результате.
   *
   * Текущие правила (детерминированно, без LLM):
   *   - OOD               → composer не вызывается (флаг иррелевантен, ставим false)
   *   - S_PRICE clarify   → true  (вопрос-уточнение, не место для cross-sell)
   *   - S_PRICE show_all/top3 → false (composer сам форсит OR с scenario != normal)
   *   - S_CATALOG empty/soft_404 → false (composer форсит сам через scenario)
   *   - S_CATALOG normal/soft_fallback → false (cross-sell допустим в normal;
   *     soft_fallback композер запретит сам через scenario != normal)
   *   - similar (Stage 8) → ВСЕГДА true (Core Memory)
   *
   * Композер применяет логику OR (запрет ИЛИ scenario != normal), поэтому
   * установка false здесь безопасна — приоритет всегда у запрета.
   */
  disallowCrosssell: boolean;
}

export interface AssemblerInput {
  route: Route;
  intent: Intent;
  /** Очищенный текст пользователя (effective_message от orchestrator). */
  query: string;
  history: ChatHistoryMessage[];
  /** Если был slot match — пробрасываем для resolver.skipped_slot и для S_search continuation. */
  slotMatch: S1Match | null;
  /** traceId — для Resolver/Expansion логов. */
  traceId: string;
  /** Pagination для S_search (default 1/12). */
  page?: number;
  perPage?: number;
  /**
   * §4.6.2: текущий ConversationState. Нужен similar-ветке для anchor fallback
   * (`state.last_shown_product_sku`). Опционально для backward-compat — другие
   * ветки игнорируют.
   */
  state?: ConversationState;
}

export interface AssemblerDeps {
  /** Resolver. */
  resolver: ResolverDeps;
  /** Query Expansion. */
  expansion: ExpansionDeps;
  /** Facet Matcher. */
  facets: FacetMatcherDeps;
  /** S_search. */
  search: SSearchDeps;
  /** S_price. */
  price: SPriceDeps;
  /**
   * §4.6 Similar/Replacement branch. Опционально для backward-compat:
   * если route===S_SIMILAR, а deps.similar отсутствует → assembler возвращает
   * empty SearchOutcome (composer выдаст soft_404), а не падает.
   */
  similar?: SSimilarDeps;
  /**
   * Catalog API client (для прямого вызова /categories/options перед s-price —
   * чтобы передать `facetOptions` в `priceBranch.input`). Тот же `apiClient`,
   * что внутри facets/search/price; вынесен наружу для совместимости с
   * мокирующими тестами.
   */
  apiClient: ApiClientDeps;
  /** Опциональный логгер общего уровня. */
  log?: (event: string, data?: Record<string, unknown>) => void;
  /** Источник времени. */
  now?: () => number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Маппинг spec §3.3 IntentType → ResolverIntent (узкий набор). */
function toResolverIntent(intent: Intent, slotMatch: S1Match | null): ResolverIntent {
  if (intent.domain_check === "out_of_domain") return "out_of_domain";
  if (intent.intent === "knowledge") return "knowledge";
  // refine_filter / next_page определяются по типу слота:
  if (slotMatch) {
    const t = slotMatch.matched_slot.type;
    if (t === "price_clarify" || t === "category_disambiguation") return "refine_filter";
  }
  if (intent.intent === "catalog") return "catalog";
  return "unknown";
}

/** Snapshot слота для resolver. Если слот несёт pending_query — он становится category. */
function toResolverSlotSnapshot(slotMatch: S1Match | null): { category?: string | null } | null {
  if (!slotMatch) return null;
  const cat = slotMatch.matched_slot.pending_query?.trim();
  return cat ? { category: cat } : null;
}

/**
 * Объединённые модификаторы для Facet Matcher: search_modifiers + critical
 * (последние строго ужимают воронку, должны учитываться). Дедупликация по
 * lowercase. Пустые строки отбрасываются.
 */
function collectModifiers(intent: Intent): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of [...(intent.critical_modifiers ?? []), ...(intent.search_modifiers ?? [])]) {
    if (typeof m !== "string") continue;
    const t = m.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

// ─── Main entry ─────────────────────────────────────────────────────────────

export async function assembleCatalog(
  input: AssemblerInput,
  deps: AssemblerDeps,
): Promise<AssemblerResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const trace: AssemblerTrace = {
    route: input.route,
    stages: [],
    pagetitle: null,
    flavor: input.route === "S_PRICE" ? "price"
          : input.route === "S_CATALOG_OOD" ? "ood"
          : input.route === "S_SIMILAR" ? "similar"
          : "catalog",
    errors: [],
  };

  // ── 1. OOD shortcut (§4.7) ────────────────────────────────────────────────
  if (input.route === "S_CATALOG_OOD" || input.intent.domain_check === "out_of_domain") {
    const t0 = now();
    log("assembler.ood_shortcut", { traceId: input.traceId });
    trace.stages.push({ stage: "ood_shortcut", ms: now() - t0 });
    return {
      composerOutcome: null,
      ood: true,
      trace,
      resolvedPagetitle: null,
      disallowCrosssell: false, // composer не вызывается; флаг иррелевантен
    };
  }

  // ── 1b. SIMILAR shortcut (§4.6) ────────────────────────────────────────────
  // Similar — отдельная ветка: НЕ переиспользует Category Resolver / Query
  // Expansion / Facet Matcher из основной воронки. У неё свой anchor-driven
  // pipeline (см. s-similar/index.ts §4.6.4). Сразу делегируем.
  if (input.route === "S_SIMILAR") {
    const t0 = now();
    if (!deps.similar) {
      // Backward-compat: deps.similar не подключён → возвращаем soft_404 как
      // безопасный fallback. Это лучше падения и сохраняет контракт composer.
      log("assembler.similar_deps_missing", { traceId: input.traceId });
      trace.stages.push({
        stage: "s_similar",
        ms: now() - t0,
        meta: { error: "deps.similar not provided" },
      });
      const emptyOutcome: SearchOutcome = {
        status: "empty",
        products: [],
        totalFromApi: 0,
        zeroPriceFiltered: 0,
        postFilterDropped: 0,
        attempts: [],
        softFallbackContext: null,
        ms: 0,
      };
      return {
        composerOutcome: { kind: "search", outcome: emptyOutcome },
        ood: false,
        trace,
        resolvedPagetitle: null,
        disallowCrosssell: true, // INV-S2: similar ВСЕГДА запрещает cross-sell
      };
    }
    const similarOutcome: SSimilarOutcome = await runSimilarBranch(
      {
        intent: input.intent,
        state: input.state ?? { conversation_id: "unknown", slots: [] },
        message: input.query,
      },
      deps.similar,
    );
    trace.pagetitle = similarOutcome.pagetitle ?? null;
    trace.stages.push({
      stage: "s_similar",
      ms: now() - t0,
      meta: {
        status: similarOutcome.status,
        products: similarOutcome.products.length,
        anchor_status: similarOutcome.trace.anchor.status,
        classify_calls: similarOutcome.trace.classifyTraitsCalls,
        degrade_iterations: similarOutcome.trace.degradeIterations,
      },
    });
    return {
      composerOutcome: {
        kind: "search",
        outcome: adaptSSimilarToSearchOutcome(similarOutcome),
      },
      ood: false,
      trace,
      resolvedPagetitle: similarOutcome.pagetitle ?? null,
      disallowCrosssell: true, // §4.6.5 INV-S2: ВСЕГДА true для similar
    };
  }

  // ── 2. Category Resolver ──────────────────────────────────────────────────
  const tCR0 = now();
  let resolver: ResolverResult;
  try {
    resolver = await resolveCategory(
      {
        query: input.query,
        intent: toResolverIntent(input.intent, input.slotMatch),
        slot: toResolverSlotSnapshot(input.slotMatch),
        traceId: input.traceId,
      },
      deps.resolver,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    trace.errors.push({ stage: "category_resolver", message: msg });
    trace.stages.push({ stage: "category_resolver", ms: now() - tCR0, meta: { error: msg } });
    // Resolver упал — нет pagetitle → S_search вернёт empty. Переходим к expansion
    // с pagetitle=''. Это даст soft_404 от composer, что корректно (мы не врём).
    resolver = {
      status: "unresolved",
      pagetitle: null,
      candidates: [],
      confidence: 0,
      source: "error",
      ms: 0,
      error: msg,
    };
  }
  trace.pagetitle = resolver.pagetitle;
  trace.stages.push({
    stage: "category_resolver",
    ms: now() - tCR0,
    meta: { status: resolver.status, pagetitle: resolver.pagetitle, confidence: resolver.confidence },
  });

  // ── 3. Query Expansion ────────────────────────────────────────────────────
  const tQE0 = now();
  let expansion: ExpansionResult;
  try {
    expansion = await expandQuery(
      { query: input.query, locale: "ru", traceId: input.traceId },
      deps.expansion,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    trace.errors.push({ stage: "query_expansion", message: msg });
    // Минимальный fallback — одна форма as_is_ru.
    expansion = {
      attempts: [{ form: "as_is_ru", text: input.query }],
      skipped: [],
      ms: 0,
    };
  }
  trace.stages.push({
    stage: "query_expansion",
    ms: now() - tQE0,
    meta: { attempts_count: expansion.attempts.length, skipped: expansion.skipped },
  });

  // ── 4. Facet Matcher (только если есть pagetitle) ─────────────────────────
  // §4.6: если категория не выбрана, фасет-вызов не имеет смысла (он привязан к pagetitle).
  const tFM0 = now();
  let facetMatch: FacetMatchResult;
  let facetOptions: RawOption[] = [];
  if (resolver.pagetitle) {
    const modifiers = collectModifiers(input.intent);
    try {
      facetMatch = await matchFacets(resolver.pagetitle, modifiers, deps.facets);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      trace.errors.push({ stage: "facet_matcher", message: msg });
      facetMatch = {
        status: "category_unavailable",
        optionFilters: {},
        optionAliases: {},
        facetCaptions: {},
        matchedModifiers: [],
        unmatchedModifiers: modifiers,
        source: "unavailable",
        ms: 0,
      };
    }

    // Для S_PRICE composer-clarify нужны RawOption[] — берём прямой вызов
    // (через тот же кэш facets:<pagetitle> результат, в идеале — но
    // matchFacets его уже прогрел). Делаем отдельный getCategoryOptions
    // только если route=S_PRICE и facetMatch не отдал нам options.
    if (input.route === "S_PRICE") {
      try {
        const opts = await getCategoryOptions(resolver.pagetitle, deps.apiClient);
        facetOptions = opts.options ?? [];
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log("assembler.facet_options_fetch_failed", { msg });
      }
    }
  } else {
    facetMatch = {
      status: "no_facets",
      optionFilters: {},
      optionAliases: {},
      facetCaptions: {},
      matchedModifiers: [],
      unmatchedModifiers: collectModifiers(input.intent),
      source: "unavailable",
      ms: 0,
    };
  }
  trace.stages.push({
    stage: "facet_matcher",
    ms: now() - tFM0,
    meta: {
      status: facetMatch.status,
      filters_count: Object.keys(facetMatch.optionFilters).length,
      facetOptions_count: facetOptions.length,
    },
  });

  // ── 5a. PRICE branch (§4.4) ───────────────────────────────────────────────
  if (input.route === "S_PRICE") {
    const tSP0 = now();
    const priceOutcome: SPriceOutcome = await priceBranch(
      {
        pagetitle: resolver.pagetitle,
        query: input.query,
        intent: input.intent,
        optionFilters: facetMatch.optionFilters,
        optionAliases: facetMatch.optionAliases,
        facetOptions,
      },
      deps.price,
    );
    trace.stages.push({
      stage: "s_price",
      ms: now() - tSP0,
      meta: {
        status: priceOutcome.status,
        total: priceOutcome.totalCount,
        branch: priceOutcome.branch,
        zero_price_leak: priceOutcome.zeroPriceLeak,
      },
    });
    return {
      composerOutcome: { kind: "price", outcome: priceOutcome },
      ood: false,
      trace,
      resolvedPagetitle: resolver.pagetitle,
      // §4.4 + §11.5b: clarify-вопрос НЕ должен сопровождаться cross-sell.
      disallowCrosssell: priceOutcome.branch === "clarify",
    };
  }

  // ── 5b. CATALOG branch (S_search) ─────────────────────────────────────────
  // §4: если pagetitle не выбран — отдаём пустой SearchOutcome=empty
  // (composer выдаст soft_404 без LLM на products>0).
  if (!resolver.pagetitle) {
    const tSS0 = now();
    const emptyOutcome: SSearchOutcome = {
      status: "empty",
      products: [],
      totalFromApi: 0,
      softFallbackContext: null,
      attempts: [],
      winningForm: null,
      zeroPriceLeak: 0,
      postFilterDropped: 0,
      ms: 0,
    };
    trace.stages.push({
      stage: "s_search",
      ms: now() - tSS0,
      meta: { skipped: "no_pagetitle" },
    });
    return {
      composerOutcome: { kind: "search", outcome: adaptSSearchToSearchOutcome(emptyOutcome) },
      ood: false,
      trace,
      resolvedPagetitle: null,
      // empty → composer сам форсит запрет (scenario != normal); ставим false.
      disallowCrosssell: false,
    };
  }

  const tSS0 = now();
  const searchOutcome: SSearchOutcome = await runSearch(
    {
      pagetitle: resolver.pagetitle,
      expansion,
      facetMatch,
      intent: input.intent,
      page: input.page,
      perPage: input.perPage,
    },
    deps.search,
  );
  trace.winningForm = searchOutcome.winningForm;
  trace.stages.push({
    stage: "s_search",
    ms: now() - tSS0,
    meta: {
      status: searchOutcome.status,
      total: searchOutcome.totalFromApi,
      products: searchOutcome.products.length,
      winning_form: searchOutcome.winningForm,
      zero_price_leak: searchOutcome.zeroPriceLeak,
      post_filter_dropped: searchOutcome.postFilterDropped,
    },
  });

  return {
    composerOutcome: { kind: "search", outcome: adaptSSearchToSearchOutcome(searchOutcome) },
    ood: false,
    trace,
    resolvedPagetitle: resolver.pagetitle,
    // S_CATALOG normal/soft_fallback: запрет не нужен на уровне assembler —
    // композер сам решит по scenario. similar-ветка (Stage 8) проставит true.
    disallowCrosssell: false,
  };
}

// ─── Re-exports для удобства потребителей ───────────────────────────────────
export type { Slot };
