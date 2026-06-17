// V3 tool: search_catalog — minimal 220volt /products wrapper.
// Data-agnostic: baseUrl + apiToken injected from caller.

import type { ProductCache, ProductFull, ProductRef, SearchCatalogOk, ToolError } from "./types.ts";

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
  category?: string;
  min_price?: number;
  max_price?: number;
  options?: Record<string, string[]>;
  page?: number;
  per_page?: number;
  sort_cheapest?: boolean;
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
  const opts = p.options as Array<{ caption_ru?: string; value_ru?: string }> | undefined;
  if (!Array.isArray(opts)) return [];
  const out: string[] = [];
  for (const o of opts) {
    if (out.length >= 5) break;
    const cap = o?.caption_ru?.trim();
    const val = o?.value_ru?.trim();
    if (cap && val) out.push(`${cap}: ${val}`);
  }
  return out;
}

export async function executeSearchCatalog(
  input: SearchCatalogInput,
  deps: CatalogClientDeps,
  cache: ProductCache,
): Promise<(SearchCatalogOk & { tool: "search_catalog" }) | (ToolError & { tool: "search_catalog" })> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 8000;

  const params = new URLSearchParams();
  if (input.mode === "by_article" && input.article) params.append("article", input.article);
  else if (input.mode === "by_pagetitle" && input.pagetitle) params.append("pagetitle", input.pagetitle);
  else if (input.mode === "by_query" && input.query) params.append("query", input.query);
  else if (input.mode === "by_filter") {
    // by_filter режим: фильтрация исключительно по category + options[].
    // Требует category ИЛИ хотя бы одну запись в options.
    if (!input.category && (!input.options || Object.keys(input.options).length === 0)) {
      return { tool: "search_catalog", ok: false, error_code: "bad_input", message: "by_filter requires category or options" };
    }
  } else {
    return { tool: "search_catalog", ok: false, error_code: "bad_input", message: "missing field for mode" };
  }

  if (input.category) params.append("category", input.category);
  if (typeof input.min_price === "number") params.append("min_price", String(input.min_price));
  if (typeof input.max_price === "number") params.append("max_price", String(input.max_price));
  if (input.sort_cheapest) {
    // 220volt quirk: min_price=1 = server-side ASC sort + filter price=0.
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
      headers: {
        Authorization: `Bearer ${deps.apiToken}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 429) return { tool: "search_catalog", ok: false, error_code: "rate_limited", message: `429 from catalog` };
      if (res.status >= 500) return { tool: "search_catalog", ok: false, error_code: "transport_5xx", message: `${res.status}` };
      return { tool: "search_catalog", ok: false, error_code: "bad_input", message: `${res.status}` };
    }

    const json = await res.json() as { data?: { results?: unknown[]; pagination?: { total?: number } } };
    const rawResults = Array.isArray(json?.data?.results) ? json.data!.results! : [];
    const total = Number(json?.data?.pagination?.total ?? rawResults.length) || 0;

    const results: ProductRef[] = [];
    for (const raw of rawResults as Array<Record<string, unknown>>) {
      const price = Number(raw.price);
      if (!Number.isFinite(price) || price <= 0) continue; // HARD BAN price=0
      const id = String(raw.id ?? "");
      if (!id) continue;
      const pagetitle = String(raw.pagetitle ?? raw.name ?? "").trim();
      if (!pagetitle) continue;
      const url = typeof raw.url === "string" ? raw.url : "";
      if (!url) continue;
      const vendor = typeof raw.vendor === "string" ? raw.vendor : null;
      const ref: ProductRef = {
        id,
        pagetitle,
        vendor,
        price,
        stock: inferStock(raw),
        short_traits: extractTraits(raw),
      };
      const full: ProductFull = { ...ref, url };
      cache.set(id, full);
      results.push(ref);
    }

    return {
      tool: "search_catalog",
      ok: true,
      mode: input.mode,
      total,
      results,
    };
  } catch (e) {
    const isAbort = (e as { name?: string })?.name === "AbortError";
    return {
      tool: "search_catalog",
      ok: false,
      error_code: isAbort ? "catalog_timeout" : "transport_5xx",
      message: (e as Error)?.message ?? "fetch failed",
    };
  } finally {
    clearTimeout(timer);
  }
}
