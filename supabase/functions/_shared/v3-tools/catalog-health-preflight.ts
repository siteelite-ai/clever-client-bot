import {
  type CatalogClientDeps,
  isRestrictedCatalogProduct,
  normalizeProductUrl,
} from "./search-catalog.ts";
import { assessCategoryFacets } from "../catalog-evidence.ts";

/** This route is private QA infrastructure, never a customer chat message. */
export const CATALOG_HEALTH_PREFLIGHT_TYPE = "catalog_health_preflight";
export const CATALOG_QA_SECRET_ENV = "VOLT220_V3_CATALOG_QA_SECRET";
export const CATALOG_QA_SECRET_HEADER = "x-catalog-qa-secret";

export type CatalogHealthClassification =
  | "auth"
  | "route"
  | "rate_limit"
  | "upstream"
  | "transport"
  | "schema_error";

type CheckName = "categories" | "products" | "facets" | "article_filter";
type CheckResult = {
  status: "ok" | "unavailable";
  http_status: number | null;
  classification?: CatalogHealthClassification;
};

export type CatalogHealthPreflightResult = {
  ok: boolean;
  status: "ready" | "unavailable";
  classification?: CatalogHealthClassification;
  // A dependency failure skips dependent checks rather than sending another
  // request to a distressed upstream. Ready requires all four checks.
  checks: Pick<Record<CheckName, CheckResult>, "categories" | "products"> &
    Partial<Pick<Record<CheckName, CheckResult>, "facets" | "article_filter">>;
};

const CHECK_TIMEOUT_MS = 8_000;
const CATEGORY_DEADLINE_MS = 10_000;
const CATEGORY_PAGE_SIZE = 200;
const MAX_CATEGORY_PAGES = 64;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_TAXONOMY_NODES = 12_000;
const MAX_CATEGORY_TITLE_CHARS = 160;
// Match the depth=10 completeness boundary of the discovery adapter. A node
// at depth 10 may have descendants hidden by the requested tree depth.
const REQUESTED_TAXONOMY_DEPTH = 10;

type EndpointResult = { check: CheckResult; results?: unknown[] };
type Leaf = { id: number; pagetitle: string };
type ProductIdentity = { id: number; article: string };

/** An exact article filter must fit in one page; taxonomy has its own full-tree walker. */
function isCompleteFirstPage(data: unknown, results: unknown[]): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const pagination = (data as { pagination?: unknown }).pagination;
  if (!pagination || typeof pagination !== "object" || Array.isArray(pagination)) {
    return false;
  }
  const page = pagination as Record<string, unknown>;
  return page.page === 1 && page.pages === 1 &&
    Number.isSafeInteger(page.per_page) && Number(page.per_page) > 0 &&
    Number.isSafeInteger(page.total) && page.total === results.length &&
    results.length <= Number(page.per_page);
}

function cleanCategoryTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.trim();
  if (
    !title || [...title].length > MAX_CATEGORY_TITLE_CHARS ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(title)
  ) return null;
  return title;
}

type CategoryPagination = {
  page: number;
  pages: number;
  per_page: number;
  total: number;
};

/** Fail closed on pagination drift, missing rows, or metadata inconsistent with the requested page. */
function readCategoryPage(
  json: unknown,
  requestedPage: number,
  firstPage?: CategoryPagination,
): { results: unknown[]; pagination: CategoryPagination } | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const envelope = json as Record<string, unknown>;
  if (envelope.success === false) return null;
  const data = envelope.data ?? envelope;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const body = data as Record<string, unknown>;
  const results = body.results;
  const rawPagination = body.pagination;
  if (!Array.isArray(results) || !rawPagination ||
    typeof rawPagination !== "object" || Array.isArray(rawPagination)) return null;
  const page = rawPagination as Record<string, unknown>;
  if (page.page !== requestedPage || !Number.isSafeInteger(page.pages) ||
    Number(page.pages) < 1 || Number(page.pages) > MAX_CATEGORY_PAGES ||
    !Number.isSafeInteger(page.per_page) || Number(page.per_page) < 1 ||
    Number(page.per_page) > CATEGORY_PAGE_SIZE ||
    !Number.isSafeInteger(page.total) || Number(page.total) < 1 ||
    Number(page.total) > MAX_TAXONOMY_NODES) return null;
  const pagination = page as CategoryPagination;
  if (pagination.pages !== Math.ceil(pagination.total / pagination.per_page) ||
    (firstPage && (pagination.pages !== firstPage.pages ||
      pagination.per_page !== firstPage.per_page ||
      pagination.total !== firstPage.total))) return null;
  const expectedLength = Math.min(
    pagination.per_page,
    pagination.total - (requestedPage - 1) * pagination.per_page,
  );
  if (expectedLength < 1 || results.length !== expectedLength) return null;
  return { results, pagination };
}

