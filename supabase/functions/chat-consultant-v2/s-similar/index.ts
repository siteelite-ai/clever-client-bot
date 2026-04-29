/**
 * Stage 8.3 — Similar / Replacement Branch (s-similar).
 * Источник: .lovable/specs/chat-consultant-v2-spec.md §4.6.1–§4.6.5 (нормативно).
 *
 * Архитектурная роль:
 *   s3-router (is_replacement===true) → ★ s-similar ★ → catalog-assembler → composer
 *
 * Что делает модуль:
 *   1. Anchor resolution (§4.6.2): intent.sku_candidate → state.last_shown → clarify_anchor.
 *   2. Anchor fetch: searchProducts({article: SKU}) → берём первую карточку.
 *   3. Category resolve: используется существующий resolveCategory.
 *   4. Category options fetch + classify_traits LLM tool call (§4.6.3).
 *   5. Trait→facet matching (через тот же facet-matcher).
 *   6. Strict search с must-фильтрами + degrade must→should (max 2 итерации, §4.6.4).
 *   7. Word-boundary post-filter уже встроен в catalog/search.
 *   8. Возврат outcome для composer: scenario='similar', disallowCrosssell=true ВСЕГДА.
 *
 * Жёсткие правила (Core Memory + §4.6.5):
 *   • disallowCrosssell === true ВСЕГДА (INV-S2).
 *   • Ровно один LLM-вызов classify_traits за ход (INV-S1).
 *   • clarify_anchor НЕ создаёт slot — разовый ответ (INV-S3).
 *   • Degrade must→should — это recovery, НЕ narrowing (INV-S4).
 *   • Никаких хардкоженных категорий/traits (INV-S5).
 *   • V1 НЕ тронут.
 */

import {
  searchProducts,
  type ApiClientDeps,
  type RawProduct,
} from '../catalog/api-client.ts';
import {
  matchFacets,
  type FacetMatcherDeps,
  type FacetMatchResult,
} from '../catalog/facet-matcher.ts';
import { search as catalogSearch, type SearchOutcome } from '../catalog/search.ts';
import {
  resolveCategory,
  type ResolverDeps,
  type ResolverResult,
} from '../category-resolver.ts';
import type {
  ClassifiedTrait,
  ClassifyTraitsResult,
  ConversationState,
  Intent,
  SimilarAnchor,
} from '../types.ts';
import { CLASSIFY_TRAITS_TOOL, CLASSIFY_TRAITS_TOOL_CHOICE } from './schema.ts';

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Финальный статус ветки. Маппинг для composer:
 *   'ok'              → scenario='similar', cards
 *   'clarify_anchor'  → scenario='similar_clarify_anchor' (один вопрос, без slot)
 *   'anchor_not_found'→ scenario='similar_anchor_not_found' + contactManager=true
 *   'all_zero_price'  → scenario='all_zero_price' + contactManager=true (§5.6.1 path B)
 *   'empty'           → scenario='empty' (degrade исчерпан, ничего не нашли)
 *   'error'           → scenario='error' + contactManager=true (§5.6.1 path B)
 */
export type SSimilarStatus =
  | 'ok'
  | 'clarify_anchor'
  | 'anchor_not_found'
  | 'all_zero_price'
  | 'empty'
  | 'error';

export interface SSimilarInput {
  intent: Intent;
  state: ConversationState;
  /** Запрос пользователя (для контекста LLM-промпта). */
  message: string;
}

export interface SSimilarTrace {
  anchor: SimilarAnchor;
  anchorProductId?: number;
  anchorPagetitle?: string;
  resolverStatus?: ResolverResult['status'];
  classifyTraitsCalls: number;
  traits?: ClassifiedTrait[];
  appliedMustKeys: string[];
  degradeIterations: number;
  searchAttempts: number;
  ms: number;
}

export interface SSimilarOutcome {
  status: SSimilarStatus;
  /** ВСЕГДА true для similar-ветки (§4.6.5 INV-S2). */
  disallowCrosssell: true;
  /** Финальная карточка-якорь (для текста «Рекомендую X вместо Y»). */
  anchorProduct?: RawProduct;
  /** Топ-N кандидатов (после ranking). */
  products: RawProduct[];
  /** Категория, в которой искали. */
  pagetitle?: string;
  /** Уточняющий вопрос (для clarify_anchor статуса). */
  clarifyQuestion?: string;
  /** Текст-объяснение для composer (1 строка, без SKU/цен). */
  recommendationContext?: string;
  trace: SSimilarTrace;
  errorMessage?: string;
}

// ─── Dependency injection ───────────────────────────────────────────────────

