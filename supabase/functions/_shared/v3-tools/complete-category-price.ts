/**
 * Optional exact-compound superlative route. Unlike by_query search, this
 * enumerates every raw row of every discovered leaf in a bounded category
 * scope before comparing prices. A partial scope/result never proves a price
 * minimum or maximum and therefore never returns a product.
 */
import type { DiscoverCategoryOk } from "./discover-category.ts";
import type { ExactCompoundMarkingRequest } from "./exact-compound-marking-policy.ts";
import { productTitleMatchesExplicitCompoundMarking } from "./exact-compound-marking-policy.ts";
import type { CatalogClientDeps } from "./search-catalog.ts";
import {
  extractUnit,
  isRestrictedCatalogProduct,
  normalizeProductUrl,
  sanitizeCatalogDescription,
} from "./search-catalog.ts";
import { isAdministrativeCatalogField } from "./catalog-field-policy.ts";
import type { ProductCache, ProductFull, ProductRef } from "./types.ts";

const PAGE_SIZE = 50;
const MAX_RAW_ROWS = 200;
const MAX_SCANNED_LEAVES = 8;
const MAX_TAXONOMY_LEAVES = 256;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_TOTAL_MS = 18_000;
const MAX_PAGE_MS = 5_000;

export interface CompleteCategoryPriceInput {
  request: ExactCompoundMarkingRequest;
  /** The unfiltered leaf set of one successful live discover_category result. */
  discovery: DiscoverCategoryOk;
}

export interface CompleteCategoryPriceEvidence {
  scope_category: string;
  /** All taxonomy leaves in the exactly resolved parent, before safe pruning. */
  taxonomy_leaf_count: number;
  /** Sibling leaves whose whole name is a different compound marking. */
  skipped_other_marking_leaves: number;
  /** Every remaining leaf was fully fetched, including ambiguous leaf names. */
  leaf_categories: string[];
  raw_rows: number;
  matching_available: number;
  restricted_excluded: number;
  unpriced_excluded: number;
  zero_stock_excluded: number;
  unit: string;
  selected_price: number;
  tied_count: number;
}

export type CompleteCategoryPriceResult =
  | { ok: true; product: ProductRef; evidence: CompleteCategoryPriceEvidence }
  | {
    ok: false;
    reason:
      | "invalid_scope" | "catalog_failure" | "catalog_partial" | "catalog_cap"
      | "duplicate_page" | "unverified_candidate" | "mixed_units" | "no_candidate";
    message: string;
    /** Source-backed choices for a unit clarification; only on mixed_units. */
    unit_options?: string[];
  };

type RawProduct = Record<string, unknown>;
type PageOk = { ok: true; total: number; rows: RawProduct[] };
type PageFailure = Extract<CompleteCategoryPriceResult, { ok: false }>;

function fail(reason: PageFailure["reason"], message: string): PageFailure {
  return { ok: false, reason, message };
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/(\d)\s*[xх×*]\s*(\d)/giu, "$1*$2")
    .replace(/(\d)[,.](\d)/gu, "$1.$2")
    .replace(/\s+/gu, " ").trim();
}

/** The literal product-class phrase that must exactly resolve in live taxonomy. */
export function exactCompoundClassPhrase(request: ExactCompoundMarkingRequest): string | null {
  if (!request || typeof request.query !== "string" || !Number.isFinite(request.first) ||
      !Number.isFinite(request.second) || request.first <= 0 || request.second <= 0) return null;
  const query = normalize(request.query);
  const marking = `${request.first}*${request.second}`;
  const position = query.indexOf(marking);
  if (position < 0) return null;
  const phrase = `${query.slice(0, position)} ${query.slice(position + marking.length)}`
    .replace(/\s+/gu, " ").trim();
  return phrase.length >= 5 ? phrase : null;
}

interface CompleteScope {
  leaves: string[];
  taxonomyLeafCount: number;
  skippedOtherMarkingLeaves: number;
}

/**
 * A sibling is safely disjoint only if its ENTIRE name is a single, different
 * compound marking (possibly prefixed/suffixed by the exact parent class).
 * Names like "other 2x1.5", "2x1.5 and 3x1.5", or "misc" are ambiguous and
 * MUST still be scanned; this is taxonomy-based pruning, not a keyword list.
 */
