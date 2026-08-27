// V3 tool: search_catalog — minimal 220volt /products wrapper.
// Data-agnostic: baseUrl + apiToken injected from caller.

import type { ProductCache, ProductRef, SearchCatalogOk, ToolError } from "./types.ts";
import { canonicalizeCompoundMarkingForCatalog } from "./exact-compound-marking-policy.ts";

const PRODUCT_DESCRIPTION_MAX_CHARS = 1_200;

/**
 * Каталожное описание приходит как HTML. В модель передаём только короткий
 * плоский текст: без тегов, скриптов, управляющих символов и невидимого мусора.
 */
export function sanitizeCatalogDescription(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const decoded = raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;|&#34;/giu, '"')
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/\s+([.,;:!?])/gu, "$1")
    .trim();
  return decoded ? decoded.slice(0, PRODUCT_DESCRIPTION_MAX_CHARS) : null;
}

/**
 * Товарная ссылка должна вести на глубокую карточку контролируемого домена.
 * Категории (/catalog/<section>/<category>/) и внешние URL отбрасываются.
 */
export function normalizeProductUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = new URL(raw.trim(), "https://220volt.kz");
    if (parsed.protocol !== "https:") return null;
    const host = parsed.hostname.toLowerCase().replace(/^www\./u, "");
    if (host !== "220volt.kz") return null;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments[0] !== "catalog" || segments.length < 4) return null;
    parsed.hostname = "220volt.kz";
    parsed.search = "";
    parsed.hash = "";
    // Markdown destinations and lightweight SSE consumers commonly treat a
    // literal ')' as the end of a link. Product slugs may legitimately contain
    // packaging markers such as "(305m)"; encode both parentheses so the
    // controlled deep link remains one unambiguous URL in every client.
    parsed.pathname = parsed.pathname.replace(/\(/g, "%28").replace(/\)/g, "%29");
    if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
    return parsed.toString();
  } catch {
    return null;
  }
}