export interface SSimilarDeps {
  apiClient: ApiClientDeps;
  facetMatcher: FacetMatcherDeps;
  resolver: ResolverDeps;
  /** LLM tool-calling для classify_traits. Должен вернуть распарсенный JSON arguments. */
  callLLM: (params: {
    systemPrompt: string;
    userMessage: string;
    tool: typeof CLASSIFY_TRAITS_TOOL;
    toolChoice: typeof CLASSIFY_TRAITS_TOOL_CHOICE;
  }) => Promise<unknown>;
  /** Валидатор payload classify_traits. Инжектится для подмены в тестах. */
  validateTraits: (raw: unknown) => ClassifyTraitsResult;
  /** Default 12 (§7.2). */
  perPage?: number;
  now?: () => number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** §4.6.4 step 7: max 2 итерации degrade must→should. */
export const MAX_DEGRADE_ITERATIONS = 2;

/** §7.2 — top-N карточек на выходе similar-ветки. */
export const SIMILAR_TOP_N = 3;

/** §7.3 — модель для structured extraction. flash-lite достаточно. */
export const SIMILAR_LLM_MODEL = 'google/gemini-2.5-flash-lite';

/**
 * Системный промпт для classify_traits. Data-agnostic: НЕ содержит примеров
 * с реальными категориями 220volt (Core Memory: «ZERO examples…»).
 * Описывает только КОНТРАКТ.
 */
export const CLASSIFY_TRAITS_SYSTEM_PROMPT =
  `Ты — компонент s-similar ассистента магазина электротехники.
Тебе дан якорный товар (название, бренд, категория) и запрос пользователя.
Твоя единственная задача — вызвать функцию classify_traits ровно один раз,
извлекая до 8 характеристик якоря для подбора похожих товаров.

Правила:
- weight='must'   — характеристика, без которой товар НЕ подойдёт
                    (например, тип крепления, рабочее напряжение, диаметр).
- weight='should' — желательная характеристика (бренд того же класса, цвет).
- weight='nice'   — контекстное (гарантия, страна) — только для текста ответа.
- key и value — короткие нормализованные строки на русском.
- category_pagetitle — точное название категории, как пришло в контексте.

Никогда не отвечай текстом — только tool call classify_traits.`;

// ─── Anchor resolution (§4.6.2) ─────────────────────────────────────────────

export function resolveAnchor(input: SSimilarInput): SimilarAnchor {
  const { intent, state } = input;
  if (intent.has_sku && typeof intent.sku_candidate === 'string' && intent.sku_candidate.trim().length > 0) {
    return { status: 'resolved', sku: intent.sku_candidate.trim(), source: 'intent_sku' };
  }
  const lastSku = state.last_shown_product_sku;
  if (typeof lastSku === 'string' && lastSku.trim().length > 0) {
    return { status: 'resolved', sku: lastSku.trim(), source: 'last_shown' };
  }
  return { status: 'clarify_anchor' };
}

// ─── Trait → facet mapping ──────────────────────────────────────────────────

/**
 * Преобразует traits (must/should) в формат "modifiers" для существующего
 * facet-matcher. facet-matcher умеет матчить произвольные строки на ключи и
 * значения опций — переиспользуем.
 *
 * Возвращаем 3 группы: must / should / nice. nice мы НЕ матчим (информативно).
 */
export function partitionTraits(traits: ClassifiedTrait[]): {
  must: ClassifiedTrait[];
  should: ClassifiedTrait[];
  nice: ClassifiedTrait[];
} {
  const must: ClassifiedTrait[] = [];
  const should: ClassifiedTrait[] = [];
  const nice: ClassifiedTrait[] = [];
  for (const t of traits) {
    if (t.weight === 'must') must.push(t);
    else if (t.weight === 'should') should.push(t);
    else nice.push(t);
  }
  return { must, should, nice };
}

/**
 * Превращает traits в массив modifier-строк "key value", который понимает
 * facet-matcher. matcher сам нормализует и матчит на key/value реальных
 * facets категории.
 */
function traitsToModifiers(traits: ClassifiedTrait[]): string[] {
  return traits.map((t) => `${t.key} ${t.value}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function runSimilarBranch(
  input: SSimilarInput,
  deps: SSimilarDeps,
): Promise<SSimilarOutcome> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const perPage = deps.perPage ?? 12;
  const trace: SSimilarTrace = {
    anchor: { status: 'clarify_anchor' },
    classifyTraitsCalls: 0,
    appliedMustKeys: [],
    degradeIterations: 0,
    searchAttempts: 0,
    ms: 0,
  };

  // Step 1 — Anchor resolution (§4.6.2).
  const anchor = resolveAnchor(input);
  trace.anchor = anchor;
  if (anchor.status === 'clarify_anchor') {
    trace.ms = now() - t0;
    return {
      status: 'clarify_anchor',
      disallowCrosssell: true,
      products: [],
      clarifyQuestion: 'Подскажите артикул или точное название товара, к которому подобрать аналог.',
      trace,
    };
  }

  // Step 2 — Fetch anchor product by SKU.
  const anchorRes = await searchProducts({ article: anchor.sku, perPage: 1 }, deps.apiClient);
  if (anchorRes.status !== 'ok' || anchorRes.products.length === 0) {
    trace.ms = now() - t0;
    return {
      status: 'anchor_not_found',
      disallowCrosssell: true,
      products: [],
      trace,
      errorMessage: `anchor SKU '${anchor.sku}' not found (api status: ${anchorRes.status})`,
    };
  }
  const anchorProduct = anchorRes.products[0];
  trace.anchorProductId = anchorProduct.id;
  const anchorPagetitle =
    (anchorProduct.category?.pagetitle ?? null) ||
    anchorProduct.pagetitle ||
    anchorProduct.name ||
    '';

  // Step 3 — Resolve category (live API).
  // Если у anchor уже есть category.pagetitle — используем напрямую (это надёжнее
  // LLM-резолва, поскольку Catalog API уже сказал, в какой категории живёт товар).
  let pagetitle = anchorProduct.category?.pagetitle ?? '';
  if (!pagetitle) {
    // Fallback: идём через resolver по anchor.name/pagetitle.
    const resolverRes = await resolveCategory(
      {
        query: anchorProduct.pagetitle || anchorProduct.name || anchor.sku,
        intent: 'catalog',
        slot: null,
        traceId: `s-similar-${anchor.sku}`,
      },
      deps.resolver,
    );
    trace.resolverStatus = resolverRes.status;
    const resolved = resolverRes.pagetitle ?? resolverRes.candidates[0]?.pagetitle ?? '';
    if (
      (resolverRes.status !== 'resolved' && resolverRes.status !== 'ambiguous' && resolverRes.status !== 'skipped_slot') ||
      !resolved
    ) {
      trace.ms = now() - t0;
      return {
        status: 'error',
        disallowCrosssell: true,
        anchorProduct,
        products: [],
        trace,
        errorMessage: `category resolver failed for anchor: ${resolverRes.status}`,
      };
    }
    pagetitle = resolved;
  }
  trace.anchorPagetitle = pagetitle;

  // Step 4 — classify_traits (LLM tool call). Ровно один раз (INV-S1).
  let classified: ClassifyTraitsResult;
  try {
    const userMessage = buildClassifyUserMessage({
      anchorProduct,
      anchorPagetitle: pagetitle,
      userQuery: input.message,
    });
    const raw = await deps.callLLM({
      systemPrompt: CLASSIFY_TRAITS_SYSTEM_PROMPT,
      userMessage,
      tool: CLASSIFY_TRAITS_TOOL,
      toolChoice: CLASSIFY_TRAITS_TOOL_CHOICE,
    });
    trace.classifyTraitsCalls = 1;
    classified = deps.validateTraits(raw);
    trace.traits = classified.traits;
  } catch (err) {
    trace.classifyTraitsCalls = 1; // вызвали, но провалились
    trace.ms = now() - t0;
    return {
      status: 'error',
      disallowCrosssell: true,
      anchorProduct,
      products: [],
      pagetitle,
      trace,
      errorMessage: `classify_traits failed: ${(err as Error).message}`,
    };
  }

  // Step 5 — Partition traits.
  let { must, should, nice } = partitionTraits(classified.traits);

  // Step 6 — Search loop with degrade must→should (max 2 итерации).
  // Каждая итерация: matchFacets(must+should) → catalogSearch.
  // При empty/all_zero_price → понижаем младший must до should и повторяем.
  let lastOutcome: SearchOutcome | null = null;
  for (let iter = 0; iter <= MAX_DEGRADE_ITERATIONS; iter++) {
    const activeModifiers = traitsToModifiers([...must, ...should]);
    const facetMatch: FacetMatchResult = await matchFacets(
      { pagetitle, modifiers: activeModifiers },
      deps.facetMatcher,
    );

    // Применяем ТОЛЬКО must как hard filters; should остаётся как ranking-сигнал.
    const mustKeysSet = new Set(must.map((t) => `${t.key}|${t.value}`));
    const hardFilters: Record<string, string[]> = {};
    const hardAliases: Record<string, string[]> = {};
    for (const [canonicalKey, values] of Object.entries(facetMatch.optionFilters)) {
      const matchedHard = values.filter((v) => {
        // Проверяем, есть ли пара (canonicalKey, v) среди must.
        // facet-matcher нормализует значения, поэтому ищем мягко через includes.
        for (const mt of must) {
          if (
            normalizeLoose(mt.key) === normalizeLoose(canonicalKey) ||
            normalizeLoose(mt.value) === normalizeLoose(v)
          ) {
            return true;
          }
        }
        return mustKeysSet.has(`${canonicalKey}|${v}`);
      });
      if (matchedHard.length > 0) {
        hardFilters[canonicalKey] = matchedHard;
        if (facetMatch.optionAliases[canonicalKey]) {
          hardAliases[canonicalKey] = facetMatch.optionAliases[canonicalKey];
        }
      }
    }
    trace.appliedMustKeys = Object.keys(hardFilters);

    // catalogSearch ожидает FacetMatchResult-подобную структуру.
    // Передаём отфильтрованную "must-only" версию.
    const mustOnlyFacetMatch: FacetMatchResult = {
      ...facetMatch,
      optionFilters: hardFilters,
      optionAliases: hardAliases,
    };

    const outcome = await catalogSearch(
      {
        pagetitle,
        query: anchorProduct.pagetitle || anchorProduct.name || '',
        facetMatch: mustOnlyFacetMatch,
        // exclude anchor SKU из результатов — иначе вернётся сам якорь.
        excludeArticles: anchorProduct.article ? [anchorProduct.article] : [],
        perPage,
      } as never,
      deps.apiClient,
    );
    trace.searchAttempts += outcome.attempts?.length ?? 1;
    lastOutcome = outcome;

    const products = (outcome.products ?? []).filter(
      (p) => !anchorProduct.article || p.article !== anchorProduct.article,
    );

    if (products.length > 0) {
      // OK — есть кандидаты. Ranking: бонус за каждый matched should-trait.
      const ranked = rankBySoftTraits(products, should);
      trace.ms = now() - t0;
      return {
        status: 'ok',
        disallowCrosssell: true,
        anchorProduct,
        products: ranked.slice(0, SIMILAR_TOP_N),
        pagetitle,
        recommendationContext: buildRecommendationContext(anchorProduct, must, should, nice),
        trace,
      };
    }

    // Degrade: понижаем младший must до should и повторяем.
    if (must.length === 0 || iter === MAX_DEGRADE_ITERATIONS) break;
    const demoted = must[must.length - 1];
    must = must.slice(0, -1);
    should = [...should, { ...demoted, weight: 'should' }];
    trace.degradeIterations++;
  }

  // Все итерации исчерпаны без результата.
  trace.ms = now() - t0;
  if (lastOutcome?.status === 'all_zero_price') {
    return {
      status: 'all_zero_price',
      disallowCrosssell: true,
      anchorProduct,
      products: [],
      pagetitle,
      trace,
    };
  }
  return {
    status: 'empty',
    disallowCrosssell: true,
    anchorProduct,
    products: [],
    pagetitle,
    trace,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeLoose(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').trim();
}

function buildClassifyUserMessage(args: {
  anchorProduct: RawProduct;
  anchorPagetitle: string;
  userQuery: string;
}): string {
  const lines: string[] = [];
  lines.push(`Якорный товар: ${args.anchorProduct.pagetitle ?? args.anchorProduct.name ?? '—'}`);
  if (args.anchorProduct.vendor) lines.push(`Бренд: ${args.anchorProduct.vendor}`);
  if (args.anchorProduct.article) lines.push(`Артикул: ${args.anchorProduct.article}`);
  lines.push(`Категория: ${args.anchorPagetitle}`);
  lines.push('');
  lines.push(`Запрос пользователя: ${args.userQuery}`);
  return lines.join('\n');
}

/**
 * Ранжирование: каждый matched should-trait добавляет +0.10 к score.
 * Базовый score = 1.0. Стабильная сортировка (sort by index при равенстве).
 */
function rankBySoftTraits(products: RawProduct[], should: ClassifiedTrait[]): RawProduct[] {
  if (should.length === 0) return products;
  const scored = products.map((p, idx) => {
    let score = 1.0;
    const haystack = `${p.pagetitle ?? ''} ${p.name ?? ''} ${p.vendor ?? ''}`.toLowerCase();
    for (const s of should) {
      if (haystack.includes(s.value.toLowerCase())) score += 0.1;
    }
    return { p, score, idx };
  });
  scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
  return scored.map((s) => s.p);
}

/**
 * Короткий контекст для composer: «Подобрал по характеристикам X, Y, Z».
 * БЕЗ SKU, цен, ссылок — только перечень trait values (must + should + nice).
 * Composer вставит это одной строкой над карточками.
 */
function buildRecommendationContext(
  _anchor: RawProduct,
  must: ClassifiedTrait[],
  should: ClassifiedTrait[],
  nice: ClassifiedTrait[],
): string {
  const parts = [...must, ...should, ...nice].slice(0, 4).map((t) => t.value);
  if (parts.length === 0) return '';
  return `Подобрал по характеристикам: ${parts.join(', ')}.`;
}
