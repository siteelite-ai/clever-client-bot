import {
  type CatalogClientDeps,
  executeSearchCatalog,
  normalizeProductUrl,
  type SearchCatalogInput,
} from "./search-catalog.ts";
import type {
  ProductCache,
  ProductFull,
  ProductRef,
  SearchCatalogOk,
  ToolError,
} from "./types.ts";

type SearchResult =
  | (SearchCatalogOk & { tool: "search_catalog" })
  | (ToolError & { tool: "search_catalog" });

export type VerifiedShortlistSearch = (
  input: SearchCatalogInput,
  deps: CatalogClientDeps,
  cache: ProductCache,
) => Promise<SearchResult>;

export interface VerifiedCutoutHint {
  productId: string;
  article: string;
  catalogUrl: string;
}

const MAX_HINTS = 8;
const MAX_REQUESTS = 20;
const MAX_SHORTLIST_REQUESTS = 8;
const HYDRATION_RESERVE_MS = 1_200;

function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= max && value.trim() === value &&
    !/[\p{Cc}\p{Cf}]/u.test(value);
}

/**
 * Private, manually approved rows are discovery hints only. This check never
 * attaches a technical fact; the hydrator must revalidate the full row after
 * a fresh live-catalog fetch. A stale/revoked row cannot even start a lookup.
 */
export function selectVerifiedCutoutHints(
  rows: readonly unknown[],
  cutoutMm: number,
  leafCategory: string,
  now: Date,
): VerifiedCutoutHint[] {
  if (
    !Number.isFinite(cutoutMm) || cutoutMm <= 0 || cutoutMm > 10_000 ||
    !validText(leafCategory, 240) || !Number.isFinite(now.getTime())
  ) return [];
  const seen = new Set<string>();
  const hints: VerifiedCutoutHint[] = [];
  for (const value of rows.slice(0, 100)) {
    if (hints.length >= MAX_HINTS) break;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (
      row.approval_status !== "approved" || row.revoked_at !== null ||
      !validText(row.product_id, 160) || !validText(row.article, 200) ||
      row.catalog_leaf_category !== leafCategory ||
      !validText(row.catalog_url, 600) ||
      normalizeProductUrl(row.catalog_url) !== row.catalog_url ||
      row.cutout_shape !== "round" ||
      !(row.cutout_kind === "exact" || row.cutout_kind === "range") ||
      typeof row.cutout_min_mm !== "number" ||
      typeof row.cutout_max_mm !== "number" ||
      !Number.isFinite(row.cutout_min_mm) ||
      !Number.isFinite(row.cutout_max_mm) ||
      row.cutout_min_mm <= 0 || row.cutout_max_mm > 10_000 ||
      row.cutout_min_mm > cutoutMm || row.cutout_max_mm < cutoutMm ||
      (row.cutout_kind === "exact" &&
        row.cutout_min_mm !== row.cutout_max_mm) ||
      (row.cutout_kind === "range" &&
        row.cutout_min_mm >= row.cutout_max_mm) ||
      typeof row.valid_until !== "string" ||
      !Number.isFinite(Date.parse(row.valid_until)) ||
      Date.parse(row.valid_until) <= now.getTime() ||
      seen.has(row.product_id)
    ) continue;
    seen.add(row.product_id);
    hints.push({
      productId: row.product_id,
      article: row.article,
      catalogUrl: row.catalog_url,
    });
  }
  return hints;
}

export interface ReplacementCatalogBudget {
  signal: AbortSignal;
  shortlistFetch: typeof fetch;
  fallbackFetch: typeof fetch;
  remainingMs: () => number;
  remainingRequests: () => number;
  stats: () => {
    totalRequests: number;
    shortlistRequests: number;
    shortlistCapReached: boolean;
    totalCapReached: boolean;
    deadlineExpired: boolean;
    aborted: boolean;
  };
  close: () => void;
}

