import { canonicalMeasurementUnit } from "./criteria-reasoning.ts";
import { isPhysicalMeasurementUnit } from "./criteria-consistency.ts";
import {
  type SystemPlanProductEvidence,
  type SystemTotalCapacityRequirement,
  verifyPerUnitSystemOutput,
} from "./system-total-capacity.ts";

/** A caller-supplied policy, never an inferred installation plan. */
export interface SystemTotalRankingPolicy {
  /** Below this many verified choices, unverified cards remain as fallback. */
  minimumVerifiedAlternatives: number;
  /** Conservative caller policy retained for compatibility; no output is pruned solely for being low. */
  severeOutputGapFactor: number;
}

export type SystemTotalRankingRequirement =
  & Pick<
    SystemTotalCapacityRequirement,
    "outputFacet" | "unit" | "minimumTotal"
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
  /** Verified outputs closest to the total need first; unknowns only as fallback. */
  retained: RankedSystemTotalCandidate[];
  /** Legacy diagnostic: a low-output unit may still be part of a valid system. */
  excludedVeryLowOutput: RankedSystemTotalCandidate[];
  /** Unknown output is not a useful alternative once enough proven choices exist. */
  excludedUnverifiedOutput: RankedSystemTotalCandidate[];
  /** Ranking alternatives never proves quantity, layout, or total capacity. */
  canClaimSystemSufficiency: false;
}

/**
 * Rank already-admissible candidates by independently verified per-unit output
 * relative to the visible total need. A very powerful unit is not automatically
 * the best alternative to an appropriately sized system. Distance is symmetric
 * on a ratio scale: a unit below the total can still be combined with others,
 * while a unit above it may be oversized. Neither case is a per-card gate.
 * Category, budget, availability, fit and all mandatory criteria must have
 * been enforced upstream. Output proximity is not overall product dominance
 * and never proves that any item or group meets the system total. Unknown or
 * mixed-unit outputs remain fallback choices only if fewer than the requested
 * minimum of distinct verified alternatives exist. Repeated IDs cannot inflate
 * that count.
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
    Number.isFinite(requirement.minimumTotal) &&
    requirement.minimumTotal > 0 &&
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
      excludedUnverifiedOutput: [],
      canClaimSystemSufficiency: false,
    };
  }

  const verified = unique.filter((candidate) =>
    candidate.perUnitOutput !== null
  );
  const excludedUnverifiedOutput = verified.length >=
      policy.minimumVerifiedAlternatives
    ? unique.filter((candidate) => candidate.perUnitOutput === null)
    : [];
  const distanceFromTotal = (output: number | null): number =>
    output === null
      ? Number.POSITIVE_INFINITY
      : Math.abs(Math.log(output) - Math.log(requirement.minimumTotal));
  const retained = unique.filter((candidate) =>
    !excludedUnverifiedOutput.includes(candidate)
  ).sort((left, right) =>
    Number(right.perUnitOutput !== null) -
      Number(left.perUnitOutput !== null) ||
    distanceFromTotal(left.perUnitOutput) -
      distanceFromTotal(right.perUnitOutput) ||
    left.inputIndex - right.inputIndex
  );
  return {
    rankingEligible: true,
    retained,
    excludedVeryLowOutput: [],
    excludedUnverifiedOutput,
    canClaimSystemSufficiency: false,
  };
}