export interface CatalogClientDeps {
  baseUrl: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface SearchCatalogInput {
  mode: "by_article" | "by_pagetitle" | "by_query" | "by_filter";
  article?: string;
  pagetitle?: string;
  query?: string;
  /**
   * Одна категория. Должна совпадать с pagetitle ЛИСТОВОЙ категории
   * (из discover_category.leaf_categories[].pagetitle).
   * Параметр `category=` в API 220volt матчит pagetitle непосредственного родителя
   * товара, т.е. лист. Зонтичные категории всегда дают 0.
   */
  category?: string;
  /**
   * Массив листовых pagetitle. Используется, когда discover_category вернул несколько
   * листьев. Выполняется параллельный fan-out (N HTTP-вызовов), результаты мерджатся
   * с дедупликацией по id.
   */
  category_in?: string[];
  min_price?: number;
  max_price?: number;
  options?: Record<string, string[]>;
  page?: number;
  per_page?: number;
  sort_cheapest?: boolean;
  sort_expensive?: boolean;
  /**
   * L₀ — листовая категория ЯКОРЯ для режима «аналог» (берётся из anchor.leaf_category).
   * Если задана и отсутствует в category/category_in — сервер автоматически инжектирует её
   * и возвращает warning. Защита от случая, когда LLM «забыл» L₀ или discover_category
   * не вернул L₀ среди leaf_categories.
   */
  anchor_leaf_category?: string;
}

function extractWarehouses(p: Record<string, unknown>): Array<{ city: string; qty: number }> {
  const wh = p.warehouses as Array<{ city?: unknown; amount?: unknown; qty?: unknown }> | undefined;
  if (!Array.isArray(wh)) return [];
  const out: Array<{ city: string; qty: number }> = [];
  for (const w of wh) {
    const city = typeof w?.city === "string" ? w.city.trim() : "";
    // API 220volt отдаёт `amount`; на всякий случай поддерживаем и `qty`.
    const qtyRaw = typeof w?.amount === "number" ? w.amount
      : typeof w?.qty === "number" ? w.qty
      : 0;
    if (!city || !Number.isFinite(qtyRaw) || qtyRaw <= 0) continue;
    out.push({ city, qty: qtyRaw });
  }
  out.sort((a, b) => b.qty - a.qty);
  return out;
}

function inferStock(p: Record<string, unknown>): ProductRef["stock"] {
  // 220volt: warehouses часто отсутствует/пуст для активных товаров.
  // Если API вернул карточку — считаем доступной, пока явно не сказано обратное.
  const wh = p.warehouses as Array<{ qty?: number | null; amount?: number | null }> | undefined;
  if (!Array.isArray(wh) || wh.length === 0) return "in_stock";
  const total = wh.reduce((s, w) => {
    const q = typeof w?.amount === "number" ? w.amount : (typeof w?.qty === "number" ? w.qty : 0);
    return s + (Number.isFinite(q) ? q : 0);
  }, 0);
  if (total <= 0) return "in_stock"; // не блокируем рендер: товар активен, наличие уточняется при заказе
  if (total < 3) return "low";
  return "in_stock";
}

function extractTraits(p: Record<string, unknown>): string[] {
  // Возвращаем ВСЕ характеристики (без лимита 5) — нужны для spec_query/compare,
  // чтобы LLM мог ответить на любой атрибут карточки. Фильтруем только пустые
  // и аномально длинные строки (шум/HTML).
  const opts = p.options as Array<{ caption_ru?: string; value_ru?: string }> | undefined;
  if (!Array.isArray(opts)) return [];
  const out: string[] = [];
  for (const o of opts) {
    const cap = o?.caption_ru?.trim();
    const val = o?.value_ru?.trim();
    if (!cap || !val) continue;
    const line = `${cap}: ${val}`;
    if (line.length > 160) continue;
    out.push(line);
  }
  return out;
}

/**
 * Единица измерения товара — обычная характеристика каталога («Единица измерения»).
 * Сопоставление нормализованное, по подписи ИЛИ ключу характеристики: никаких словарей
 * товаров/категорий, работает одинаково для любой категории. Нет характеристики → null.
 */
export function extractUnit(p: Record<string, unknown>): string | null {
  const opts = p.options as Array<{ key?: unknown; caption_ru?: unknown; value_ru?: unknown }> | undefined;
  if (!Array.isArray(opts)) return null;
  for (const o of opts) {
    const cap = String(o?.caption_ru ?? "").toLowerCase().replace(/ё/g, "е").trim();
    const key = String(o?.key ?? "").toLowerCase();
    const isUnit = cap.startsWith("единица измерения") || key.startsWith("edinica_izmereniya");
    if (!isUnit) continue;
    const val = typeof o?.value_ru === "string" ? o.value_ru.trim() : String(o?.value_ru ?? "").trim();
    if (!val || val.length > 12) continue;
    return val;
  }
  return null;
}

/**
 * Достаём pagetitle листовой категории товара из любого варианта формы ответа /products.
 * Поддерживаем: raw.category (строка), raw.category.pagetitle, raw.categories[0].pagetitle.
 * Data-agnostic — никаких хардкодов.
 */
function extractLeafCategory(p: Record<string, unknown>): string | null {
  const c = p.category;
  if (typeof c === "string" && c.trim()) return c.trim();
  if (c && typeof c === "object") {
    const pt = (c as Record<string, unknown>).pagetitle;
    if (typeof pt === "string" && pt.trim()) return pt.trim();
  }
  const cs = p.categories;
  if (Array.isArray(cs) && cs.length > 0) {
    const first = cs[0] as Record<string, unknown> | string | undefined;
    if (typeof first === "string" && first.trim()) return first.trim();
    if (first && typeof first === "object") {
      const pt = (first as Record<string, unknown>).pagetitle;
      if (typeof pt === "string" && pt.trim()) return pt.trim();
    }
  }
  return null;
}

/**
 * Бренд карточки. Источник — ТОЛЬКО options[brend__brend].
 * Топ-левел поле `vendor` из 220volt API — это производитель (например,
 * "Ningbo Innovation Electronic Company Limited" у ламп IEK), а не бренд,
 * поэтому fallback на него давал неверные данные. Если бренд в options не
 * пришёл — возвращаем null и просто не показываем строку «Бренд».
 * Отбрасываем значения, похожие на маркировку серии/кабеля (ВВГ, ПВС, ...).
 * Data-agnostic: без словарей брендов/серий.
 */
function looksLikeMarking(s: string): boolean {
  const v = (s || "").trim();
  if (!v || v.length > 10) return false;
  return /^[А-ЯЁ]{2,6}(нг)?[\s\d.,*хХx/-]{0,8}$/u.test(v);
}

function extractBrand(p: Record<string, unknown>): string | null {
  const opts = p.options;
  if (Array.isArray(opts)) {
    for (const o of opts as Array<Record<string, unknown>>) {
      if (o && (o.key === "brend__brend" || (typeof o.key === "string" && o.key.startsWith("brend__")))) {
        const raw = o.value_ru ?? o.value;
        const v = typeof raw === "string" ? raw.trim() : "";
        if (v && !looksLikeMarking(v)) return v;
      }
    }
  }
  return null;
}

type SingleSearchResult =
  | { ok: true; total: number; results: ProductRef[] }
  | { ok: false; error_code: ToolError["error_code"]; message: string };

/** Один HTTP-вызов /products. Применяет input как есть, плюс опциональный single `category` override. */
async function singleSearch(
  input: SearchCatalogInput,
  deps: CatalogClientDeps,
  cache: ProductCache,
  categoryOverride?: string,
): Promise<SingleSearchResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 8000;

