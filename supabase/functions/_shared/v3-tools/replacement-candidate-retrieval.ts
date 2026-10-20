import {
  type CatalogClientDeps,
  executeSearchCatalog,
  type SearchCatalogInput,
} from "./search-catalog.ts";
import type {
  CatalogCandidateCoverage,
  ProductCache,
  ProductRef,
  SearchCatalogOk,
  ToolError,
} from "./types.ts";

type SearchResult =
  | (SearchCatalogOk & { tool: "search_catalog" })
  | (ToolError & { tool: "search_catalog" });

export type ReplacementCandidateSearch = (
  input: SearchCatalogInput,
  deps: CatalogClientDeps,
  cache: ProductCache,
) => Promise<SearchResult>;

export interface ReplacementCandidateRetrievalInput {
  /** The verified source's immediate leaf, never a parent or inferred category. */
  leafCategory: string;
  /** Source-derived exact options; these are retrieval hints, not fit proof. */
  strictOptions: Record<string, string[]>;
  /** Preferred order for dropping source-derived options. All remaining keys follow. */
  softFacetOrder?: readonly string[];
  minPrice?: number;
  maxPrice?: number;
  deps: CatalogClientDeps;
  cache: ProductCache;
  /** Maximum search_catalog tool calls across stages; hard-clamped to 30. */
  maxPagesTotal?: number;
  /** Maximum physical catalog fetches including recovery/retries; hard-clamped to 60. */
  maxCatalogRequestsTotal?: number;
  /** Per-stage page limit before the facet-free stage; hard-clamped to 10. */
  maxPagesPerStage?: number;
  /** Facet-free leaf-stage page limit; hard-clamped to 20. */
  maxLeafPages?: number;
  /** Shared deadline for all stages; hard-clamped to 30 seconds. */
  deadlineMs?: number;
  pageSize?: number;
  /** Optional caller-owned fit/cardinality gate, evaluated after every page. */
  stopWhen?: (products: readonly ProductRef[]) => boolean;
  /** Tests may inject a catalog-shaped executor; production uses the shared tool. */
  search?: ReplacementCandidateSearch;
}

export interface ReplacementCandidatePageEvidence {
  page: number;
  /** The tool's upstream pagination total, not the post-policy result count. */
  reportedTotal: number;
  /** The shared tool's raw-row coverage for this tool-page request. */
  candidateCoverage: CatalogCandidateCoverage;
  /** Public, policy-filtered rows made available to later fit checks. */
  visibleCount: number;
  warnings: string[];
}

export interface ReplacementCandidateStageEvidence {
  id: string;
  kind: "strict" | "relaxed" | "leaf_only";
  droppedFacetKeys: string[];
  activeFacetKeys: string[];
  pages: ReplacementCandidatePageEvidence[];
  /** Never inferred from `products.length`; it is tool-page evidence only. */
  coverage: CatalogCandidateCoverage;
  /** The requested page window ended, but this is not proof of catalog exhaustiveness. */
  requestedWindowScanned: boolean;
  interruption:
    | null
    | "stage_page_limit"
    | "global_page_limit"
    | "upstream_request_limit"
    | "deadline"
    | "external_abort"
    | "catalog_error"
    | "pagination_changed"
    | "target_reached";
}

export interface ReplacementCandidateRetrievalResult {
  /** Dedupe by catalog ID; no stock/model/fit decision is made here. */
  products: ProductRef[];
  stages: ReplacementCandidateStageEvidence[];
  plannedStageCount: number;
  /** Number of search_catalog tool calls, not physical upstream requests. */
  pagesRequested: number;
  /** Number of physical catalog fetches, including hidden recovery/retries. */
  catalogRequestsMade: number;
  termination:
    | "stage_plan_completed"
    | "target_reached"
    | "page_cap"
    | "request_cap"
    | "deadline"
    | "external_abort"
    | "catalog_error"
    | "pagination_changed";
  failedStage?: {
    id: string;
    errorCode: ToolError["error_code"];
    message: string;
  };
  /** Complete means only that one exact leaf+price+facet query fit in one raw page. */
  leafQueryCoverage: CatalogCandidateCoverage | null;
}

