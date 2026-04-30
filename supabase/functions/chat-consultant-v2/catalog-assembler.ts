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
import type { FacetMatcherLLMDeps } from "./catalog/facet-matcher-llm.ts";
import { matchFacetsWithLLM } from "./catalog/facet-matcher-llm.ts";
import type { SSearchDeps, SSearchOutcome } from "./s-search.ts";
import { runSearch } from "./s-search.ts";
import type { SPriceDeps, SPriceOutcome } from "./s-price.ts";
import { priceBranch } from "./s-price.ts";
import type { ApiClientDeps, RawOption, RawProduct } from "./catalog/api-client.ts";
import { getCategoryOptions, searchProducts, extractFacetSchemaFromProducts } from "./catalog/api-client.ts";
import type { SearchOutcome, SearchStatus } from "./catalog/search.ts";
import { N_PROBE } from "./config.ts";
import type { CategoryNounExtractorDeps } from "./category-noun-extractor.ts";
import { extractCategoryNoun } from "./category-noun-extractor.ts";
import type { SoftSuggestDeps } from "./soft-suggest.ts";
import { runSoftSuggest } from "./soft-suggest.ts";

// ─── F.5.8: defense-in-depth для disallowCrosssell ──────────────────────────
//
// Контракт (§5.4.1 + §11.5b + Core memory «Cross-sell NOT shown for similar»):
//
//   Cross-sell разрешён ТОЛЬКО когда у пользователя на руках валидная выдача
//   с товарами (scenario='normal' в композере). Любой другой исход —
//   уточнение, escalation, soft_404, soft_fallback, infrastructure failure —
//   запрет cross-sell.
//
//   Composer применяет ту же логику OR на своём уровне (`scenarioDisallowed =
//   scenario !== 'normal'`). F.5.8 добавляет ВТОРОЙ слой защиты в assembler:
//   запрет проставляется ЯВНО на основании финального статуса outcome'а,
//   независимо от того, как composer ИНТЕРПРЕТИРУЕТ scenario. Это страхует
//   от регрессий decideScenario и от добавления новых веток с дефолтом
//   `disallowCrosssell=false`.
//
//   Helper'ы — pure functions, тестируются отдельно.

/**
 * Запрет cross-sell для S_PRICE: разрешён ТОЛЬКО когда branch ∈ {'show_all','show_top'},
 * т.е. когда есть готовая отсортированная выдача товаров. Все остальные ветки
 * (clarify, error, all_zero_price, empty, out_of_domain) — запрет.
 */
export function shouldDisallowCrosssellForPrice(outcome: SPriceOutcome): boolean {
  return !(outcome.status === "ok" &&
    (outcome.branch === "show_all" || outcome.branch === "show_top"));
}

/**
 * Запрет cross-sell для S_CATALOG (search): разрешён ТОЛЬКО при status='ok'
 * с непустыми товарами. soft_fallback тоже запрещён (§4.8: уточнение, не
 * место для cross-sell). Согласовано с composer'ом (см. §5.4.1).
 */
export function shouldDisallowCrosssellForSearch(outcome: SearchOutcome): boolean {
  if (outcome.status !== "ok") return true;
  return outcome.products.length === 0;
}
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
  | "parallel_probe"
  | "query_expansion"
  | "facet_matcher"
  | "category_noun_extractor"
  | "soft_suggest"
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
  /**
   * §4.6 + §11.6: короткая 1-строка-объяснение от similar-ветки
   * («Подобрал по характеристикам X, Y, Z.»). НЕ содержит SKU/цен/брендов.
   * Композер вставляет первой строкой ПЕРЕД LLM intro в similar-сценарии.
   * undefined для не-similar веток.
   */
  recommendationContext?: string;
  /**
   * §22.3 spec — готовый markdown HINT-блок от Soft-Suggest. Когда задан,
   * `index.ts` пробрасывает его в `composeCatalogAnswer.input.softSuggestHint`.
   * undefined для веток, где Soft-Suggest не запускался / выключен / не дал результатов.
   */
  softSuggestHint?: string | null;
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
  /**
   * §22.2 spec — Branch A флаг (Query-First). Когда true (Option A: всегда вызывается
   * extractor если флаг включён), assembler пытается извлечь категорию-существительное
   * и пробрасывает его как `categoryNounOverride` в `runSearch`. Default false.
   */
  queryFirstEnabled?: boolean;
  /**
   * §22.3 spec — Branch B флаг (Soft-Suggest). Когда true и есть unmatchedModifiers
   * + живая schema, assembler вызывает `runSoftSuggest` и возвращает `softSuggestHint`
   * для composer. Default false. БЕЗ молчаливой фильтрации (правило «no self-narrowing»).
   */
  softSuggestEnabled?: boolean;
}

