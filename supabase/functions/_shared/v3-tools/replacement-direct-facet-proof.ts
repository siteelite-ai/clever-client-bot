import type { ProductFull } from "./types.ts";

export interface DirectReplacementAxis {
  key: string;
  value: string;
}

function exactLiveValue(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/(?<=\d),(?=\d)/gu, ".")
    .replace(/\s+/gu, " ");
}

/**
 * A search filter is only retrieval evidence. A direct replacement may publish
 * transferable axes only when the returned card itself carries every exact
 * value under the corresponding live facet key. Title numerals and other
 * facets cannot substitute for a missing or contradictory value.
 */
export function productProvesDirectReplacementAxes(
  product: Pick<ProductFull, "facet_values" | "price"> | undefined,
  axes: DirectReplacementAxis[],
  budgetCap: number | null,
): boolean {
  if (!product || !Number.isFinite(product.price) || product.price <= 0) {
    return false;
  }
  if (budgetCap !== null && product.price > budgetCap) return false;
  const facetValues = product.facet_values;
  if (axes.length === 0 || !facetValues) return false;
  return axes.every(({ key, value }) => {
    if (!key || !Object.hasOwn(facetValues, key)) return false;
    const actual = facetValues[key];
    const expected = exactLiveValue(value);
    return Boolean(
      expected && Array.isArray(actual) && actual.length > 0 &&
        actual.every((entry) =>
          typeof entry === "string" && exactLiveValue(entry) === expected
        ),
    );
  });
}

export interface DirectReplacementEmptyEvidence {
  strictTotal: number | null;
  splitTotals: ReadonlyArray<number | null>;
  /** Undefined means this optional recovery search was not needed. */
  broadTotal?: number | null;
  unverifiedFacetCount: number;
}

/**
 * An empty rendered set is not evidence that the catalog is empty. Only zero
 * totals from every attempted search can support that outcome; positive raw
 * pools, incomplete searches or cards without exact facet proof delegate.
 */
export function directReplacementEmptyOutcome(
  evidence: DirectReplacementEmptyEvidence,
): "confirmed_empty" | "query_inconsistent" {
  if (evidence.unverifiedFacetCount > 0 || evidence.strictTotal !== 0) {
    return "query_inconsistent";
  }
  if (
    evidence.splitTotals.length === 0 ||
    evidence.splitTotals.some((total) => total !== 0) ||
    (evidence.broadTotal !== undefined && evidence.broadTotal !== 0)
  ) return "query_inconsistent";
  return "confirmed_empty";
}
