import { type Criterion, normalizeKey } from "./criteria-gate.ts";
import type { Facet } from "./discover-category.ts";
import type { PartialApplicationClassGuard } from "./partial-application-class-guard.ts";
import type { SearchCatalogInput } from "./search-catalog.ts";

export interface SparseFeatureRecoveryBranch {
  /** Exact live classification values only; never includes the sparse feature. */
  options: Record<string, string[]>;
  classValues: Array<{ key: string; value: string }>;
}

export interface SparseFeatureRecoveryPlan {
  featureFacetKey: string;
  positiveCount: number;
  scopeCount: number;
  branches: SparseFeatureRecoveryBranch[];
}

/** The frozen live class is the retrieval scope. A discovered leaf can be an
 * unrelated sibling, so never intersect this recovery with a suggested leaf.
 * Final product-class and customer-criterion checks still apply per card. */
export function sparseClassSearchInput(
  branch: SparseFeatureRecoveryBranch,
  page: number,
  budgetCap: number | null,
): SearchCatalogInput {
  return {
    mode: "by_filter",
    options: branch.options,
    min_price: 1,
    ...(budgetCap !== null && budgetCap > 0
      ? { max_price: budgetCap }
      : {}),
    page,
    per_page: 50,
  };
}

const AFFIRMATIVE = new Set([
  "да",
  "есть",
  "имеется",
  "присутствует",
  "yes",
  "true",
]);

/** Unsorted, bounded class pages cannot establish a price extremum. */
export function hasPriceOrderingIntentForSparseRecovery(
  message: string,
): boolean {
  const normalized = normalizeKey(message).replace(
    /(?:^|\s)не\s+(?:дороже|дешевле|подороже|подешевле)(?=\s|$)/gu,
    " ",
  );
  return /(?:сам\p{L}*\s+(?:дешев|дорог|недорог|доступн)\p{L}*|бюджетн\p{L}*|премиальн\p{L}*|премиум|премьюм|флагман\p{L}*|поэконом\p{L}*|подоступн\p{L}*|подешевле|подороже|дешевле|дороже|в том же\s+\p{L}*ценов\p{L}*\s+сегмент\p{L}*)/u
    .test(normalized);
}

/** Merge only pools that the caller has independently put through all gates. */
export function mergeProvenRecoveryIds(...pools: string[][]): string[] {
  return [...new Set(pools.flat().filter(Boolean))];
}

/**
 * A sparse affirmative filter can miss products whose own card proves the
 * feature but whose upstream boolean facet is absent. This plan changes only
 * retrieval: an independently frozen use-class guard supplies exact live
 * class values, while the full criterion remains mandatory on every card.
 */
