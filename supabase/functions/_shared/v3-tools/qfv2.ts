// V3: Query-First v2 pipeline (QFv2).
//
// Спека §3.2 / mem://features/query-first-branch:
//   1. Pool: GET /products?query=<noun> per_page=N_POOL   (БЕЗ category, БЕЗ модификаторов)
//   2. Self-Bootstrap facets — агрегация options[] из pool.results.
//   3. Apply modifiers — word-boundary post-filter по pagetitle + options.value_ru.
//   4. Branch:
//        - final > 0  → qfv2_final
//        - final = 0 & pool ≤ 7 → qfv2_pool_rescue (показываем pool)
//        - final = 0 & pool > 7 → qfv2_honest_empty (пусто + applied_facets с alt_values)
//        - pool = 0 → caller вызывает Jargon Recovery → ретрай → qfv2_jargon_recovery
//
// Data-agnostic: никаких whitelist'ов категорий, синонимов или брендов.

import type { CatalogClientDeps } from "./search-catalog.ts";
import type { ExpandPoolOk, ProductCache, ProductFull, ProductRef, ToolError } from "./types.ts";

const N_POOL = 100;
const POOL_RESCUE_THRESHOLD = 7;
const POOL_TIMEOUT_MS = 4000;

export interface QfV2Input {
  noun: string;
  modifiers?: string[];
  price_intent?: "cheapest" | "most_expensive" | null;
  min_price?: number;
  max_price?: number;
  brand?: string;
}

interface RawProduct {
  id?: unknown;
  pagetitle?: unknown;
  name?: unknown;
  vendor?: unknown;
  price?: unknown;
  url?: unknown;
  options?: Array<{ key?: string; caption_ru?: string; value_ru?: string }>;
  warehouses?: Array<{ qty?: number | null }>;
}

interface FacetAggregate {
  key: string;
  caption: string;
  values: Map<string, number>; // value_ru → count
}

// ─── helpers ────────────────────────────────────────────────────────────────

function inferStock(p: RawProduct): ProductRef["stock"] {
  const wh = p.warehouses;
  if (!Array.isArray(wh) || wh.length === 0) return "in_stock";
  const total = wh.reduce((s, w) => s + (typeof w?.qty === "number" ? w.qty : 0), 0);
  if (total <= 0) return "in_stock";
  if (total < 3) return "low";
  return "in_stock";
}

function extractTraits(p: RawProduct): string[] {
  if (!Array.isArray(p.options)) return [];
  const out: string[] = [];
  for (const o of p.options) {
    if (out.length >= 5) break;
    if (o?.caption_ru && o?.value_ru) out.push(`${o.caption_ru}: ${o.value_ru}`);
  }
  return out;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function wordBoundaryMatch(haystack: string, needle: string): boolean {
  const h = ` ${normalize(haystack)} `;
  const n = normalize(needle);
  if (!n) return false;
  return h.includes(` ${n} `) || h.includes(` ${n}`) || h.includes(`${n} `);
}

function aggregateBootstrapFacets(products: RawProduct[]): FacetAggregate[] {
  const map = new Map<string, FacetAggregate>();
  for (const p of products) {
    if (!Array.isArray(p.options)) continue;
    for (const o of p.options) {
      const key = o?.key?.trim();
      const caption = o?.caption_ru?.trim();
      const value = o?.value_ru?.trim();
      if (!key || !caption || !value) continue;
      let agg = map.get(key);
      if (!agg) {
        agg = { key, caption, values: new Map() };
        map.set(key, agg);
      }
      agg.values.set(value, (agg.values.get(value) ?? 0) + 1);
    }
  }
  return [...map.values()];
}

interface MatchedFacet {
  key: string;
  caption: string;
  matchedValues: string[];
  alternativeValues: string[]; // top other values for honest-empty
}

/**
 * Пытается сматчить каждый modifier на одно значение какого-то facet'а из bootstrap.
 * Чисто строковое сопоставление (word-boundary, нормализация) — без LLM.
 * Data-agnostic.
 */
function matchModifiersToFacets(modifiers: string[], facets: FacetAggregate[]): {
  matched: MatchedFacet[];
  unmatched: string[];
} {
  const matched: MatchedFacet[] = [];
  const unmatched: string[] = [];
  const usedFacetKeys = new Set<string>();

  for (const mod of modifiers) {
    let hit: { facet: FacetAggregate; value: string } | null = null;
    for (const f of facets) {
      if (usedFacetKeys.has(f.key)) continue;
      for (const v of f.values.keys()) {
        if (wordBoundaryMatch(v, mod) || wordBoundaryMatch(mod, v)) {
          hit = { facet: f, value: v };
          break;
        }
      }
      if (hit) break;
    }
    if (hit) {
      usedFacetKeys.add(hit.facet.key);
      const alt = [...hit.facet.values.entries()]
        .filter(([v]) => v !== hit!.value)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([v]) => v);
      matched.push({ key: hit.facet.key, caption: hit.facet.caption, matchedValues: [hit.value], alternativeValues: alt });
    } else {
      unmatched.push(mod);
    }
  }
  return { matched, unmatched };
}

