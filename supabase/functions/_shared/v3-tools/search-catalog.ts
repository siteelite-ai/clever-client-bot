// V3 tool: search_catalog — minimal 220volt /products wrapper.
// Data-agnostic: baseUrl + apiToken injected from caller.

import type { ProductCache, ProductRef, SearchCatalogOk, ToolError } from "./types.ts";

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

function inferStock(p: Record<string, unknown>): ProductRef["stock"] {
  // 220volt: warehouses часто отсутствует/пуст для активных товаров.
  // Если API вернул карточку — считаем доступной, пока явно не сказано обратное.
  const wh = p.warehouses as Array<{ qty?: number | null }> | undefined;
  if (!Array.isArray(wh) || wh.length === 0) return "in_stock";
  const total = wh.reduce((s, w) => s + (typeof w?.qty === "number" ? w.qty : 0), 0);
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
 * Бренд карточки. Каскад: options[brend__brend] → vendor. Отбрасываем
 * значения, которые выглядят как маркировка серии/кабеля (ВВГ, ПВС, ...).
 * Data-agnostic: без словарей брендов/серий.
 * Sync с V1 `getBrandFromProduct` в chat-consultant/index.ts.
 */
function looksLikeMarking(s: string): boolean {
  const v = (s || "").trim();
  if (!v || v.length > 10) return false;
  return /^[А-ЯЁ]{2,6}(нг)?[\s\-\d.,*хХx\/]{0,8}$/u.test(v);
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
  const vendor = typeof p.vendor === "string" ? p.vendor.trim() : "";
  if (vendor && !looksLikeMarking(vendor)) return vendor;
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
      const u = typeof raw.url === "string" ? raw.url : "";
      if (!u) continue;
      const vendor = extractBrand(raw);
      const ref: ProductRef = {
        id, pagetitle, vendor, price,
        stock: inferStock(raw),
        short_traits: extractTraits(raw),
        leaf_category: extractLeafCategory(raw),
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

async function singleSearchSorted(
  input: SearchCatalogInput,
  deps: CatalogClientDeps,
  cache: ProductCache,
  categoryOverride: string | undefined,
  warnings: string[],
): Promise<SingleSearchResult> {
  if (!input.sort_cheapest && !input.sort_expensive) {
    return singleSearch(input, deps, cache, categoryOverride);
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
  return { ok: true, total: totalApi, results: sorted.slice(0, requestedPerPage) };
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
      return { tool: "search_catalog", ok: false, error_code: "bad_input", message: "by_filter requires category/category_in or options" };
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

  // Один запрос: либо нет category fan-out, либо ровно одна категория.
  if (categories.length <= 1) {
    const r = await singleSearchSorted(input, deps, cache, categories[0], warnings);
    if (!r.ok) return { tool: "search_catalog", ok: false, error_code: r.error_code, message: r.message };
    return { tool: "search_catalog", ok: true, mode: input.mode, total: r.total, results: r.results, ...(warnings.length ? { warnings } : {}) };
  }

  // Fan-out: параллельные запросы по каждой листовой категории, merge с дедупликацией по id.
  const settled = await Promise.all(
    categories.map((cat) => singleSearchSorted(input, deps, cache, cat, warnings)),
  );
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
