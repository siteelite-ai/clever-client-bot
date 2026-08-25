import type { Facet } from "./discover-category.ts";
import { isReplacementIdentityFacet } from "./search-filter-guard.ts";
import type { ProductRef } from "./types.ts";

export interface ExplicitReplacementAxis {
  key: string;
  caption: string;
  value: string;
  total: number;
}

export interface ReplacementLookupKeys {
  articles: string[];
  modelCodes: string[];
}

/** Compact variant/curve/class codes are often visible in titles even when
 * the catalog omits the matching trait. Capture only a standalone uppercase
 * letter explicitly introduced by a parameter label. */
export function extractExplicitSingleLetterCodes(message: string): string[] {
  const matches = [...String(message ?? "").matchAll(
    /(?<![\p{L}\p{N}])\p{L}{4,}(?:\s+\p{L}{4,}){0,2}\s*[:=–—-]?\s+([A-ZА-ЯЁ])(?![\p{L}\p{N}])/gu,
  )];
  return distinct(matches.map((match) => codeNorm(match[1])));
}

function norm(value: string): string {
  return String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/[^a-zа-я0-9]+/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function codeNorm(value: string): string {
  return norm(value).replace(/\s+/gu, "");
}

function distinct(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** Extracts only structural identifiers from the current request. */
export function extractReplacementLookupKeys(message: string): ReplacementLookupKeys {
  const articles = distinct([...message.matchAll(/(?<!\d)\d{6,18}(?!\d)/gu)].map((match) => match[0]));
  const tokens = message.match(/[a-zа-я0-9][a-zа-я0-9._/-]{2,}/giu) ?? [];
  const separatedModelCodes = [...message.matchAll(
    /(?<![\p{L}\p{N}])[\p{L}]{1,6}\s+\d{1,6}(?:\s*[-/.]\s*\d{1,6})+(?![\p{L}\p{N}])/giu,
  )].flatMap((match) => {
    const spaced = match[0].replace(/\s+/gu, " ").replace(/\s*([-/.])\s*/gu, "$1").trim();
    return [spaced, spaced.replace(/\s+/gu, "")];
  });
  const modelCodes = distinct([...separatedModelCodes, ...tokens
    .map((token) => token.replace(/[^a-zа-я0-9-]/giu, ""))
    .filter((token) => token.length >= 4 && /\p{L}/u.test(token) && /\d/u.test(token))
    .filter((token) => !/^\d+(?:[.,-]\d+)?[a-zа-я]{1,4}$/iu.test(token))
  ].sort((left, right) => right.length - left.length));
  return { articles, modelCodes };
}

function traitEntries(product: ProductRef): Array<{ caption: string; value: string }> {
  const entries: Array<{ caption: string; value: string }> = [];
  for (const line of product.short_traits ?? []) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const caption = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (caption && value) entries.push({ caption, value });
  }
  return entries;
}

function captionsMatch(left: string, right: string): boolean {
  const a = norm(left);
  const b = norm(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function canonicalFacetValue(facet: Facet, traitValue: string): { value: string; total: number } | null {
  const wanted = norm(traitValue);
  const wantedCode = codeNorm(traitValue);
  const match = (facet.values ?? []).find((candidate) => {
    const candidateNorm = norm(candidate.value);
    const candidateCode = codeNorm(candidate.value);
    return candidateNorm === wanted || candidateCode === wantedCode;
  });
  if (!match) return null;
  return { value: String(match.value), total: Number(match.products_count ?? Number.POSITIVE_INFINITY) };
}

function explicitInAnchorText(value: string, evidence: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^\d+(?:[.,]\d+)?$/u.test(trimmed)) {
    const escaped = trimmed.replace(/[.,]/u, "[.,]");
    return new RegExp(`(?<!\\d)${escaped}(?!\\d)`, "u").test(evidence);
  }
  const compact = codeNorm(trimmed);
  return compact.length >= 2 && codeNorm(evidence).includes(compact);
}

function captionIsEvidenced(caption: string, evidence: string): boolean {
  const evidenceTokens = norm(evidence).split(" ").filter((token) => token.length >= 4);
  return norm(caption).split(" ")
    .filter((token) => token.length >= 4)
    .some((captionToken) => evidenceTokens.some((token) =>
      token.slice(0, 4) === captionToken.slice(0, 4)
    ));
}

function standaloneCodeIsEvidenced(value: string, evidence: string): boolean {
  const wanted = codeNorm(value);
  if (!wanted) return false;
  return (String(evidence ?? "").match(/[\p{L}\p{N}]+/gu) ?? [])
    .some((token) => codeNorm(token) === wanted);
}

function compactSingleCodes(value: string): string[] {
  return [...new Set((String(value ?? "").match(/[\p{L}\p{N}]+/gu) ?? [])
    .map(codeNorm)
    .filter((token) => token.length === 1 && /\p{L}/u.test(token)))];
}

/**
 * Builds a compact search plan only from live anchor traits, live facet values,
 * and literals present in the customer's anchor description. No category or
 * product dictionaries are used. Identity facets never become analogue axes.
 */
export function selectExplicitAnchorAxes(
  product: ProductRef,
  facets: Facet[],
  userMessage: string,
  limit = 3,
): ExplicitReplacementAxis[] {
  const evidence = `${userMessage}\n${product.pagetitle}`;
  const axes: ExplicitReplacementAxis[] = [];
  for (const facet of facets) {
    if (isReplacementIdentityFacet(facet)) continue;
    const trait = traitEntries(product).find((entry) => captionsMatch(entry.caption, facet.caption));
    const traitCanonical = trait ? canonicalFacetValue(facet, trait.value) : null;
    const visibleCompactCanonical = captionIsEvidenced(facet.caption, userMessage)
      ? (facet.values ?? []).find((candidate) => {
        const codes = compactSingleCodes(candidate.value);
        return codes.some((code) =>
          standaloneCodeIsEvidenced(code, userMessage) &&
          standaloneCodeIsEvidenced(code, product.pagetitle)
        );
      })
      : null;
    const canonical = traitCanonical ?? (visibleCompactCanonical
      ? { value: String(visibleCompactCanonical.value), total: Number(visibleCompactCanonical.products_count ?? Number.POSITIVE_INFINITY) }
      : null);
    if (!canonical) continue;
    const singleCodes = compactSingleCodes(canonical.value);
    const explicitValue = explicitInAnchorText(canonical.value, evidence) || Boolean(
      singleCodes.length > 0 &&
      captionIsEvidenced(facet.caption, userMessage) &&
      singleCodes.some((code) =>
        standaloneCodeIsEvidenced(code, userMessage) &&
        standaloneCodeIsEvidenced(code, product.pagetitle)
      ),
    );
    if (!explicitValue) continue;
    // A bare binary number occurs in many unrelated technical and merchandising
    // facets. It becomes an analogue axis only when the customer also named
    // the facet meaning (for example, a pole-count caption), not merely because
    // another "1" happens to occur in the model title.
    const facetIsBinary = (facet.values ?? []).length > 0 && (facet.values ?? []).every(({ value }) =>
      /^[01](?:[.,]0+)?$/u.test(String(value).trim())
    );
    if (facetIsBinary && !captionIsEvidenced(facet.caption, userMessage)) continue;
    axes.push({ key: facet.key, caption: facet.caption, value: canonical.value, total: canonical.total });
  }
  return axes
    .sort((left, right) => left.total - right.total || left.caption.localeCompare(right.caption, "ru"))
    .slice(0, Math.max(2, limit));
}

export function productContainsSourceModel(product: Pick<ProductRef, "pagetitle">, modelCodes: string[]): boolean {
  const title = codeNorm(product.pagetitle);
  return modelCodes.some((code) => {
    const needle = codeNorm(code);
    return needle.length >= 4 && title.includes(needle);
  });
}