  const params = new URLSearchParams();
  if (input.mode === "by_article" && input.article) params.append("article", input.article);
  else if (input.mode === "by_pagetitle" && input.pagetitle) params.append("pagetitle", input.pagetitle);
  else if (input.mode === "by_query" && input.query) params.append("query", input.query);

  const cat = categoryOverride ?? input.category;
  if (cat) params.append("category", cat);
  if (typeof input.min_price === "number") params.append("min_price", String(input.min_price));
  if (typeof input.max_price === "number") params.append("max_price", String(input.max_price));
  if (input.sort_cheapest || input.sort_expensive) {
    // min_price=1 отсекает мусорные карточки price=0, которые ломают сортировку с обоих концов.
    if (!params.has("min_price")) params.append("min_price", "1");
  }
  const perPage = Math.min(Math.max(input.per_page ?? 10, 1), 50);
  params.append("per_page", String(perPage));
  if (input.page && input.page > 1) params.append("page", String(input.page));

  if (input.options) {
    for (const [key, vals] of Object.entries(input.options)) {
      for (const v of vals) params.append(`options[${key}][]`, v);
    }
  }

  const url = `${deps.baseUrl}/products?${params}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${deps.apiToken}`, "Content-Type": "application/json" },
      signal: controller.signal,
    });

    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 429) return { ok: false, error_code: "rate_limited", message: `429 from catalog` };
      if (res.status >= 500) return { ok: false, error_code: "transport_5xx", message: `${res.status}` };
      return { ok: false, error_code: "bad_input", message: `${res.status}` };
    }

    const json = await res.json() as { data?: { results?: unknown[]; pagination?: { total?: number } } };
    const rawResults = Array.isArray(json?.data?.results) ? json.data!.results! : [];
    const total = Number(json?.data?.pagination?.total ?? rawResults.length) || 0;

    const results: ProductRef[] = [];
    for (const raw of rawResults as Array<Record<string, unknown>>) {
      const price = Number(raw.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      const id = String(raw.id ?? "");
      if (!id) continue;
      const pagetitle = String(raw.pagetitle ?? raw.name ?? "").trim();
      if (!pagetitle) continue;
      const u = normalizeProductUrl(raw.url);
      if (!u) continue;
      const vendor = extractBrand(raw);
      const warehouses = extractWarehouses(raw);
      const descriptionExcerpt = sanitizeCatalogDescription(raw.content);
      const article = typeof raw.article === "string" && raw.article.trim()
        ? raw.article.trim().slice(0, 120)
        : null;
      const ref: ProductRef = {
        id, pagetitle, vendor, price,
        article,
        unit: extractUnit(raw),
        stock: inferStock(raw),
        short_traits: extractTraits(raw),
        description_excerpt: descriptionExcerpt,
        // A product returned by an exact category-filtered request has that
        // category as verified query provenance even when the API omits the
        // redundant category object in the product payload. Preserve this
        // lineage for later class gates instead of treating it as unknown.
        leaf_category: extractLeafCategory(raw) ?? categoryOverride ?? null,
        ...(warehouses.length > 0 ? { warehouses } : {}),
      };
      cache.set(id, { ...ref, url: u });
      results.push(ref);
    }
    return { ok: true, total, results };
  } catch (e) {
    const isAbort = (e as { name?: string })?.name === "AbortError";
    return { ok: false, error_code: isAbort ? "catalog_timeout" : "transport_5xx", message: (e as Error)?.message ?? "fetch failed" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sort-aware fetch: API 220volt не поддерживает sort. Когда нужна сортировка по цене
 * (sort_cheapest=true или sort_expensive=true), тянем до MAX_SORT_FETCH товаров
 * (fan-out по страницам с per_page=50), сортируем на нашей стороне и обрезаем до
 * запрошенного per_page. `total` сохраняем честный — из первого ответа API. Если в
 * категории больше MAX_SORT_FETCH товаров — добавляем warning sort_truncated.
 */
const SORT_PAGE_SIZE = 50;
const MAX_SORT_FETCH = 200; // 4 страницы × 50 — потолок защиты от тяжёлых категорий
const MAX_OPTION_ALTERNATIVE_REQUESTS = 24;

/**
 * The upstream pagination total counts raw rows, while the tool contract only
 * exposes cards that can actually be rendered (positive price, stable id/title
 * and a controlled deep link). A page can therefore report `total > 0` and
 * still materialise zero products. Treating that as a successful pool makes
 * the agent loop over empty render calls.
 *
 * On that mismatch, scan a bounded 200-row window. If a later page contains
 * usable cards, return them with the upstream total. If the whole window is
 * unusable, expose total=0 so the ordinary query/category recovery can run.
 */
async function recoverUnmaterializedCatalogWindow(
  input: SearchCatalogInput,
  primary: Extract<SingleSearchResult, { ok: true }>,
  deps: CatalogClientDeps,
  cache: ProductCache,
  categoryOverride: string | undefined,
  warnings: string[],
): Promise<SingleSearchResult> {
  if (primary.total <= 0 || primary.results.length > 0) return primary;

  const requestedPerPage = Math.min(Math.max(input.per_page ?? 10, 1), 50);
  const pagesToScan = Math.max(1, Math.ceil(Math.min(primary.total, MAX_SORT_FETCH) / SORT_PAGE_SIZE));
  const recoveredById = new Map<string, ProductRef>();

  // Use a stable 50-row page size for the recovery window. Requests are
  // sequential and stop on the first page with usable cards, so a malformed
  // category cannot create an unbounded fan-out or add avoidable latency.
  for (let page = 1; page <= pagesToScan && recoveredById.size === 0; page++) {
    const candidatePage = await singleSearch(
      { ...input, per_page: SORT_PAGE_SIZE, page },
      deps,
      cache,
      categoryOverride,
    );
    if (!candidatePage.ok) {
      if (candidatePage.error_code === "rate_limited") break;
      continue;
    }
    for (const product of candidatePage.results) {
      if (!recoveredById.has(product.id)) recoveredById.set(product.id, product);
    }
  }

  const recovered = [...recoveredById.values()].slice(0, requestedPerPage);
  if (recovered.length > 0) {
    warnings.push(`catalog_materialization_recovered:${recovered.length}/${primary.total}`);
    return { ok: true, total: primary.total, results: recovered };
  }

  warnings.push(`catalog_unmaterialized_total:${primary.total}`);
  return { ok: true, total: 0, results: [] };
}

/**
 * The catalog endpoint does not reliably implement OR for repeated
 * `options[key][]` values: an exact range compiled from live facet values can
 * return zero although every individual value exists. Compile OR-within-a-
 * facet / AND-between-facets into exact request variants. The expansion is
 * deliberately bounded; oversized model requests keep the legacy aggregate
 * form instead of causing an unbounded network fan-out.
 */
export function expandOptionAlternatives(input: SearchCatalogInput): SearchCatalogInput[] {
  const entries = Object.entries(input.options ?? {})
    .map(([key, values]) => [key, [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))]] as const)
    .filter(([, values]) => values.length > 0);
  if (entries.length === 0 || entries.every(([, values]) => values.length === 1)) return [input];
  const combinations = entries.reduce((count, [, values]) => count * values.length, 1);
  if (!Number.isFinite(combinations) || combinations <= 1 || combinations > MAX_OPTION_ALTERNATIVE_REQUESTS) {
    return [input];
  }
  let variants: Array<Record<string, string[]>> = [{}];
  for (const [key, values] of entries) {
    variants = variants.flatMap((variant) => values.map((value) => ({ ...variant, [key]: [value] })));
  }
  return variants.map((options) => ({ ...input, options }));
}