/** Validate the actual complete tree, including nested IDs and explicit child arrays. */
function scanCategoryNodes(
  roots: unknown[],
  seenIds: Set<number>,
): boolean {
  const stack = roots.map((node) => ({ node, depth: 0 }));
  while (stack.length > 0) {
    if (seenIds.size >= MAX_TAXONOMY_NODES) return false;
    const next = stack.pop();
    if (!next || next.depth >= REQUESTED_TAXONOMY_DEPTH) return false;
    const raw = next.node;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const node = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(node.id) || Number(node.id) <= 0 ||
      seenIds.has(Number(node.id)) ||
      !cleanCategoryTitle(node.pagetitle) || !Array.isArray(node.children)) {
      return false;
    }
    seenIds.add(Number(node.id));
    for (const child of node.children) {
      stack.push({ node: child, depth: next.depth + 1 });
    }
  }
  return true;
}

/** Fetch every root page under one deadline; partial taxonomy is never ready. */
async function checkCategories(deps: CatalogClientDeps): Promise<EndpointResult> {
  const controller = new AbortController();
  const timeoutMs = Math.min(
    deps.timeoutMs ?? CATEGORY_DEADLINE_MS,
    CATEGORY_DEADLINE_MS,
  );
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let httpStatus: number | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error("catalog taxonomy deadline"));
    }, Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([
      (async (): Promise<EndpointResult> => {
        const roots: unknown[] = [];
        const seenIds = new Set<number>();
        let firstPage: CategoryPagination | undefined;
        for (let page = 1; page <= (firstPage?.pages ?? 1); page++) {
          const url = `${deps.baseUrl}/categories?parent=0&depth=10&per_page=${CATEGORY_PAGE_SIZE}&page=${page}`;
          httpStatus = null;
          const response = await (deps.fetchImpl ?? fetch)(url, {
            method: "GET",
            redirect: "error",
            headers: {
              Authorization: `Bearer ${deps.apiToken}`,
              "Content-Type": "application/json",
            },
            signal: controller.signal,
          });
          httpStatus = response.status;
          if (!response.ok) {
            return { check: {
              status: "unavailable",
              http_status: response.status,
              classification: classifyCatalogHealthHttpStatus(response.status),
            } };
          }
          const decoded = readCategoryPage(
            await readBoundedJson(response), page, firstPage,
          );
          if (!decoded || !scanCategoryNodes(decoded.results, seenIds)) {
            return { check: {
              status: "unavailable", http_status: response.status,
              classification: "schema_error",
            } };
          }
          firstPage ??= decoded.pagination;
          roots.push(...decoded.results);
        }
        return {
          check: { status: "ok", http_status: httpStatus },
          results: roots,
        };
      })(),
      timeout,
    ]);
  } catch {
    return { check: {
      status: "unavailable",
      http_status: httpStatus,
      classification: httpStatus === null || controller.signal.aborted
        ? "transport"
        : "schema_error",
    } };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    controller.abort();
  }
}

/** Use an explicit live leaf, preferring the immediate parent of a usable product. */
function representativeLeaf(
  categories: unknown[],
  products: unknown[],
): Leaf | null {
  const stack = [...categories];
  const leaves: Leaf[] = [];
  const titleCounts = new Map<string, number>();
  let visited = 0;
  while (stack.length > 0) {
    if (++visited > MAX_TAXONOMY_NODES) return null;
    const raw = stack.pop();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const node = raw as Record<string, unknown>;
    const title = cleanCategoryTitle(node.pagetitle);
    if (!Number.isSafeInteger(node.id) || Number(node.id) <= 0 ||
      !title || !Array.isArray(node.children)) return null;
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
    if (node.children.length > 0) {
      for (const child of node.children) stack.push(child);
    } else {
      leaves.push({ id: Number(node.id), pagetitle: title });
    }
  }
  const uniqueLeaves = leaves.filter((leaf) =>
    titleCounts.get(leaf.pagetitle) === 1
  );
  if (uniqueLeaves.length === 0) return null;
  for (const raw of products) {
    if (!hasUsableProduct([raw])) continue;
    const product = raw as Record<string, unknown>;
    const category = product.category;
    if (!category || typeof category !== "object" || Array.isArray(category)) {
      continue;
    }
    const parent = category as Record<string, unknown>;
    const title = cleanCategoryTitle(parent.pagetitle);
    if (!title) continue;
    const leaf = uniqueLeaves.find((candidate) =>
      candidate.pagetitle === title && candidate.id === parent.id
    );
    if (leaf) return leaf;
  }
  // Older catalog pages may omit the product's redundant category field.
  // Explicit children=[] plus an unambiguous title still proves a live leaf.
  return uniqueLeaves[0];
}

