// V3 tool: discover_category — обёртка над GET /categories/options?pagetitle=<noun>.
// Возвращает реальные фасеты категории (ключи/значения/units) для последующего точного фильтра.
// Data-agnostic: НИКАКИХ доменных списков фасетов в коде.

import type { CatalogClientDeps } from "./search-catalog.ts";

export interface DiscoverCategoryInput {
  noun: string; // pagetitle категории каталога ("Кабель", "Розетки", ...)
}

export interface FacetValue {
  value: string;
  products_count?: number;
}

export interface Facet {
  key: string;          // машинный ключ для options[key][]=value
  caption: string;      // человеко-читаемое имя
  type: string;         // "string" | "number" | ...
  unit: string | null;  // "мм²", "В", "Вт" — если есть
  min?: number | null;
  max?: number | null;
  values: FacetValue[]; // только реально встречающиеся значения
}

export interface DiscoverCategoryOk {
  ok: true;
  category: { id: number | null; pagetitle: string; total_products: number };
  facets: Facet[];
}

export interface DiscoverCategoryErr {
  ok: false;
  error_code: "category_not_found" | "catalog_timeout" | "transport_5xx" | "bad_input" | "internal";
  message: string;
}

export async function executeDiscoverCategory(
  input: DiscoverCategoryInput,
  deps: CatalogClientDeps,
): Promise<(DiscoverCategoryOk & { tool: "discover_category" }) | (DiscoverCategoryErr & { tool: "discover_category" })> {
  const noun = (input.noun ?? "").trim();
  if (!noun) {
    return { tool: "discover_category", ok: false, error_code: "bad_input", message: "noun required" };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10000;

  // API ожидает параметр `pagetitle` (а сам параметр в Swagger назван `pagettitle`/`pagetitle` —
  // используем оба имени для безопасности).
  const params = new URLSearchParams();
  params.append("pagetitle", noun);

  const url = `${deps.baseUrl}/categories/options?${params}`;
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

    if (res.status === 404) {
      await res.body?.cancel();
      return { tool: "discover_category", ok: false, error_code: "category_not_found", message: `no category for "${noun}"` };
    }
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status >= 500) return { tool: "discover_category", ok: false, error_code: "transport_5xx", message: `${res.status}` };
      return { tool: "discover_category", ok: false, error_code: "bad_input", message: `${res.status}` };
    }

    const json = await res.json() as {
      data?: {
        category?: { id?: number; pagetitle?: string; total_products?: number };
        options?: Array<{
          key?: string;
          caption_ru?: string;
          type?: string;
          unit?: string | null;
          min?: number | null;
          max?: number | null;
          values?: Array<{ value_ru?: string; products_count?: number }>;
        }>;
      };
    };

    const cat = json?.data?.category ?? {};
    const rawOptions = Array.isArray(json?.data?.options) ? json.data!.options! : [];

    const facets: Facet[] = [];
    for (const o of rawOptions) {
      const key = (o?.key ?? "").trim();
      const caption = (o?.caption_ru ?? "").trim();
      if (!key || !caption) continue;
      const values: FacetValue[] = [];
      if (Array.isArray(o.values)) {
        for (const v of o.values) {
          const vv = (v?.value_ru ?? "").trim();
          if (!vv) continue;
          values.push({ value: vv, products_count: typeof v.products_count === "number" ? v.products_count : undefined });
        }
      }
      facets.push({
        key,
        caption,
        type: o.type ?? "string",
        unit: o.unit ?? null,
        min: o.min ?? null,
        max: o.max ?? null,
        values,
      });
    }

    return {
      tool: "discover_category",
      ok: true,
      category: {
        id: typeof cat.id === "number" ? cat.id : null,
        pagetitle: cat.pagetitle ?? noun,
        total_products: typeof cat.total_products === "number" ? cat.total_products : 0,
      },
      facets,
    };
  } catch (e) {
    const isAbort = (e as { name?: string })?.name === "AbortError";
    return {
      tool: "discover_category",
      ok: false,
      error_code: isAbort ? "catalog_timeout" : "transport_5xx",
      message: (e as Error)?.message ?? "fetch failed",
    };
  } finally {
    clearTimeout(timer);
  }
}
