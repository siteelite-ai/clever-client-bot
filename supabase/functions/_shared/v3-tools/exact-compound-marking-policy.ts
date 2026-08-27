import type { ProductRef } from "./types.ts";
import type { Criterion } from "./criteria-gate.ts";

export interface ExactCompoundMarkingRequest {
  query: string;
  first: number;
  second: number;
  priceDirection: "cheapest" | "expensive" | null;
}

export interface ExplicitCompoundMarking {
  first: number;
  second: number;
}

function norm(value: string): string {
  return String(value ?? "").toLocaleLowerCase("ru").replace(/ё/g, "е");
}

function number(value: string): number | null {
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

const SELECT_INTENT = /(?:^|[^\p{L}])(?:найд\p{L}*|ищ\p{L}*|покаж\p{L}*|подбер\p{L}*|нуж\p{L}*|хоч\p{L}*)(?=$|[^\p{L}])/u;
const INQUIRY_ONLY = /(?:^|[^\p{L}])(?:подойд\p{L}*|почему|можно\s+ли|совместим\p{L}*)(?=$|[^\p{L}])/u;
const COMPOUND = /\b(\d{1,3})\s*(?:x|х|×|\*)\s*(\d+(?:[.,]\d+)?)\b/iu;

/**
 * Produces one punctuation-only catalog spelling for an explicit N×S token.
 * Product words and their order remain exactly as the consultant supplied them.
 */
export function canonicalizeCompoundMarkingForCatalog(query: string): string {
  return query.replace(new RegExp(COMPOUND.source, "giu"), (_match, first: string, second: string) =>
    `${first}*${second.replace(".", ",")}`
  );
}

/**
 * Extracts only the explicit N×S token written by the user. This is deliberately
 * independent of product vocabulary and selection intent so the same literal
 * constraint can protect every final-render path, including semantic requests.
 */
export function extractExplicitCompoundMarking(message: string): ExplicitCompoundMarking | null {
  const match = norm(message).match(COMPOUND);
  if (!match) return null;
  const first = number(match[1]);
  const second = number(match[2]);
  return first === null || second === null ? null : { first, second };
}

/**
 * Detects when an explicit N×S lookup also contains semantic requirements that
 * cannot be proven by the compound marking alone. The rule is intentionally
 * structural: after request/sort language and the literal marking are removed,
 * more than two lexical terms means the model must project at least one
 * additional requirement into a machine-checkable render criterion. No
 * product nouns, brands, aliases, or catalog values are encoded here.
 */
export function requiresSemanticCompoundEvidence(message: string): boolean {
  if (!extractExplicitCompoundMarking(message)) return false;
  return (semanticCompoundSourceQuery(message).match(/\p{L}+/gu) ?? []).length > 2;
}

/** Model-owned lexical source for semantic recovery, with only request/sort
 * language and the literal N×S constraint removed. */
export function semanticCompoundSourceQuery(message: string): string {
  return norm(message)
    .replace(/[?!]/gu, " ")
    .replace(/(?:^|[^\p{L}])(?:како\p{L}*\s+есть|что\s+есть|все\s+позици\p{L}*|все\s+товар\p{L}*|все\s+вариант\p{L}*|весь\s+ассортимент)(?=$|[^\p{L}])/gu, " ")
    .replace(/(?:^|[^\p{L}])(?:найд\p{L}*|ищ\p{L}*|покаж\p{L}*|подбер\p{L}*|хоч\p{L}*|нуж\p{L}*|пожалуйста)(?=$|[^\p{L}])/gu, " ")
    .replace(/(?:^|[^\p{L}])(?:сам\p{L}*|дешев\p{L}*|бюджетн\p{L}*|недорог\p{L}*|дорог\p{L}*|премиум\p{L}*)(?=$|[^\p{L}])/gu, " ")
    .replace(new RegExp(COMPOUND.source, "giu"), " ")
    .replace(/\s+/gu, " ")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .trim();
}

function semanticTokenStem(token: string): string {
  const normalized = norm(token).replace(/[^\p{L}\p{N}]+/gu, "");
  if (/^[a-z0-9]+$/u.test(normalized)) return normalized;
  if (normalized.length >= 7) return normalized.slice(0, 5);
  if (normalized.length >= 5) return normalized.slice(0, 4);
  return normalized;
}

/**
 * Separates the live-taxonomy class wording from descriptive requirements so
 * jargon recovery can translate the complete semantic combination instead of
 * treating it as one literal catalog phrase. The partition is learned only
 * from category labels returned for the user's exact N×S marking; no product
 * nouns, cable families, materials, or aliases are stored server-side.
 *
 * When the live taxonomy provides no lexical anchor, the original query stays
 * intact. This fail-closed fallback avoids guessing which user word is a class.
 */
export function partitionSemanticCompoundSourceByLiveTaxonomy(
  sourceQuery: string,
  liveCategoryLabels: string[],
): { query: string; semanticModifiers: string[] } {
  const sourceTokens = sourceQuery.match(/[\p{L}\p{N}-]{3,}/gu) ?? [];
  if (sourceTokens.length === 0) return { query: sourceQuery.trim(), semanticModifiers: [] };
  const categoryStems = new Set(
    liveCategoryLabels
      .flatMap((label) => norm(label).match(/[\p{L}\p{N}-]{3,}/gu) ?? [])
      .map(semanticTokenStem)
      .filter(Boolean),
  );
  if (categoryStems.size === 0) return { query: sourceQuery.trim(), semanticModifiers: [] };

  const classTokens = sourceTokens.filter((token) => categoryStems.has(semanticTokenStem(token)));
  if (classTokens.length === 0) return { query: sourceQuery.trim(), semanticModifiers: [] };
  const semanticModifiers = sourceTokens.filter((token) => !categoryStems.has(semanticTokenStem(token)));
  if (semanticModifiers.length === 0) return { query: sourceQuery.trim(), semanticModifiers: [] };
  return {
    query: classTokens.join(" "),
    semanticModifiers,
  };
}

/**
 * Keeps only the live leaves that best match the customer's own class wording.
 * A numeric marking is shared by unrelated classes (for example a cable and an
 * extension lead), so a marking-only seed must never authorize every category
 * it happens to return. Ties stay allowed; zero-overlap leaves are excluded.
 */
export function selectBestMatchingSemanticCompoundCategories(
  sourceQuery: string,
  liveCategoryLabels: string[],
): string[] {
  const sourceStems = new Set(
    (sourceQuery.match(/[\p{L}\p{N}-]{3,}/gu) ?? [])
      .map(semanticTokenStem)
      .filter(Boolean),
  );
  const scored = liveCategoryLabels.map((category) => {
    const stems = new Set(
      (norm(category).match(/[\p{L}\p{N}-]{3,}/gu) ?? [])
        .map(semanticTokenStem)
        .filter(Boolean),
    );
    const overlap = [...stems].filter((stem) => sourceStems.has(stem)).length;
    return { category, overlap };
  });
  const best = Math.max(0, ...scored.map((item) => item.overlap));
  if (best <= 0) return [];
  return scored.filter((item) => item.overlap === best).map((item) => item.category);
}

function textHasExactCompoundMarking(evidence: string, marking: ExplicitCompoundMarking): boolean {
  for (const match of evidence.matchAll(new RegExp(COMPOUND.source, "giu"))) {
    const first = number(match[1]);
    const second = number(match[2]);
    if (first === marking.first && second === marking.second) return true;
  }
  return false;
}

/** Final-card evidence must be visible in the product title itself. */
export function productTitleMatchesExplicitCompoundMarking(
  pagetitle: string,
  marking: ExplicitCompoundMarking,
): boolean {
  return textHasExactCompoundMarking(pagetitle, marking);
}

/**
 * Builds a bounded literal-search ladder from wording already selected by the
 * consultant. The only server-generated part is the punctuation-normalized
 * N×S token written by the user. No product nouns, families or synonyms are
 * introduced here.
 */
export function compoundRecoveryQueries(
  marking: ExplicitCompoundMarking,
  modelHints: string[],
  limit = 8,
): string[] {
  const literal = `${marking.first}*${String(marking.second).replace(".", ",")}`;
  const cleanedHints = modelHints
    .map((hint) => norm(hint).replace(new RegExp(COMPOUND.source, "giu"), " ").replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  const singleWord = cleanedHints.filter((hint) => /^\p{L}[\p{L}\p{N}-]*$/u.test(hint));
  const phrases = cleanedHints.filter((hint) => !singleWord.includes(hint));
  const tokens = cleanedHints.flatMap((hint) => hint.match(/[\p{L}\p{N}-]{3,}/gu) ?? []);
  const leadingTokens = phrases
    .map((hint) => hint.match(/^[\p{L}\p{N}-]{3,}/u)?.[0] ?? "")
    .filter(Boolean);
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const hint of [...singleWord, ...leadingTokens, ...phrases, ...tokens]) {
    const query = `${hint} ${literal}`.replace(/\s+/gu, " ").trim();
    const key = norm(query);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= Math.max(1, Math.min(limit, 12))) break;
  }
  return queries;
}