function hasUsableProduct(results: unknown[]): boolean {
  return results.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const product = item as Record<string, unknown>;
    if (isRestrictedCatalogProduct(product)) return false;
    const price = Number(product.price);
    return Number.isFinite(price) && price > 0 &&
      String(product.id ?? "").trim().length > 0 &&
      String(product.pagetitle ?? product.name ?? "").trim().length > 0 &&
      normalizeProductUrl(product.url) !== null;
  });
}

/** Derive the exact filter probe from a usable baseline SKU, never a fixture. */
function representativeProductIdentity(results: unknown[]): ProductIdentity | null {
  for (const raw of results) {
    if (!hasUsableProduct([raw])) continue;
    const product = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(product.id) || Number(product.id) <= 0) continue;
    if (typeof product.article !== "string") continue;
    const article = product.article.trim();
    if (!article || [...article].length > 120 ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(article)) continue;
    return { id: Number(product.id), article };
  }
  return null;
}

export function isExactCatalogHealthPreflightPayload(
  body: unknown,
): body is { type: typeof CATALOG_HEALTH_PREFLIGHT_TYPE } {
  return body !== null && typeof body === "object" &&
    !Array.isArray(body) &&
    Object.keys(body).length === 1 &&
    (body as { type?: unknown }).type === CATALOG_HEALTH_PREFLIGHT_TYPE;
}