export interface AssemblerDeps {
  /** Resolver. */
  resolver: ResolverDeps;
  /** Query Expansion. */
  expansion: ExpansionDeps;
  /** Facet Matcher (детерминированный — fallback). */
  facets: FacetMatcherDeps;
  /**
   * §9.3 LLM Facet Matcher (опциональный). Когда задан — используется как
   * основной путь резолва трейтов; детерминированный matcher остаётся как
   * deep-fallback при mode='llm_failed' (uptime).
   */
  facetsLLM?: FacetMatcherLLMDeps;
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
  /** §22.2 spec — extractor для Branch A. Опциональный (без него Branch A пропускается). */
  categoryNounExtractor?: CategoryNounExtractorDeps;
  /** §22.3 spec — Soft-Suggest LLM. Опциональный (без него Branch B пропускается). */
  softSuggest?: SoftSuggestDeps;
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
      recommendationContext: similarOutcome.recommendationContext || undefined,
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

  // ── 2b. §22.2 spec — Branch A kick-off (Query-First Category Noun Extractor)
  // Запускаем параллельно с probe и Query Expansion. Не блокирует пайплайн —
  // ждём только перед runSearch. Если флаг выключен ИЛИ deps нет ИЛИ extractor
  // вернул "" → categoryNounOverride остаётся пустым (поведение без изменений).
  const tCNE0 = now();
  const categoryNounPromise: Promise<string> = (async () => {
    if (!input.queryFirstEnabled) return "";
    if (!deps.categoryNounExtractor) return "";
    try {
      const r = await extractCategoryNoun(
        { userQuery: input.query, locale: "ru" },
        deps.categoryNounExtractor,
      );
      trace.stages.push({
        stage: "category_noun_extractor",
        ms: now() - tCNE0,
        meta: { source: r.source, noun: r.categoryNoun, raw: r.rawLLMValue },
      });
      return r.categoryNoun;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      trace.errors.push({ stage: "category_noun_extractor", message: msg });
      trace.stages.push({
        stage: "category_noun_extractor",
        ms: now() - tCNE0,
        meta: { error: msg },
      });
      return "";
    }
  })();

  // ── 3. §4.10 Parallel Probe (kick-off, awaited перед Facet Matcher) ──────
  // Запускаем probe-запрос /products?per_page=N_PROBE параллельно с Query
  // Expansion. Результат нужен ТОЛЬКО как Self-Bootstrap fallback для Facet
  // Matcher (§4.10.1) — на случай транспортного сбоя /categories/options.
  //
  // Probe идёт category-only (+ price из intent.price_range, если задан) —
  // НЕ инжектим unmatchedModifiers в query (§4.10.2 sanitization).
  // Если pagetitle пуст — probe пропускаем (нечего запрашивать).
  const tProbe0 = now();
  const probePromise: Promise<RawProduct[]> = (async () => {
    if (!resolver.pagetitle) return [];
    try {
      const minP = input.intent.price_intent === "range"
        ? (input.intent.price_range?.min as number | undefined)
        : undefined;
      const maxP = input.intent.price_intent === "range"
        ? (input.intent.price_range?.max as number | undefined)
        : undefined;
      const probe = await searchProducts(
        {
          category: resolver.pagetitle,
          perPage: N_PROBE,
          minPrice: typeof minP === "number" ? minP : undefined,
          maxPrice: typeof maxP === "number" ? maxP : undefined,
        },
        deps.apiClient,
      );
      return probe.status === "ok" ? probe.products : [];
    } catch (e) {
      log("assembler.probe_failed", { msg: e instanceof Error ? e.message : String(e) });
      return [];
    }
  })();

