import type { DiscoverCategoryOk } from "./discover-category.ts";
import {
  type CatalogClientDeps,
  executeSearchCatalog,
  type SearchCatalogInput,
} from "./search-catalog.ts";
import type { ProductCache } from "./types.ts";
import { isAdministrativeCatalogField } from "./catalog-field-policy.ts";

/** Retrieval evidence is deliberately not a renderable product pool. No IDs,
 * URLs, manufacturer/private fields, side effects or shared cache escape. */
export async function retrievePrivateSelectionCandidates(input: {
  discovery: DiscoverCategoryOk;
  options: Record<string, string[]>;
  maxPrice: number | null;
  deps: CatalogClientDeps;
}, search: typeof executeSearchCatalog = executeSearchCatalog) {
  const { discovery } = input;
  const categories = [
    ...new Set(
      discovery.leaf_categories.map((x) => x.pagetitle).filter(Boolean),
    ),
  ];
  if (!categories.length) categories.push(discovery.category.pagetitle);
  if (!categories[0] || categories.length > 3) {
    return { status: "skipped" as const, count: 0 };
  }
  const schema = new Map(discovery.facets.map((f) => [f.key, f]));
  // Never silently drop an explicit filter in order to get candidates.
  for (const [key, values] of Object.entries(input.options)) {
    const facet = schema.get(key);
    if (
      !facet || !values.length || isAdministrativeCatalogField(facet) ||
      values.some((v) => !facet.values.some((x) => x.value === v))
    ) {
      return { status: "skipped" as const, count: 0 };
    }
  }
  const request: SearchCatalogInput = {
    mode: "by_filter",
    category_in: categories,
    options: input.options,
    per_page: 12,
    page: 1,
    ...(input.maxPrice === null ? {} : { max_price: input.maxPrice }),
  };
  const cache: ProductCache = new Map();
  try {
    const result = await search(request, input.deps, cache);
    if (!result.ok) return { status: "unavailable" as const, count: 0 };
    const candidates = result.results.slice(0, 6).map((ref) => {
      const product = cache.get(ref.id);
      return {
        name: ref.pagetitle.slice(0, 180),
        properties: Object.entries(product?.facet_values ?? {})
          .filter(([key]) =>
            schema.has(key) && !isAdministrativeCatalogField(schema.get(key)!)
          )
          .slice(0, 24).map(([key, values]) => ({
            key,
            caption: schema.get(key)!.caption.slice(0, 120),
            values: values.slice(0, 4).map((v) => v.slice(0, 100)),
          })),
      };
    });
    const evidence = {
      category: discovery.category.pagetitle.slice(0, 180),
      sample_only: true,
      candidates,
    };
    // Bound model input, not only HTTP work. Omitted facts are not verified.
    while (JSON.stringify(evidence).length > 12000 && candidates.length > 1) {
      candidates.pop();
    }
    while (
      JSON.stringify(evidence).length > 12000 &&
      candidates[0]?.properties.length
    ) candidates[0].properties.pop();
    return {
      status: candidates.length ? "ready" as const : "empty" as const,
      count: candidates.length,
      evidence,
    };
  } catch {
    return { status: "unavailable" as const, count: 0 };
  }
}
