/**
 * Evidence boundaries for catalog taxonomy and facet responses.
 *
 * This module has no fetch, cache, product vocabulary, or search policy. An
 * adapter must supply the HTTP status and parsed body of every requested page.
 * Only `complete` taxonomy can support an absence claim or a reusable cache;
 * `visible_only` names are positive observations for this call only.
 */

export type CatalogEvidenceFailure =
  | "http_error"
  | "invalid_envelope"
  | "invalid_pagination"
  | "invalid_category"
  | "duplicate_id"
  | "page_drift"
  | "missing_page"
  | "empty_catalog"
  | "invalid_facets"
  | "category_mismatch";

type Unavailable = { state: "unavailable"; reason: CatalogEvidenceFailure };

export type CategoryPagination = {
  page: number;
  perPage: number;
  pages: number;
  total: number;
};

export type CategoryPageEvidence =
  | Unavailable
  | {
    state: "complete" | "visible_only";
    pagination: CategoryPagination;
    names: string[];
    ids: number[];
  };

export type CategoryEvidence =
  | Unavailable
  | { state: "complete" | "visible_only"; names: string[] };

export type CategoryEvidenceLimits = {
  maxPages?: number;
  maxPerPage?: number;
  maxDepth?: number;
  maxNodes?: number;
  maxNames?: number;
};

const DEFAULT_LIMITS = {
  maxPages: 50,
  maxPerPage: 200,
  maxDepth: 10,
  maxNodes: 12_000,
  maxNames: 10_000,
} as const;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function successHttp(status: number): boolean {
  return safeInt(status) && status >= 200 && status < 300;
}

/** Accept the legacy direct body and up to two legitimate `data` envelopes. */
function unwrapCatalogData(raw: unknown): Record<string, unknown> | null {
  let current: unknown = raw;
  for (let level = 0; level <= 2; level++) {
    if (!object(current)) return null;
    // Absence of success is a legitimate catalog format. If the field exists,
    // it must affirm success; null/false/string success is not proof.
    if ("success" in current && current.success !== true) return null;
    if (!("data" in current)) return current;
    if (level === 2) return null;
    current = current.data;
  }
  return null;
}

function limit(value: number | undefined, fallback: number): number {
  return safeInt(value) && value > 0 ? value : fallback;
}

/** Validate one requested root page, including every visible descendant. */
export function assessCategoryPage(
  raw: unknown,
  requestedPage: number,
  httpStatus = 200,
  limits: CategoryEvidenceLimits = {},
): CategoryPageEvidence {
  if (!successHttp(httpStatus)) {
    return { state: "unavailable", reason: "http_error" };
  }
  const data = unwrapCatalogData(raw);
  if (!data) return { state: "unavailable", reason: "invalid_envelope" };
  const pagination = data.pagination;
  if (
    !object(pagination) || !Array.isArray(data.results) ||
    !safeInt(requestedPage) || requestedPage < 1 ||
    !safeInt(pagination.page) || pagination.page !== requestedPage ||
    !safeInt(pagination.per_page) || pagination.per_page < 1 ||
    pagination.per_page > limit(limits.maxPerPage, DEFAULT_LIMITS.maxPerPage) ||
    !safeInt(pagination.pages) || pagination.pages < 1 ||
    pagination.pages > limit(limits.maxPages, DEFAULT_LIMITS.maxPages) ||
    !safeInt(pagination.total) || pagination.total < 0 ||
    pagination.pages !==
      Math.max(1, Math.ceil(pagination.total / pagination.per_page)) ||
    requestedPage > pagination.pages ||
    data.results.length !== Math.min(
        pagination.per_page,
        Math.max(
          0,
          pagination.total - (requestedPage - 1) * pagination.per_page,
        ),
      )
  ) {
    return { state: "unavailable", reason: "invalid_pagination" };
  }

  const names = new Set<string>();
  const ids = new Set<number>();
  let childrenComplete = true;
  let failure: CatalogEvidenceFailure | null = null;
  const maxDepth = limit(limits.maxDepth, DEFAULT_LIMITS.maxDepth);
  const maxNodes = limit(limits.maxNodes, DEFAULT_LIMITS.maxNodes);
  const maxNames = limit(limits.maxNames, DEFAULT_LIMITS.maxNames);

  const visit = (nodes: unknown[], depth: number): void => {
    // An empty child list proves there is nothing deeper to validate. It is
    // legitimate on a leaf exactly at the requested maximum depth.
    if (nodes.length === 0) return;
    if (depth > maxDepth) {
      failure = "invalid_category";
      return;
    }
    for (const node of nodes) {
      if (failure) return;
      if (
        !object(node) || !safeInt(node.id) || node.id < 0 ||
        typeof node.pagetitle !== "string" || !node.pagetitle.trim() ||
        typeof node.alias !== "string" ||
        !safeInt(node.parent) || node.parent < 0 ||
        (node.children != null && !Array.isArray(node.children))
      ) {
        failure = "invalid_category";
        return;
      }
      if (ids.has(node.id)) {
        failure = "duplicate_id";
        return;
      }
      ids.add(node.id);
      names.add(node.pagetitle.trim());
      if (ids.size > maxNodes || names.size > maxNames) {
        failure = "invalid_category";
        return;
      }
      if (!Array.isArray(node.children)) childrenComplete = false;
      else visit(node.children, depth + 1);
    }
  };
  visit(data.results, 0);
  if (failure) return { state: "unavailable", reason: failure };
  return {
    state: childrenComplete ? "complete" : "visible_only",
    pagination: {
      page: pagination.page,
      perPage: pagination.per_page,
      pages: pagination.pages,
      total: pagination.total,
    },
    names: [...names],
    ids: [...ids],
  };
}