export function buildSparseFeatureRecoveryPlan(input: {
  facets: Facet[];
  categoryTotal: number;
  customerCriteria: Criterion[];
  terminalCriteria: Criterion[];
  classGuards: PartialApplicationClassGuard[];
  maxBranches?: number;
}): SparseFeatureRecoveryPlan | null {
  const { facets, classGuards } = input;
  if (!classGuards.length || !facets.length) return null;
  const liveClassGuards = classGuards.flatMap((guard) => {
    const facet = facets.find((candidate) => candidate.key === guard.facetKey);
    if (!facet) return [];
    const live = new Set(facet.values.map(({ value }) => value));
    const contradictory = new Set(guard.contradictoryValues);
    const compatible = [...new Set(guard.compatibleValues)].filter((value) =>
      live.has(value) && !contradictory.has(value)
    );
    return compatible.length > 0 ? [{ facet, compatible }] : [];
  });
  // A stale discovery guard is still enforced at the final card gate, but it
  // cannot supply an exact filter for this live recovery scope.
  if (liveClassGuards.length === 0) return null;

  const customerAffirmatives = input.customerCriteria.filter((criterion) =>
    criterion.evidence === "user_explicit" &&
    (criterion.level ?? "A") === "A" &&
    criterion.op === "eq" &&
    typeof criterion.value === "string" &&
    AFFIRMATIVE.has(normalizeKey(criterion.value))
  );
  let sparseFeature: {
    key: string;
    positiveCount: number;
    scopeCount: number;
  } | null = null;
  for (const criterion of customerAffirmatives) {
    if (
      !input.terminalCriteria.some((frozen) =>
        (frozen.level ?? "A") === "A" && frozen.op === "eq" &&
        normalizeKey(frozen.key) === normalizeKey(criterion.key) &&
        normalizeKey(String(frozen.value)) ===
          normalizeKey(String(criterion.value))
      )
    ) continue;
    // Match a unique live axis without running the card-proof checker over a
    // synthetic facet value. Retrieval planning and intrinsic card proof are
    // intentionally independent; the latter is enforced after retrieval.
    const wanted = normalizeKey(criterion.key);
    const exact = facets.filter((facet) =>
      normalizeKey(facet.key) === wanted ||
      normalizeKey(facet.caption) === wanted
    );
    const matched = exact.length > 0
      ? exact
      : facets.filter((facet) =>
        wanted.length >= 5 &&
        [facet.key, facet.caption].some((label) => {
          const normalized = normalizeKey(label);
          return normalized.includes(wanted) || wanted.includes(normalized);
        })
      );
    if (matched.length !== 1) continue;
    const facet = matched[0];
    const positive = facet.values.find((candidate) =>
      normalizeKey(candidate.value) === normalizeKey(String(criterion.value)) &&
      AFFIRMATIVE.has(normalizeKey(candidate.value))
    );
    const positiveCount = positive?.products_count;
    if (
      !facet || !Number.isFinite(positiveCount) ||
      (positiveCount as number) < 0
    ) continue;
    const knownFacetTotal = facet.values.reduce(
      (total, candidate) =>
        total +
        (Number.isFinite(candidate.products_count)
          ? Math.max(0, candidate.products_count!)
          : 0),
      0,
    );
    const knownClassTotal = Math.max(
      0,
      ...liveClassGuards.map(({ facet }) => {
        return facet.values.reduce(
          (total, candidate) =>
            total +
            (Number.isFinite(candidate.products_count)
              ? Math.max(0, candidate.products_count!)
              : 0),
          0,
        );
      }),
    );
    const scopeCount = Math.max(
      Number.isFinite(input.categoryTotal) ? input.categoryTotal : 0,
      knownFacetTotal,
      knownClassTotal,
    );
    // Require positive, observed sparsity; a missing count is not evidence.
    if (scopeCount <= 0 || positiveCount! * 4 > scopeCount) continue;
    sparseFeature = {
      key: facet.key,
      positiveCount: positiveCount!,
      scopeCount,
    };
    break;
  }
  if (!sparseFeature) return null;
  const retrievalGuards = liveClassGuards.filter(({ facet }) =>
    facet.key !== sparseFeature.key
  );
  if (retrievalGuards.length === 0) return null;

  const maxBranches = Math.min(4, Math.max(1, input.maxBranches ?? 4));
  let branches: SparseFeatureRecoveryBranch[] = [{
    options: {},
    classValues: [],
  }];
  for (const { facet, compatible } of retrievalGuards) {
    const next: SparseFeatureRecoveryBranch[] = [];
    for (const branch of branches) {
      for (const value of compatible) {
        const previous = branch.options[facet.key];
        if (previous && previous[0] !== value) continue;
        next.push({
          options: { ...branch.options, [facet.key]: [value] },
          classValues: previous
            ? branch.classValues
            : [...branch.classValues, { key: facet.key, value }],
        });
        if (next.length >= maxBranches) break;
      }
      if (next.length >= maxBranches) break;
    }
    if (next.length === 0) return null;
    branches = next;
  }
  return {
    featureFacetKey: sparseFeature.key,
    positiveCount: sparseFeature.positiveCount,
    scopeCount: sparseFeature.scopeCount,
    branches,
  };
}
