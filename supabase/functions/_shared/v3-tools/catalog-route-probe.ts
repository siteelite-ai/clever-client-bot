import {
  type CatalogClientDeps,
  executeSearchCatalog,
} from "./search-catalog.ts";
import {
  executeDiscoverCategory,
  verifyExactCatalogLeaf,
} from "./discover-category.ts";
import type { ProductCache } from "./types.ts";

/** Private, read-only diagnostics. The caller must authenticate before calling this helper. */
export const CATALOG_ROUTE_PROBE_TYPE = "catalog_route_probe";

export interface CatalogRouteProbePayload {
  type: typeof CATALOG_ROUTE_PROBE_TYPE;
  query?: string;
  exact_category?: string;
  /** Optional diagnostic for compound answers; not required for exact-leaf readiness. */
  check_facets?: true;
}

export type CatalogRouteProbeClassification =
  | "invalid_probe"
  | "timeout"
  | "rate_limit"
  | "upstream"
  | "no_match"
  | "adapter";

export interface CatalogRouteProbeCheck {
  status: "ok" | "unavailable";
  duration_ms: number;
  classification?: Exclude<CatalogRouteProbeClassification, "invalid_probe">;
  /** The ordinary taxonomy adapter may use its one-hour cache. This is not proof of a cold fetch. */
  taxonomy_cache?: "eligible_unverified";
}

export interface CatalogRouteProbeResult {
  ok: boolean;
  status: "ready" | "unavailable";
  classification?: CatalogRouteProbeClassification;
  checks: {
    search?: CatalogRouteProbeCheck;
    exact_leaf?: CatalogRouteProbeCheck;
    taxonomy?: CatalogRouteProbeCheck;
  };
}

export interface CatalogRouteProbeLimits {
  /** One logical search may otherwise retry 429 more than once. */
  searchDeadlineMs?: number;
  /** The taxonomy adapter uses this deadline for each of its two bounded phases. */
  taxonomyRequestTimeoutMs?: number;
}

const MAX_FIELD_CHARACTERS = 64;
const SEARCH_DEADLINE_MS = 8_500;
const TAXONOMY_REQUEST_TIMEOUT_MS = 6_000;

function cleanProbeField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || [...text].length > MAX_FIELD_CHARACTERS) return null;
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text)) return null;
  return text;
}

export function isCatalogRouteProbeCandidate(
  body: unknown,
): body is { type: typeof CATALOG_ROUTE_PROBE_TYPE } {
  return body !== null && typeof body === "object" && !Array.isArray(body) &&
    (body as { type?: unknown }).type === CATALOG_ROUTE_PROBE_TYPE;
}

/** Unknown keys, unbounded text and empty probes fail before any catalog request. */
export function parseCatalogRouteProbePayload(
  body: unknown,
): CatalogRouteProbePayload | null {
  if (!isCatalogRouteProbeCandidate(body)) return null;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) =>
    key !== "type" && key !== "query" && key !== "exact_category" &&
    key !== "check_facets"
  )) return null;
  const hasQuery = Object.hasOwn(record, "query");
  const hasCategory = Object.hasOwn(record, "exact_category");
  if (!hasQuery && !hasCategory) return null;
  const query = hasQuery ? cleanProbeField(record.query) : null;
  const exactCategory = hasCategory
    ? cleanProbeField(record.exact_category)
    : null;
  if ((hasQuery && query === null) || (hasCategory && exactCategory === null)) {
    return null;
  }
  const checkFacets = Object.hasOwn(record, "check_facets");
  if (checkFacets && (record.check_facets !== true || !exactCategory)) return null;
  return {
    type: CATALOG_ROUTE_PROBE_TYPE,
    ...(query ? { query } : {}),
    ...(exactCategory ? { exact_category: exactCategory } : {}),
    ...(checkFacets ? { check_facets: true as const } : {}),
  };
}

function boundedMs(requested: number | undefined, maximum: number): number {
  return Number.isSafeInteger(requested) && requested! > 0
    ? Math.min(requested!, maximum)
    : maximum;
}

function classificationForErrorCode(
  code: string,
): Exclude<CatalogRouteProbeClassification, "invalid_probe"> {
  switch (code) {
    case "catalog_timeout":
      return "timeout";
    case "rate_limited":
      return "rate_limit";
    case "category_not_found":
      return "no_match";
    case "bad_input":
    case "incomplete_filter":
      return "adapter";
    default:
      return "upstream";
  }
}

function unavailable(
  started: number,
  classification: Exclude<CatalogRouteProbeClassification, "invalid_probe">,
  taxonomy = false,
): CatalogRouteProbeCheck {
  return {
    status: "unavailable",
    classification,
    duration_ms: Math.max(0, Date.now() - started),
    ...(taxonomy ? { taxonomy_cache: "eligible_unverified" as const } : {}),
  };
}

