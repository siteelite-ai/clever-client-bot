import {
  checkCriterion,
  type Criterion,
  normalizeKey,
} from "./criteria-gate.ts";
import type { ProductCache, ProductFull } from "./types.ts";

interface LiveFacet {
  key: string;
  caption?: string | null;
  values?: Array<{ value: string }>;
}

interface ExactFilter {
  mode: string;
  options?: Record<string, string[]>;
}

interface ProductIdentity {
  id: string;
  url: string;
}

interface FacetSchema {
  key: string;
  caption: string;
  values: ReadonlySet<string>;
  captionUnique: boolean;
}

interface FacetReceipt {
  key: string;
  caption: string;
  captionUnique: boolean;
  value: string;
}

export type CatalogFacetSchemaSnapshot = ReadonlyMap<string, FacetSchema>;

/**
 * Private, request-local provenance. The ProductCache is recreated for every
 * turn, including a new conversation, and is never serialized to the model or
 * the browser. The URL is part of the identity so an upstream reuse of a SKU
 * for a different product cannot inherit an earlier facet proof.
 */
const activeSchemas = new WeakMap<ProductCache, CatalogFacetSchemaSnapshot>();
const receipts = new WeakMap<ProductCache, Map<string, FacetReceipt[]>>();

function identity(product: ProductIdentity): string {
  return `${product.id.length}:${product.id}${product.url}`;
}

/**
 * Bind a copied live discovery schema to the current turn cache. A later
 * discovery replaces this active schema, but cannot mutate receipts captured
 * by searches that already executed against an earlier schema.
 */
export function setActiveCatalogFacetSchema(
  cache: ProductCache,
  facets: readonly LiveFacet[],
): void {
  const valid = (Array.isArray(facets) ? facets : []).filter((facet) =>
    typeof facet?.key === "string" && facet.key.trim() &&
    Array.isArray(facet.values)
  );
  const captionCounts = new Map<string, number>();
  for (const facet of valid) {
    const caption = normalizeKey(facet.caption ?? "");
    if (caption) {
      captionCounts.set(caption, (captionCounts.get(caption) ?? 0) + 1);
    }
  }
  const snapshot = new Map<string, FacetSchema>();
  const duplicateKeys = new Set<string>();
  for (const facet of valid) {
    // A duplicate machine key has no unambiguous value/caption mapping.
    if (duplicateKeys.has(facet.key)) continue;
    if (snapshot.has(facet.key)) {
      snapshot.delete(facet.key);
      duplicateKeys.add(facet.key);
      continue;
    }
    const caption = String(facet.caption ?? "").trim();
    snapshot.set(facet.key, {
      key: facet.key,
      caption,
      values: new Set(
        facet.values?.map((entry: { value: string }) => String(entry.value))
          .filter(Boolean) ?? [],
      ),
      captionUnique: Boolean(caption) &&
        captionCounts.get(normalizeKey(caption)) === 1,
    });
  }
  activeSchemas.set(cache, snapshot);
}

/** Capture before awaiting the HTTP request, not after another discovery. */
export function snapshotActiveCatalogFacetSchema(
  cache: ProductCache,
): CatalogFacetSchemaSnapshot | null {
  return activeSchemas.get(cache) ?? null;
}

/**
 * Called only after an executed by_filter request has succeeded. In particular,
 * a by_query hit, a category-only filter, and an unexpanded multi-value OR
 * request prove no exact option value for a returned card.
 */
export function recordSuccessfulCatalogFacetFilter(
  cache: ProductCache,
  filter: ExactFilter,
  products: readonly ProductIdentity[],
  schema: CatalogFacetSchemaSnapshot | null,
): void {
  if (filter.mode !== "by_filter" || products.length === 0 || !schema) return;
  const options = Object.entries(filter.options ?? {});
  if (
    options.length === 0 ||
    options.some(([key, values]) =>
      !key.trim() || !Array.isArray(values) || values.length !== 1 ||
      typeof values[0] !== "string" || !values[0].trim()
    )
  ) return;

  // HTTP 200 does not prove the upstream applied arbitrary option names or
  // values. Reject the whole receipt when any submitted option is absent from
  // the live discovery schema captured at execution time.
  const proven = options.map(([key, [value]]) => {
    const facet = schema.get(key);
    return facet && facet.values.has(value)
      ? {
        key: facet.key,
        caption: facet.caption,
        captionUnique: facet.captionUnique,
        value,
      }
      : null;
  });
  if (proven.some((entry) => !entry)) return;

  let byProduct = receipts.get(cache);
  if (!byProduct) {
    byProduct = new Map();
    receipts.set(cache, byProduct);
  }
  for (const product of products) {
    if (!product.id || !product.url) continue;
    const key = identity(product);
    const known = byProduct.get(key) ?? [];
    for (const entry of proven) {
      if (!entry) continue;
      if (
        !known.some((receipt) =>
          receipt.key === entry.key && receipt.caption === entry.caption &&
          receipt.value === entry.value
        )
      ) known.push({ ...entry });
    }
    byProduct.set(key, known);
  }
}

/** One returned SKU/URL must have a successful exact option for this OR group. */
export function hasCatalogFacetFilterProof(
  cache: ProductCache,
  product: ProductFull,
  alternatives: readonly Criterion[],
): boolean {
  const productReceipts = receipts.get(cache)?.get(identity(product));
  if (!productReceipts || alternatives.length === 0) return false;
  return alternatives.some((criterion) => {
    if (criterion.proof_scope === "application_suitability") return false;
    const key = normalizeKey(criterion.key);
    for (const receipt of productReceipts) {
      if (
        normalizeKey(receipt.key) !== key &&
        !(receipt.captionUnique && normalizeKey(receipt.caption) === key)
      ) continue;
      // Reuse the same numeric, unit and equality semantics as the card
      // checker. Inspect only this executed option, not another field on
      // the current card (which may itself have changed during recovery).
      // A filter on 16 A cannot prove 160 A or another OR member.
      const check = checkCriterion({
        id: product.id,
        pagetitle: "",
        vendor: null,
        price: product.price,
        stock: product.stock,
        short_traits: [`${criterion.key}: ${receipt.value}`],
      }, criterion);
      if (check.verdict === "pass") return true;
    }
    return false;
  });
}
