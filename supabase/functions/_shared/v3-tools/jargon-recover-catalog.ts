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
  /** Exact live leaves injected by the orchestrator after discovery. */
  category_in?: string[];
  /** Require descriptive modifiers to participate in one model-owned title token. */
  require_semantic_bridge?: boolean;
}

export interface JargonRecoverCatalogDeps extends CatalogClientDeps {
  openrouterApiKey: string;
  /** @deprecated A live discovered category is now always used as safe context. */
  categoryContextEnabled?: boolean;
  /**
   * @deprecated Truthful partial evidence is now an invariant rather than an
   * experiment. Kept only so older callers and database rows remain compatible.
   */
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

function inflectionStem(token: string): string {
  if (/^[a-z0-9]+$/u.test(token)) return token;
  if (token.length >= 7) return token.slice(0, 5);
  if (token.length >= 5) return token.slice(0, 4);
  return token;
}

/**
 * When the API omits a product's category object, the already discovered live
 * category may still be proved by the card title itself. Morphology is handled
 * mechanically (лампы ↔ лампа); no taxonomy or product vocabulary is stored.
 */
export function titleSupportsLiveCategoryLabel(title: string, categoryLabel: string): boolean {
  const categoryTokens = tokenize(categoryLabel).map(inflectionStem);
  if (categoryTokens.length === 0) return false;
  const titleTokens = tokenize(title).map(inflectionStem);
  return categoryTokens.every((token) => titleTokens.includes(token));
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

/** Keeps terminal lexical recovery consistent with the normal in-loop path.
 * A source word differing from a category-scoped, title-proven translation is
 * expected for jargon and is not an unresolved product constraint. Only
 * independently requested modifiers require a labelled axis split. */
export function classifyGroundedJargonEvidence(
  partialMatch: boolean,
  matchedQuery: string,
  candidateCount: number,
  unresolvedModifiers: string[],
): "empty" | "exact" | "axis_split" {
  if (!matchedQuery.trim() || candidateCount <= 0) return "empty";
  return partialMatch && unresolvedModifiers.length > 0 ? "axis_split" : "exact";
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
 * Proves one independently requested axis from visible catalog evidence.
 * Structural values (E27, IP65, 2x1.5) are compared punctuation-insensitively;
 * ordinary phrases must occur literally after normalization. The function is
 * deliberately vocabulary-free and therefore cannot manufacture synonyms.
 */
export function productSupportsGroundedAxis(product: ProductRef, axis: string): boolean {
  return titleSupportsGroundedAxis(
    `${product.pagetitle} ${product.vendor ?? ""} ${product.short_traits.join(" ")}`,
    axis,
  );
}

/** Same structural proof restricted to text that is visible in a card title. */
export function titleSupportsGroundedAxis(title: string, axis: string): boolean {
  const value = normalize(axis);
  if (!value) return false;
  const rawHaystack = String(title ?? "");
  if (/\d/u.test(value) && /\p{L}/u.test(value)) {
    return normalizeCodeLike(rawHaystack).includes(normalizeCodeLike(value));
  }
  return normalize(rawHaystack).includes(value);
}

function customerAxisLabel(value: string): string {
  return String(value ?? "")
    .replace(/[<>\p{Cc}*_`[\]()]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80);
}

/** Customer-facing disclaimer for evidence-backed, separately rendered axes. */
export function buildGroundedAxisSplitCaption(baseAxis: string, otherAxes: string[]): string {
  const labels = [baseAxis, ...otherAxes]
    .map(customerAxisLabel)
    .filter(Boolean)
    .filter((label, index, values) => values.findIndex((value) => normalize(value) === normalize(label)) === index)
    .slice(0, 4);
  const quoted = labels.map((label) => `«${label}»`);
  if (quoted.length < 2) {
    return "Точное сочетание всех условий в актуальном каталоге не подтвердилось. Показываю отдельно подтверждённое направление — это не полное совпадение с исходным запросом.";
  }
  return `Товаров, где одновременно подтверждены ${quoted.join(" и ")}, в актуальном каталоге не нашлось. Показываю эти направления отдельно: карточки из разных секций нельзя считать одним полным совпадением. Выберите, какое условие сохранить.`;
}

export function buildGroundedAxisSectionHeading(axis: string): string {
  const label = customerAxisLabel(axis) || "отдельное условие";
  return `**Отдельно подтверждено «${label}»:**`;
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
  // The caller may pass only a live discovered category. It is evidence, not
  // an experimental hint, so disabling an old rollout flag must not make the
  // lexical helper context-free and stochastic again.
  const categoryHint = input.category ? input.category.trim() : undefined;
  const categoryLeaves = Array.isArray(input.category_in)
    ? [...new Set(input.category_in.map(String).map((value) => value.trim()).filter(Boolean))]
    : [];

  const jargon = await tryJargonFallback(source, {
    apiKey: deps.openrouterApiKey,
    category: categoryHint,
    strategy: "translation_only",
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
    matched: { candidate: string; filtered: ProductRef[]; evidenceScore: number } | null;
    axial: { candidate: string; baseResults: ProductRef[]; evidenceScore: number } | null;
  };
  const tryCandidates = async (
    values: string[],
    activeModifiers: string[],
    allowAxial = true,
  ): Promise<CandidateAttempt> => {
    let axial: CandidateAttempt["axial"] = null;
    let matched: CandidateAttempt["matched"] = null;
    let matchedScore = -1;
    let axialScore = -1;
    const liveCategoryNames = new Set(
      [input.category, ...categoryLeaves]
        .map((value) => normalize(String(value ?? "")))
        .filter(Boolean),
    );
    const liveCategoryTokenStems = new Set(
      [...liveCategoryNames]
        .flatMap((value) => tokenize(value))
        .map(inflectionStem),
    );
    for (const candidate of values.slice(0, 4)) {
      const candidateKey = normalize(candidate);
      if (!candidateKey || attemptedCandidates.has(candidateKey)) continue;
      attemptedCandidates.add(candidateKey);
      // A candidate which merely repeats the already discovered live taxonomy
      // adds no evidence for the customer's unknown word. This rejects a
      // stochastic translation such as «светодиодная лампа» inside the live
      // leaf «Светодиодные лампы», without any product-specific dictionary.
      const candidateEvidenceTokens = tokenize(candidate)
        .filter((token) => !liveCategoryTokenStems.has(inflectionStem(token)));
      const candidateScore = candidateEvidenceTokens.length > 0
        ? candidateEvidenceTokens.reduce((sum, token) => sum + token.length, 0)
        : liveCategoryTokenStems.size > 0
        ? 0
        : normalize(candidate).replace(/\s+/gu, "").length;
      if (candidateScore <= 0) continue;
      const scopedInput: JargonRecoverCatalogInput = input;
      const categoryScope = categoryLeaves.length > 0
        ? { category_in: categoryLeaves }
        : input.category
          ? { category: input.category }
          : {};
      const result = await executeSearchCatalog({
        mode: "by_query",
        query: candidate,
        // The discovered category is a hard relevance boundary, not merely an
        // LLM hint. Without it a plausible lexical candidate can return an
        // unrelated product from another catalog branch.
        ...categoryScope,
        min_price: input.min_price,
        max_price: input.max_price,
        per_page: perPage,
      }, deps, cache);
      if (!result.ok) continue;

      // A non-empty search response is not lexical proof: catalog search may
      // broaden or tokenize a candidate and return products that contain only
      // its generic part. Keep walking the helper's candidates until the
      // complete selected term is visible in live titles.
      let groundedResults = result.results.filter((product) =>
        titleSupportsGroundedJargonQuery(product.pagetitle, candidate)
      );
      // Some catalog nodes returned by taxonomy are parents while /products
      // filters only by an immediate category name. If every live leaf probe
      // is empty, retry the SAME distinctive candidate once without the HTTP
      // category parameter, then retain only cards whose own live category is
      // the discovered umbrella/leaf. This repairs taxonomy/API shape drift
      // without opening a cross-category lexical fallback (LABEL OFF remains
      // outside the lamp branch, while a CORN card classified as «Лампы» is
      // admitted). Broad one-word candidates are still rejected by the title
      // proof above.
      if (result.results.length === 0 && liveCategoryNames.size > 0) {
        const unscoped = await executeSearchCatalog({
          mode: "by_query",
          query: candidate,
          min_price: scopedInput.min_price,
          max_price: scopedInput.max_price,
          per_page: perPage,
        }, deps, cache);
        if (unscoped.ok) {
          groundedResults = unscoped.results.filter((product) =>
            titleSupportsGroundedJargonQuery(product.pagetitle, candidate) &&
            (
              liveCategoryNames.has(normalize(product.leaf_category ?? "")) ||
              [input.category, ...categoryLeaves].some((category) =>
                titleSupportsLiveCategoryLabel(product.pagetitle, String(category ?? ""))
              )
            )
          );
        }
      }
      let filtered = groundedResults.filter((p) => productMatchesModifiers(p, activeModifiers));

      // The catalog returns only one bounded page for a lexical candidate.
      // When an independently proven structural value (E27, IP65, N×S, etc.)
      // is outside that first page, local filtering can falsely report an
      // empty intersection. Retry the SAME model-owned candidate with only the
      // structural modifiers appended to the catalog query, then keep the
      // original title and modifier proofs. Descriptive properties are never
      // appended here: they must first be translated by the semantic bridge.
      const structuralModifiers = splitSemanticJargonModifiers(activeModifiers).structural
        .filter((modifier) => !normalizeCodeLike(candidate).includes(normalizeCodeLike(modifier)));
      if (filtered.length === 0 && structuralModifiers.length > 0) {
        const combinedQuery = [candidate, ...structuralModifiers].join(" ").replace(/\s+/gu, " ").trim();
        const combined = await executeSearchCatalog({
          mode: "by_query",
          query: combinedQuery,
          ...categoryScope,
          min_price: input.min_price,
          max_price: input.max_price,
          per_page: perPage,
        }, deps, cache);
        let combinedGrounded = combined.ok
          ? combined.results.filter((product) =>
            titleSupportsGroundedJargonQuery(product.pagetitle, candidate)
          )
          : [];
        if (combinedGrounded.length === 0 && liveCategoryNames.size > 0) {
          const unscopedCombined = await executeSearchCatalog({
            mode: "by_query",
            query: combinedQuery,
            min_price: input.min_price,
            max_price: input.max_price,
            per_page: perPage,
          }, deps, cache);
          if (unscopedCombined.ok) {
            combinedGrounded = unscopedCombined.results.filter((product) =>
              titleSupportsGroundedJargonQuery(product.pagetitle, candidate) &&
              (
                liveCategoryNames.has(normalize(product.leaf_category ?? "")) ||
                [input.category, ...categoryLeaves].some((category) =>
                  titleSupportsLiveCategoryLabel(product.pagetitle, String(category ?? ""))
                )
              )
            );
          }
        }
        filtered = combinedGrounded.filter((product) => productMatchesModifiers(product, activeModifiers));
      }
      if (filtered.length > 0 && candidateScore > matchedScore) {
        matched = { candidate, filtered, evidenceScore: candidateScore };
        matchedScore = candidateScore;
      }
      // Preserve live evidence for the base lexical class even when an
      // independent modifier makes the strict intersection empty. Returning
      // this as an explicit partial match is an honesty boundary, so it must
      // not depend on an operational feature flag.
      if (
        allowAxial && filtered.length === 0 && groundedResults.length > 0 &&
        activeModifiers.length > 0 && candidateScore > axialScore
      ) {
        axial = { candidate, baseResults: groundedResults, evidenceScore: candidateScore };
        axialScore = candidateScore;
      }
    }
    return { matched, axial };
  };

  const initial = await tryCandidates(candidates, modifiers);
  let matched = initial.matched;
  let axialFallback = initial.axial;
  let semanticBridgeMatched = false;

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

  // If literal translation/transliteration produced no live base, ask once for
  // a professional title token. This weaker semantic route is never allowed to
  // create an axial split: an associated product with a missing modifier must
  // not be presented as one half of the customer's original combination.
  if (!matched && !axialFallback) {
    const translated = await tryJargonFallback(source, {
      apiKey: deps.openrouterApiKey,
      category: categoryHint,
      strategy: "title_token",
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs,
    });
    const translatedCandidates = (translated.ok ? translated.candidates : [])
      .map((candidate) => candidate.trim())
      .filter(Boolean)
      .filter((candidate, index, values) =>
        values.findIndex((value) => normalize(value) === normalize(candidate)) === index
      );
    for (const candidate of translatedCandidates) {
      if (!allCandidates.some((known) => normalize(known) === normalize(candidate))) allCandidates.push(candidate);
    }
    const translatedAttempt = await tryCandidates(translatedCandidates, modifiers, false);
    matched = translatedAttempt.matched;
    axialFallback ??= translatedAttempt.axial;
  }

  // If literal modifier matching is empty, translate the consultant's own
  // descriptive modifiers together with its query. Numeric/code-like axes stay
  // independent, and the caller still verifies matched_query in live titles.
  if (!matched || input.require_semantic_bridge) {
    const bridged = splitSemanticJargonModifiers(modifiers);
    const bridgeSource = [source, ...bridged.semantic].join(" ").replace(/\s+/gu, " ").trim();
    if (bridged.semantic.length > 0 && normalize(bridgeSource) !== normalize(source)) {
      const bridgeJargon = await tryJargonFallback(bridgeSource, {
        apiKey: deps.openrouterApiKey,
        category: categoryHint,
        strategy: "title_token",
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
      if (bridge.matched) {
        matched = bridge.matched;
        semanticBridgeMatched = true;
      }
      axialFallback ??= bridge.axial;
    }
  }

  if (matched) {
    const sliced = matched.filtered.slice(0, perPage);
    const { partial_match, unmatched_tokens } = computePartialMatch(source, modifiers, sliced);
    // A translated candidate that happens to satisfy the modifier is weaker
    // evidence than another live candidate which proves the lexical base but
    // explicitly misses that modifier. Prefer the latter as a labelled split;
    // otherwise an associated E27 product could hide the real CORN/G4 axis.
    const axialIsStronger = axialFallback &&
      normalize(axialFallback.candidate) !== normalize(matched.candidate) &&
      axialFallback.baseResults.some((product) =>
        titleSupportsGroundedJargonQuery(product.pagetitle, matched.candidate)
      );
    if (!(partial_match && axialIsStronger)) {
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
        semantic_bridge_matched: semanticBridgeMatched,
      };
    }
  }

  // Return base cards without silently dropping modifiers. The orchestrator
  // may render them only as separately labelled alternatives, never as proof
  // of the original combined request.
  if (axialFallback) {
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
      semantic_bridge_matched: false,
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
    semantic_bridge_matched: false,
  };
}