/** Counts physical HTTP calls, including recovery pages and 429 retries. */
export function createReplacementCatalogBudget(options: {
  deadlineMs: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): ReplacementCatalogBudget {
  const deadlineMs = Math.max(
    1,
    Math.min(9_000, Math.trunc(options.deadlineMs)),
  );
  const deadlineAt = Date.now() + deadlineMs;
  const controller = new AbortController();
  let totalRequests = 0;
  let shortlistRequests = 0;
  let shortlistCapReached = false;
  let totalCapReached = false;
  let deadlineExpired = false;
  const externalAbort = () => controller.abort();
  options.signal?.addEventListener("abort", externalAbort, { once: true });
  if (options.signal?.aborted) externalAbort();
  const timer = setTimeout(() => {
    deadlineExpired = true;
    controller.abort();
  }, deadlineMs);
  const upstream = options.fetchImpl ?? fetch;
  const countedFetch =
    (phase: "shortlist" | "fallback"): typeof fetch => (input, init) => {
      if (controller.signal.aborted || Date.now() >= deadlineAt) {
        deadlineExpired = deadlineExpired || Date.now() >= deadlineAt;
        return Promise.reject(new DOMException("Aborted", "AbortError"));
      }
      if (totalRequests >= MAX_REQUESTS) {
        totalCapReached = true;
        return Promise.reject(new Error("replacement catalog request cap"));
      }
      if (
        phase === "shortlist" &&
        shortlistRequests >= MAX_SHORTLIST_REQUESTS
      ) {
        shortlistCapReached = true;
        return Promise.reject(new Error("replacement shortlist request cap"));
      }
      totalRequests++;
      if (phase === "shortlist") shortlistRequests++;
      const mergedSignal = init?.signal
        ? AbortSignal.any([init.signal, controller.signal])
        : controller.signal;
      return upstream(input, { ...init, signal: mergedSignal });
    };
  return {
    signal: controller.signal,
    shortlistFetch: countedFetch("shortlist"),
    fallbackFetch: countedFetch("fallback"),
    remainingMs: () => Math.max(0, deadlineAt - Date.now()),
    remainingRequests: () => Math.max(0, MAX_REQUESTS - totalRequests),
    stats: () => ({
      totalRequests,
      shortlistRequests,
      shortlistCapReached,
      totalCapReached,
      deadlineExpired,
      aborted: controller.signal.aborted,
    }),
    close: () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", externalAbort);
    },
  };
}

export interface VerifiedCutoutShortlistResult {
  products: ProductRef[];
  attempted: number;
  rejected: number;
  catalogErrors: number;
  interrupted: boolean;
}

