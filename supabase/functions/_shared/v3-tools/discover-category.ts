// V3 tool: discover_category.
// 1) noun/query → live /categories list → exact pagetitle resolver (LLM over real list)
// 2) exact pagetitle → GET /categories/options
// Data-agnostic: НИКАКИХ доменных списков категорий/фасетов в коде.

import type { CatalogClientDeps } from "./search-catalog.ts";
import {
  compactFacetCodeSupportScore,
  resolveCompoundFacetValueEvidence,
  type CompactCodeFacet,
} from "./compact-facet-code.ts";
import { isAdministrativeCatalogField } from "./catalog-field-policy.ts";
import { extractCustomerOwnedDiscoveryTarget } from "./category-reasoning-guard.ts";

const CATEGORIES_TTL_MS = 60 * 60 * 1000;
const MODEL = "google/gemini-2.5-flash";

interface CategoryNode {
  id: number;
  pagetitle: string;
  parentId: number | null;
  childrenIds: number[];
}

export interface CategoryTreeNode {
  id: number;
  pagetitle: string;
  parentId: number | null;
  childrenIds: number[];
}

interface CategoriesCache {
  flat: CategoryCandidate[];           // для exact/LLM-резолвера по pagetitle
  byId: Map<number, CategoryNode>;     // для обхода поддерева (родитель → дети)
  byPagetitle: Map<string, number>;    // pagetitle (нормализованный) → id
  isLeaf: Map<string, boolean>;        // нормализованный pagetitle → лист ли (childrenIds.length === 0)
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
  resolution_method?: "exact" | "live_taxonomy" | "live_facet_schema" | "model";
}

