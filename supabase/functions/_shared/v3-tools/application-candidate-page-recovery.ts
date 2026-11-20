import type { SearchCatalogInput } from "./search-catalog.ts";
import type { CatalogCandidateCoverage } from "./types.ts";

/** An eligibility rejection is not a failed translation. Continue the SAME
 * verified category/query/filter window, not guesses at a different noun.
 * This bounded plan retrieves candidates; it never certifies a card. */
export interface ApplicationCandidatePageInput {
  search: SearchCatalogInput;
  ready: boolean;
  applicationGap: boolean;
  subjectProved: boolean;
  lexicalRequirement: boolean;
  verifiedCategories: readonly string[];
  rawTotal: number;
  rawCoverage: CatalogCandidateCoverage | undefined;
}

/** Fixed diagnostic codes, not arbitrary request/model strings. */
export const APPLICATION_PAGE_ADMISSION = {
  allowed: 0, not_ready: 1, no_application_gap: 2, subject_unproven: 3,
  lexical_obligation: 4, unsupported_mode: 5, conflicting_identity: 6,
  ordered_or_replacement: 7, fanout: 8, invalid_window: 9, unverified_scope: 10,
} as const;
type Reason = keyof typeof APPLICATION_PAGE_ADMISSION;
export function applicationCandidatePageDecision(input: ApplicationCandidatePageInput): {
  reason: Reason; reasonCode: number; pages: SearchCatalogInput[] | null; knownApplicationGap: boolean;
} {
  // Semantic state is owned by accepted inputs and current card evidence.
  // An unsupported cursor/sort/fan-out does not make a known noun unknown.
  const knownApplicationGap = input.ready && input.applicationGap && input.subjectProved && !input.lexicalRequirement;
  const deny = (reason: Reason) => ({ reason, reasonCode: APPLICATION_PAGE_ADMISSION[reason], pages: null, knownApplicationGap });
  const request = input.search;
  if (!input.ready) return deny("not_ready");
  if (!input.applicationGap) return deny("no_application_gap");
  if (!input.subjectProved) return deny("subject_unproven");
  if (input.lexicalRequirement) return deny("lexical_obligation");
  if (request.mode !== "by_filter" && request.mode !== "by_query") return deny("unsupported_mode");
  if (request.article || request.pagetitle || request.mode === "by_filter" && request.query ||
    request.mode === "by_query" && (typeof request.query !== "string" || !request.query.trim())) return deny("conflicting_identity");
  if (request.sort_cheapest || request.sort_expensive || request.anchor_leaf_category) return deny("ordered_or_replacement");
  if (Object.values(request.options ?? {}).some(values => !Array.isArray(values) || values.length !== 1)) return deny("fanout");
  if ((request.page ?? 1) !== 1 || request.per_page !== 50) return deny("invalid_window");
  const categories = [...new Set([request.category, ...(request.category_in ?? [])].filter(Boolean))];
  if (categories.length !== 1 || !input.verifiedCategories.includes(categories[0]!)) return deny("unverified_scope");
  // A complete first page needs no further request, but still distinguishes
  // a proved class/application gap from an unknown lexical subject.
  // Missing count/page metadata is a coverage gap, not a new product-name
  // problem or permission to erase the original query/category/filters.
  const usableCount = Number.isSafeInteger(input.rawTotal) && input.rawTotal > 0;
  const pages = usableCount && input.rawCoverage === "complete_query_window" ? 1
    : usableCount && input.rawCoverage === "partial" ? Math.min(4, Math.ceil(input.rawTotal / 50)) : 4;
  const requests = Array.from({ length: Math.max(0, pages - 1) }, (_, i) => ({
    ...structuredClone(request), page: i + 2,
  }));
  return { reason: "allowed", reasonCode: 0, pages: requests, knownApplicationGap };
}
export function compileApplicationCandidatePageRecovery(input: ApplicationCandidatePageInput): SearchCatalogInput[] | null {
  return applicationCandidatePageDecision(input).pages;
}
