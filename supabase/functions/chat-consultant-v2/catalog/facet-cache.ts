import {
  getCategoryOptions,
  type ApiClientDeps,
  type CategoryOptionsResult,
} from "./api-client.ts";

type FacetCache = <T>(
  namespace: string,
  rawKey: string,
  ttlSec: number,
  compute: () => Promise<T>,
) => Promise<{ value: T; cacheHit: boolean }>;

class UncacheableFacetResponse extends Error {
  constructor(readonly result: CategoryOptionsResult) {
    super("unverified_facet_response");
  }
}

/** Both deterministic and LLM matchers share one admission rule. */
export function isVerifiedCategoryOptionsResult(
  value: unknown,
  expectedPagetitle?: string,
): value is CategoryOptionsResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<CategoryOptionsResult>;
  return (expectedPagetitle === undefined ||
      result.categoryPagetitle === expectedPagetitle) &&
    Array.isArray(result.options) && Number.isSafeInteger(result.totalProducts) &&
    ((result.status === "ok" && result.options.length > 0) ||
      (result.status === "empty" && result.options.length === 0 &&
        result.totalProducts === 0));
}

export async function loadCategoryFacets(
  pagetitle: string,
  ttlSec: number,
  apiClient: ApiClientDeps,
  cacheGetOrCompute: FacetCache,
): Promise<{ value: CategoryOptionsResult; source: "cache" | "live" | "unavailable" }> {
  try {
    const cached = await cacheGetOrCompute<CategoryOptionsResult>(
      "facets",
      pagetitle,
      ttlSec,
      async () => {
        const result = await getCategoryOptions(pagetitle, apiClient);
        // Throwing inside compute prevents even a cache adapter that stores
        // every returned value from caching HTTP/schema failures for one hour.
        if (!isVerifiedCategoryOptionsResult(result, pagetitle)) {
          throw new UncacheableFacetResponse(result);
        }
        return result;
      },
    );
    if (isVerifiedCategoryOptionsResult(cached.value, pagetitle)) {
      return { value: cached.value, source: cached.cacheHit ? "cache" : "live" };
    }
    // Legacy cache entries may contain a 502 or malformed body. Ignore them.
  } catch (error) {
    if (error instanceof UncacheableFacetResponse) {
      return { value: error.result, source: "unavailable" };
    }
    // Cache failure alone does not make the catalog unavailable.
  }
  const value = await getCategoryOptions(pagetitle, apiClient);
  return {
    value,
    source: isVerifiedCategoryOptionsResult(value, pagetitle) ? "live" : "unavailable",
  };
}