async function searchProbe(
  query: string,
  deps: CatalogClientDeps,
  deadlineMs: number,
): Promise<CatalogRouteProbeCheck> {
  const started = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The production branch uses the same by_query/min_price/per_page adapter.
    // Bound its possible rate-limit retries as one private QA operation.
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, deadlineMs);
    });
    const cache: ProductCache = new Map();
    const result = await Promise.race([
      executeSearchCatalog(
        { mode: "by_query", query, min_price: 1, per_page: 50 },
        {
          ...deps,
          timeoutMs: Math.min(deps.timeoutMs ?? deadlineMs, deadlineMs),
          signal: controller.signal,
        },
        cache,
      ),
      deadline,
    ]);
    if (result === null || controller.signal.aborted) {
      return unavailable(started, "timeout");
    }
    if (!result.ok) {
      return unavailable(started, classificationForErrorCode(result.error_code));
    }
    if (result.results.length === 0) return unavailable(started, "no_match");
    return { status: "ok", duration_ms: Math.max(0, Date.now() - started) };
  } catch {
    return unavailable(started, controller.signal.aborted ? "timeout" : "upstream");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

async function taxonomyProbe(
  exactCategory: string,
  deps: CatalogClientDeps,
  timeoutMs: number,
): Promise<CatalogRouteProbeCheck> {
  const started = Date.now();
  try {
    // Do not provide openrouterApiKey. Exact pagetitle resolution needs only
    // catalog taxonomy and /categories/options, never a paid model request.
    const result = await executeDiscoverCategory(
      { noun: exactCategory },
      {
        ...deps,
        timeoutMs: Math.min(deps.timeoutMs ?? timeoutMs, timeoutMs),
        openrouterApiKey: undefined,
        requireExactPagetitle: true,
      },
    );
    if (!result.ok) {
      // Discovery can report category_not_found after /options failed. Only
      // exact-leaf taxonomy may classify a genuine absence.
      const classification = result.error_code === "category_not_found"
        ? "upstream"
        : classificationForErrorCode(result.error_code);
      return unavailable(started, classification, true);
    }
    if (result.leaf_categories.length === 0) {
      return unavailable(started, "no_match", true);
    }
    return {
      status: "ok",
      duration_ms: Math.max(0, Date.now() - started),
      taxonomy_cache: "eligible_unverified",
    };
  } catch {
    return unavailable(started, "upstream", true);
  }
}

async function exactLeafProbe(
  exactCategory: string,
  deps: CatalogClientDeps,
  timeoutMs: number,
): Promise<CatalogRouteProbeCheck> {
  const started = Date.now();
  try {
    const result = await verifyExactCatalogLeaf(exactCategory, {
      ...deps,
      timeoutMs: Math.min(deps.timeoutMs ?? timeoutMs, timeoutMs),
      openrouterApiKey: undefined,
    });
    if (!result.ok) {
      return unavailable(started, classificationForErrorCode(result.error_code), true);
    }
    return {
      status: "ok",
      duration_ms: Math.max(0, Date.now() - started),
      taxonomy_cache: "eligible_unverified",
    };
  } catch {
    return unavailable(started, "upstream", true);
  }
}

/** Never return catalog payloads, request values, tokens or raw exceptions. */
export async function runCatalogRouteProbe(
  rawPayload: unknown,
  deps: CatalogClientDeps,
  limits: CatalogRouteProbeLimits = {},
): Promise<CatalogRouteProbeResult> {
  const payload = parseCatalogRouteProbePayload(rawPayload);
  if (!payload) {
    return {
      ok: false,
      status: "unavailable",
      classification: "invalid_probe",
      checks: {},
    };
  }
  const checks: CatalogRouteProbeResult["checks"] = {};
  // Sequential requests avoid making a distressed upstream handle both
  // expensive paths at once. They are still independently classified.
  if (payload.query) {
    checks.search = await searchProbe(
      payload.query,
      deps,
      boundedMs(limits.searchDeadlineMs, SEARCH_DEADLINE_MS),
    );
  }
  if (payload.exact_category) {
    checks.exact_leaf = await exactLeafProbe(
      payload.exact_category,
      deps,
      boundedMs(limits.taxonomyRequestTimeoutMs, TAXONOMY_REQUEST_TIMEOUT_MS),
    );
    if (payload.check_facets) {
      checks.taxonomy = await taxonomyProbe(
        payload.exact_category,
        deps,
        boundedMs(limits.taxonomyRequestTimeoutMs, TAXONOMY_REQUEST_TIMEOUT_MS),
      );
    }
  }
  const failed = Object.values(checks).find((check) =>
    check.status === "unavailable"
  );
  return failed
    ? {
      ok: false,
      status: "unavailable",
      classification: failed.classification ?? "upstream",
      checks,
    }
    : { ok: true, status: "ready", checks };
}
