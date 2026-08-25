// V3 tool: jargon_recover_catalog — direct lexical recovery + catalog validation.
// Data-agnostic: candidates come from the LLM helper, every result is verified by /products.

import { executeSearchCatalog, type CatalogClientDeps } from "./search-catalog.ts";
import { tryJargonFallback } from "./jargon-fallback.ts";
import type { JargonRecoverOk, ProductCache, ProductRef, ToolError } from "./types.ts";

export interface JargonRecoverCatalogInput {
  query: string;
  modifiers?: string[];
  min_price?: number;
  max_price?: number;
  per_page?: number;
  category?: string;
}

export interface JargonRecoverCatalogDeps extends CatalogClientDeps {
  openrouterApiKey: string;
  /** Флаг: передавать ли активную категорию в jargon-помощник для более точных кандидатов. */
  categoryContextEnabled?: boolean;
  /** Флаг: при пустом пересечении с modifiers возвращать базовые товары и класть модификаторы в unmatched_tokens (не «резать в 0»). */
  axialModifiersEnabled?: boolean;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function normalizeCodeLike(s: string): string {
  const map: Record<string, string> = { а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x" };
  return normalize(s).replace(/[авекмнорстух]/gu, (ch) => map[ch] ?? ch).replace(/\s+/g, "");
}

/**
 * Proves that a catalog title supports the exact query selected by the jargon
 * helper. This is intentionally lexical and data-agnostic: it accepts neither
 * a synonym dictionary nor the helper's claim alone. Every meaningful query
 * token must be visible in the live product title. Code-like tokens may span
 * spaces/punctuation (for example, `ВВГнг` in `ВВГ нг`).
 *
 * A single ordinary word is too broad to terminate the search (`лампа` could
 * match thousands of unrelated forms). A lone token is accepted only when it
 * is structurally distinctive: it contains Latin letters, digits, or a mixed
 * alphanumeric/code shape.
 */
export function titleSupportsGroundedJargonQuery(title: string, matchedQuery: string): boolean {
  const tokens = normalize(matchedQuery).split(/\s+/).filter((token) => token.length >= 3);
  if (tokens.length === 0) return false;
  const rawSingleToken = matchedQuery.trim();
  const isCompactCyrillicCode = /^[А-ЯЁ]{2,4}(?:[а-яё]{1,4})?$/u.test(rawSingleToken);
  if (tokens.length === 1 && !/[a-z\d]/iu.test(tokens[0]) && !isCompactCyrillicCode) return false;

  const normalizedTitle = normalize(title);
  const compactTitle = normalizeCodeLike(title);
  return tokens.every((token) =>
    normalizedTitle.split(/\s+/).includes(token) || compactTitle.includes(normalizeCodeLike(token))
  );
}

/**
 * Recovers only a live-title-grounded subset that a preceding jargon lookup
 * already loaded into the request cache. The caller supplies any additional
 * literal invariant (for example an exact N×S marking); this helper merely
 * keeps candidate order, title evidence and deduplication data-agnostic.
 *
 * It deliberately rejects broad one-word candidates through
 * titleSupportsGroundedJargonQuery and never performs another catalog call.
 */
export function selectGroundedJargonCacheFallback(
  products: ProductRef[],
  candidates: string[],
  additionalTitleEvidence: (product: ProductRef) => boolean,
): { matchedQuery: string; results: ProductRef[] } | null {
  for (const candidate of candidates) {
    const byId = new Map<string, ProductRef>();
    for (const product of products) {
      if (!Number.isFinite(product.price) || product.price <= 0) continue;
      if (!titleSupportsGroundedJargonQuery(product.pagetitle, candidate)) continue;
      if (!additionalTitleEvidence(product)) continue;
      if (!byId.has(product.id)) byId.set(product.id, product);
    }
    const results = [...byId.values()];
    if (results.length > 0) return { matchedQuery: candidate, results };
  }
  return null;
}

function tokenize(s: string): string[] {
  return normalize(s).split(/\s+/).filter((t) => t.length >= 3);
}

/**
 * Lets the lexical helper see descriptive axes that may change the catalog
 * term, while keeping numeric/code-like modifiers as independent constraints.
 * The split is vocabulary-free and uses only the shape of model-owned text.
 */
export function splitSemanticJargonModifiers(modifiers: string[]): { semantic: string[]; structural: string[] } {
  const semantic: string[] = [];
  const structural: string[] = [];
  for (const raw of modifiers) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    const normalized = normalize(value);
    const descriptive = Boolean(normalized) && /\p{L}/u.test(normalized) && !/\d/u.test(normalized) &&
      normalized.split(/\s+/u).every((token) => token.length >= 3);
    (descriptive ? semantic : structural).push(value);
  }
  return { semantic, structural };
}

function productHaystack(p: ProductRef): string {
  return normalize(`${p.pagetitle} ${p.vendor ?? ""} ${p.short_traits.join(" ")}`);
}

function productMatchesModifiers(p: ProductRef, modifiers: string[]): boolean {
  const clean = modifiers.map(normalize).filter(Boolean);
  if (clean.length === 0) return true;
  const rawHaystack = `${p.pagetitle} ${p.vendor ?? ""} ${p.short_traits.join(" ")}`;
  const haystack = normalize(rawHaystack);
  const codeHaystack = normalizeCodeLike(rawHaystack);
  return clean.every((m) => {
    if (/\d/.test(m) && /\p{L}/u.test(m)) return codeHaystack.includes(normalizeCodeLike(m));
    return haystack.includes(m);
  });
}

/**
 * Считает токены исходного запроса+modifiers, которые не встречаются НИ В ОДНОЙ карточке.
 * Data-agnostic: никаких словарей форм/типов/категорий, чисто лексическая проверка.
 */
function computePartialMatch(
  sourceQuery: string,
  modifiers: string[],
  results: ProductRef[],
): { partial_match: boolean; unmatched_tokens: string[] } {
  if (results.length === 0) {
    return { partial_match: false, unmatched_tokens: [] };
  }
  const sourceTokens = tokenize(sourceQuery);
  const modifierTokens = modifiers.flatMap(tokenize);
  const allTokens = Array.from(new Set([...sourceTokens, ...modifierTokens]));
  if (allTokens.length === 0) {
    return { partial_match: false, unmatched_tokens: [] };
  }
  const haystacks = results.map(productHaystack);
  const unmatched = allTokens.filter((tok) => !haystacks.some((h) => h.includes(tok)));
  return { partial_match: unmatched.length > 0, unmatched_tokens: unmatched };
}

export async function executeJargonRecoverCatalog(
  input: JargonRecoverCatalogInput,
  deps: JargonRecoverCatalogDeps,
  cache: ProductCache,
): Promise<(JargonRecoverOk & { tool: "jargon_recover_catalog" }) | (ToolError & { tool: "jargon_recover_catalog" })> {
  const source = (input.query ?? "").trim();
  if (!source) return { tool: "jargon_recover_catalog", ok: false, error_code: "bad_input", message: "query required" };

  const modifiers = input.modifiers ?? [];
  const perPage = input.per_page ?? 10;
  const categoryHint = deps.categoryContextEnabled && input.category ? input.category.trim() : undefined;

  const jargon = await tryJargonFallback(source, {
    apiKey: deps.openrouterApiKey,
    category: categoryHint,
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
  });
  const candidates = [
    ...(jargon.ok ? jargon.candidates : []),
    source,
  ].map((c) => c.trim()).filter(Boolean).filter((c, i, arr) => arr.findIndex((x) => normalize(x) === normalize(c)) === i);
  const allCandidates = [...candidates];
  const attemptedCandidates = new Set<string>();

  type CandidateAttempt = {
    matched: { candidate: string; filtered: ProductRef[] } | null;
    axial: { candidate: string; baseResults: ProductRef[] } | null;
  };
  const tryCandidates = async (values: string[], activeModifiers: string[]): Promise<CandidateAttempt> => {
    let axial: CandidateAttempt["axial"] = null;
    for (const candidate of values.slice(0, 4)) {
      const candidateKey = normalize(candidate);
      if (!candidateKey || attemptedCandidates.has(candidateKey)) continue;
      attemptedCandidates.add(candidateKey);
      const result = await executeSearchCatalog({
        mode: "by_query",
        query: candidate,
        // The discovered category is a hard relevance boundary, not merely an
        // LLM hint. Without it a plausible lexical candidate can return an
        // unrelated product from another catalog branch.
        category: input.category,
        min_price: input.min_price,
        max_price: input.max_price,
        per_page: perPage,
      }, deps, cache);
      if (!result.ok) continue;

      // A non-empty search response is not lexical proof: catalog search may
      // broaden or tokenize a candidate and return products that contain only
      // its generic part. Keep walking the helper's candidates until the
      // complete selected term is visible in live titles.
      const groundedResults = result.results.filter((product) =>
        titleSupportsGroundedJargonQuery(product.pagetitle, candidate)
      );
      const filtered = groundedResults.filter((p) => productMatchesModifiers(p, activeModifiers));
      if (filtered.length > 0) return { matched: { candidate, filtered }, axial };
      if (deps.axialModifiersEnabled && axial === null && groundedResults.length > 0 && activeModifiers.length > 0) {
        axial = { candidate, baseResults: groundedResults };
      }
    }
    return { matched: null, axial };
  };

  const initial = await tryCandidates(candidates, modifiers);
  let matched = initial.matched;
  let axialFallback = initial.axial;

  // A lexical helper often returns a translated phrase while live titles mix
  // languages (for example a Russian class noun plus a Latin family token).
  // If no complete phrase is title-grounded, try its atomic tokens from most
  // distinctive to shortest. The title-proof policy still rejects broad
  // ordinary one-word candidates, so this is not an unguarded OR search.
  if (!matched) {
    const atomicCandidates = candidates
      .flatMap((candidate) => tokenize(candidate))
      .filter((candidate, index, values) =>
        !candidates.some((full) => normalize(full) === normalize(candidate)) &&
        values.findIndex((value) => normalize(value) === normalize(candidate)) === index
      )
      .sort((left, right) => right.length - left.length);
    for (const candidate of atomicCandidates) {
      if (!allCandidates.some((known) => normalize(known) === normalize(candidate))) allCandidates.push(candidate);
    }
    const atomic = await tryCandidates(atomicCandidates, modifiers);
    matched = atomic.matched;
    axialFallback ??= atomic.axial;
  }

  // If literal modifier matching is empty, translate the consultant's own
  // descriptive modifiers together with its query. Numeric/code-like axes stay
  // independent, and the caller still verifies matched_query in live titles.
  if (!matched) {
    const bridged = splitSemanticJargonModifiers(modifiers);
    const bridgeSource = [source, ...bridged.semantic].join(" ").replace(/\s+/gu, " ").trim();
    if (bridged.semantic.length > 0 && normalize(bridgeSource) !== normalize(source)) {
      const bridgeJargon = await tryJargonFallback(bridgeSource, {
        apiKey: deps.openrouterApiKey,
        category: categoryHint,
        fetchImpl: deps.fetchImpl,
        timeoutMs: deps.timeoutMs,
      });
      const bridgeCandidates = [
        ...(bridgeJargon.ok ? bridgeJargon.candidates : []),
        bridgeSource,
      ].map((candidate) => candidate.trim()).filter(Boolean)
        .filter((candidate, index, values) => values.findIndex((value) => normalize(value) === normalize(candidate)) === index);
      for (const candidate of bridgeCandidates) {
        if (!allCandidates.some((known) => normalize(known) === normalize(candidate))) allCandidates.push(candidate);
      }
      const bridge = await tryCandidates(bridgeCandidates, bridged.structural);
      matched = bridge.matched;
      axialFallback ??= bridge.axial;
    }
  }

  if (matched) {
    const sliced = matched.filtered.slice(0, perPage);
    const { partial_match, unmatched_tokens } = computePartialMatch(source, modifiers, sliced);
    return {
      tool: "jargon_recover_catalog",
      ok: true,
      source_query: source,
      candidates: allCandidates,
      matched_query: matched.candidate,
      results: sliced,
      total: matched.filtered.length,
      partial_match,
      unmatched_tokens,
    };
  }

  // Флаг v3_jargon_axial_modifiers_enabled: возвращаем базовые карточки без
  // модификаторов и честно сообщаем модели, что именно не совпало.
  if (deps.axialModifiersEnabled && axialFallback) {
    const sliced = axialFallback.baseResults.slice(0, perPage);
    // Явно объявляем ВСЕ токены модификаторов как unmatched — это ключевой сигнал
    // для модели: карточки существуют по noun, но конкретный модификатор клиента
    // (например «E27» при CORN-лампах с G4/G9/E14) в этих карточках отсутствует.
    const modifierTokens = Array.from(new Set(modifiers.flatMap(tokenize)));
    const { unmatched_tokens: computed } = computePartialMatch(source, modifiers, sliced);
    const unmatched_tokens = Array.from(new Set([...modifierTokens, ...computed]));
    return {
      tool: "jargon_recover_catalog",
      ok: true,
      source_query: source,
      candidates: allCandidates,
      matched_query: axialFallback.candidate,
      results: sliced,
      total: sliced.length,
      partial_match: true,
      unmatched_tokens,
    };
  }

  return {
    tool: "jargon_recover_catalog",
    ok: true,
    source_query: source,
    candidates: allCandidates,
    matched_query: null,
    results: [],
    total: 0,
    partial_match: false,
    unmatched_tokens: [],
  };
}