async function singleSearchSorted(
  input: SearchCatalogInput,
  deps: CatalogClientDeps,
  cache: ProductCache,
  categoryOverride: string | undefined,
  warnings: string[],
): Promise<SingleSearchResult> {
  if (!input.sort_cheapest && !input.sort_expensive) {
    const primary = await singleSearch(input, deps, cache, categoryOverride);
    if (!primary.ok) return primary;
    return recoverUnmaterializedCatalogWindow(
      input,
      primary,
      deps,
      cache,
      categoryOverride,
      warnings,
    );
  }
  const requestedPerPage = Math.min(Math.max(input.per_page ?? 10, 1), 50);
  // Первая страница — узнаём total.
  const first = await singleSearch(
    { ...input, per_page: SORT_PAGE_SIZE, page: 1 },
    deps,
    cache,
    categoryOverride,
  );
  if (!first.ok) return first;
  const all: ProductRef[] = [...first.results];
  const totalApi = first.total;
  const cap = Math.min(totalApi, MAX_SORT_FETCH);
  const pagesNeeded = Math.ceil(cap / SORT_PAGE_SIZE);
  if (pagesNeeded > 1) {
    const extra = await Promise.all(
      Array.from({ length: pagesNeeded - 1 }, (_, i) =>
        singleSearch({ ...input, per_page: SORT_PAGE_SIZE, page: i + 2 }, deps, cache, categoryOverride),
      ),
    );
    for (const r of extra) {
      if (r.ok) all.push(...r.results);
    }
  }
  // Дедуп по id (на случай если API повторит товар на стыке страниц).
  const byId = new Map<string, ProductRef>();
  for (const p of all) if (!byId.has(p.id)) byId.set(p.id, p);
  const cmp = input.sort_expensive
    ? (a: ProductRef, b: ProductRef) => b.price - a.price
    : (a: ProductRef, b: ProductRef) => a.price - b.price;
  const sorted = [...byId.values()].sort(cmp);
  if (totalApi > MAX_SORT_FETCH) {
    warnings.push(`sort_truncated:${totalApi}>${MAX_SORT_FETCH}`);
  }
  if (totalApi > 0 && sorted.length === 0) {
    warnings.push(`catalog_unmaterialized_total:${totalApi}`);
    return { ok: true, total: 0, results: [] };
  }
  return { ok: true, total: totalApi, results: sorted.slice(0, requestedPerPage) };
}

