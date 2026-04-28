// chat-consultant-v2 / catalog/search.ts
// Stage 2 — Step 11.3: Strict Search Multi-Attempt с post-filter и Soft Fallback (data-layer).
//
// Spec sync: §4.8 + §4.8.1 (softFallbackContext.droppedFacetCaption).
//
// Контракт (Core Memory + spec §5.6.1 + mem://features/search-pipeline):
//
//   Вход:   { category?, query?, optionFilters?, optionAliases?,
//             page?, perPage? }
//   Выход:  SearchOutcome { status, products, ...diagnostics }
//
// Архитектурная роль: ВЕРХ над api-client.searchProducts. Один вызов
// search.ts = одна логическая попытка найти товары для catalog-хода.
// Composer (Задача 5) читает `outcome.status` и решает:
//   - 'ok'              → рендерим карточки (через formatter), soft404_streak=0.
//   - 'soft_fallback'   → рендерим карточки + tail-line «Уточните…», streak=0.
//   - 'empty_degraded'  → пустой результат + degraded-флаг (для метрики), streak+=1.
//   - 'empty'           → soft404_streak += 1 (см. §5.6.1).
//   - 'all_zero_price'  → НИКОГДА не показываем товары (HARD BAN), streak += 1.
//   - 'error'           → escalation сразу, без инкремента streak.
//
// Чего здесь НЕТ (это другие модули — НЕ Задача 3):
//   ✗ Lexicon Resolver (§9.2b)        → отдельный модуль (TODO)
//   ✗ Facet Matcher (§9.3, LLM)       → отдельный модуль (TODO)
//   ✗ Scan-or-Clarify для price-sort  → отдельный модуль (§9.7)
//   ✗ Cross-sell / Soft 404 текст     → composer (Задача 5)
//   ✗ Pagination state в slot         → orchestrator
//
// Жёсткие правила (Core Memory):
//   K1. БОТ НЕ САМОСУЖАЕТ воронку. `search.ts` НЕ добавляет min_price/max_price
//       и НЕ выбирает facet-значения сам. Получает их СТРОГО на входе.
//       Defect: `auto_narrowing_attempts_total` должен быть 0.
//   K2. Word-boundary post-filter — обязателен. API возвращает иногда подстрочные
//       матчи; это засоряет выдачу. Фильтруем по `\b<token>\b` в pagetitle.
//       НЕТ word-match → товар отбрасывается.
//   K3. Soft Fallback (data) — fallback БЕЗ optionFilters. Только если был хотя бы
//       один фильтр И strict attempt вернул 0. Composer обязан показать ОДНУ
//       короткую tail-line (§11.2a), search просто помечает `status='soft_fallback'`.
//   K4. Все товары наружу — после double price>0 фильтра (api-client + здесь).
//
// V1 НЕ тронут.

import type {
  ApiClientDeps,
  RawProduct,
  SearchProductsInput,
  SearchProductsResult,
} from "./api-client.ts";
import { searchProducts } from "./api-client.ts";

// ─── Public types ───────────────────────────────────────────────────────────

