import {
  type CatalogClientDeps,
  isRestrictedCatalogProduct,
  normalizeProductUrl,
} from "./search-catalog.ts";

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

type CheckName = "categories" | "products" | "facets";
type CheckResult = {
  status: "ok" | "unavailable";
  http_status: number | null;
  classification?: CatalogHealthClassification;
};

export type CatalogHealthPreflightResult = {
  ok: boolean;
  status: "ready" | "unavailable";
  classification?: CatalogHealthClassification;
  // A dependency failure skips facets rather than sending another request to
  // a distressed upstream. A ready result must always contain all three.
  checks: Pick<Record<CheckName, CheckResult>, "categories" | "products"> &
    Partial<Pick<Record<CheckName, CheckResult>, "facets">>;
};

const CHECK_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_TAXONOMY_NODES = 12_000;
const MAX_CATEGORY_TITLE_CHARS = 160;

type EndpointResult = { check: CheckResult; results?: unknown[] };
type Leaf = { id: number; pagetitle: string };

function cleanCategoryTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.trim();
  if (
    !title || [...title].length > MAX_CATEGORY_TITLE_CHARS ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(title)
  ) return null;
  return title;
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
  name: CheckName,
  deps: CatalogClientDeps,
  leaf?: Leaf,
): Promise<EndpointResult> {
  if (name === "facets" && !leaf) {
    return { check: {
      status: "unavailable", http_status: null, classification: "schema_error",
    } };
  }
  const params = name === "categories"
    ? "parent=0&depth=10&per_page=200&page=1"
    : name === "products"
    ? "per_page=20&page=1&min_price=1"
    : new URLSearchParams({ pagetitle: leaf?.pagetitle ?? "" }).toString();
  const path = name === "facets" ? "categories/options" : name;
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
            validOptions;
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
        const data = name === "categories"
          ? envelope?.data ?? envelope
          : envelope?.data;
        const results = data && typeof data === "object" && !Array.isArray(data)
          ? (data as { results?: unknown }).results
          : null;
        const validCategories = Array.isArray(results) &&
          results.length > 0 &&
          results.every((root) =>
            root && typeof root === "object" && !Array.isArray(root) &&
            typeof root.id === "number" &&
            typeof root.pagetitle === "string" && root.pagetitle.trim()
          );
        const validProducts = Array.isArray(results) &&
          hasUsableProduct(results);
        if (name === "categories" ? !validCategories : !validProducts) {
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
 * Checks route availability on one representative live leaf. This is not
 * proof that a different customer's exact category has healthy facets; use
 * the private exact-category route probe before that paid QA scenario.
 */
export async function runCatalogHealthPreflight(
  deps: CatalogClientDeps,
): Promise<CatalogHealthPreflightResult> {
  // The first two checks are independent. Facets follow only after a live,
  // validated leaf is available, with one additional bounded read-only call.
  const [categoryResult, productResult] = await Promise.all([
    checkEndpoint("categories", deps),
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
  const facets = (await checkEndpoint("facets", deps, leaf)).check;
  const allChecks = { ...checks, facets };
  return facets.status === "ok"
    ? { ok: true, status: "ready", checks: allChecks }
    : {
      ok: false,
      status: "unavailable",
      classification: facets.classification ?? "upstream",
      checks: allChecks,
    };
}