function isDisjointMarkingLeaf(leaf: string, classPhrase: string, request: ExactCompoundMarkingRequest): boolean {
  const name = normalize(leaf);
  const marker = "(\\d{1,3})\\s*\\*\\s*(\\d+(?:\\.\\d+)?)";
  const escapedClass = classPhrase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const whole = new RegExp(`^(?:${marker}|${escapedClass} ${marker}|${marker} ${escapedClass})$`, "u");
  const match = name.match(whole);
  if (!match) return false;
  const first = Number(match[1] ?? match[3] ?? match[5]);
  const second = Number(match[2] ?? match[4] ?? match[6]);
  return Number.isFinite(first) && Number.isFinite(second) &&
    (first !== request.first || second !== request.second);
}

type TitleRelation = "match" | "unrelated" | "ambiguous";

/**
 * Compare the customer-owned product class as ordered whole lexical tokens
 * before the exact compound marking. Product descriptors may intervene between
 * class tokens or before the marking; no product-specific vocabulary is used.
 * A partially matching class or multiple sizes is ambiguous, not an exclusion:
 * silently discarding it could turn a cheaper item into a false minimum.
 */
function titleRelation(title: string, request: ExactCompoundMarkingRequest): TitleRelation {
  const classPhrase = exactCompoundClassPhrase(request);
  if (!classPhrase) return "ambiguous";
  const value = normalize(title);
  const allMarkings = [...value.matchAll(/\b(\d{1,3})\*(\d+(?:\.\d+)?)\b/gu)];
  const matchingMarkings = allMarkings.filter((match) =>
    Number(match[1]) === request.first && Number(match[2]) === request.second
  );
  if (!matchingMarkings.length || !productTitleMatchesExplicitCompoundMarking(title, request)) {
    return "unrelated";
  }
  if (allMarkings.some((match) =>
    Number(match[1]) !== request.first || Number(match[2]) !== request.second
  )) return "ambiguous";
  const marking = matchingMarkings[0];
  const after = value.slice((marking.index ?? 0) + marking[0].length);
  if (/^\s*[xх×*]\s*\d/iu.test(after)) return "ambiguous";
  const prefixTokens: string[] = value.slice(0, marking.index).match(/[\p{L}\p{N}]+/gu) ?? [];
  const classTokens: string[] = classPhrase.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!classTokens.length) return "ambiguous";
  let next = 0;
  for (const token of prefixTokens) {
    if (token === classTokens[next]) next++;
    if (next === classTokens.length) return "match";
  }
  // A same-size card inside an exactly resolved parent but with no proven
  // class/title relation is a taxonomy contradiction (or an unknown synonym).
  // Either way it cannot be silently excluded from a minimum calculation.
  return "ambiguous";
}

function validScope(input: CompleteCategoryPriceInput): CompleteScope | null {
  const { request, discovery } = input;
  if (!request || !["cheapest", "expensive"].includes(request.priceDirection ?? "") ||
      request.exhaustive || !Number.isFinite(request.first) || !Number.isFinite(request.second) ||
      request.first <= 0 || request.second <= 0 ||
      typeof request.query !== "string" || !request.query.trim() || request.query.length > 160 ||
      !productTitleMatchesExplicitCompoundMarking(request.query, request) ||
      !discovery?.ok || discovery.resolution_method !== "exact" ||
      !Number.isSafeInteger(discovery.category?.id) || Number(discovery.category.id) <= 0 ||
      typeof discovery.category?.pagetitle !== "string" ||
      !Array.isArray(discovery.leaf_categories) || discovery.leaf_categories.length < 1 ||
      discovery.leaf_categories.length > MAX_TAXONOMY_LEAVES) return null;
  const leaves = discovery.leaf_categories.map((leaf) => leaf?.pagetitle?.trim());
  if (leaves.some((name) => typeof name !== "string" || !name || name.length > 120) ||
      discovery.leaf_categories.some((leaf) => !Number.isSafeInteger(leaf?.id) || leaf.id <= 0)) return null;
  if (new Set(leaves.map(normalize)).size !== leaves.length ||
      new Set(discovery.leaf_categories.map((leaf) => leaf.id)).size !== leaves.length) return null;
  const categoryName = normalize(discovery.category.pagetitle);
  const query = normalize(request.query);
  const classPhrase = exactCompoundClassPhrase(request);
  const exactLeaf = categoryName === query && leaves.length === 1 &&
    normalize(leaves[0]) === categoryName &&
    discovery.leaf_categories[0].id === discovery.category.id;
  const exactGroup = classPhrase !== null && categoryName === classPhrase;
  if (!exactLeaf && !exactGroup) return null;
  const scanned = exactGroup && classPhrase
    ? (leaves as string[]).filter((leaf) => !isDisjointMarkingLeaf(leaf, classPhrase, request))
    : leaves as string[];
  if (!scanned.length || scanned.length > MAX_SCANNED_LEAVES) return null;
  return {
    leaves: scanned,
    taxonomyLeafCount: leaves.length,
    skippedOtherMarkingLeaves: leaves.length - scanned.length,
  };
}

