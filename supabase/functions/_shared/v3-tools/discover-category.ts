// V3 tool: discover_category.
// 1) noun/query → live /categories list → exact pagetitle resolver (LLM over real list)
// 2) exact pagetitle → GET /categories/options
// Data-agnostic: НИКАКИХ доменных списков категорий/фасетов в коде.

import type { CatalogClientDeps } from "./search-catalog.ts";

const CATEGORIES_TTL_MS = 60 * 60 * 1000;
const MODEL = "google/gemini-2.5-flash";

interface CategoryNode {
  id: number;
  pagetitle: string;
  parentId: number | null;
  childrenIds: number[];
}

interface CategoriesCache {
  flat: CategoryCandidate[];           // для exact/LLM-резолвера по pagetitle
  byId: Map<number, CategoryNode>;     // для обхода поддерева (родитель → дети)
  byPagetitle: Map<string, number>;    // pagetitle (нормализованный) → id
  ts: number;
}

let categoriesCache: CategoriesCache | null = null;

export interface DiscoverCategoryInput {
  noun: string; // тип товара из запроса; НЕ обязан быть точным pagetitle каталога
  semantic_query?: string; // полный запрос клиента, если есть — помогает резолверу выбрать ветку
}

export interface DiscoverCategoryDeps extends CatalogClientDeps {
  openrouterApiKey?: string | null;
}

interface CategoryCandidate {
  id: number | null;
  pagetitle: string;
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

/** Листовая категория из дерева /categories — pagetitle подходит для search_catalog?category=<pagetitle> */
export interface LeafCategory {
  id: number;
  pagetitle: string;
}

export interface DiscoverCategoryOk {
  ok: true;
  category: { id: number | null; pagetitle: string; total_products: number };
  facets: Facet[];
  /**
   * Листовые категории внутри resolved category. Параметр `category=` в /products
   * матчит ТОЛЬКО pagetitle листа (не зонтика). LLM обязан брать category_in
   * для search_catalog отсюда, иначе фильтр всегда даст 0.
   * Если resolved category — сама лист, список содержит её саму.
   */
  leaf_categories: LeafCategory[];
  resolved_from?: string;
}

export interface DiscoverCategoryErr {
  ok: false;
  error_code: "category_not_found" | "catalog_timeout" | "transport_5xx" | "bad_input" | "internal";
  message: string;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function cleanText(v: unknown): string {
  return typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
}

function isUsefulDiscovery(x: DiscoverCategoryOk): boolean {
  return x.category.total_products > 0 && x.facets.length > 0;
}

function collectCategories(
  nodes: unknown,
  parentId: number | null,
  acc: { flat: CategoryCandidate[]; byId: Map<number, CategoryNode>; byPagetitle: Map<string, number> },
): void {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes as Array<Record<string, unknown>>) {
    const pagetitle = typeof node?.pagetitle === "string" ? node.pagetitle.trim() : "";
    const id = typeof node.id === "number" ? node.id : null;
    if (pagetitle) acc.flat.push({ id, pagetitle });
    if (id !== null && pagetitle) {
      const children = Array.isArray(node.children) ? node.children as Array<Record<string, unknown>> : [];
      const childrenIds = children
        .map((c) => (typeof c.id === "number" ? c.id : null))
        .filter((x): x is number => x !== null);
      acc.byId.set(id, { id, pagetitle, parentId, childrenIds });
      acc.byPagetitle.set(normalize(pagetitle), id);
    }
    collectCategories(node?.children, id, acc);
  }
}

async function fetchCategories(deps: DiscoverCategoryDeps): Promise<CategoriesCache> {
  if (categoriesCache && Date.now() - categoriesCache.ts < CATEGORIES_TTL_MS) return categoriesCache;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const first = await fetchCategoriesPage(fetchImpl, deps, 1);
  const acc = { flat: [] as CategoryCandidate[], byId: new Map<number, CategoryNode>(), byPagetitle: new Map<string, number>() };
  collectCategories(first.results, null, acc);

  const pages = Math.max(1, Number(first.pagination?.pages) || 1);
  for (let page = 2; page <= pages; page++) {
    const next = await fetchCategoriesPage(fetchImpl, deps, page);
    collectCategories(next.results, null, acc);
  }

  const flatDeduped = Array.from(new Map(acc.flat.map((c) => [c.pagetitle, c])).values())
    .sort((a, b) => a.pagetitle.localeCompare(b.pagetitle));
  categoriesCache = { flat: flatDeduped, byId: acc.byId, byPagetitle: acc.byPagetitle, ts: Date.now() };
  return categoriesCache;
}

/**
 * Собирает все листовые pagetitle (children=[]) в поддереве с корнем `rootId`.
 * Если сам root уже лист — возвращает только его.
 */
function collectLeafDescendants(rootId: number, byId: Map<number, CategoryNode>): LeafCategory[] {
  const root = byId.get(rootId);
  if (!root) return [];
  const leaves: LeafCategory[] = [];
  const visited = new Set<number>();
  const stack: number[] = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = byId.get(id);
    if (!node) continue;
    if (node.childrenIds.length === 0) {
      leaves.push({ id: node.id, pagetitle: node.pagetitle });
    } else {
      for (const cid of node.childrenIds) stack.push(cid);
    }
  }
  return leaves;
}