async function singleSearchSortedWithCompoundFallback(
  input: SearchCatalogInput,
  deps: CatalogClientDeps,
  cache: ProductCache,
  categoryOverride: string | undefined,
  warnings: string[],
): Promise<SingleSearchResult> {
  const primary = await singleSearchSorted(input, deps, cache, categoryOverride, warnings);
  if (
    !primary.ok ||
    primary.total > 0 ||
    input.mode !== "by_query" ||
    typeof input.query !== "string"
  ) return primary;

  const canonicalQuery = canonicalizeCompoundMarkingForCatalog(input.query);
  if (canonicalQuery === input.query) return primary;

  const retry = await singleSearchSorted(
    { ...input, query: canonicalQuery },
    deps,
    cache,
    categoryOverride,
    warnings,
  );
  if (!retry.ok || retry.total <= 0) return primary;
  if (!warnings.includes("compound_query_variant_retry")) {
    warnings.push("compound_query_variant_retry");
  }
  return retry;
}

async function searchWithRateLimitRetry(
  input: SearchCatalogInput,
  deps: CatalogClientDeps,
  cache: ProductCache,
  categoryOverride: string | undefined,
  warnings: string[],
): Promise<SingleSearchResult> {
  let result = await singleSearchSortedWithCompoundFallback(input, deps, cache, categoryOverride, warnings);
  for (let attempt = 1; !result.ok && result.error_code === "rate_limited" && attempt <= 2; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    result = await singleSearchSortedWithCompoundFallback(input, deps, cache, categoryOverride, warnings);
    if (result.ok && !warnings.includes("rate_limit_retry_recovered")) warnings.push("rate_limit_retry_recovered");
  }
  return result;
}