/**
 * Combine all requested root pages. A complete claim requires every page,
 * consistent pagination, and globally unique category IDs (including leaves).
 */
export function combineCategoryPages(
  pages: readonly CategoryPageEvidence[],
  limits: Pick<CategoryEvidenceLimits, "maxNames" | "maxNodes"> = {},
): CategoryEvidence {
  if (pages.length === 0) {
    return { state: "unavailable", reason: "missing_page" };
  }
  const failed = pages.find((page): page is Unavailable =>
    page.state === "unavailable"
  );
  if (failed) return failed;
  const available = pages as Array<Exclude<CategoryPageEvidence, Unavailable>>;
  const first = available.find((page) => page.pagination.page === 1);
  if (!first) return { state: "unavailable", reason: "missing_page" };
  if (pages.length !== first.pagination.pages) {
    return { state: "unavailable", reason: "missing_page" };
  }
  const visitedPages = new Set<number>();
  const names = new Set<string>();
  const ids = new Set<number>();
  let complete = true;
  const maxNames = limit(limits.maxNames, DEFAULT_LIMITS.maxNames);
  const maxNodes = limit(limits.maxNodes, DEFAULT_LIMITS.maxNodes);
  for (const page of available) {
    const p = page.pagination;
    if (
      visitedPages.has(p.page) || p.page < 1 ||
      p.page > first.pagination.pages ||
      p.perPage !== first.pagination.perPage ||
      p.pages !== first.pagination.pages ||
      p.total !== first.pagination.total
    ) {
      return { state: "unavailable", reason: "page_drift" };
    }
    visitedPages.add(p.page);
    if (page.state === "visible_only") complete = false;
    for (const id of page.ids) {
      if (ids.has(id)) return { state: "unavailable", reason: "duplicate_id" };
      ids.add(id);
      if (ids.size > maxNodes) {
        return { state: "unavailable", reason: "invalid_category" };
      }
    }
    for (const name of page.names) {
      names.add(name);
      if (names.size > maxNames) {
        return { state: "unavailable", reason: "invalid_category" };
      }
    }
  }
  if (names.size === 0) {
    return { state: "unavailable", reason: "empty_catalog" };
  }
  return {
    state: complete ? "complete" : "visible_only",
    names: [...names].sort(),
  };
}

export type CatalogFacetCategory = Record<string, unknown> & {
  total_products: number;
};
export type CatalogFacetOption = Record<string, unknown> & {
  key: string;
  values: Record<string, unknown>[];
};

export type FacetEvidence =
  | Unavailable
  | {
    state: "verified";
    category: CatalogFacetCategory;
    options: CatalogFacetOption[];
    totalProducts: number;
  };

export type FacetIdentity = {
  categoryId?: number | string;
  pagetitle?: string;
};

function validFacetOption(value: unknown): value is CatalogFacetOption {
  if (
    !object(value) || typeof value.key !== "string" || !value.key.trim() ||
    !Array.isArray(value.values) ||
    (value.caption_ru != null && typeof value.caption_ru !== "string") ||
    (value.caption_kz != null && typeof value.caption_kz !== "string") ||
    (value.caption != null && typeof value.caption !== "string")
  ) return false;
  return value.values.every((entry: unknown) => {
    if (!object(entry)) return false;
    const ru = entry.value_ru ?? entry.value;
    const kz = entry.value_kz;
    const count = entry.products_count;
    return (ru == null || typeof ru === "string" ||
      (typeof ru === "number" && Number.isFinite(ru))) &&
      (kz == null || typeof kz === "string") &&
      ((typeof ru === "string" && !!ru.trim()) || typeof ru === "number" ||
        (typeof kz === "string" && !!kz.trim())) &&
      (count == null || (safeInt(count) && count >= 0));
  });
}

/** A facet schema is verified only for the exact requested category. */
export function assessCategoryFacets(
  raw: unknown,
  expected: FacetIdentity,
  httpStatus = 200,
): FacetEvidence {
  if (!successHttp(httpStatus)) {
    return { state: "unavailable", reason: "http_error" };
  }
  const data = unwrapCatalogData(raw);
  if (!data) return { state: "unavailable", reason: "invalid_envelope" };
  if (
    !object(data.category) || !Array.isArray(data.options) ||
    !safeInt(data.category.total_products) || data.category.total_products < 0
  ) {
    return { state: "unavailable", reason: "invalid_facets" };
  }
  const requestedId = expected.categoryId;
  const requestedTitle = expected.pagetitle?.trim();
  const validRequestedId = requestedId == null ||
    ((typeof requestedId === "number" || typeof requestedId === "string") &&
      /^\d{1,15}$/.test(String(requestedId)) &&
      Number.isSafeInteger(Number(requestedId)) && Number(requestedId) >= 1);
  if (
    !validRequestedId || (requestedId == null && !requestedTitle) ||
    (requestedId != null && String(data.category.id) !== String(requestedId)) ||
    (requestedTitle &&
      (typeof data.category.pagetitle !== "string" ||
        data.category.pagetitle.trim() !== requestedTitle))
  ) {
    return { state: "unavailable", reason: "category_mismatch" };
  }
  if (
    data.options.some((option: unknown) => !validFacetOption(option)) ||
    (data.category.total_products > 0 &&
      !data.options.some((option: CatalogFacetOption) =>
        option.values.length > 0
      ))
  ) {
    return { state: "unavailable", reason: "invalid_facets" };
  }
  return {
    state: "verified",
    category: data.category as CatalogFacetCategory,
    options: data.options as CatalogFacetOption[],
    totalProducts: data.category.total_products,
  };
}
