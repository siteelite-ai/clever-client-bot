import type { SearchFacet } from "./search-filter-guard.ts";
import type { SearchCatalogInput } from "./search-catalog.ts";

export type CatalogSearchState =
  | "found"
  | "confirmed_empty"
  | "query_inconsistent"
  | "anchor_missing"
  | "upstream_error";

export interface CatalogSearchOutcome {
  state: CatalogSearchState;
  search_total: number;
  discovery_evidence_count: number;
  retryable: boolean;
}

export interface NamedSeriesFacetEvidence {
  key: string;
  value: string;
  products_count: number;
}

function normalize(value: string): string {
  return String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/[^a-zа-я0-9]+/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function isSeriesFacet(facet: Pick<SearchFacet, "key" | "caption">): boolean {
  const label = normalize(`${facet.key} ${facet.caption ?? ""}`);
  return /(?:^| )(?:model|series|collection|line|range|модел\w*|серия|серии|коллекц\w*|линейк\w*)(?: |$)/u
    .test(label);
}

function isBrandFacet(facet: Pick<SearchFacet, "key" | "caption">): boolean {
  const label = normalize(`${facet.key} ${facet.caption ?? ""}`);
  return /(?:^| )(?:brand|vendor|manufacturer|producer|trademark|бренд|производител\w*|торгов\w* марк\w*|марка)(?: |$)/u
    .test(label);
}

function valueContainsNamedEntity(value: string, wanted: string): boolean {
  const normalized = normalize(value);
  return normalized === wanted || ` ${normalized} `.includes(` ${wanted} `);
}

/** Returns only an exact live facet value for the explicitly named series. */
export function findNamedSeriesFacetEvidence(
  facets: SearchFacet[],
  seriesToken: string,
): NamedSeriesFacetEvidence | null {
  const wanted = normalize(seriesToken);
  if (!wanted) return null;
  // Prefer semantic identity facets, but do not assume one fixed catalog key:
  // different branches expose the same entity as series, line, collection or
  // a branch-specific discrete option. Brand is intentionally never accepted.
  const ordered = [
    ...facets.filter((facet) => isSeriesFacet(facet)),
    ...facets.filter((facet) => !isSeriesFacet(facet) && !isBrandFacet(facet)),
  ];
  for (const facet of ordered) {
    const match = facet.values.find((candidate) =>
      valueContainsNamedEntity(candidate.value, wanted)
    );
    if (match) {
      const productsCount = Number(
        (match as SearchFacet["values"][number] & { products_count?: unknown })
          .products_count ?? 0,
      );
      return {
        key: facet.key,
        value: match.value,
        products_count: Number.isFinite(productsCount) && productsCount > 0
          ? productsCount
          : 0,
      };
    }
  }
  return null;
}

/**
 * Keeps a model-authored facet search only when the exact key/value pair is
 * present in the current discovery snapshot and names the requested entity.
 * This lets grounded reasoning survive without trusting arbitrary tool args.
 */
export function searchInputUsesNamedSeriesFacet(
  input: Partial<SearchCatalogInput>,
  facets: SearchFacet[],
  seriesToken: string,
): boolean {
  if (input.mode !== "by_filter" || !input.options || typeof input.options !== "object") {
    return false;
  }
  const wanted = normalize(seriesToken);
  if (!wanted) return false;
  const options = input.options as Record<string, unknown>;
  return facets.some((facet) => {
    if (!(facet.key in options)) return false;
    const requested = Array.isArray(options[facet.key])
      ? options[facet.key] as unknown[]
      : [options[facet.key]];
    return facet.values.some((candidate) =>
      valueContainsNamedEntity(candidate.value, wanted) &&
      requested.some((value) => normalize(String(value)) === normalize(candidate.value))
    );
  });
}

/**
 * A zero response is not proof of an empty catalog when the same discovery
 * snapshot advertises matching products. That state allows one bounded query
 * repair; ordinary empty results and upstream failures remain terminal.
 */
export function classifyCatalogSearchOutcome(input: {
  search_ok: boolean;
  search_total?: number;
  discovery_evidence_count?: number;
  anchor_missing?: boolean;
}): CatalogSearchOutcome {
  const searchTotal = Number.isFinite(input.search_total)
    ? Math.max(0, Number(input.search_total))
    : 0;
  const discoveryCount = Number.isFinite(input.discovery_evidence_count)
    ? Math.max(0, Number(input.discovery_evidence_count))
    : 0;
  if (input.anchor_missing) {
    return {
      state: "anchor_missing",
      search_total: searchTotal,
      discovery_evidence_count: discoveryCount,
      retryable: false,
    };
  }
  if (!input.search_ok) {
    return {
      state: "upstream_error",
      search_total: searchTotal,
      discovery_evidence_count: discoveryCount,
      retryable: true,
    };
  }
  if (searchTotal > 0) {
    return {
      state: "found",
      search_total: searchTotal,
      discovery_evidence_count: discoveryCount,
      retryable: false,
    };
  }
  if (discoveryCount > 0) {
    return {
      state: "query_inconsistent",
      search_total: 0,
      discovery_evidence_count: discoveryCount,
      retryable: true,
    };
  }
  return {
    state: "confirmed_empty",
    search_total: 0,
    discovery_evidence_count: 0,
    retryable: false,
  };
}

/**
 * Repairs a category/filter contradiction with one option-only query. Only
 * transport-neutral constraints survive; category scope is intentionally
 * removed because it is the conflicting part of the original request.
 */
export function buildFacetConsistencyRecoveryInput(
  evidence: NamedSeriesFacetEvidence,
  requested: Partial<SearchCatalogInput>,
): SearchCatalogInput {
  const perPage = Number(requested.per_page);
  return {
    mode: "by_filter",
    options: { [evidence.key]: [evidence.value] },
    per_page: Number.isFinite(perPage) ? Math.max(8, Math.min(50, perPage)) : 8,
    ...(Number.isFinite(requested.min_price)
      ? { min_price: requested.min_price }
      : {}),
    ...(Number.isFinite(requested.max_price)
      ? { max_price: requested.max_price }
      : {}),
    ...(requested.sort_cheapest === true ? { sort_cheapest: true } : {}),
    ...(requested.sort_expensive === true ? { sort_expensive: true } : {}),
  };
}

/**
 * Final bounded transport strategy for an entity explicitly named by the
 * customer. The returned pool still has to prove the same token in product
 * titles; this helper only removes unrelated query terms that can make the
 * catalog's AND search inconsistent.
 */
export function buildCanonicalEntityRecoveryInput(
  entityToken: string,
): SearchCatalogInput {
  return {
    mode: "by_query",
    query: entityToken.trim(),
    per_page: 50,
  };
}