interface PlannedStage {
  id: string;
  kind: ReplacementCandidateStageEvidence["kind"];
  droppedFacetKeys: string[];
  activeFacetKeys: string[];
  options: Record<string, string[]>;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  return Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.trunc(value!)))
    : fallback;
}

function safeFacetKey(key: string): boolean {
  return key.length > 0 && key.length <= 240 &&
    !/[\p{Cc}\p{Cf}]/u.test(key) &&
    !["__proto__", "prototype", "constructor"].includes(key);
}

function validateOptions(
  options: Record<string, string[]>,
): Array<[string, string[]]> {
  const entries = Object.entries(options);
  if (entries.length > 20) {
    throw new TypeError("too many replacement retrieval facets");
  }
  for (const [key, values] of entries) {
    // The upstream OR-within-facet behavior is not reliable. A source profile
    // supplies one exact value per facet; broader OR plans need their own proof.
    if (
      !safeFacetKey(key) || !Array.isArray(values) || values.length !== 1 ||
      typeof values[0] !== "string" || !values[0].trim() ||
      values[0].length > 240
    ) {
      throw new TypeError("invalid source-derived replacement retrieval facet");
    }
  }
  return entries.map(([key, values]) => [key, [values[0]]]);
}

function buildStages(
  entries: Array<[string, string[]]>,
  preferredOrder: readonly string[],
): PlannedStage[] {
  const options = new Map(entries);
  if (options.size === 0) {
    return [{
      id: "leaf_only",
      kind: "leaf_only",
      droppedFacetKeys: [],
      activeFacetKeys: [],
      options: Object.create(null),
    }];
  }
  const orderedKeys = [
    ...new Set(preferredOrder.filter((key) => options.has(key))),
    ...entries.map(([key]) => key).filter((key) =>
      !preferredOrder.includes(key)
    ),
  ];
  const stages: PlannedStage[] = [];
  const active = new Map(options);
  const dropped: string[] = [];
  const snapshot = (id: string, kind: PlannedStage["kind"]): PlannedStage => ({
    id,
    kind,
    droppedFacetKeys: [...dropped],
    activeFacetKeys: [...active.keys()],
    options: Object.fromEntries(active),
  });
  stages.push(snapshot("strict", "strict"));
  for (const key of orderedKeys) {
    active.delete(key);
    dropped.push(key);
    stages.push(
      snapshot(
        active.size === 0 ? "leaf_only" : `relax_${dropped.length}`,
        active.size === 0 ? "leaf_only" : "relaxed",
      ),
    );
  }
  return stages;
}

function uncertainWarnings(warnings: readonly string[]): boolean {
  return warnings.some((warning) =>
    /^(?:catalog_unmaterialized_total|sort_truncated|option_alternatives_fanout):/u
      .test(warning)
  );
}

/**
 * Progressive recall for a verified, source-only replacement request.
 *
 * This deliberately does NOT select analogs. Every returned card still needs
 * the caller's source-ID/model exclusion, positive-stock/price rules, live
 * structural fit, and dimensional/installation checks. A relaxed query only
 * broadens what those gates may inspect. Production requests pass through
 * executeSearchCatalog, which removes restricted-view products before cache
 * insertion; no alternate raw-API path is introduced here.
 *
 * The category and price bounds are invariant across stages. The final
 * `leaf_only` stage removes only source-derived facets, not those bounds.
 * No result claims a catalog-wide minimum or a complete catalog scan.
 */