async function fetchRawPage(
  leaf: string,
  page: number,
  deps: CatalogClientDeps,
  remainingMs: number,
): Promise<PageOk | PageFailure> {
  if (remainingMs <= 0 || deps.signal?.aborted) return fail("catalog_failure", "catalog deadline exceeded");
  const params = new URLSearchParams({ category: leaf, per_page: String(PAGE_SIZE), page: String(page) });
  const url = `${deps.baseUrl.replace(/\/+$/u, "")}/products?${params}`;
  const controller = new AbortController();
  let timer: number | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("catalog page deadline exceeded"));
      }, Math.min(MAX_PAGE_MS, deps.timeoutMs ?? MAX_PAGE_MS, remainingMs));
    });
    const request = (async () => {
      const signal = deps.signal ? AbortSignal.any([controller.signal, deps.signal]) : controller.signal;
      const response = await (deps.fetchImpl ?? fetch)(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${deps.apiToken}`, Accept: "application/json" },
        signal,
      });
      if (!response.ok) throw new Error(`catalog HTTP ${response.status}`);
      if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")) {
        throw new Error("catalog response is not JSON");
      }
      const declaredBytes = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredBytes) && declaredBytes > MAX_RESPONSE_BYTES) {
        throw new Error("catalog response exceeds size limit");
      }
      const body = response.body;
      if (!body) throw new Error("catalog response has no body");
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let byteCount = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          byteCount += part.value.byteLength;
          if (byteCount > MAX_RESPONSE_BYTES) {
            controller.abort();
            void reader.cancel().catch(() => {});
            throw new Error("catalog response exceeds size limit");
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(byteCount);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const json = JSON.parse(text) as { data?: { results?: unknown; pagination?: { total?: unknown } } };
      const total = json?.data?.pagination?.total;
      const rows = json?.data?.results;
      if (!Number.isSafeInteger(total) || Number(total) < 0 || !Array.isArray(rows) ||
          rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
        throw new Error("catalog response has no complete raw pagination contract");
      }
      return { ok: true as const, total: Number(total), rows: rows as RawProduct[] };
    })();
    return await Promise.race([request, deadline]);
  } catch (error) {
    return fail("catalog_failure", String((error as Error)?.message ?? error));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function warehouseProof(raw: RawProduct): "positive" | "zero" | "unknown" {
  if (!Array.isArray(raw.warehouses) || raw.warehouses.length === 0) return "unknown";
  let positive = false;
  for (const row of raw.warehouses) {
    if (!row || typeof row !== "object") return "unknown";
    const value = (row as { amount?: unknown; qty?: unknown }).amount ??
      (row as { qty?: unknown }).qty;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "unknown";
    if (value > 0) {
      if (typeof (row as { city?: unknown }).city !== "string" ||
          !(row as { city: string }).city.trim()) return "unknown";
      positive = true;
    }
  }
  return positive ? "positive" : "zero";
}

function declaredLeaf(raw: RawProduct): string | null {
  if (typeof raw.category === "string" && raw.category.trim()) return raw.category.trim();
  if (raw.category && typeof raw.category === "object" && !Array.isArray(raw.category)) {
    const name = (raw.category as { pagetitle?: unknown }).pagetitle;
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return null;
}

function positiveWarehouses(raw: RawProduct): Array<{ city: string; qty: number }> {
  return (raw.warehouses as Array<{ city?: unknown; amount?: unknown; qty?: unknown }>)
    .map((row) => ({
      city: typeof row.city === "string" ? row.city.trim() : "",
      qty: Number(row.amount ?? row.qty),
    }))
    .filter((row) => row.city && Number.isFinite(row.qty) && row.qty > 0)
    .sort((left, right) => right.qty - left.qty);
}

function productFromRaw(raw: RawProduct, leaf: string, unit: string): ProductFull {
  const id = String(raw.id);
  const pagetitle = String(raw.pagetitle ?? raw.name).trim();
  const options = Array.isArray(raw.options) ? raw.options as Array<Record<string, unknown>> : [];
  const traits: string[] = [];
  const facetValues = new Map<string, Set<string>>();
  let vendor: string | null = null;
  for (const option of options) {
    if (!option || typeof option !== "object" || Array.isArray(option)) continue;
    const key = typeof option.key === "string" ? option.key.trim() : "";
    const caption = typeof option.caption_ru === "string" ? option.caption_ru.trim() : "";
    const value = typeof option.value_ru === "string" ? option.value_ru.trim() : "";
    if (key === "brend__brend" && value && !/^[А-ЯЁ]{2,6}(нг)?[\s\d.,*хХx/-]{0,8}$/u.test(value)) vendor = value;
    if (!key || !value || isAdministrativeCatalogField({ key, caption })) continue;
    if (caption && `${caption}: ${value}`.length <= 160) traits.push(`${caption}: ${value}`);
    if (key.length <= 240 && value.length <= 240) {
      const set = facetValues.get(key) ?? new Set<string>();
      set.add(value);
      facetValues.set(key, set);
    }
  }
  const warehouses = positiveWarehouses(raw);
  const article = typeof raw.article === "string" && raw.article.trim()
    ? raw.article.trim().slice(0, 120) : null;
  return {
    id, pagetitle, vendor, price: Number(raw.price), article, unit,
    stock: warehouses.reduce((sum, row) => sum + row.qty, 0) < 3 ? "low" : "in_stock",
    short_traits: traits,
    description_excerpt: sanitizeCatalogDescription(raw.content),
    leaf_category: leaf,
    warehouses,
    url: normalizeProductUrl(raw.url)!,
    warehouse_evidence: "positive",
    ...(facetValues.size > 0
      ? { facet_values: Object.fromEntries([...facetValues].map(([key, values]) => [key, [...values]])) }
      : {}),
  };
}

/**
 * No user/LLM text is sent as a catalog full-text query. The user-owned exact
 * phrase is applied only AFTER all rows of all trusted live leaves are fetched.
 * The caller must use the returned product only on `ok: true`; a failure must
 * suppress any unproven "самый дешёвый/дорогой" claim.
 */
export async function selectCompleteCategoryPrice(
  input: CompleteCategoryPriceInput,
  deps: CatalogClientDeps,
  cache: ProductCache,
): Promise<CompleteCategoryPriceResult> {
  const scope = validScope(input);
  if (!scope || !deps.baseUrl || !deps.apiToken) {
    return fail("invalid_scope", "exact compound and a complete live leaf-category scope are required");
  }
  const { leaves } = scope;
  const deadline = Date.now() + MAX_TOTAL_MS;
  const all = new Map<string, { raw: RawProduct; leaf: string }>();
  let declaredRawTotal = 0;
  for (const leaf of leaves) {
    const first = await fetchRawPage(leaf, 1, deps, deadline - Date.now());
    if (!first.ok) return first;
    if (declaredRawTotal + first.total > MAX_RAW_ROWS) {
      return fail("catalog_cap", `complete category exceeds ${MAX_RAW_ROWS} raw rows`);
    }
    declaredRawTotal += first.total;
    const pageCount = Math.ceil(first.total / PAGE_SIZE);
    if (first.rows.length !== Math.min(first.total, PAGE_SIZE)) {
      return fail("catalog_partial", `leaf ${leaf} first page is incomplete`);
    }
    for (let page = 1; page <= pageCount; page++) {
      const result = page === 1 ? first : await fetchRawPage(leaf, page, deps, deadline - Date.now());
      if (!result.ok) return result;
      if (result.total !== first.total ||
          result.rows.length !== Math.min(PAGE_SIZE, first.total - (page - 1) * PAGE_SIZE)) {
        return fail("catalog_partial", `leaf ${leaf} page ${page} is incomplete or changed`);
      }
      for (const raw of result.rows) {
        const declared = declaredLeaf(raw);
        if (declared && normalize(declared) !== normalize(leaf)) {
          return fail("catalog_partial", `row category disagrees with requested leaf ${leaf}`);
        }
        const id = raw.id === null || raw.id === undefined ? "" : String(raw.id).trim();
        if (!id || all.has(id)) return fail("duplicate_page", `duplicate or missing catalog row ID in ${leaf}`);
        all.set(id, { raw, leaf });
      }
    }
  }
  if (all.size !== declaredRawTotal) return fail("catalog_partial", "declared and materialized row counts disagree");
  const candidates: Array<{ raw: RawProduct; leaf: string; unit: string; price: number }> = [];
  let restrictedExcluded = 0;
  let unpricedExcluded = 0;
  let zeroStockExcluded = 0;
  for (const { raw, leaf } of all.values()) {
    const title = typeof raw.pagetitle === "string" ? raw.pagetitle
      : typeof raw.name === "string" ? raw.name : "";
    const relation = titleRelation(title, input.request);
    if (relation === "unrelated") continue;
    if (isRestrictedCatalogProduct(raw)) { restrictedExcluded++; continue; }
    const price = Number(raw.price);
    if (!Number.isFinite(price) || price <= 0) { unpricedExcluded++; continue; }
    const stock = warehouseProof(raw);
    if (stock === "zero") { zeroStockExcluded++; continue; }
    if (stock !== "positive") return fail("unverified_candidate", `stock is unverified for catalog row ${raw.id}`);
    if (relation === "ambiguous") return fail("unverified_candidate", `title class or marking is ambiguous for catalog row ${raw.id}`);
    const unit = extractUnit(raw)?.normalize("NFKC").trim().toLocaleLowerCase("ru-RU").replace(/\.$/u, "");
    if (!unit || !normalizeProductUrl(raw.url)) {
      return fail("unverified_candidate", `unit or product URL is unverified for catalog row ${raw.id}`);
    }
    candidates.push({ raw, leaf, unit, price });
  }
  if (!candidates.length) return fail("no_candidate", "no available, priced, exact-title candidate in the complete category");
  const units = [...new Set(candidates.map((candidate) => candidate.unit))];
  if (units.length !== 1) return {
    ...fail("mixed_units", "exact candidates use incomparable catalog sale units"),
    unit_options: units.slice(0, 5),
  };
  const direction = input.request.priceDirection === "expensive" ? -1 : 1;
  candidates.sort((left, right) => direction * (left.price - right.price) ||
    String(left.raw.id).localeCompare(String(right.raw.id)));
  const winner = candidates[0];
  const full = productFromRaw(winner.raw, winner.leaf, units[0]);
  cache.set(full.id, full);
  const { url: _url, warehouse_evidence: _warehouse, facet_values: _facets, ...product } = full;
  return {
    ok: true,
    product,
    evidence: {
      scope_category: input.discovery.category.pagetitle,
      taxonomy_leaf_count: scope.taxonomyLeafCount,
      skipped_other_marking_leaves: scope.skippedOtherMarkingLeaves,
      leaf_categories: leaves,
      raw_rows: declaredRawTotal,
      matching_available: candidates.length,
      restricted_excluded: restrictedExcluded,
      unpriced_excluded: unpricedExcluded,
      zero_stock_excluded: zeroStockExcluded,
      unit: units[0],
      selected_price: winner.price,
      tied_count: candidates.filter((item) => item.price === winner.price).length,
    },
  };
}