export async function executeSearchCatalog(
  input: SearchCatalogInput,
  deps: CatalogClientDeps,
  cache: ProductCache,
): Promise<(SearchCatalogOk & { tool: "search_catalog" }) | (ToolError & { tool: "search_catalog" })> {
  // Валидация режима.
  if (input.mode === "by_article" && !input.article) return { tool: "search_catalog", ok: false, error_code: "bad_input", message: "by_article requires article" };
  if (input.mode === "by_pagetitle" && !input.pagetitle) return { tool: "search_catalog", ok: false, error_code: "bad_input", message: "by_pagetitle requires pagetitle" };
  if (input.mode === "by_query" && !input.query) return { tool: "search_catalog", ok: false, error_code: "bad_input", message: "by_query requires query" };
  if (input.mode === "by_filter") {
    const hasCat = !!input.category || (Array.isArray(input.category_in) && input.category_in.length > 0);
    const hasOpts = input.options && Object.keys(input.options).length > 0;
    if (!hasCat && !hasOpts) {
      return { tool: "search_catalog", ok: false, error_code: "incomplete_filter", message: "by_filter requires category/category_in or options" };
    }
  } else if (input.mode !== "by_article" && input.mode !== "by_pagetitle" && input.mode !== "by_query") {
    return { tool: "search_catalog", ok: false, error_code: "bad_input", message: "missing field for mode" };
  }

  // Нормализуем category_in: убираем дубли с input.category и между собой.
  const categories: string[] = [];
  const seenCat = new Set<string>();
  if (input.category) { categories.push(input.category); seenCat.add(input.category); }
  if (Array.isArray(input.category_in)) {
    for (const c of input.category_in) {
      if (typeof c === "string" && c && !seenCat.has(c)) { categories.push(c); seenCat.add(c); }
    }
  }

  // ANCHOR-L₀ INCONSISTENCY GUARD: если задан anchor_leaf_category и его нет в category_in —
  // инжектируем (как ПЕРВУЮ категорию) и помечаем warning'ом. Без хардкодов: работает на любую категорию.
  const warnings: string[] = [];
  if (input.mode === "by_filter" && typeof input.anchor_leaf_category === "string" && input.anchor_leaf_category.trim()) {
    const anchorCat = input.anchor_leaf_category.trim();
    if (!seenCat.has(anchorCat)) {
      categories.unshift(anchorCat);
      seenCat.add(anchorCat);
      warnings.push(`anchor_leaf_category_injected:${anchorCat}`);
    }
  }

  const optionVariants = input.mode === "by_filter" ? expandOptionAlternatives(input) : [input];
  if (optionVariants.length > 1) warnings.push(`option_alternatives_fanout:${optionVariants.length}`);

  // Один запрос: нет ни category fan-out, ни OR-альтернатив фасета.
  if (categories.length <= 1 && optionVariants.length === 1) {
    const r = await searchWithRateLimitRetry(optionVariants[0], deps, cache, categories[0], warnings);
    if (!r.ok) return { tool: "search_catalog", ok: false, error_code: r.error_code, message: r.message };
    return { tool: "search_catalog", ok: true, mode: input.mode, total: r.total, results: r.results, ...(warnings.length ? { warnings } : {}) };
  }

  // Fan-out: Cartesian product of leaf categories and exact option variants.
  // Each request keeps AND between different facets; merged requests implement
  // OR between accepted values of the same facet.
  const categoryVariants = categories.length > 0 ? categories : [undefined];
  const settled: SingleSearchResult[] = [];
  if (optionVariants.length > 1) {
    // Exact alternatives are intentionally executed one variant at a time.
    // Bursting a dozen live values at once causes catalog 429 responses and a
    // false empty result. Stop once enough unique cards are collected for the
    // requested page; all completed variants remain exact evidence.
    const collected = new Set<string>();
    const requestedPerPage = Math.min(Math.max(input.per_page ?? 10, 1), 50);
    for (const variant of optionVariants) {
      const batch = await Promise.all(categoryVariants.map((cat) =>
        searchWithRateLimitRetry(variant, deps, cache, cat, warnings)
      ));
      settled.push(...batch);
      for (const result of batch) {
        if (result.ok) result.results.forEach((product) => collected.add(product.id));
      }
      if (collected.size >= requestedPerPage) break;
    }
  } else {
    settled.push(...await Promise.all(
      categoryVariants.map((cat) => searchWithRateLimitRetry(optionVariants[0], deps, cache, cat, warnings)),
    ));
  }
  const okResults = settled.filter((r): r is Extract<SingleSearchResult, { ok: true }> => r.ok);
  if (okResults.length === 0) {
    // Все упали — возвращаем первую ошибку.
    const firstErr = settled.find((r): r is Extract<SingleSearchResult, { ok: false }> => !r.ok)!;
    return { tool: "search_catalog", ok: false, error_code: firstErr.error_code, message: firstErr.message };
  }
  const mergedById = new Map<string, ProductRef>();
  let totalSum = 0;
  for (const r of okResults) {
    totalSum += r.total;
    for (const p of r.results) {
      if (!mergedById.has(p.id)) mergedById.set(p.id, p);
    }
  }
  if (mergedById.size === 0) {
    const rateLimitError = settled.find((r): r is Extract<SingleSearchResult, { ok: false }> =>
      !r.ok && r.error_code === "rate_limited"
    );
    if (rateLimitError) {
      return { tool: "search_catalog", ok: false, error_code: rateLimitError.error_code, message: rateLimitError.message };
    }
  }
  const merged = [...mergedById.values()];
  // После fan-out пересортируем мердж, если запрошена сортировка по цене,
  // т.к. слияние нескольких листьев нарушает порядок.
  if (input.sort_cheapest) merged.sort((a, b) => a.price - b.price);
  else if (input.sort_expensive) merged.sort((a, b) => b.price - a.price);
  const perPage = Math.min(Math.max(input.per_page ?? 10, 1), 50);
  return {
    tool: "search_catalog",
    ok: true,
    mode: input.mode,
    total: totalSum, // суммарный total по веткам (грубая оценка; дедуп — на уровне results)
    results: merged.slice(0, perPage),
    ...(warnings.length ? { warnings } : {}),
  };
}