export async function retrieveReplacementCandidateWindow(
  input: ReplacementCandidateRetrievalInput,
): Promise<ReplacementCandidateRetrievalResult> {
  const leaf = input.leafCategory.trim();
  if (
    !leaf || leaf.length > 240 || !Number.isFinite(input.minPrice ?? 1) ||
    (input.minPrice ?? 1) < 0 ||
    (input.maxPrice !== undefined &&
      (!Number.isFinite(input.maxPrice) || input.maxPrice <= 0 ||
        input.maxPrice < (input.minPrice ?? 1)))
  ) {
    throw new TypeError("invalid replacement retrieval bounds");
  }
  const entries = validateOptions(input.strictOptions);
  const stages = buildStages(entries, input.softFacetOrder ?? []);
  const pageSize = boundedInteger(input.pageSize, 50, 1, 50);
  const maxPagesTotal = boundedInteger(input.maxPagesTotal, 12, 1, 30);
  const maxCatalogRequestsTotal = boundedInteger(
    input.maxCatalogRequestsTotal,
    24,
    1,
    60,
  );
  const maxPagesPerStage = boundedInteger(input.maxPagesPerStage, 1, 1, 10);
  const maxLeafPages = boundedInteger(input.maxLeafPages, 5, 1, 20);
  const deadlineMs = boundedInteger(input.deadlineMs, 10_000, 1, 30_000);
  const search = input.search ?? executeSearchCatalog;
  const found = new Map<string, ProductRef>();
  const evidence: ReplacementCandidateStageEvidence[] = [];
  let pagesRequested = 0;
  let catalogRequestsMade = 0;
  let catalogRequestBudgetExceeded = false;
  let termination: ReplacementCandidateRetrievalResult["termination"] =
    "stage_plan_completed";
  let failedStage: ReplacementCandidateRetrievalResult["failedStage"];
  let leafQueryCoverage: CatalogCandidateCoverage | null = null;
  let ownDeadlineExpired = false;
  const controller = new AbortController();
  const onExternalAbort = () => {
    controller.abort();
  };
  input.deps.signal?.addEventListener("abort", onExternalAbort, { once: true });
  // The external signal can change between the first read and registration.
  if (input.deps.signal?.aborted) onExternalAbort();
  const timer = setTimeout(() => {
    ownDeadlineExpired = true;
    controller.abort();
  }, deadlineMs);
  const upstreamFetch = input.deps.fetchImpl ?? fetch;
  const boundedFetch: typeof fetch = (...args) => {
    if (controller.signal.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }
    if (catalogRequestsMade >= maxCatalogRequestsTotal) {
      catalogRequestBudgetExceeded = true;
      return Promise.reject(
        new Error("replacement catalog request limit reached"),
      );
    }
    catalogRequestsMade++;
    return upstreamFetch(...args);
  };
  const deps = {
    ...input.deps,
    fetchImpl: boundedFetch,
    signal: controller.signal,
  };
  const abortOutcome = (): "deadline" | "external_abort" =>
    ownDeadlineExpired ? "deadline" : "external_abort";
  try {
    for (const plan of stages) {
      if (controller.signal.aborted) {
        termination = abortOutcome();
        break;
      }
      if (pagesRequested >= maxPagesTotal) {
        termination = "page_cap";
        break;
      }
      if (catalogRequestsMade >= maxCatalogRequestsTotal) {
        termination = "request_cap";
        break;
      }
      const stage: ReplacementCandidateStageEvidence = {
        id: plan.id,
        kind: plan.kind,
        droppedFacetKeys: plan.droppedFacetKeys,
        activeFacetKeys: plan.activeFacetKeys,
        pages: [],
        coverage: "unknown",
        requestedWindowScanned: false,
        interruption: null,
      };
      evidence.push(stage);
      const stagePageCap = plan.kind === "leaf_only"
        ? maxLeafPages
        : maxPagesPerStage;
      let firstTotal: number | null = null;
      let unknownCoverage = false;
      for (let page = 1; page <= stagePageCap; page++) {
        if (controller.signal.aborted) {
          stage.interruption = abortOutcome();
          termination = stage.interruption;
          break;
        }
        if (pagesRequested >= maxPagesTotal) {
          stage.interruption = "global_page_limit";
          termination = "page_cap";
          break;
        }
        if (catalogRequestsMade >= maxCatalogRequestsTotal) {
          stage.interruption = "upstream_request_limit";
          termination = "request_cap";
          break;
        }
        const request: SearchCatalogInput = {
          mode: "by_filter",
          category: leaf,
          anchor_leaf_category: leaf,
          min_price: input.minPrice ?? 1,
          ...(input.maxPrice !== undefined
            ? { max_price: input.maxPrice }
            : {}),
          per_page: pageSize,
          page,
          ...(plan.activeFacetKeys.length ? { options: plan.options } : {}),
        };
        // A timeout still returns if an injected executor ignores AbortSignal.
        // The real catalog fetch also observes the same signal, so it cannot
        // continue spending the request budget after this function returns.
        let abortListener: (() => void) | undefined;
        const aborted = new Promise<null>((resolve) => {
          abortListener = () => resolve(null);
          controller.signal.addEventListener("abort", abortListener, {
            once: true,
          });
          if (controller.signal.aborted) resolve(null);
        });
        pagesRequested++;
        let result: SearchResult | null;
        try {
          result = await Promise.race([
            search(request, deps, input.cache),
            aborted,
          ]);
        } catch {
          if (abortListener) {
            controller.signal.removeEventListener("abort", abortListener);
          }
          stage.interruption = "catalog_error";
          termination = "catalog_error";
          failedStage = {
            id: plan.id,
            errorCode: "internal",
            message: "catalog executor rejected",
          };
          break;
        }
        if (abortListener) {
          controller.signal.removeEventListener("abort", abortListener);
        }
        if (result === null || controller.signal.aborted) {
          stage.interruption = abortOutcome();
          termination = stage.interruption;
          break;
        }
        if (catalogRequestBudgetExceeded) {
          stage.interruption = "upstream_request_limit";
          termination = "request_cap";
          break;
        }
        if (!result.ok) {
          stage.interruption = "catalog_error";
          termination = "catalog_error";
          failedStage = {
            id: plan.id,
            errorCode: result.error_code,
            message: result.message,
          };
          break;
        }
        const warnings = result.warnings ?? [];
        stage.pages.push({
          page,
          reportedTotal: result.total,
          candidateCoverage: result.candidate_coverage ?? "unknown",
          visibleCount: result.results.length,
          warnings: [...warnings],
        });
        if (
          !Number.isSafeInteger(result.total) || result.total < 0 ||
          (firstTotal !== null && result.total !== firstTotal)
        ) {
          stage.interruption = "pagination_changed";
          termination = "pagination_changed";
          break;
        }
        firstTotal ??= result.total;
        if (
          result.candidate_coverage === "unknown" ||
          !result.candidate_coverage ||
          uncertainWarnings(warnings) ||
          (result.candidate_coverage === "complete_query_window" &&
            (page > 1 || result.total > pageSize))
        ) unknownCoverage = true;
        for (const product of result.results) {
          if (!found.has(product.id)) found.set(product.id, product);
        }
        stage.coverage = unknownCoverage
          ? "unknown"
          : page === 1 && result.candidate_coverage === "complete_query_window"
          ? "complete_query_window"
          : "partial";
        if (
          result.candidate_coverage !== "unknown" &&
          result.candidate_coverage !== undefined &&
          !uncertainWarnings(warnings) &&
          result.total <= page * pageSize
        ) {
          stage.requestedWindowScanned = true;
        }
        if (input.stopWhen?.([...found.values()])) {
          stage.interruption = "target_reached";
          termination = "target_reached";
          break;
        }
        if (stage.requestedWindowScanned) break;
      }
      if (plan.kind === "leaf_only") leafQueryCoverage = stage.coverage;
      if (termination !== "stage_plan_completed") break;
      if (!stage.requestedWindowScanned) {
        stage.interruption = catalogRequestsMade >= maxCatalogRequestsTotal
          ? "upstream_request_limit"
          : pagesRequested >= maxPagesTotal
          ? "global_page_limit"
          : "stage_page_limit";
        if (stage.interruption === "global_page_limit") {
          termination = "page_cap";
        } else if (stage.interruption === "upstream_request_limit") {
          termination = "request_cap";
        }
      }
    }
  } finally {
    clearTimeout(timer);
    input.deps.signal?.removeEventListener("abort", onExternalAbort);
  }
  return {
    products: [...found.values()],
    stages: evidence,
    plannedStageCount: stages.length,
    pagesRequested,
    catalogRequestsMade,
    termination,
    ...(failedStage ? { failedStage } : {}),
    leafQueryCoverage,
  };
}