export function classifyCatalogHealthHttpStatus(
  status: number,
): CatalogHealthClassification {
  if (status === 401 || status === 403) return "auth";
  if (status === 404 || status === 405) return "route";
  if (status === 429) return "rate_limit";
  return "upstream";
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing response body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("response too large");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function checkEndpoint(
  name: Exclude<CheckName, "categories">,
  deps: CatalogClientDeps,
  leaf?: Leaf,
  identity?: ProductIdentity,
): Promise<EndpointResult> {
  if ((name === "facets" && !leaf) ||
    (name === "article_filter" && !identity)) {
    return { check: {
      status: "unavailable", http_status: null, classification: "schema_error",
    } };
  }
  const params = name === "products"
    ? "per_page=20&page=1&min_price=1"
    : name === "article_filter"
    ? new URLSearchParams({ article: identity?.article ?? "", per_page: "50", page: "1" }).toString()
    : new URLSearchParams({ pagetitle: leaf?.pagetitle ?? "" }).toString();
  const path = name === "facets" ? "categories/options"
    : name === "article_filter" ? "products" : name;
  const url = `${deps.baseUrl}/${path}?${params}`;
  const controller = new AbortController();
  const timeoutMs = Math.min(
    deps.timeoutMs ?? CHECK_TIMEOUT_MS,
    CHECK_TIMEOUT_MS,
  );
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let httpStatus: number | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error("catalog preflight timeout"));
    }, Math.max(1, timeoutMs));
  });
  try {
    const result = await Promise.race([
      (async (): Promise<EndpointResult> => {
        const response = await (deps.fetchImpl ?? fetch)(url, {
          method: "GET",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${deps.apiToken}`,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        });
        httpStatus = response.status;
        if (!response.ok) {
          return { check: {
            status: "unavailable",
            http_status: response.status,
            classification: classifyCatalogHealthHttpStatus(response.status),
          } };
        }
        const json = await readBoundedJson(response);
        const envelope =
          json && typeof json === "object" && !Array.isArray(json)
            ? json as { data?: unknown; results?: unknown; success?: unknown }
            : null;
        if (name === "facets") {
          const data = envelope?.data;
          const unwrapped = data && typeof data === "object" &&
              !Array.isArray(data) && "data" in data &&
              !("options" in data)
            ? (data as { data?: unknown }).data
            : data;
          const facets = unwrapped && typeof unwrapped === "object" &&
              !Array.isArray(unwrapped)
            ? unwrapped as Record<string, unknown>
            : null;
          const category = facets?.category &&
              typeof facets.category === "object" &&
              !Array.isArray(facets.category)
            ? facets.category as Record<string, unknown>
            : null;
          // This response must belong to exactly the live taxonomy leaf we
          // requested, not a fallback/default category or an error envelope.
          const options = facets?.options;
          const validOptions = Array.isArray(options) && options.every((raw) => {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
              return false;
            }
            const option = raw as Record<string, unknown>;
            return typeof option.key === "string" && !!option.key.trim() &&
              typeof option.caption_ru === "string" &&
              !!option.caption_ru.trim();
          });
          const valid = envelope?.success !== false && !!leaf &&
            category?.id === leaf.id &&
            category?.pagetitle === leaf.pagetitle &&
            Number.isSafeInteger(category?.total_products) &&
            Number(category?.total_products) >= 0 &&
            validOptions &&
            // Keep QA readiness at least as strict as the runtime adapter:
            // positive product count needs an actual facet value, not merely
            // a nonempty list of empty facet shells.
            assessCategoryFacets(json, {
              categoryId: leaf.id,
              pagetitle: leaf.pagetitle,
            }).state === "verified";
          return { check: valid
            ? { status: "ok", http_status: response.status }
            : {
              status: "unavailable",
              http_status: response.status,
              classification: "schema_error",
            } };
        }
        if (name === "article_filter") {
          const data = envelope?.data;
          const filtered = data && typeof data === "object" && !Array.isArray(data)
            ? data as { results?: unknown }
            : null;
          const results = filtered?.results;
          // Unknown, contradictory or multi-page metadata cannot prove the
          // exact filter: unseen rows may violate it. Never report ready.
          const valid = envelope?.success !== false && !!identity &&
            Array.isArray(results) && results.length > 0 &&
            isCompleteFirstPage(filtered, results) &&
            results.every((raw) => {
              if (!hasUsableProduct([raw])) return false;
              const product = raw as Record<string, unknown>;
              return Number.isSafeInteger(product.id) && Number(product.id) > 0 &&
                typeof product.article === "string" &&
                product.article.trim() === identity.article;
            }) &&
            results.some((raw) =>
              (raw as Record<string, unknown>).id === identity.id
            );
          return { check: valid
            ? { status: "ok", http_status: response.status }
            : {
              status: "unavailable",
              http_status: response.status,
              classification: "schema_error",
            } };
        }
        // Discovery accepts either envelope; search_catalog specifically
        // consumes data.results, so the products check follows that adapter.
        const data = envelope?.data;
        const results = data && typeof data === "object" && !Array.isArray(data)
          ? (data as { results?: unknown }).results
          : null;
        const validProducts = Array.isArray(results) &&
          hasUsableProduct(results);
        if (envelope?.success === false || !validProducts) {
          return { check: {
            status: "unavailable",
            http_status: response.status,
            classification: "schema_error",
          } };
        }
        return {
          check: { status: "ok", http_status: response.status },
          results: results as unknown[],
        };
      })(),
      timeout,
    ]);
    return result;
  } catch {
    // A response whose body is malformed is distinct from a network failure.
    return { check: {
      status: "unavailable",
      http_status: httpStatus,
      classification: httpStatus === null || controller.signal.aborted
        ? "transport"
        : "schema_error",
    } };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    controller.abort();
  }
}

/**
 * Checks route availability on one representative live leaf and exact article.
 * This is not proof that a different customer's exact category has healthy facets; use
 * the private exact-category route probe before that paid QA scenario.
 */
export async function runCatalogHealthPreflight(
  deps: CatalogClientDeps,
): Promise<CatalogHealthPreflightResult> {
  // The first two checks are independent. Facets and exact article follow
  // only after usable baseline data, with bounded read-only calls in parallel.
  const [categoryResult, productResult] = await Promise.all([
    checkCategories(deps),
    checkEndpoint("products", deps),
  ]);
  const categories = categoryResult.check;
  const products = productResult.check;
  const checks = { categories, products };
  const failed = categories.status !== "ok"
    ? categories
    : products.status !== "ok"
    ? products
    : null;
  if (failed) {
    return {
      ok: false,
      status: "unavailable",
      classification: failed.classification ?? "upstream",
      checks,
    };
  }
  const leaf = representativeLeaf(
    categoryResult.results ?? [],
    productResult.results ?? [],
  );
  if (!leaf) {
    return {
      ok: false,
      status: "unavailable",
      classification: "schema_error",
      checks,
    };
  }
  const identity = representativeProductIdentity(productResult.results ?? []);
  if (!identity) {
    return {
      ok: false,
      status: "unavailable",
      classification: "schema_error",
      checks: {
        ...checks,
        article_filter: {
          status: "unavailable", http_status: null, classification: "schema_error",
        },
      },
    };
  }
  const [facetResult, articleResult] = await Promise.all([
    checkEndpoint("facets", deps, leaf),
    checkEndpoint("article_filter", deps, undefined, identity),
  ]);
  const facets = facetResult.check;
  const article_filter = articleResult.check;
  const allChecks = { ...checks, facets, article_filter };
  return facets.status === "ok" && article_filter.status === "ok"
    ? { ok: true, status: "ready", checks: allChecks }
    : {
      ok: false,
      status: "unavailable",
      classification: (facets.status !== "ok" ? facets : article_filter)
        .classification ?? "upstream",
      checks: allChecks,
    };
}
