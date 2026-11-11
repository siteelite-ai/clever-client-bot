import { isAdministrativeCatalogField } from "./catalog-field-policy.ts";
import {
  type ExplicitCompoundMarking,
  partitionSemanticCompoundSourceByLiveTaxonomy,
  productTitleMatchesExplicitCompoundMarking,
} from "./exact-compound-marking-policy.ts";
import { titleSupportsLiveCategoryLabel } from "./jargon-recover-catalog.ts";
import { guardSearchFilters, type SearchFacet } from "./search-filter-guard.ts";
import type { ProductFull } from "./types.ts";

type Field = { key: string; caption: string; value: string };
export type SemanticCompoundFacetPlan = {
  category: string;
  classQuery: string;
  fields: Field[];
};

const norm = (value: string): string =>
  value.normalize("NFKC").trim().toLocaleLowerCase("ru-RU").replace(/ё/gu, "е")
    .replace(/\s+/gu, " ");

/** Use only actual keys/captions/values on materialized cards of one leaf.
 * This is a bounded vocabulary for a follow-up search, not a claim of a full
 * schema or category coverage. Ambiguous captions never authorize a filter. */
function fieldsObservedInLeaf(
  category: string,
  products: readonly ProductFull[],
): SearchFacet[] {
  const fields = new Map<
    string,
    { caption: string; values: Map<string, string> }
  >();
  const ambiguous = new Set<string>();
  for (const product of products) {
    if (norm(product.leaf_category ?? "") !== norm(category)) continue;
    for (const [key, values] of Object.entries(product.facet_values ?? {})) {
      const caption = product.facet_captions?.[key];
      if (!caption || isAdministrativeCatalogField({ key, caption })) continue;
      const field = fields.get(key) ?? { caption, values: new Map() };
      if (norm(field.caption) !== norm(caption)) ambiguous.add(key);
      for (const value of values) {
        if (value.trim()) field.values.set(norm(value), value);
      }
      fields.set(key, field);
    }
  }
  return [...fields].filter(([key]) => !ambiguous.has(key)).map((
    [key, field],
  ) => ({
    key,
    caption: field.caption,
    values: [...field.values.values()].map((value) => ({ value })),
  }));
}

/** A model-translated title is not needed when all independent descriptive
 * words have unique, customer-owned catalog fields. Unknown words, short
 * codes, disjunction and negation defer to the existing proof route. */
export function compileSemanticCompoundFacetPlan(
  sourceQuery: string,
  category: string,
  products: readonly ProductFull[],
): SemanticCompoundFacetPlan | null {
  const source = norm(sourceQuery);
  const words = source.split(" ");
  if (
    !/^[\p{L}-]+(?:\s+[\p{L}-]+)*$/u.test(source) || words.length > 10 ||
    words.some((w) => /^(?:не|без|кроме|или|либо|вместо)$/u.test(w))
  ) return null;
  // Partition per leaf: one category may not absorb a class qualifier on
  // behalf of its sibling simply because it happens to contain that word.
  const partition = partitionSemanticCompoundSourceByLiveTaxonomy(source, [
    category,
  ]);
  if (
    !partition.semanticModifiers.length ||
    partition.semanticModifiers.length > 6 ||
    [...partition.query.split(" "), ...partition.semanticModifiers].sort().join(
        " ",
      ) !==
      [...words].sort().join(" ")
  ) return null;
  const facets = fieldsObservedInLeaf(category, products);
  if (!facets.length || facets.length > 120) return null;
  const project = (evidence: string) =>
    guardSearchFilters(
      { mode: "by_filter" },
      facets,
      evidence,
      evidence,
      evidence,
      [],
      {
        allowDerivedNumericFacetInference: false,
        allowProseOnlyFacetInference: false,
      },
    ).user_backed;
  const all = project(source);
  const fields: Field[] = [];
  for (const modifier of partition.semanticModifiers) {
    const matches = project(modifier);
    if (matches.length !== 1) return null;
    const [{ key, value }] = matches;
    const facet = facets.find((item) => item.key === key);
    if (
      !facet?.caption ||
      !all.some((item) => item.key === key && item.value === value)
    ) return null;
    const existing = fields.find((field) => field.key === key);
    if (existing && norm(existing.value) !== norm(value)) return null;
    if (!existing) fields.push({ key, caption: facet.caption, value });
  }
  return { category, classQuery: partition.query, fields };
}

/** Independent, same-card verification, even after an exact API filter. A
 * missing/conflicting facet, wrong class/marking or no positive stock cannot
 * be rescued by a title token or by the other cards in the result. */
export function productProvesSemanticCompoundFacets(
  product: ProductFull,
  plan: SemanticCompoundFacetPlan,
  marking: ExplicitCompoundMarking,
): boolean {
  return Number.isFinite(product.price) && product.price > 0 &&
    !!product.warehouses?.some(({ qty }) => Number.isFinite(qty) && qty > 0) &&
    norm(product.leaf_category ?? "") === norm(plan.category) &&
    titleSupportsLiveCategoryLabel(product.pagetitle, plan.classQuery) &&
    productTitleMatchesExplicitCompoundMarking(product.pagetitle, marking) &&
    plan.fields.every(({ key, caption, value }) => {
      const values = product.facet_values?.[key];
      return norm(product.facet_captions?.[key] ?? "") === norm(caption) &&
        !!values?.length && values.every((actual) =>
          norm(actual) === norm(value)
        );
    });
}