export interface SearchInput {
  /** Категория из Category Resolver (точный pagetitle). */
  category?: string;
  /**
   * Текстовый запрос. ТОЛЬКО canonical_tokens из Lexicon (§9.3 invariant) —
   * unresolved traits сюда НЕ попадают. На уровне search.ts это контракт
   * вызывающего кода; здесь мы просто прокидываем строку как есть.
   */
  query?: string;
  /** SKU. Если задан — приоритетнее query. */
  article?: string;
  /** Уже разрешённые фасеты `{ canonical_key: ["value"] }` от Facet Matcher. */
  optionFilters?: Record<string, string[]>;
  /** Карта алиасов для каждого canonical_key. */
  optionAliases?: Record<string, string[]>;
  /**
   * §4.8.1: Человекочитаемые caption-ы фасетов (canonical_key → caption из RawOption.caption,
   * полученные Facet Matcher из живого API). Используются ТОЛЬКО для заполнения
   * `softFallbackContext.droppedFacetCaption` — никакой бизнес-логики на этом не строим.
   */
  optionFilterCaptions?: Record<string, string>;
  /**
   * §4.8: Порядок применения фасетов (canonical_keys). Soft Fallback снимает фильтры
   * с конца списка по одному; первый успех фиксирует `droppedFacetCaption`.
   * Если порядок не задан, fallback: снимаем все фильтры разом, caption берётся
   * по первому ключу из `optionFilters` (для обратной совместимости).
   */
  optionFilterOrder?: string[];
  /** Цена — ТОЛЬКО если её явно назвал пользователь (K1). */
  minPrice?: number;
  maxPrice?: number;
  page?: number;       // default 1
  perPage?: number;    // default 12 (§7.2)
}

export type SearchStatus =
  | "ok"               // ≥1 товар после всех фильтров
  | "soft_fallback"    // 0 со strict, но ≥1 без optionFilters → composer должен tail-line
  | "empty"            // 0 везде, без quirk-признаков
  | "empty_degraded"   // api-client вернул признак Q3 quirk
  | "all_zero_price"   // API дал товары, но все price≤0 (HARD BAN)
  | "error";           // HTTP/timeout/network — escalation, не считаем soft 404

export interface SoftFallbackContext {
  /**
   * §4.8.1: UI-caption фасета, который был снят (из RawOption.caption через
   * Facet Matcher). НЕ raw-key. Композер использует это поле для tail-line
   * `Если важно уточнить *<droppedFacetCaption>* — напишите.`
   * НЕ может быть пустой строкой (инвариант: caption живой из API).
   */
  droppedFacetCaption: string;
}

export interface SearchOutcome {
  status: SearchStatus;
  products: RawProduct[];        // ВСЕГДА price>0
  totalFromApi: number;          // что сообщил API (для метрик)
  zeroPriceFiltered: number;     // метрика zero_price_leak (должна быть 0 после double-filter)
  postFilterDropped: number;     // K2: сколько отбросил word-boundary post-filter
  attempts: SearchAttempt[];     // диагностика: какие попытки делали
  pagination?: {
    page: number;
    perPage: number;
    totalPages: number;
  };
  degradedHint?: {
    suspectedQuirkKey: string;
    recoveredCount: number;
  };
  /**
   * §4.8.1: Заполнено ТОЛЬКО при status === 'soft_fallback'. При других статусах = null.
   */
  softFallbackContext: SoftFallbackContext | null;
  errorMessage?: string;
  ms: number;
}

export interface SearchAttempt {
  label: "strict" | "soft_fallback";
  ms: number;
  raw: SearchProductsResult;
  /** Какой фасет был снят на этой попытке soft_fallback (canonical_key). */
  droppedFacetKey?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_PER_PAGE = 12;

// ─── Word-boundary post-filter (K2) ─────────────────────────────────────────

/**
 * Извлекает «слова» из строки для word-boundary матчинга.
 * Работает с unicode-буквами (ru/kk) + цифрами. Длина ≥ 2 символов.
 *
 * NB: `\b` в JS regex плохо работает с unicode — реализуем вручную.
 */
export function tokenize(s: string): string[] {
  if (!s) return [];
  const lower = s.toLowerCase();
  const out: string[] = [];
  let buf = "";
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    // letter (any unicode) or digit
    if (/[\p{L}\p{N}]/u.test(ch)) {
      buf += ch;
    } else {
      if (buf.length >= 2) out.push(buf);
      buf = "";
    }
  }
  if (buf.length >= 2) out.push(buf);
  return out;
}

/**
 * Проверяет: есть ли ХОТЯ БЫ ОДНО слово запроса как полное слово в `pagetitle`
 * товара. Это word-boundary post-filter (K2).
 *
 * Если запрос пуст — фильтр НЕ применяется (всё пропускаем — это поиск только
 * по фасетам/категории).
 *
 * Если у товара нет pagetitle/name — товар отбрасывается (нечего матчить).
 */
