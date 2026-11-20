import type { SearchCatalogInput } from "./search-catalog.ts";
import type { CatalogCandidateCoverage } from "./types.ts";

/** An eligibility rejection is not a failed translation. Continue the SAME
 * verified category/filter window, not guesses at a different product noun.
 * This bounded plan retrieves candidates; it never certifies a card. */
export function compileApplicationCandidatePageRecovery(input: {
  search: SearchCatalogInput;
  ready: boolean;
  applicationGap: boolean;
  subjectProved: boolean;
  lexicalRequirement: boolean;
  verifiedLeaf: string;
  rawTotal: number;
  rawCoverage: CatalogCandidateCoverage | undefined;
}): SearchCatalogInput[] | null {
  const request = input.search;
  if (!input.ready || !input.applicationGap || !input.subjectProved || input.lexicalRequirement ||
    request.mode !== "by_filter" || request.query || request.article || request.pagetitle ||
    request.sort_cheapest || request.sort_expensive || request.anchor_leaf_category ||
    Object.values(request.options ?? {}).some(values => !Array.isArray(values) || values.length !== 1) ||
    (request.page ?? 1) !== 1 || request.per_page !== 50 ||
    !Number.isSafeInteger(input.rawTotal) || input.rawTotal < 1 ||
    input.rawCoverage === undefined || input.rawCoverage === "unknown") return null;
  const categories = [...new Set([request.category, ...(request.category_in ?? [])].filter(Boolean))];
  if (categories.length !== 1 || categories[0] !== input.verifiedLeaf) return null;
  // A complete first page needs no further request, but still distinguishes
  // a proved class/application gap from an unknown lexical subject.
  if (input.rawCoverage === "complete_query_window") return [];
  const pages = Math.min(4, Math.ceil(input.rawTotal / 50));
  return Array.from({ length: Math.max(0, pages - 1) }, (_, i) => ({
    ...structuredClone(request), page: i + 2,
  }));
}
