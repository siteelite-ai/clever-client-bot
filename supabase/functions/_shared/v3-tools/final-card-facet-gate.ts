import {
  checkCriterion,
  type Criterion,
  normalizeKey,
} from "./criteria-gate.ts";
import { filterProductsByMandatoryFacetTitleContradictions } from "./selection-contract.ts";
import { hasCatalogFacetFilterProof } from "./catalog-facet-proof-ledger.ts";
import type { ProductCache, ProductFull } from "./types.ts";

interface LiveFacet {
  key: string;
  caption?: string | null;
  values?: Array<{ value: string }>;
}

export interface FinalCardFacetRejection {
  id: string;
  key: string;
  actual: string;
  source:
    | "card_trait"
    | "catalog_facet"
    | "other_card_evidence"
    | "missing_proof"
    | "visible_title";
}

/**
 * A recovery may introduce a new card after the earlier criteria gate ran.
 * Recheck every frozen mandatory criterion against independent evidence on
 * that final card. An explicit contradiction wins over search provenance;
 * missing or incomparable card data needs a per-SKU exact catalog-filter
 * receipt. In particular, a missing short trait is not evidence of a mismatch
 * but cannot silently confer eligibility on an unrelated recovery result.
 */
export function filterFinalCardsByMandatoryFacetEvidence<
  T extends ProductFull,
>(
  products: T[],
  frozenCriteria: readonly Criterion[],
  liveFacets: LiveFacet[] = [],
  proofCache?: ProductCache,
): { products: T[]; rejected: FinalCardFacetRejection[] } {
  const mandatory = (Array.isArray(frozenCriteria) ? frozenCriteria : [])
    .filter((criterion) => criterion?.key && (criterion.level ?? "A") === "A");
  if (mandatory.length === 0) {
    return { products: [...products], rejected: [] };
  }

  // Equality alternatives for one facet are OR, as in applyCriteriaGate and
  // the catalog's options[key][] filter. Other constraints remain independent.
  const groups = new Map<string, Criterion[]>();
  mandatory.forEach((criterion, index) => {
    const key = criterion.op === "eq"
      ? `eq:${normalizeKey(criterion.key)}`
      : `single:${index}`;
    groups.set(key, [...(groups.get(key) ?? []), criterion]);
  });
  const discoveredCaptions = new Map(
    liveFacets.map((facet) => [facet.key, facet.caption ?? ""]),
  );
  const rejected: FinalCardFacetRejection[] = [];
  const evidenceSafe = products.filter((product) => {
    for (const alternatives of groups.values()) {
      const key = alternatives[0].key;
      const normalizedKey = normalizeKey(key);
      const traitValues = (product.short_traits ?? []).flatMap((line) => {
        const colon = line.indexOf(":");
        return colon > 0 &&
            normalizeKey(line.slice(0, colon)) === normalizedKey
          ? [line.slice(colon + 1).trim()]
          : [];
      }).filter(Boolean);
      const matchingFacetEntries = Object.entries(
        product.facet_values ?? {},
      ).filter(([facetKey]) => {
        const caption = product.facet_captions?.[facetKey] ??
          discoveredCaptions.get(facetKey) ?? facetKey;
        return normalizeKey(caption) === normalizedKey;
      });
      // Multiple machine keys with the same caption are ambiguous, not proof
      // that a particular value belongs to this criterion.
      const facetValues = matchingFacetEntries.length === 1
        ? matchingFacetEntries[0][1].filter(Boolean)
        : [];
      const sources = [
        { source: "catalog_facet" as const, values: facetValues },
        { source: "card_trait" as const, values: traitValues },
      ].filter(({ values }) => values.length > 0);
      const independentChecks = alternatives.map((criterion) =>
        checkCriterion({ ...product, short_traits: [] }, criterion)
      );
      if (independentChecks.every((check) => check.verdict === "fail")) {
        rejected.push({
          id: product.id,
          key,
          actual: independentChecks.map((check) => check.actual).filter(Boolean)
            .join(" | "),
          source: "other_card_evidence",
        });
        return false;
      }
      const independentPass = independentChecks.some((check) =>
        check.verdict === "pass"
      );
      let explicitFacetPass = false;
      if (sources.length === 0) {
        if (
          proofCache && !independentPass &&
          !hasCatalogFacetFilterProof(
            proofCache,
            product,
            alternatives,
          )
        ) {
          rejected.push({
            id: product.id,
            key,
            actual: "",
            source: "missing_proof",
          });
          return false;
        }
        continue;
      }
      for (const { source, values } of sources) {
        // A multi-valued facet may legitimately offer alternatives. Reject
        // only when every explicit value contradicts every allowed value.
        const checks = values.flatMap((value) =>
          alternatives.map((criterion) =>
            checkCriterion({
              ...product,
              short_traits: [`${criterion.key}: ${value}`],
            }, criterion)
          )
        );
        if (checks.every((check) => check.verdict === "fail")) {
          rejected.push({
            id: product.id,
            key,
            actual: values.join(" | "),
            source,
          });
          return false;
        }
        if (checks.some((check) => check.verdict === "pass")) {
          explicitFacetPass = true;
        }
      }
      if (
        proofCache && !independentPass && !explicitFacetPass &&
        !hasCatalogFacetFilterProof(
          proofCache,
          product,
          alternatives,
        )
      ) {
        rejected.push({
          id: product.id,
          key,
          actual: "",
          source: "missing_proof",
        });
        return false;
      }
    }
    return true;
  });

  // A rendered title must not name a live sibling value even if a facet or
  // an earlier filter says otherwise. This is the existing generic title gate
  // applied after every recovery rather than only the model render path.
  const titleSafe = filterProductsByMandatoryFacetTitleContradictions(
    evidenceSafe,
    mandatory,
    liveFacets,
  );
  rejected.push(...titleSafe.rejected_ids.map((id) => ({
    id,
    key: "visible_title",
    actual: products.find((product) => product.id === id)?.pagetitle ?? "",
    source: "visible_title" as const,
  })));
  return { products: titleSafe.products, rejected };
}