function parseResolverCandidates(raw: string, valid: Set<string>): Array<{ pagetitle: string; confidence: number }> {
  let txt = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const first = txt.indexOf("{");
  const last = txt.lastIndexOf("}");
  if (first >= 0 && last > first) txt = txt.slice(first, last + 1);
  try {
    const parsed = JSON.parse(txt) as { candidates?: Array<{ pagetitle?: unknown; confidence?: unknown }> };
    return (parsed.candidates ?? [])
      .filter((c) => typeof c.pagetitle === "string" && valid.has(c.pagetitle) && typeof c.confidence === "number")
      .map((c) => ({ pagetitle: c.pagetitle as string, confidence: Math.max(0, Math.min(1, c.confidence as number)) }))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);
  } catch {
    return [];
  }
}

async function fetchCategoriesPage(
  fetchImpl: typeof fetch,
  deps: DiscoverCategoryDeps,
  page: number,
): Promise<{ results: unknown[]; pagination?: { pages?: number } }> {
  const params = new URLSearchParams({ parent: "0", depth: "10", per_page: "200", page: String(page) });
  const res = await fetchImpl(`${deps.baseUrl}/categories?${params}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${deps.apiToken}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`categories ${res.status}`);
  const raw = await res.json() as { data?: { results?: unknown[]; pagination?: { pages?: number } }; results?: unknown[]; pagination?: { pages?: number } };
  const data = raw.data ?? raw;
  return { results: Array.isArray(data.results) ? data.results : [], pagination: data.pagination };
}

async function resolvePagetitle(
  input: DiscoverCategoryInput,
  deps: DiscoverCategoryDeps,
): Promise<{ pagetitle: string; resolvedFrom?: string; candidates: string[]; cache: CategoriesCache } | null> {
  const noun = input.noun.trim();
  const cache = await fetchCategories(deps);
  const flat = cache.flat;
  const exact = flat.find((c) => normalize(c.pagetitle) === normalize(noun));
  if (exact) return { pagetitle: exact.pagetitle, candidates: [exact.pagetitle], cache };
  if (!deps.openrouterApiKey) return null;

  const list = flat.map((c, i) => `${i + 1}. ${c.pagetitle}`).join("\n");
  const query = [input.semantic_query?.trim(), noun].filter(Boolean).join("\nNOUN: ");
  const res = await (deps.fetchImpl ?? fetch)("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deps.openrouterApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://chat-volt.testdevops.ru",
      "X-Title": "220volt-v3-category-resolver",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 400,
      messages: [
        {
          role: "system",
          content: `You are a CATEGORY MATCHER for an e-commerce catalog. Pick exact pagetitle values only from the provided live list. If nothing is related, return {"candidates":[]}. Output strict JSON: {"candidates":[{"pagetitle":"<exact list item>","confidence":0.0}]}. No prose.`,
        },
        {
          role: "user",
          content: `USER QUERY / NOUN:\n${query}\n\nCATALOG CATEGORIES (${flat.length}, choose exact pagetitle):\n${list}\n\nReturn JSON now.`,
        },
      ],
    }),
  });
  if (!res.ok) return null;
  const json = await res.json() as { choices?: Array<{ message?: { content?: string | null } }> };
  const candidates = parseResolverCandidates(json.choices?.[0]?.message?.content ?? "", new Set(flat.map((c) => c.pagetitle)));
  const usable = candidates.filter((c) => c.confidence >= 0.45).map((c) => c.pagetitle);
  if (usable.length === 0) return null;
  return { pagetitle: usable[0], resolvedFrom: noun, candidates: usable, cache };
}

async function fetchFacetsForPagetitle(
  pagetitle: string,
  deps: DiscoverCategoryDeps,
): Promise<{ ok: true; data: DiscoverCategoryOk } | { ok: false; status: number; message: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10000;

  const params = new URLSearchParams();
  params.append("pagetitle", pagetitle);

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

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, message: text.slice(0, 200) || String(res.status) };
    }

    const json = await res.json() as {
      data?: {
        data?: unknown;
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
    const envelope = json?.data && "data" in json.data && !("options" in json.data) ? json.data.data as typeof json.data : json.data;
    const cat = envelope?.category ?? {};
    const rawOptions = Array.isArray(envelope?.options) ? envelope.options : [];

    const facets: Facet[] = [];
    for (const o of rawOptions) {
      const key = cleanText(o?.key);
      const caption = cleanText(o?.caption_ru);
      if (!key || !caption) continue;
      const values: FacetValue[] = [];
      if (Array.isArray(o.values)) {
        for (const v of o.values) {
          const vv = cleanText(v?.value_ru);
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
      ok: true,
      data: {
        ok: true,
        category: {
          id: typeof cat.id === "number" ? cat.id : null,
          pagetitle: cleanText(cat.pagetitle) || pagetitle,
          total_products: typeof cat.total_products === "number" ? cat.total_products : 0,
        },
        facets,
        leaf_categories: [], // заполняется в executeDiscoverCategory (нужен cache из resolvePagetitle)
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Резолвит листовые pagetitle для resolved category, используя cache из /categories.
 * Возвращает {self} если категория уже лист, либо список всех листьев поддерева.
 */
function resolveLeafCategories(
  resolvedPagetitle: string,
  catId: number | null,
  cache: CategoriesCache,
): LeafCategory[] {
  // Сначала пытаемся найти id по pagetitle (cat.id из /options может отсутствовать).
  let id = catId;
  if (id === null) {
    const fromMap = cache.byPagetitle.get(normalize(resolvedPagetitle));
    if (typeof fromMap === "number") id = fromMap;
  }
  if (id === null) return [{ id: 0, pagetitle: resolvedPagetitle }]; // fallback: используем сам resolved
  const leaves = collectLeafDescendants(id, cache.byId);
  if (leaves.length === 0) {
    const self = cache.byId.get(id);
    if (self) return [{ id: self.id, pagetitle: self.pagetitle }];
    return [{ id: 0, pagetitle: resolvedPagetitle }];
  }
  return leaves;
}

export async function executeDiscoverCategory(
  input: DiscoverCategoryInput,
  deps: DiscoverCategoryDeps,
): Promise<(DiscoverCategoryOk & { tool: "discover_category" }) | (DiscoverCategoryErr & { tool: "discover_category" })> {
  const noun = (input.noun ?? "").trim();
  if (!noun) {
    return { tool: "discover_category", ok: false, error_code: "bad_input", message: "noun required" };
  }

  try {
    // Resolve pagetitle against the LIVE category list first (exact-match, then LLM resolver).
    // Calling /categories/options with an arbitrary noun (e.g. "кабель") can hang the upstream API,
    // so we never hit /options without a validated pagetitle from the real catalog.
    const resolved = await resolvePagetitle(input, deps);
    if (!resolved) {
      return { tool: "discover_category", ok: false, error_code: "category_not_found", message: `no category for "${noun}"` };
    }

    for (const pagetitle of resolved.candidates) {
      const facets = await fetchFacetsForPagetitle(pagetitle, deps);
      if (facets.ok && isUsefulDiscovery(facets.data)) {
        const leaves = resolveLeafCategories(facets.data.category.pagetitle, facets.data.category.id, resolved.cache);
        return { tool: "discover_category", ...facets.data, leaf_categories: leaves, resolved_from: resolved.resolvedFrom };
      }
    }
    return { tool: "discover_category", ok: false, error_code: "category_not_found", message: `no category facets for "${noun}"` };
  } catch (e) {
    const isAbort = (e as { name?: string })?.name === "AbortError";
    return {
      tool: "discover_category",
      ok: false,
      error_code: isAbort ? "catalog_timeout" : "transport_5xx",
      message: (e as Error)?.message ?? "fetch failed",
    };
  }
}
