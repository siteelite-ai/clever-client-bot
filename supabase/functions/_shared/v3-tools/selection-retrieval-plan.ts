import type { SearchCatalogInput } from "./search-catalog.ts";

/** Retrieval is not a product recommendation. A READY declaration and a
 * verified live category can start a bounded candidate search even when no
 * exact live facet expresses the customer's application. The existing
 * criteria, application and final-card guards must still prove every card.
 * No product vocabulary, model call or permissions are introduced here. */
export function compileReadyCandidateRetrieval(input: {
  ready: boolean;
  intent: string;
  category: string;
  leaves: readonly string[];
  replacement: boolean;
  seriesRequiresGrounding: boolean;
  broadAssortment: boolean;
}): (SearchCatalogInput & Record<string, unknown>) | null {
  if (!input.ready || input.intent !== "select" || input.replacement ||
    input.seriesRequiresGrounding || input.broadAssortment) return null;
  const leaves = [...new Set(input.leaves.map(value => value.trim()).filter(Boolean))];
  const category = input.category.trim();
  // Bound fan-out; an unresolved parent is not a licensed cross-catalog search.
  if (!category || leaves.length > 8) return null;
  return {
    mode: "by_filter",
    ...(leaves.length ? { category_in: leaves } : { category }),
    per_page: 50,
  };
}
