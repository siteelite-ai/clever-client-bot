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
}

export interface JargonRecoverCatalogDeps extends CatalogClientDeps {
  openrouterApiKey: string;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function normalizeCodeLike(s: string): string {
  const map: Record<string, string> = { а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x" };
  return normalize(s).replace(/[авекмнорстух]/gu, (ch) => map[ch] ?? ch).replace(/\s+/g, "");
}

function tokenize(s: string): string[] {
  return normalize(s).split(/\s+/).filter((t) => t.length >= 3);
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

  const jargon = await tryJargonFallback(source, { apiKey: deps.openrouterApiKey });
  const candidates = [
    ...(jargon.ok ? jargon.candidates : []),
    source,
  ].map((c) => c.trim()).filter(Boolean).filter((c, i, arr) => arr.findIndex((x) => normalize(x) === normalize(c)) === i);

  for (const candidate of candidates.slice(0, 4)) {
    const result = await executeSearchCatalog({
      mode: "by_query",
      query: candidate,
      min_price: input.min_price,
      max_price: input.max_price,
      per_page: input.per_page ?? 10,
    }, deps, cache);
    if (!result.ok) continue;

    const filtered = result.results.filter((p) => productMatchesModifiers(p, input.modifiers ?? []));
    if (filtered.length > 0) {
      const sliced = filtered.slice(0, input.per_page ?? 10);
      const { partial_match, unmatched_tokens } = computePartialMatch(source, input.modifiers ?? [], sliced);
      return {
        tool: "jargon_recover_catalog",
        ok: true,
        source_query: source,
        candidates,
        matched_query: candidate,
        results: sliced,
        total: filtered.length,
        partial_match,
        unmatched_tokens,
      };
    }
  }

  return {
    tool: "jargon_recover_catalog",
    ok: true,
    source_query: source,
    candidates,
    matched_query: null,
    results: [],
    total: 0,
    partial_match: false,
    unmatched_tokens: [],
  };
}