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

function productMatchesModifiers(p: ProductRef, modifiers: string[]): boolean {
  const clean = modifiers.map(normalize).filter(Boolean);
  if (clean.length === 0) return true;
  const haystack = normalize(`${p.pagetitle} ${p.vendor ?? ""} ${p.short_traits.join(" ")}`);
  return clean.every((m) => haystack.includes(m));
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
      return {
        tool: "jargon_recover_catalog",
        ok: true,
        source_query: source,
        candidates,
        matched_query: candidate,
        results: filtered.slice(0, input.per_page ?? 10),
        total: filtered.length,
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
  };
}