async function beforeAbort<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<{ completed: true; value: T } | { completed: false }> {
  if (signal.aborted) return { completed: false };
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<{ completed: false }>((resolve) => {
    onAbort = () => resolve({ completed: false });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) resolve({ completed: false });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(operation).then((value) => ({
        completed: true as const,
        value,
      })),
      cancelled,
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * The shortlist does not certify analogs. It asks the ordinary restricted-view
 * filtering catalog tool for each approved article, binds the response back to
 * the approved row, then delegates final fit to the same guarded assessor as
 * the paginated path. Two workers bound concurrent HTTP activity; all exact
 * live matches share one bounded private-facts hydration query.
 */
export async function retrieveVerifiedCutoutShortlist(input: {
  hints: readonly VerifiedCutoutHint[];
  sourceProductId: string;
  leafCategory: string;
  maxPrice?: number;
  deps: CatalogClientDeps;
  cache: ProductCache;
  remainingMs: () => number;
  hydrate: (
    cache: ProductCache,
    ids: readonly string[],
    signal: AbortSignal,
  ) => Promise<void>;
  accept: (product: ProductRef) => boolean;
  target: number;
  search?: VerifiedShortlistSearch;
}): Promise<VerifiedCutoutShortlistResult> {
  const signal = input.deps.signal;
  if (!signal) throw new TypeError("shortlist requires shared signal");
  const search = input.search ?? executeSearchCatalog;
  const found = new Map<string, ProductRef>();
  let next = 0;
  let attempted = 0;
  let rejected = 0;
  let catalogErrors = 0;
  let interrupted = false;
  let halted = false;
  const hints = input.hints.slice(0, MAX_HINTS);
  while (
    !signal.aborted && !halted && found.size < input.target &&
    next < hints.length
  ) {
    if (input.remainingMs() < HYDRATION_RESERVE_MS) {
      interrupted = true;
      break;
    }
    const needed = input.target - found.size;
    const staged = new Map<
      string,
      { product: ProductRef; full: ProductFull }
    >();
    const waveController = new AbortController();
    const waveSignal = AbortSignal.any([signal, waveController.signal]);
    let waveReserveExpired = false;
    const waveTimer = setTimeout(() => {
      waveReserveExpired = true;
      waveController.abort();
    }, Math.max(1, input.remainingMs() - HYDRATION_RESERVE_MS));
    let inFlight = 0;
    const worker = async () => {
      while (
        !waveSignal.aborted && !halted &&
        staged.size + inFlight < needed &&
        next < hints.length
      ) {
        const hint = hints[next++];
        if (hint.productId === input.sourceProductId) continue;
        attempted++;
        inFlight++;
        try {
          // A detached cache is essential: an injected or broken transport may
          // finish after cancellation. Late rows never touch the shared cache.
          const privateCache: ProductCache = new Map();
          let result: SearchResult;
          try {
            const settled = await beforeAbort(
              () =>
                search(
                  {
                    mode: "by_article",
                    article: hint.article,
                    category: input.leafCategory,
                    min_price: 1,
                    ...(input.maxPrice !== undefined
                      ? { max_price: input.maxPrice }
                      : {}),
                    per_page: 50,
                  },
                  { ...input.deps, signal: waveSignal },
                  privateCache,
                ),
              waveSignal,
            );
            if (!settled.completed) {
              if (signal.aborted || staged.size < needed) interrupted = true;
              break;
            }
            result = settled.value;
          } catch {
            if (!waveController.signal.aborted) {
              catalogErrors++;
              interrupted = true;
              halted = true;
            }
            break;
          }
          if (waveSignal.aborted) break;
          if (!result.ok) {
            catalogErrors++;
            interrupted = true;
            halted = true;
            // A failed exact lookup must not become evidence of absence.
            break;
          }
          const matches = result.results.filter((product) => {
            const full = privateCache.get(product.id);
            return product.id === hint.productId &&
              full?.id === hint.productId &&
              full.article === hint.article && full.url === hint.catalogUrl &&
              full.leaf_category === input.leafCategory &&
              full.warehouse_evidence === "positive" &&
              full.warehouses?.some(({ qty }) =>
                Number.isFinite(qty) && qty > 0
              ) &&
              Number.isFinite(full.price) && full.price > 0 &&
              (input.maxPrice === undefined || full.price <= input.maxPrice);
          });
          if (matches.length !== 1) {
            rejected++;
            continue;
          }
          const product = matches[0];
          const full = privateCache.get(product.id);
          if (!full) {
            rejected++;
            continue;
          }
          staged.set(product.id, { product, full });
          if (staged.size >= needed) waveController.abort();
        } finally {
          inFlight--;
        }
      }
    };
    try {
      await Promise.all([worker(), worker()]);
    } finally {
      clearTimeout(waveTimer);
    }
    if (waveReserveExpired) {
      interrupted = true;
      halted = true;
    }
    if (signal.aborted) break;
    if (staged.size === 0) continue;
    const privateBatch: ProductCache = new Map(
      [...staged].map(([id, { full }]) => [id, full]),
    );
    let hydrated = false;
    try {
      const settled = await beforeAbort(
        () => input.hydrate(privateBatch, [...staged.keys()], signal),
        signal,
      );
      hydrated = settled.completed;
      if (!hydrated) interrupted = true;
    } catch {
      interrupted = true;
    }
    // A failed sibling article lookup makes coverage partial, but must not
    // discard a different card that did pass the exact live+approved proof.
    if (!signal.aborted && hydrated) {
      for (const [id, { product }] of staged) {
        if (found.size >= input.target) break;
        const full = privateBatch.get(id);
        if (!full) {
          rejected++;
          continue;
        }
        const previous = input.cache.get(id);
        input.cache.set(id, full);
        if (input.accept(product)) found.set(id, product);
        else {
          if (previous) input.cache.set(id, previous);
          else input.cache.delete(id);
          rejected++;
        }
      }
    }
    if (!hydrated) break;
  }
  if (found.size < input.target && next < hints.length) interrupted = true;
  return {
    products: [...found.values()],
    attempted,
    rejected,
    catalogErrors,
    interrupted: interrupted || signal.aborted,
  };
}