  // ── 4. Query Expansion ────────────────────────────────────────────────────
  // §9.2b §3: вместо сырой реплики передаём извлечённые Intent-LLM трейты
  // (`search_modifiers ∪ critical_modifiers`). Это `extractRuTokens` из
  // спеки — отбрасываем шумовые слова реплики («найди», «подскажи» и т.п.),
  // которые ломают word-boundary post-filter §9.2c.
  const tQE0 = now();
  const expansionTraits = collectModifiers(input.intent);
  let expansion: ExpansionResult;
  try {
    expansion = await expandQuery(
      {
        query: input.query,
        locale: "ru",
        traceId: input.traceId,
        traits: expansionTraits,
      },
      deps.expansion,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    trace.errors.push({ stage: "query_expansion", message: msg });
    // Минимальный fallback — одна форма as_is_ru на базе трейтов
    // (или сырого query, если трейтов нет).
    const fallbackText = expansionTraits.length > 0
      ? expansionTraits.join(" ")
      : input.query;
    expansion = {
      attempts: [{ form: "as_is_ru", text: fallbackText }],
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
  //
  // §9.3 предписывает LLM-based matching (морфология RU/KK, числовые
  // эквиваленты, билингвальность, составные конструкции) — это deps.facetsLLM.
  // Детерминированный matchFacets остаётся как:
  //   • baseline для случаев, когда LLM-deps не сконфигурированы (тесты, MVP);
  //   • deep-fallback при mode='llm_failed' после §28-retry (uptime).
  //
  // Когда оба пути отработали, optionFilters/optionAliases/facetCaptions
  // склеиваются в одну FacetMatchResult-структуру (контракт s-search/s-price
  // не меняется).
  const tFM0 = now();
  let facetMatch: FacetMatchResult;
  let facetOptions: RawOption[] = [];
  let llmFacetMode: string = "skipped";
  let llmFacetMs = 0;
  let llmFacetUnresolvedCount = 0;
  let llmFacetSoftMatchesCount = 0;
  let llmFacetResolvedCount = 0;
  let bootstrapUsed = false;
  let probeProductsCount = 0;

  if (resolver.pagetitle) {
    const modifiers = collectModifiers(input.intent);

    // §4.10.1: дожидаемся probe и собираем bootstrap-схему фасетов из
    // per-item Product.options[]. Это fallback на случай transport-failure
    // /categories/options. Если probe пуст — bootstrap=[] и matchFacets
    // вернёт 'category_unavailable' как раньше.
    const probeProducts = await probePromise;
    probeProductsCount = probeProducts.length;
    const bootstrapOptions: RawOption[] = probeProducts.length > 0
      ? extractFacetSchemaFromProducts(probeProducts)
      : [];
    trace.stages.push({
      stage: "parallel_probe",
      ms: now() - tProbe0,
      meta: {
        probe_products: probeProductsCount,
        bootstrap_options: bootstrapOptions.length,
      },
    });

    // §9.3 канонический путь: LLM Facet Matcher.
    let llmResult: Awaited<ReturnType<typeof matchFacetsWithLLM>> | null = null;
    if (deps.facetsLLM && modifiers.length > 0) {
      try {
        llmResult = await matchFacetsWithLLM(
          {
            pagetitle: resolver.pagetitle,
            traits: modifiers,
            user_query_raw: input.query,
            bootstrapOptions,
          },
          deps.facetsLLM,
        );
        llmFacetMode = llmResult.mode;
        llmFacetMs = llmResult.ms;
        llmFacetUnresolvedCount = llmResult.unresolved.length;
        llmFacetSoftMatchesCount = llmResult.soft_matches.length;
        llmFacetResolvedCount = llmResult.resolved.length;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        trace.errors.push({ stage: "facet_matcher", message: `llm: ${msg}` });
        llmFacetMode = "exception";
      }
    }

    // Если LLM сработал успешно (mode='ok') — используем его результат как
    // источник optionFilters. Иначе degrade на детерминированный matcher
    // (с bootstrap-fallback §4.10.1).
    if (llmResult && llmResult.mode === "ok") {
      const matchedTraits = [
        ...llmResult.resolved.map((r) => r.trait),
        ...llmResult.soft_matches.map((s) => s.trait),
      ];
      const unmatchedTraits = llmResult.unresolved.map((u) => u.trait);
      facetMatch = {
        status: Object.keys(llmResult.optionFilters).length > 0 ? "ok" : "no_matches",
        optionFilters: llmResult.optionFilters,
        optionAliases: llmResult.optionAliases,
        facetCaptions: llmResult.facetCaptions,
        matchedModifiers: matchedTraits,
        unmatchedModifiers: unmatchedTraits,
        source: llmResult.source,
        ms: llmResult.ms,
      };
    } else {
      // Degrade-путь: либо LLM-deps нет, либо mode='llm_failed'/'no_facets'/'no_traits'/'category_unavailable'/'exception'.
      // Передаём bootstrapOptions — если /categories/options вернёт transport-failure,
      // matchFacets продолжит работать на bootstrap-схеме (source='bootstrap').
      try {
        facetMatch = await matchFacets(
          resolver.pagetitle,
          modifiers,
          deps.facets,
          bootstrapOptions.length > 0 ? bootstrapOptions : undefined,
        );
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
    }
    bootstrapUsed = facetMatch.source === "bootstrap";

    // Для S_PRICE composer-clarify нужны RawOption[] — берём прямой вызов
    // (через тот же кэш facets:<pagetitle> результат, в идеале — но
    // matchFacets его уже прогрел). Делаем отдельный getCategoryOptions
    // только если route=S_PRICE и facetMatch не отдал нам options.
    //
    // §4.10.1: bootstrap-counts НЕ годятся для price_clarify (counts
    // ограничены N_PROBE → статистически некорректны). Если facets живой
    // схемы недоступны И bootstrap использован → facetOptions остаётся пуст,
    // composer уйдёт в S-CATALOG без clarify (см. spec).
    if (input.route === "S_PRICE") {
      try {
        const opts = await getCategoryOptions(resolver.pagetitle, deps.apiClient);
        facetOptions = opts.status === "ok" ? (opts.options ?? []) : [];
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
      facets_source: facetMatch.source,
      bootstrap_used: bootstrapUsed,
      probe_products: probeProductsCount,
      llm_mode: llmFacetMode,
      llm_ms: llmFacetMs,
      llm_resolved: llmFacetResolvedCount,
      llm_soft_matches: llmFacetSoftMatchesCount,
      llm_unresolved: llmFacetUnresolvedCount,
    },
  });

  // ── §4.10.2 Sanitization ─────────────────────────────────────────────────
  // Если фасет-схема недоступна (category_unavailable) И bootstrap не спас —
  // НЕ инжектим unmatchedModifiers в ?query=. Strict-search идёт category-only
  // (+price из intent.price_range, если есть). Это защищает от каскадного zero-result
  // при сбоях /categories/options. Defect `auto_query_pollution_total`=0.
  if (facetMatch.status === "category_unavailable" && resolver.pagetitle) {
    const sanitizedExpansion: ExpansionResult = {
      attempts: [{ form: "as_is_ru", text: resolver.pagetitle }],
      skipped: expansion.skipped,
      ms: expansion.ms,
    };
    log("assembler.sanitize_query_on_category_unavailable", {
      pagetitle: resolver.pagetitle,
      original_attempts: expansion.attempts.length,
      dropped_traits: expansionTraits,
    });
    expansion = sanitizedExpansion;
  }

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
      // F.5.8 + §4.4 + §11.5b + §5.6.1: запрет cross-sell для всех price-веток
      // кроме show_all/show_top (clarify-вопрос, error от breaker, all_zero_price,
      // empty, out_of_domain — все требуют запрета). Defense in depth: composer
      // отдельно форсит то же через scenario != 'normal'.
      disallowCrosssell: shouldDisallowCrosssellForPrice(priceOutcome),
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
    const adaptedEmpty = adaptSSearchToSearchOutcome(emptyOutcome);
    return {
      composerOutcome: { kind: "search", outcome: adaptedEmpty },
      ood: false,
      trace,
      resolvedPagetitle: null,
      // F.5.8: empty → запрет (defense in depth). Composer всё равно форсит то же.
      disallowCrosssell: shouldDisallowCrosssellForSearch(adaptedEmpty),
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

  const adaptedSearch = adaptSSearchToSearchOutcome(searchOutcome);
  return {
    composerOutcome: { kind: "search", outcome: adaptedSearch },
    ood: false,
    trace,
    resolvedPagetitle: resolver.pagetitle,
    // F.5.8: cross-sell разрешён ТОЛЬКО при ok+products. soft_fallback/empty/error
    // → запрет (defense in depth поверх composer scenario-логики).
    disallowCrosssell: shouldDisallowCrosssellForSearch(adaptedSearch),
  };
}

// ─── Re-exports для удобства потребителей ───────────────────────────────────
export type { Slot };