export interface DiscoverCategoryErr {
  ok: false;
  error_code: "category_not_found" | "catalog_timeout" | "transport_5xx" | "bad_input" | "internal";
  message: string;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const LOCAL_CATEGORY_GRAMMAR_WORDS = new Set([
  "без", "для", "или", "над", "под", "при", "про", "через",
]);

const LOCAL_CATEGORY_MODIFIER_PREPOSITIONS = new Set([
  "без", "в", "во", "для", "до", "из", "к", "ко", "на", "над", "от", "под", "при", "про", "с", "со", "через",
]);

const LOCAL_CATEGORY_NEGATION_WORDS = new Set(["не", "ни"]);

const LOCAL_CATEGORY_RU_SUFFIXES = [
  "ыми", "ими", "ого", "его", "ому", "ему",
  "ая", "яя", "ое", "ее", "ой", "ей", "ом", "ем", "ую", "юю",
  "ый", "ий", "ые", "ие", "ых", "их", "ам", "ям", "ах", "ях", "ов", "ев",
  "у", "ю", "а", "я", "о", "е", "ы", "и",
];

const LOCAL_CATEGORY_RU_ADJECTIVE_SUFFIXES = [
  "ыми", "ими", "ого", "его", "ому", "ему",
  "ая", "яя", "ое", "ее", "ой", "ей", "ом", "ем", "ую", "юю",
  "ый", "ий", "ые", "ие", "ых", "их", "ым", "им",
];

function localCategoryStem(token: string): string {
  if (!/^[а-я]+$/u.test(token) || token.length < 5) return token;
  for (const suffix of LOCAL_CATEGORY_RU_SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

function localCategoryTokenMatches(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length < 4 || right.length < 4) return false;
  const a = localCategoryStem(left);
  const b = localCategoryStem(right);
  if (a === b) return true;
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  const shorter = Math.min(a.length, b.length);
  const longer = Math.max(a.length, b.length);
  // Inflectional forms stay close in total stem length. A short standalone
  // class head must not match a longer compound word merely because both
  // begin alike (`кабель` vs `кабеленесущие`). That false prefix match can
  // route an otherwise explicit product request into a sibling taxonomy.
  return shared >= 5 && shared / shorter >= 0.6 && shared / longer >= 0.55;
}

function localCategoryTokens(value: string): string[] {
  return normalize(value).split(" ").filter((token) =>
    token.length >= 2 &&
    token !== "и" &&
    !LOCAL_CATEGORY_GRAMMAR_WORDS.has(token) &&
    !LOCAL_CATEGORY_MODIFIER_PREPOSITIONS.has(token)
  );
}

function categoryDiscriminatorTokens(value: string): string[] {
  return normalize(value).split(" ").filter((token) =>
    token.length >= 2 &&
    token !== "и" &&
    !LOCAL_CATEGORY_GRAMMAR_WORDS.has(token)
  );
}

function isLikelyRussianAdjective(token: string): boolean {
  return /^[а-я]+$/u.test(token) && LOCAL_CATEGORY_RU_ADJECTIVE_SUFFIXES.some((suffix) =>
    token.endsWith(suffix) && token.length - suffix.length >= 4
  );
}

/**
 * A customer may use the unique first word of a compound live category as a
 * standalone class name (`автомат` for `Автоматические выключатели`). Permit
 * that only when the token is head-like rather than an adjective/modifier and
 * exactly one live category starts with the matching stem. This deliberately
 * remains fail-closed for shared heads such as `кабель` and for phrases like
 * `для автоматического ...`; no product alias is encoded here.
 */
function groundedHeadTokenForCategory(
  rawQueryTokens: string[],
  pagetitle: string,
): string | null {
  const categoryTokens = localCategoryTokens(pagetitle);
  if (categoryTokens.length < 2) return null;
  const categoryHead = categoryTokens[0];
  return rawQueryTokens.find((queryToken, index) =>
      queryToken.length >= 5 &&
      !isLikelyRussianAdjective(queryToken) &&
      localCategoryTokenMatches(categoryHead, queryToken) &&
      (index === 0 || (
        !LOCAL_CATEGORY_MODIFIER_PREPOSITIONS.has(rawQueryTokens[index - 1]) &&
        !rawQueryTokens.slice(Math.max(0, index - 3), index)
          .some((token) => LOCAL_CATEGORY_NEGATION_WORDS.has(token))
      ))
    ) ?? null;
}

export function resolveGroundedCategoryHeadToken(
  queryText: string,
  pagetitle: string,
): string | null {
  return groundedHeadTokenForCategory(
    normalize(queryText).split(" ").filter(Boolean),
    pagetitle,
  );
}

/**
 * A semantic matcher may correctly recognise the customer-owned product head
 * but still guess an unrequested leaf below it. Application context alone is
 * not proof of a catalogue subtype: selecting such a leaf makes every later
 * reasoning/search step rationalise the same initial mistake. When the leaf
 * adds a discriminator absent from the customer text, keep the nearest live
 * ancestor that still owns the grounded head. The later reasoning step can
 * then select a subtype from live facets or ask for a genuinely necessary
 * clarification. Explicit leaf markings remain unchanged.
 *
 * This is taxonomy-only and category-neutral: the vocabulary is supplied by
 * the current customer text and live tree.
 */
export function liftUngroundedLeafToCustomerHeadAncestor(
  queryText: string,
  winnerPagetitle: string,
  nodes: Iterable<CategoryTreeNode>,
): string {
  const nodeList = [...nodes];
  const byId = new Map(nodeList.map((node) => [node.id, node]));
  const winner = nodeList.find((node) => normalize(node.pagetitle) === normalize(winnerPagetitle));
  if (!winner || winner.childrenIds.length > 0) return winnerPagetitle;

  const rawQueryTokens = normalize(queryText).split(" ").filter(Boolean);
  const winnerTokens = categoryDiscriminatorTokens(winner.pagetitle);
  const groundedHead = groundedHeadTokenForCategory(rawQueryTokens, winner.pagetitle) ?? (
    winnerTokens.length >= 2
      ? rawQueryTokens.find((queryToken, index) =>
        queryToken.length >= 4 &&
        !isLikelyRussianAdjective(queryToken) &&
        localCategoryTokenMatches(winnerTokens[0], queryToken) &&
        (index === 0 || (
          !LOCAL_CATEGORY_MODIFIER_PREPOSITIONS.has(rawQueryTokens[index - 1]) &&
          !rawQueryTokens.slice(Math.max(0, index - 3), index)
            .some((token) => LOCAL_CATEGORY_NEGATION_WORDS.has(token))
        ))
      ) ?? null
      : null
  );
  if (!groundedHead) return winnerPagetitle;

  const discriminators = winnerTokens
    .filter((token) => !localCategoryTokenMatches(token, groundedHead));
  const discriminatorsGrounded = discriminators.length > 0 && discriminators.every((token) =>
    rawQueryTokens.some((candidate) => localCategoryTokenMatches(token, candidate))
  );
  if (discriminatorsGrounded) return winnerPagetitle;

  let parentId = winner.parentId;
  const visited = new Set<number>();
  while (parentId !== null && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    const preservesHead = categoryDiscriminatorTokens(parent.pagetitle)
      .some((token) => localCategoryTokenMatches(token, groundedHead));
    if (parent.childrenIds.length > 0 && preservesHead) return parent.pagetitle;
    parentId = parent.parentId;
  }
  return winnerPagetitle;
}

function collectHeadCategoryCandidates(
  rawQueryTokens: string[],
  pagetitles: string[],
): string[] {
  return pagetitles.filter((pagetitle) =>
    groundedHeadTokenForCategory(rawQueryTokens, pagetitle) !== null
  );
}

function resolveUniqueHeadCategory(
  rawQueryTokens: string[],
  pagetitles: string[],
): string[] {
  const candidates = collectHeadCategoryCandidates(rawQueryTokens, pagetitles);
  return candidates.length === 1 ? candidates : [];
}

interface CategoryFacetEvidence extends CompactCodeFacet {
  caption: string;
}

/**
 * A compact customer code can encode values from two independent live axes
 * (`C16` => value `C` on one facet plus value `16` on another). Recognise that
 * relation from the candidate's live schema only: no category, brand or
 * product vocabulary is embedded here. Both axes must be present, a lone
 * mixed value is insufficient, and ambiguity between candidates remains a
 * fail-closed tie.
 */
/**
 * Disambiguate several live categories sharing the same customer head only by
 * their own live facet schema. Two distinct pieces of query evidence must
 * support one candidate, and its score must be unique. Evidence may be an
 * explicit facet caption or a compact code proven by values from two live
 * facet axes. A single generic word or a tie is insufficient, so semantic
 * resolution remains fail-closed.
 */
export function resolveHeadCategoryByFacetEvidence(
  queryText: string,
  candidates: Array<{ pagetitle: string; facets: CategoryFacetEvidence[] }>,
): string | null {
  const queryTokens = Array.from(new Set(localCategoryTokens(queryText).filter((token) => token.length >= 5)));
  const scored = candidates.map((candidate) => {
    const matchedAxes = queryTokens.filter((queryToken) =>
      candidate.facets.some((facet) =>
        localCategoryTokens(facet.caption).some((facetToken) =>
          localCategoryTokenMatches(facetToken, queryToken)
        )
      )
    );
    const compactScore = compactFacetCodeSupportScore(queryText, candidate.facets);
    const compoundScore = resolveCompoundFacetValueEvidence(queryText, candidate.facets).length * 2;
    return {
      pagetitle: candidate.pagetitle,
      score: matchedAxes.length + compactScore + compoundScore,
    };
  }).sort((left, right) => right.score - left.score || left.pagetitle.localeCompare(right.pagetitle));
  const best = scored[0];
  if (!best || best.score < 2) return null;
  return scored.filter((candidate) => candidate.score === best.score).length === 1
    ? best.pagetitle
    : null;
}

function orderedTokenStart(categoryTokens: string[], queryTokens: string[]): number | null {
  let queryIndex = 0;
  let start = -1;
  for (const categoryToken of categoryTokens) {
    while (
      queryIndex < queryTokens.length &&
      !localCategoryTokenMatches(categoryToken, queryTokens[queryIndex])
    ) queryIndex += 1;
    if (queryIndex >= queryTokens.length) return null;
    if (start < 0) start = queryIndex;
    queryIndex += 1;
  }
  return start;
}

/**
 * Resolve an obvious category name without a model call, using only titles
 * from the live taxonomy. Every meaningful category token must be present in
 * the customer text (with conservative inflection matching), and a tied best
 * match is rejected as ambiguous. This is a quota/speed fallback, not a
 * product dictionary: jargon and semantic aliases still go to the resolver.
 */
export function resolveLocalCategoryPagetitles(
  input: DiscoverCategoryInput,
  pagetitles: string[],
): string[] {
  const completeQueryText = [input.semantic_query ?? "", input.noun].join(" ");
  // A transformation names both the source product and the destination.
  // Only the customer-owned destination is positive category evidence; using
  // the complete sentence makes two otherwise obvious live classes tie and
  // needlessly sends the request to the model resolver.
  const queryText = extractCustomerOwnedDiscoveryTarget(completeQueryText) ??
    completeQueryText;
  const rawQueryTokens = normalize(queryText).split(" ").filter(Boolean);
  const queryTokens = localCategoryTokens(queryText);
  if (queryTokens.length === 0) return [];

  const ranked = pagetitles.map((pagetitle) => {
    const categoryTokens = localCategoryTokens(pagetitle);
    if (
      categoryTokens.length === 0 ||
      !categoryTokens.every((token) => queryTokens.some((queryToken) =>
        localCategoryTokenMatches(token, queryToken)
      ))
    ) return null;
    const orderedStart = orderedTokenStart(categoryTokens, rawQueryTokens);
    const relationRole = orderedStart !== null && orderedStart > 0 &&
        LOCAL_CATEGORY_MODIFIER_PREPOSITIONS.has(rawQueryTokens[orderedStart - 1])
      ? 0
      : 1;
    return {
      pagetitle,
      tokenCount: categoryTokens.length,
      relationRole,
      ordered: orderedStart === null ? 0 : 1,
    };
  }).filter((candidate): candidate is {
    pagetitle: string;
    tokenCount: number;
    relationRole: number;
    ordered: number;
  } => Boolean(candidate));

  ranked.sort((left, right) =>
    right.relationRole - left.relationRole ||
    right.tokenCount - left.tokenCount ||
    right.ordered - left.ordered ||
    left.pagetitle.localeCompare(right.pagetitle)
  );
  const best = ranked[0];
  if (!best) return resolveUniqueHeadCategory(rawQueryTokens, pagetitles);
  const tied = ranked.filter((candidate) =>
    candidate.relationRole === best.relationRole &&
    candidate.tokenCount === best.tokenCount &&
    candidate.ordered === best.ordered
  );
  return tied.length === 1 ? [best.pagetitle] : [];
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
  // Build isLeaf map: листом считается узел без детей в дереве /categories.
  const isLeaf = new Map<string, boolean>();
  for (const node of acc.byId.values()) {
    isLeaf.set(normalize(node.pagetitle), node.childrenIds.length === 0);
  }
  categoriesCache = { flat: flatDeduped, byId: acc.byId, byPagetitle: acc.byPagetitle, isLeaf, ts: Date.now() };
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

/** Токены строки для overlap-сравнения (lowercase, ё→е, без пунктуации, длиннее 1 символа). */
function tokensOf(s: string): Set<string> {
  return new Set(normalize(s).split(" ").filter((t) => t.length > 1));
}

/**
 * Если LLM выбрал GROUP (зонтик), пытаемся заменить его на более конкретный лист
 * этого же поддерева, чьи токены лучше пересекаются с запросом. Полностью data-agnostic:
 * никаких доменных списков — работает на любом каталоге, у которого есть дерево /categories.
 */
function preferLeafWithinGroup(
  winnerPagetitle: string,
  queryTokens: Set<string>,
  cache: CategoriesCache,
): string {
  const isWinnerLeaf = cache.isLeaf.get(normalize(winnerPagetitle)) === true;
  if (isWinnerLeaf) return winnerPagetitle;
  const id = cache.byPagetitle.get(normalize(winnerPagetitle));
  if (typeof id !== "number") return winnerPagetitle;
  const leaves = collectLeafDescendants(id, cache.byId);
  if (leaves.length === 0) return winnerPagetitle;
  const winnerTokens = tokensOf(winnerPagetitle);
  // Очки = (токены листа ∩ query) − (токены листа ∩ winner), чтобы не плюсовать общие "лампы".
  let best: { pagetitle: string; score: number } | null = null;
  for (const leaf of leaves) {
    const lt = tokensOf(leaf.pagetitle);
    let extra = 0;
    for (const t of lt) if (queryTokens.has(t) && !winnerTokens.has(t)) extra++;
    if (extra <= 0) continue;
    if (!best || extra > best.score) best = { pagetitle: leaf.pagetitle, score: extra };
  }
  return best ? best.pagetitle : winnerPagetitle;
}

async function resolvePagetitle(
  input: DiscoverCategoryInput,
  deps: DiscoverCategoryDeps,
): Promise<{
  pagetitle: string;
  resolvedFrom?: string;
  resolutionMethod: NonNullable<DiscoverCategoryOk["resolution_method"]>;
  candidates: string[];
  cache: CategoriesCache;
  prefetched?: Map<string, DiscoverCategoryOk>;
} | null> {
  const noun = input.noun.trim();
  const cache = await fetchCategories(deps);
  const flat = cache.flat;
  const exact = flat.find((c) => normalize(c.pagetitle) === normalize(noun));
  if (exact) {
    return {
      pagetitle: exact.pagetitle,
      resolutionMethod: "exact",
      candidates: [exact.pagetitle],
      cache,
    };
  }
  const completeQueryText = [input.semantic_query ?? "", input.noun].join(" ");
  const queryText = extractCustomerOwnedDiscoveryTarget(completeQueryText) ??
    completeQueryText;
  const rawQueryTokens = normalize(queryText).split(" ").filter(Boolean);
  const localCandidates = resolveLocalCategoryPagetitles(input, flat.map((candidate) => candidate.pagetitle));
  if (localCandidates.length > 0) {
    return {
      pagetitle: localCandidates[0],
      resolvedFrom: groundedHeadTokenForCategory(rawQueryTokens, localCandidates[0]) ?? noun,
      resolutionMethod: "live_taxonomy",
      candidates: localCandidates,
      cache,
    };
  }
  const headCandidates = collectHeadCategoryCandidates(
    rawQueryTokens,
    flat.map((candidate) => candidate.pagetitle),
  );
  if (headCandidates.length > 1 && headCandidates.length <= 6) {
    const prefetched = new Map<string, DiscoverCategoryOk>();
    await Promise.all(headCandidates.map(async (pagetitle) => {
      const facets = await fetchFacetsForPagetitle(pagetitle, deps);
      if (facets.ok && isUsefulDiscovery(facets.data)) prefetched.set(pagetitle, facets.data);
    }));
    const schemaWinner = resolveHeadCategoryByFacetEvidence(queryText, headCandidates
      .map((pagetitle) => ({ pagetitle, facets: prefetched.get(pagetitle)?.facets ?? [] })));
    if (schemaWinner) {
      return {
        pagetitle: schemaWinner,
        resolvedFrom: groundedHeadTokenForCategory(rawQueryTokens, schemaWinner) ?? noun,
        resolutionMethod: "live_facet_schema",
        candidates: [schemaWinner],
        cache,
        prefetched,
      };
    }
  }
  if (!deps.openrouterApiKey) return null;

  const list = flat
    .map((c, i) => {
      const tag = cache.isLeaf.get(normalize(c.pagetitle)) ? "[LEAF]" : "[GROUP]";
      return `${i + 1}. ${tag} ${c.pagetitle}`;
    })
    .join("\n");
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
          content: `You are a CATEGORY MATCHER for an e-commerce catalog. Pick exact pagetitle values only from the provided live list. Each item is tagged [LEAF] (no children) or [GROUP] (umbrella with children). PREFER [LEAF] when the query specifies a subtype (e.g. modifier like material/form/technology); pick [GROUP] only when the query is generic and no leaf matches the subtype. If nothing is related, return {"candidates":[]}. Output strict JSON: {"candidates":[{"pagetitle":"<exact list item>","confidence":0.0}]}. No prose.`,
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
  // Страховка: если победитель — GROUP, и среди его листьев есть более конкретный по токенам запроса — берём лист.
  const qTokens = tokensOf([input.semantic_query ?? "", noun].join(" "));
  const refined = usable.map((p) => {
    const leafPreferred = preferLeafWithinGroup(p, qTokens, cache);
    return liftUngroundedLeafToCustomerHeadAncestor(
      [input.semantic_query ?? "", noun].join(" "),
      leafPreferred,
      cache.byId.values(),
    );
  });
  // Дедупликация с сохранением порядка.
  const seen = new Set<string>();
  const finalList: string[] = [];
  for (const p of refined) if (!seen.has(p)) { seen.add(p); finalList.push(p); }
  return {
    pagetitle: finalList[0],
    resolvedFrom: groundedHeadTokenForCategory(rawQueryTokens, finalList[0]) ?? noun,
    resolutionMethod: "model",
    candidates: finalList,
    cache,
  };
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
      if (isAdministrativeCatalogField({ key, caption })) continue;
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
      const prefetched = resolved.prefetched?.get(pagetitle);
      const facets = prefetched
        ? { ok: true as const, data: prefetched }
        : await fetchFacetsForPagetitle(pagetitle, deps);
      if (facets.ok && isUsefulDiscovery(facets.data)) {
        const leaves = resolveLeafCategories(facets.data.category.pagetitle, facets.data.category.id, resolved.cache);
        return {
          tool: "discover_category",
          ...facets.data,
          leaf_categories: leaves,
          resolved_from: resolved.resolvedFrom,
          resolution_method: resolved.resolutionMethod,
        };
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
