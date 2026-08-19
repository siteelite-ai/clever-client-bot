import type { ProductRef } from "./types.ts";

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
  const lexicalTerms = query
    .replace(COMPOUND, " ")
    .match(/\p{L}+/gu) ?? [];
  if (lexicalTerms.length > 2) return null;
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