function productMatchesUnmatched(p: ProductFull, raw: RawProduct, unmatched: string[]): boolean {
  if (unmatched.length === 0) return true;
  const optBlob = Array.isArray(raw.options)
    ? raw.options.map((o) => `${o?.value_ru ?? ""}`).join(" ")
    : "";
  const haystack = `${p.pagetitle} ${p.vendor ?? ""} ${optBlob}`;
  return unmatched.every((m) => wordBoundaryMatch(haystack, m));
}

function productMatchesFacet(raw: RawProduct, mf: MatchedFacet): boolean {
  if (!Array.isArray(raw.options)) return false;
  for (const o of raw.options) {
    if (o?.key !== mf.key) continue;
    if (typeof o?.value_ru === "string" && mf.matchedValues.includes(o.value_ru)) return true;
  }
  return false;
}

// ─── pool fetch ─────────────────────────────────────────────────────────────

async function fetchPool(
  query: string,
  deps: CatalogClientDeps,
  input: QfV2Input,
): Promise<{ raw: RawProduct[]; refs: ProductFull[]; total: number } | { error: ToolError["error_code"]; message: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const params = new URLSearchParams();
  params.append("query", query);
  params.append("per_page", String(N_POOL));
  if (typeof input.min_price === "number") params.append("min_price", String(input.min_price));
  if (typeof input.max_price === "number") params.append("max_price", String(input.max_price));
  if (input.price_intent === "cheapest" && !params.has("min_price")) params.append("min_price", "1");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POOL_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${deps.baseUrl}/products?${params}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${deps.apiToken}`, "Content-Type": "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 429) return { error: "rate_limited", message: `429` };
      if (res.status >= 500) return { error: "transport_5xx", message: `${res.status}` };
      return { error: "bad_input", message: `${res.status}` };
    }
    const json = await res.json() as { data?: { results?: RawProduct[]; pagination?: { total?: number } } };
    const rawList = Array.isArray(json?.data?.results) ? json.data!.results! : [];
    const total = Number(json?.data?.pagination?.total ?? rawList.length) || 0;

    const refs: ProductFull[] = [];
    const cleanRaw: RawProduct[] = [];
    for (const raw of rawList) {
      const price = Number(raw.price);
      if (!Number.isFinite(price) || price <= 0) continue; // HARD BAN
      const id = String(raw.id ?? "");
      if (!id) continue;
      const pagetitle = String(raw.pagetitle ?? raw.name ?? "").trim();
      if (!pagetitle) continue;
      const url = typeof raw.url === "string" ? raw.url : "";
      if (!url) continue;
      refs.push({
        id,
        pagetitle,
        vendor: typeof raw.vendor === "string" ? raw.vendor : null,
        price,
        stock: inferStock(raw),
        short_traits: extractTraits(raw),
        url,
      });
      cleanRaw.push(raw);
    }
    return { raw: cleanRaw, refs, total };
  } catch (e) {
    const isAbort = (e as { name?: string })?.name === "AbortError";
    return { error: isAbort ? "catalog_timeout" : "transport_5xx", message: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

// ─── main ──────────────────────────────────────────────────────────────────

export async function runQfV2(
  input: QfV2Input,
  deps: CatalogClientDeps,
  cache: ProductCache,
): Promise<(ExpandPoolOk & { tool: "expand_search_to_pool" }) | (ToolError & { tool: "expand_search_to_pool" })> {
  const noun = (input.noun ?? "").trim();
  if (!noun) {
    return { tool: "expand_search_to_pool", ok: false, error_code: "bad_input", message: "noun required" };
  }

  const pool = await fetchPool(noun, deps, input);
  if ("error" in pool) {
    return { tool: "expand_search_to_pool", ok: false, error_code: pool.error, message: pool.message };
  }

  // Sort if needed
  if (input.price_intent === "cheapest") {
    pool.refs.sort((a, b) => a.price - b.price);
  } else if (input.price_intent === "most_expensive") {
    pool.refs.sort((a, b) => b.price - a.price);
  }

  // Cache full products from pool — render_products will need them.
  for (const p of pool.refs) cache.set(p.id, p);

  const modifiers = (input.modifiers ?? []).map((m) => m.trim()).filter(Boolean);
  if (input.brand) modifiers.push(input.brand);

  // pool=0 → caller handles jargon recovery
  if (pool.refs.length === 0) {
    return {
      tool: "expand_search_to_pool",
      ok: true,
      total: 0,
      results: [],
      branch_tag: "qfv2_honest_empty",
    };
  }

  // No modifiers → return pool truncated to 10.
  if (modifiers.length === 0) {
    const top = pool.refs.slice(0, 10);
    return {
      tool: "expand_search_to_pool",
      ok: true,
      total: pool.total,
      results: top,
      branch_tag: "qfv2_final",
    };
  }

  // Bootstrap facets from pool
  const facets = aggregateBootstrapFacets(pool.raw);
  const { matched, unmatched } = matchModifiersToFacets(modifiers, facets);

  // Apply matched facets + unmatched word-boundary filter
  const final: ProductFull[] = [];
  for (let i = 0; i < pool.refs.length; i++) {
    const ref = pool.refs[i];
    const raw = pool.raw[i];
    let pass = true;
    for (const mf of matched) {
      if (!productMatchesFacet(raw, mf)) { pass = false; break; }
    }
    if (pass && unmatched.length > 0) {
      if (!productMatchesUnmatched(ref, raw, unmatched)) pass = false;
    }
    if (pass) final.push(ref);
  }

  if (final.length > 0) {
    return {
      tool: "expand_search_to_pool",
      ok: true,
      total: final.length,
      results: final.slice(0, 10),
      branch_tag: "qfv2_final",
      applied_facets: matched.map((m) => ({ key: m.key, values: m.matchedValues })),
    };
  }

  // final = 0 → Pool Rescue (если pool узкий — noun уже точный)
  if (pool.refs.length <= POOL_RESCUE_THRESHOLD) {
    return {
      tool: "expand_search_to_pool",
      ok: true,
      total: pool.refs.length,
      results: pool.refs,
      branch_tag: "qfv2_pool_rescue",
    };
  }

  // final = 0 & pool широкий → Honest-Empty с альтернативами
  return {
    tool: "expand_search_to_pool",
    ok: true,
    total: 0,
    results: [],
    branch_tag: "qfv2_honest_empty",
    applied_facets: matched.map((m) => ({
      key: m.key,
      values: m.matchedValues,
      alternative_values: m.alternativeValues,
    })),
  };
}
