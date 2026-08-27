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
    matched: { candidate: string; filtered: ProductRef[] } | null;
    axial: { candidate: string; baseResults: ProductRef[] } | null;
  };
  const tryCandidates = async (
    values: string[],
    activeModifiers: string[],
    allowAxial = true,
  ): Promise<CandidateAttempt> => {
    let axial: CandidateAttempt["axial"] = null;
    const liveCategoryNames = new Set(
      [input.category, ...categoryLeaves]
        .map((value) => normalize(String(value ?? "")))
        .filter(Boolean),
    );
    for (const candidate of values.slice(0, 4)) {
      const candidateKey = normalize(candidate);
      if (!candidateKey || attemptedCandidates.has(candidateKey)) continue;
      attemptedCandidates.add(candidateKey);
      const scopedInput: JargonRecoverCatalogInput = input;
      const result = await executeSearchCatalog({
        mode: "by_query",
        query: candidate,
        // The discovered category is a hard relevance boundary, not merely an
        // LLM hint. Without it a plausible lexical candidate can return an
        // unrelated product from another catalog branch.
        ...(categoryLeaves.length > 0
          ? { category_in: categoryLeaves }
          : input.category
            ? { category: input.category }
            : {}),
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
      const filtered = groundedResults.filter((p) => productMatchesModifiers(p, activeModifiers));
      if (filtered.length > 0) return { matched: { candidate, filtered }, axial };
      // Preserve live evidence for the base lexical class even when an
      // independent modifier makes the strict intersection empty. Returning
      // this as an explicit partial match is an honesty boundary, so it must
      // not depend on an operational feature flag.
      if (allowAxial && axial === null && groundedResults.length > 0 && activeModifiers.length > 0) {
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
  if (!matched) {
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
