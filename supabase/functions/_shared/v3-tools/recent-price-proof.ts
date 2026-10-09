import { productUrlIdentity, type RecentProductEvidence } from "./recent-product-evidence.ts";
import type { ProductCache, ProductFull, ProductRef } from "./types.ts";

export type RecentPriceProofFailure =
  | "insufficient_set"
  | "incomplete_set"
  | "identity_mismatch"
  | "unverified_price"
  | "unverified_stock"
  | "unverified_unit"
  | "mixed_units";

export type RecentPriceProof =
  | {
    ok: true;
    winner: ProductFull;
    compared_count: number;
    unit: string;
  }
  | { ok: false; reason: RecentPriceProofFailure };

function normalizedUnit(value: string | null | undefined): string {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е").replace(/[.\s]+/gu, "").trim();
}

/** A title is a lookup hint, never identity: two catalog SKUs can share it. */
export function exactRecentPriceSkuFromSearch(
  previous: RecentProductEvidence,
  results: readonly ProductRef[],
  cache: ProductCache,
): ProductFull | null {
  const sameId = results.find((product) => String(product.id) === previous.id);
  return sameId ? cache.get(String(sameId.id)) ?? null : null;
}

/**
 * A price claim about "these products" is valid only for the complete newest
 * rendered batch, with the same live identities and comparable sale units.
 * The result is deliberately independent of product category or vocabulary.
 */
export function proveRecentPriceSet(
  expected: readonly RecentProductEvidence[],
  refreshed: readonly (ProductFull | null)[],
  direction: "cheapest" | "expensive",
): RecentPriceProof {
  if (expected.length < 2) {
    return { ok: false, reason: "insufficient_set" };
  }
  if (expected.length !== refreshed.length) {
    return { ok: false, reason: "incomplete_set" };
  }
  const seenIds = new Set<string>();
  const products: ProductFull[] = [];
  let commonUnit: string | null = null;
  for (let index = 0; index < expected.length; index++) {
    const previous = expected[index];
    const product = refreshed[index];
    if (!previous?.id || seenIds.has(previous.id) || !product) {
      return { ok: false, reason: "incomplete_set" };
    }
    seenIds.add(previous.id);
    const previousUrl = productUrlIdentity(previous.url);
    const currentUrl = productUrlIdentity(product.url);
    if (
      product.id !== previous.id || !previousUrl || !currentUrl ||
      currentUrl !== previousUrl
    ) {
      return { ok: false, reason: "identity_mismatch" };
    }
    if (!Number.isFinite(product.price) || product.price <= 0) {
      return { ok: false, reason: "unverified_price" };
    }
    if (
      product.warehouse_evidence !== "positive" ||
      !Array.isArray(product.warehouses) ||
      !product.warehouses.some((warehouse) =>
        typeof warehouse.city === "string" && warehouse.city.trim() &&
        Number.isFinite(warehouse.qty) && warehouse.qty > 0
      )
    ) {
      return { ok: false, reason: "unverified_stock" };
    }
    const unit = normalizedUnit(product.unit);
    if (!unit) return { ok: false, reason: "unverified_unit" };
    if (commonUnit !== null && unit !== commonUnit) {
      return { ok: false, reason: "mixed_units" };
    }
    commonUnit = unit;
    products.push(product);
  }
  const ordered = products.sort((left, right) =>
    (direction === "expensive"
      ? right.price - left.price
      : left.price - right.price) || left.id.localeCompare(right.id)
  );
  return {
    ok: true,
    winner: ordered[0],
    compared_count: ordered.length,
    unit: commonUnit!,
  };
}