/** A bounded direct selector must not pretend to satisfy an exhaustive request. */
export function isExhaustiveCompoundRequest(message: string): boolean {
  const normalized = norm(message).replace(/\s+/gu, " ");
  return /(?:^|[^\p{L}])(?:все|весь|всю|полный\s+список|все\s+позиции)(?=$|[^\p{L}])/u.test(normalized);
}

/**
 * Allows the server to finish a non-exhaustive selection immediately after a
 * model-owned filtered search when every live title proves the user's N×S.
 * Exhaustive requests remain model-owned because the ordinary recovery has a
 * bounded card limit and must not silently turn “all positions” into a sample.
 */
export function shouldTerminateAfterGroundedCompoundSearch(
  message: string,
  pagetitles: string[],
  marking: ExplicitCompoundMarking,
): boolean {
  if (pagetitles.length === 0) return false;
  if (isExhaustiveCompoundRequest(message)) return false;
  return pagetitles.every((title) => productTitleMatchesExplicitCompoundMarking(title, marking));
}

function scalarCriterionNumber(criterion: Criterion): number | null {
  if (criterion.op !== "eq" || Array.isArray(criterion.value)) return null;
  if (typeof criterion.value === "number") return Number.isFinite(criterion.value) ? criterion.value : null;
  const raw = criterion.value.trim().replace(",", ".");
  if (!/^\d+(?:\.\d+)?$/u.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function keyTokens(key: string): Set<string> {
  return new Set(norm(key).match(/[\p{L}\p{N}]{3,}/gu) ?? []);
}

/**
 * Removes only criteria that duplicate a compound marking already proven by
 * every candidate title. Other suitability criteria remain untouched.
 *
 * The model may express N×S either as one literal criterion (`3×1,5`) or as
 * two scalar axes (`Количество жил = 3`, `Сечение жилы = 1,5 мм²`). Scalar
 * axes are considered a decomposition only when their labels share a token or
 * the second axis carries a square-millimetre unit. This is structural and
 * product-agnostic; no category, brand, or jargon dictionary is involved.
 */
export function subsumeCriteriaProvenByExplicitCompound(
  criteria: Criterion[],
  marking: ExplicitCompoundMarking,
): { criteria: Criterion[]; subsumed: Criterion[] } {
  const subsumedIndexes = new Set<number>();

  criteria.forEach((criterion, index) => {
    if (
      criterion.op === "eq" &&
      typeof criterion.value === "string" &&
      textHasExactCompoundMarking(criterion.value, marking)
    ) {
      subsumedIndexes.add(index);
    }
  });

  const firstCandidates = criteria
    .map((criterion, index) => ({ criterion, index, value: scalarCriterionNumber(criterion) }))
    .filter((item) => !subsumedIndexes.has(item.index) && item.value === marking.first);
  const secondCandidates = criteria
    .map((criterion, index) => ({ criterion, index, value: scalarCriterionNumber(criterion) }))
    .filter((item) => !subsumedIndexes.has(item.index) && item.value === marking.second);

  outer: for (const first of firstCandidates) {
    const firstTokens = keyTokens(first.criterion.key);
    for (const second of secondCandidates) {
      if (first.index === second.index) continue;
      const secondTokens = keyTokens(second.criterion.key);
      const sharedLabelToken = [...firstTokens].some((token) => secondTokens.has(token));
      const squareMillimetreAxis = /мм\s*(?:2|²)/iu.test(String(second.criterion.unit ?? ""));
      if (!sharedLabelToken && !squareMillimetreAxis) continue;
      subsumedIndexes.add(first.index);
      subsumedIndexes.add(second.index);
      break outer;
    }
  }

  return {
    criteria: criteria.filter((_criterion, index) => !subsumedIndexes.has(index)),
    subsumed: criteria.filter((_criterion, index) => subsumedIndexes.has(index)),
  };
}

/**
 * Routes an explicit product lookup containing a compound catalog marking
 * (for example 2×1.5, with x/х/×/* spellings used by the catalog)
 * without asking the model to recreate those exact numbers as facet values.
 */
export function classifyExactCompoundMarkingRequest(message: string): ExactCompoundMarkingRequest | null {
  const input = norm(message);
  if (!SELECT_INTENT.test(input) || INQUIRY_ONLY.test(input)) return null;
  const marking = extractExplicitCompoundMarking(input);
  if (!marking) return null;
  const { first, second } = marking;

  const priceDirection = /(?:сам\p{L}*\s+)?(?:дешев\p{L}*|бюджетн\p{L}*|недорог\p{L}*)/u.test(input)
    ? "cheapest"
    : /(?:сам\p{L}*\s+)?(?:дорог\p{L}*|премиум\p{L}*)/u.test(input)
      ? "expensive"
      : null;

  const query = input
    .replace(/[?!]/gu, " ")
    .replace(/(?:^|[^\p{L}])(?:найд\p{L}*|ищ\p{L}*|покаж\p{L}*|подбер\p{L}*|хоч\p{L}*|нуж\p{L}*|пожалуйста)(?=$|[^\p{L}])/gu, " ")
    .replace(/(?:^|[^\p{L}])(?:сам\p{L}*|дешев\p{L}*|бюджетн\p{L}*|недорог\p{L}*|дорог\p{L}*|премиум\p{L}*)(?=$|[^\p{L}])/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!/\p{L}/u.test(query)) return null;
  // This shortcut is intentionally narrow. The catalog full-text endpoint has
  // AND semantics; three or more lexical terms usually mean the request also
  // contains a semantic attribute that the consultant must translate using
  // its reasoning (for example an execution/material requirement). Sending
  // that conversational phrase directly would turn a valid request into a
  // deterministic false empty. No product vocabulary is used here.
  if (requiresSemanticCompoundEvidence(message)) return null;
  return { query, first, second, priceDirection };
}

function hasExactCompound(evidence: string, request: ExactCompoundMarkingRequest): boolean {
  return textHasExactCompoundMarking(evidence, request);
}

export function selectExactCompoundMarkedProducts(
  products: ProductRef[],
  request: ExactCompoundMarkingRequest,
  limit = request.priceDirection ? 1 : 4,
): ProductRef[] {
  const byId = new Map<string, ProductRef>();
  for (const product of products) {
    const evidence = `${product.pagetitle}\n${product.short_traits.join("\n")}`;
    if (!hasExactCompound(evidence, request)) continue;
    if (!Number.isFinite(product.price) || product.price <= 0) continue;
    if (!byId.has(product.id)) byId.set(product.id, product);
  }
  const direction = request.priceDirection === "expensive" ? -1 : 1;
  return [...byId.values()]
    .sort((left, right) => direction * (left.price - right.price))
    .slice(0, Math.max(1, Math.min(limit, 8)));
}

export function exactCompoundMarkingIntro(request: ExactCompoundMarkingRequest): string {
  const price = request.priceDirection === "cheapest"
    ? " и сортирую точные совпадения от самой низкой цены"
    : request.priceDirection === "expensive"
      ? " и сортирую точные совпадения от самой высокой цены"
      : "";
  return `Ищу в каталоге точную маркировку «${request.query}»${price}; товары с другим составным размером не показываю.`;
}

export function exactCompoundMarkingEmpty(request: ExactCompoundMarkingRequest): string {
  return `По точной маркировке «${request.query}» товар с размером ${request.first}×${String(request.second).replace(".", ",")} в текущей выдаче каталога не подтвердился. Другой размер под видом подходящего показывать не буду.`;
}
