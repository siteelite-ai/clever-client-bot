import type { ProductFull } from "./types.ts";

/**
 * A category page can replace the cached source while replacements are being
 * searched. The old verified row must not certify a changed live product.
 * Compare source technical evidence, not merely its cache key. This internal
 * fingerprint is used only inside one request, never logged or sent to users.
 */
export function structuralSourceEvidenceSnapshot(
  product: ProductFull | undefined,
): string | null {
  if (!product) return null;
  const facets = Object.fromEntries(
    Object.entries(product.facet_values ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => [key, [...values].sort()]),
  );
  const captions = Object.fromEntries(
    Object.entries(product.facet_captions ?? {})
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return JSON.stringify({
    id: product.id,
    article: product.article,
    url: product.url,
    pagetitle: product.pagetitle,
    leaf_category: product.leaf_category,
    short_traits: [...product.short_traits].sort(),
    description_excerpt: product.description_excerpt,
    facet_values: facets,
    facet_captions: captions,
    verified_manufacturer_facts: product.verified_manufacturer_facts,
  });
}
