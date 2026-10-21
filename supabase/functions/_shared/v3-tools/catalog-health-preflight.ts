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

type CheckName = "categories" | "products";
type CheckResult = {
  status: "ok" | "unavailable";
  http_status: number | null;
  classification?: CatalogHealthClassification;
};

export type CatalogHealthPreflightResult = {
  ok: boolean;
  status: "ready" | "unavailable";
  classification?: CatalogHealthClassification;
  checks: Record<CheckName, CheckResult>;
};

const CHECK_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

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
): Promise<CheckResult> {
  const params = name === "categories"
    ? "parent=0&depth=10&per_page=200&page=1"
    : "per_page=20&page=1&min_price=1";
  const url = `${deps.baseUrl}/${name}?${params}`;
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
      (async (): Promise<CheckResult> => {
        const response = await (deps.fetchImpl ?? fetch)(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${deps.apiToken}`,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        });
        httpStatus = response.status;
        if (!response.ok) {
          return {
            status: "unavailable",
            http_status: response.status,
            classification: classifyCatalogHealthHttpStatus(response.status),
          };
        }
        const json = await readBoundedJson(response);
        const envelope =
          json && typeof json === "object" && !Array.isArray(json)
            ? json as { data?: unknown; results?: unknown }
            : null;
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
          return {
            status: "unavailable",
            http_status: response.status,
            classification: "schema_error",
          };
        }
        return { status: "ok", http_status: response.status };
      })(),
      timeout,
    ]);
    return result;
  } catch {
    // A response whose body is malformed is distinct from a network failure.
    return {
      status: "unavailable",
      http_status: httpStatus,
      classification: httpStatus === null || controller.signal.aborted
        ? "transport"
        : "schema_error",
    };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    controller.abort();
  }
}

export async function runCatalogHealthPreflight(
  deps: CatalogClientDeps,
): Promise<CatalogHealthPreflightResult> {
  // The two checks are independent; one failure must not hide the other's
  // status, and the total wait remains one bounded request window.
  const [categories, products] = await Promise.all([
    checkEndpoint("categories", deps),
    checkEndpoint("products", deps),
  ]);
  const checks = { categories, products };
  const failed = categories.status !== "ok"
    ? categories
    : products.status !== "ok"
    ? products
    : null;
  return failed
    ? {
      ok: false,
      status: "unavailable",
      classification: failed.classification ?? "upstream",
      checks,
    }
    : { ok: true, status: "ready", checks };
}
