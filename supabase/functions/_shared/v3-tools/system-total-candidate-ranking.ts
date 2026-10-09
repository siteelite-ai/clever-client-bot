import { canonicalMeasurementUnit } from "./criteria-reasoning.ts";
import { isPhysicalMeasurementUnit } from "./criteria-consistency.ts";
import {
  type SystemPlanProductEvidence,
  type SystemTotalCapacityRequirement,
  verifyPerUnitSystemOutput,
} from "./system-total-capacity.ts";

/** A caller-supplied policy, never an inferred installation plan. */
export interface SystemTotalRankingPolicy {
  /** Normally the lower bound of the requested alternative-card count. */
  minimumVerifiedAlternatives: number;
  /** A severe relative gap (at least 2×), not an absolute unit threshold. */
  severeOutputGapFactor: number;
}

export type SystemTotalRankingRequirement =
  & Pick<
    SystemTotalCapacityRequirement,
    "outputFacet" | "unit"
  >
  & { measurementScope: string | null };

export interface RankedSystemTotalCandidate {
  product: SystemPlanProductEvidence;
  inputIndex: number;
  perUnitOutput: number | null;
  proofSources: Array<"facet_values" | "short_traits">;
  outputIssue?:
    | "missing_output"
    | "ambiguous_output"
    | "unit_mismatch"
    | "missing_product_id";
}

export interface SystemTotalCandidateRanking {
  /** False means even relative output ranking is not evidence-backed. */
  rankingEligible: boolean;
  /** Stronger verified per-unit outputs first; unknown outputs remain visible. */
  retained: RankedSystemTotalCandidate[];
  /** Only verified severe low-output outliers can be removed. */
  excludedVeryLowOutput: RankedSystemTotalCandidate[];
  /** Ranking alternatives never proves quantity, layout, or total capacity. */
  canClaimSystemSufficiency: false;
}

/**
 * Rank already-admissible candidates by independently verified per-unit output.
 * Category, budget, availability, fit and all mandatory criteria must have
 * been enforced upstream. An output-only comparison is not overall product
 * dominance and never proves that any item or group meets the system total.
 *
 * A candidate is pruned only when at least the required number of *other*
 * distinct, verified products each have a severe relative output advantage.
 * Unknown or mixed-unit outputs are retained but cannot serve as proof for
 * pruning. Repeated product IDs cannot inflate the alternative count.
 */
export function rankSystemTotalCandidates(
  requirement: SystemTotalRankingRequirement,
  candidates: SystemPlanProductEvidence[],
  policy: SystemTotalRankingPolicy,
): SystemTotalCandidateRanking {
  const unit = canonicalMeasurementUnit(requirement.unit);
  const rankingEligible = requirement.measurementScope === "system_total" &&
    Boolean(requirement.outputFacet.key) &&
    Boolean(unit) && isPhysicalMeasurementUnit(unit) &&
    Number.isSafeInteger(policy.minimumVerifiedAlternatives) &&
    policy.minimumVerifiedAlternatives >= 1 &&
    Number.isFinite(policy.severeOutputGapFactor) &&
    policy.severeOutputGapFactor >= 2;

  const seenIds = new Set<string>();
  const unique = candidates.flatMap<RankedSystemTotalCandidate>((
    product,
    inputIndex,
  ) => {
    const id = String(product?.id ?? "");
    if (id && seenIds.has(id)) return [];
    if (id) seenIds.add(id);
    if (!rankingEligible || !id) {
      return [{
        product,
        inputIndex,
        perUnitOutput: null,
        proofSources: [],
        ...(!id ? { outputIssue: "missing_product_id" as const } : {}),
      }];
    }
    const proof = verifyPerUnitSystemOutput(
      product,
      requirement.outputFacet,
      unit,
    );
    return [{
      product,
      inputIndex,
      perUnitOutput: "value" in proof ? proof.value : null,
      proofSources: "value" in proof ? proof.sources : [],
      ...("issue" in proof ? { outputIssue: proof.issue } : {}),
    }];
  });
  if (!rankingEligible) {
    return {
      rankingEligible: false,
      retained: unique,
      excludedVeryLowOutput: [],
      canClaimSystemSufficiency: false,
    };
  }

  const verified = unique.filter((candidate) =>
    candidate.perUnitOutput !== null
  );
  const excludedVeryLowOutput = verified.filter((candidate) => {
    const severeThreshold = (candidate.perUnitOutput ?? 0) *
      policy.severeOutputGapFactor;
    if (!Number.isFinite(severeThreshold)) return false;
    const strongerAlternatives = verified.filter((other) =>
      other.product.id !== candidate.product.id &&
      (other.perUnitOutput ?? 0) >= severeThreshold
    );
    return strongerAlternatives.length >= policy.minimumVerifiedAlternatives;
  });
  const excludedIds = new Set(
    excludedVeryLowOutput.map((candidate) => candidate.product.id),
  );
  const retained = unique.filter((candidate) =>
    !excludedIds.has(candidate.product.id)
  ).sort((left, right) =>
    Number(right.perUnitOutput !== null) -
      Number(left.perUnitOutput !== null) ||
    (right.perUnitOutput ?? 0) - (left.perUnitOutput ?? 0) ||
    left.inputIndex - right.inputIndex
  );
  return {
    rankingEligible: true,
    retained,
    excludedVeryLowOutput,
    canClaimSystemSufficiency: false,
  };
}
