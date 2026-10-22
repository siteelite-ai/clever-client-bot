import type { ProductCache, ProductFull } from "./types.ts";
import { validateVerifiedManufacturerFacts } from "./verified-manufacturer-facts.ts";

/**
 * One request's service-role loader. The callback must return rows from the
 * private approved-facts table, never caller-supplied JSON or public tools.
 */
export type VerifiedManufacturerRowsLoader = (
  productIds: readonly string[],
  signal?: AbortSignal,
) => Promise<unknown[]>;

export interface VerifiedManufacturerHydrationStats {
  queries: number;
  attached: number;
  rejected: number;
  failed: number;
  aborted: number;
  /** A requested, uncached ID could not be checked within DB query/failure caps. */
  exhausted: number;
}

export interface VerifiedManufacturerHydrator {
  hydrate: (
    cache: ProductCache,
    productIds: readonly string[],
    signal?: AbortSignal,
  ) => Promise<void>;
  stats: () => VerifiedManufacturerHydrationStats;
}

function rowProductId(row: unknown): string | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const id = (row as Record<string, unknown>).product_id;
  return typeof id === "string" && id.length > 0 && id.length <= 160
    ? id
    : null;
}

/**
 * Hydrate only internal cached ProductFull objects. A later catalog page may
 * replace one of those objects, so memoize raw rows and revalidate the full
 * identity each time rather than trusting an earlier ID-only match.
 */
export function createVerifiedManufacturerHydrator(
  loadRows: VerifiedManufacturerRowsLoader,
  options: {
    maxBatchIds?: number;
    maxQueries?: number;
    maxFailures?: number;
    now?: () => Date;
  } = {},
): VerifiedManufacturerHydrator {
  const maxBatchIds = Math.max(1, Math.min(200, options.maxBatchIds ?? 100));
  const maxQueries = Math.max(1, Math.min(20, options.maxQueries ?? 13));
  const maxFailures = Math.max(1, Math.min(3, options.maxFailures ?? 2));
  const now = options.now ?? (() => new Date());
  const memo = new Map<string, unknown[]>();
  const counters: VerifiedManufacturerHydrationStats = {
    queries: 0,
    attached: 0,
    rejected: 0,
    failed: 0,
    aborted: 0,
    exhausted: 0,
  };

  const attach = (product: ProductFull, rows: readonly unknown[]) => {
    delete product.verified_manufacturer_facts;
    if (rows.length === 0) return;
    if (rows.length !== 1) {
      counters.rejected++;
      return;
    }
    const verified = validateVerifiedManufacturerFacts(rows[0], product, now());
    if (!verified) {
      counters.rejected++;
      return;
    }
    product.verified_manufacturer_facts = verified;
    counters.attached++;
  };

  return {
    async hydrate(cache, productIds, signal) {
      if (signal?.aborted) {
        counters.aborted++;
        return;
      }
      const ids = [...new Set(productIds)].filter((id) =>
        typeof id === "string" && id.length > 0 && id.length <= 160 &&
        cache.has(id)
      ).slice(0, maxBatchIds);
      for (const id of ids) {
        const product = cache.get(id);
        if (product) delete product.verified_manufacturer_facts;
      }
      const missing = ids.filter((id) => !memo.has(id));
      if (missing.length) {
        if (counters.queries >= maxQueries || counters.failed >= maxFailures) {
          counters.exhausted++;
          return;
        }
        counters.queries++;
        let rows: unknown[];
        try {
          rows = await loadRows(missing, signal);
        } catch {
          if (signal?.aborted) counters.aborted++;
          else counters.failed++;
          return;
        }
        // The catalog deadline can win a Promise.race while the DB request is
        // resolving. Never mutate its shared cache after that cancellation.
        if (signal?.aborted) {
          counters.aborted++;
          return;
        }
        if (!Array.isArray(rows) || rows.length > missing.length * 2) {
          counters.failed++;
          return;
        }
        const grouped = new Map(missing.map((id) => [id, [] as unknown[]]));
        for (const row of rows) {
          const id = rowProductId(row);
          if (id && grouped.has(id)) grouped.get(id)!.push(row);
        }
        for (const [id, group] of grouped) memo.set(id, group);
      }
      if (signal?.aborted) {
        counters.aborted++;
        return;
      }
      for (const id of ids) {
        const product = cache.get(id);
        if (product) attach(product, memo.get(id) ?? []);
      }
    },
    stats: () => ({ ...counters }),
  };
}