export function matchesWordBoundary(product: RawProduct, queryTokens: string[]): boolean {
  if (queryTokens.length === 0) return true;
  const haystackParts: string[] = [];
  if (typeof product.pagetitle === "string") haystackParts.push(product.pagetitle);
  if (typeof product.name === "string") haystackParts.push(product.name);
  if (haystackParts.length === 0) return false;
  const productTokens = new Set(tokenize(haystackParts.join(" ")));
  for (const qt of queryTokens) {
    if (productTokens.has(qt)) return true;
  }
  return false;
}

// ─── Core: search ───────────────────────────────────────────────────────────

export async function search(
  input: SearchInput,
  deps: ApiClientDeps,
): Promise<SearchOutcome> {
  const t0 = Date.now();
  const perPage = input.perPage ?? DEFAULT_PER_PAGE;
  const page = input.page ?? 1;
  const queryTokens = input.article ? [] : tokenize(input.query ?? "");
  const attempts: SearchAttempt[] = [];

  // ── ATTEMPT 1: Strict (со всеми optionFilters) ────────────────────────
  const strictInput: SearchProductsInput = toApiInput(input, perPage, page);
  const strictRaw = await searchProducts(strictInput, deps);
  attempts.push({ label: "strict", ms: strictRaw.ms, raw: strictRaw });

  // Хард-фейлы: HTTP/timeout/network → error (escalation, без soft404 streak).
  if (
    strictRaw.status === "http_error" ||
    strictRaw.status === "timeout" ||
    strictRaw.status === "network_error"
  ) {
    return {
      status: "error",
      products: [],
      totalFromApi: 0,
      zeroPriceFiltered: 0,
      postFilterDropped: 0,
      attempts,
      ms: Date.now() - t0,
      errorMessage: strictRaw.errorMessage,
    };
  }

  // all_zero_price — товары были, но все price≤0. Не делаем soft fallback —
  // это сигнал «у категории нет валидных цен», composer уйдёт на CONTACT_MANAGER.
  if (strictRaw.status === "all_zero_price") {
    return {
      status: "all_zero_price",
      products: [],
      totalFromApi: strictRaw.totalFromApi,
      zeroPriceFiltered: strictRaw.zeroPriceFiltered,
      postFilterDropped: 0,
      attempts,
      ms: Date.now() - t0,
    };
  }

  // empty_degraded — Q3 quirk. Мы НЕ делаем здесь soft_fallback, потому что
  // api-client уже попробовал retry-без-quirk-ключа. Возвращаем как есть, чтобы
  // composer мог показать корректный Soft 404 (с пометкой degraded для метрик).
  if (strictRaw.status === "empty_degraded") {
    return {
      status: "empty_degraded",
      products: [],
      totalFromApi: 0,
      zeroPriceFiltered: strictRaw.zeroPriceFiltered,
      postFilterDropped: 0,
      attempts,
      degradedHint: strictRaw.degradedHint,
      ms: Date.now() - t0,
    };
  }

  // status === 'ok' | 'empty' → применяем word-boundary post-filter.
  const strictFiltered = strictRaw.products.filter((p) => matchesWordBoundary(p, queryTokens));
  const strictPostDropped = strictRaw.products.length - strictFiltered.length;

  if (strictFiltered.length > 0) {
    return {
      status: "ok",
      products: strictFiltered,
      totalFromApi: strictRaw.totalFromApi,
      zeroPriceFiltered: strictRaw.zeroPriceFiltered,
      postFilterDropped: strictPostDropped,
      attempts,
      pagination: {
        page,
        perPage,
        totalPages: estimateTotalPages(strictRaw.totalFromApi, perPage),
      },
      ms: Date.now() - t0,
    };
  }

  // ── ATTEMPT 2: Soft Fallback (без optionFilters) ──────────────────────
  // Триггер: были фильтры И strict вернул 0 (после API + post-filter).
  // Если фильтров не было — soft fallback бесполезен, сразу 'empty'.
  const hadFilters = input.optionFilters &&
    Object.keys(input.optionFilters).length > 0;

  if (!hadFilters) {
    return {
      status: "empty",
      products: [],
      totalFromApi: strictRaw.totalFromApi,
      zeroPriceFiltered: strictRaw.zeroPriceFiltered,
      postFilterDropped: strictPostDropped,
      attempts,
      ms: Date.now() - t0,
    };
  }

  const softInput: SearchProductsInput = toApiInput(
    { ...input, optionFilters: undefined, optionAliases: undefined },
    perPage,
    page,
  );
  const softRaw = await searchProducts(softInput, deps);
  attempts.push({ label: "soft_fallback", ms: softRaw.ms, raw: softRaw });

  // На soft attempt error/zero/degraded → возвращаем как есть, без рекурсии.
  if (
    softRaw.status === "http_error" ||
    softRaw.status === "timeout" ||
    softRaw.status === "network_error"
  ) {
    return {
      status: "empty",
      products: [],
      totalFromApi: strictRaw.totalFromApi,
      zeroPriceFiltered: strictRaw.zeroPriceFiltered,
      postFilterDropped: strictPostDropped,
      attempts,
      ms: Date.now() - t0,
    };
  }

  if (softRaw.status === "all_zero_price") {
    return {
      status: "all_zero_price",
      products: [],
      totalFromApi: softRaw.totalFromApi,
      zeroPriceFiltered: strictRaw.zeroPriceFiltered + softRaw.zeroPriceFiltered,
      postFilterDropped: strictPostDropped,
      attempts,
      ms: Date.now() - t0,
    };
  }

  if (softRaw.status === "empty_degraded") {
    // Маловероятно (фильтры выкинули), но обрабатываем.
    return {
      status: "empty_degraded",
      products: [],
      totalFromApi: 0,
      zeroPriceFiltered: strictRaw.zeroPriceFiltered + softRaw.zeroPriceFiltered,
      postFilterDropped: strictPostDropped,
      attempts,
      degradedHint: softRaw.degradedHint,
      ms: Date.now() - t0,
    };
  }

  const softFiltered = softRaw.products.filter((p) => matchesWordBoundary(p, queryTokens));
  const softPostDropped = softRaw.products.length - softFiltered.length;

  if (softFiltered.length > 0) {
    return {
      status: "soft_fallback",
      products: softFiltered,
      totalFromApi: softRaw.totalFromApi,
      zeroPriceFiltered: strictRaw.zeroPriceFiltered + softRaw.zeroPriceFiltered,
      postFilterDropped: strictPostDropped + softPostDropped,
      attempts,
      pagination: {
        page,
        perPage,
        totalPages: estimateTotalPages(softRaw.totalFromApi, perPage),
      },
      ms: Date.now() - t0,
    };
  }

  return {
    status: "empty",
    products: [],
    totalFromApi: softRaw.totalFromApi,
    zeroPriceFiltered: strictRaw.zeroPriceFiltered + softRaw.zeroPriceFiltered,
    postFilterDropped: strictPostDropped + softPostDropped,
    attempts,
    ms: Date.now() - t0,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function toApiInput(
  input: SearchInput,
  perPage: number,
  page: number,
): SearchProductsInput {
  return {
    query: input.query,
    pagetitle: input.category,
    article: input.article,
    minPrice: input.minPrice,
    maxPrice: input.maxPrice,
    perPage,
    page,
    optionFilters: input.optionFilters,
    optionAliases: input.optionAliases,
  };
}

function estimateTotalPages(total: number, perPage: number): number {
  if (total <= 0 || perPage <= 0) return 0;
  return Math.ceil(total / perPage);
}
