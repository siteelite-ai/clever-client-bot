import {
  type Criterion,
  extendSelectionCriteriaPlan,
} from "./criteria-gate.ts";
import { evaluateReplacementCandidateFit } from "./replacement-candidate-fit.ts";
import { extractReplacementDimensions } from "./replacement-provisional-evidence.ts";
import {
  evaluateStructuralReplacementCandidate,
  type StructuralReplacementFit,
  type StructuralReplacementProfile,
} from "./replacement-structural-proof.ts";
import type { ResultCardinalityContract } from "./result-cardinality.ts";
import type { ProductFull } from "./types.ts";

/**
 * A verified mounting cut-out is meaningful only for a recessed fixture.
 * The live mount option is corroborated when the structural profile is built;
 * a title, category name, or an ambiguous multi-purpose option cannot opt in.
 */
export function hasVerifiedRecessedStructuralMount(
  profile: StructuralReplacementProfile,
): boolean {
  const mount = profile.roles.mount;
  if (!mount) return false;
  const option = profile.searchOptions[mount.facet.key];
  if (!Array.isArray(option) || option.length !== 1) return false;
  const normalized = (value: string) =>
    value.normalize("NFKC")
      .toLocaleLowerCase("ru-RU").replace(/ё/gu, "е")
      .replace(/\s+/gu, " ").trim();
  if (normalized(option[0]) !== normalized(mount.sourceValue)) return false;
  // "Flush mount" may describe a surface fixture; it does not prove a
  // ceiling cut-out. Only explicit recessed terminology opts into this path.
  return /^(?:встраиваем(?:ый|ая|ое|ые)|врезн(?:ой|ая|ое|ые)|recessed)$/u
    .test(normalized(option[0]));
}

export interface GuardedStructuralSelectionContract {
  hash: string;
  mandatory_criteria: Array<{
    key: string;
    op: string;
    value: string | number | [number, number];
    unit?: string;
    evidence: "user_explicit" | "derived_required";
  }>;
  visible_requirements: Array<{
    kind: "mounting_cutout" | "availability";
    label: string;
    op?: "eq";
    value?: number;
    unit?: string;
  }>;
  result_cardinality: ResultCardinalityContract;
}

/**
 * Build the public machine contract from exactly the proof that accepted all
 * rendered candidates. Generic catalogue diameter measures the housing on
 * many cards and is never substituted for a mounting cut-out here. An absent
 * or contradictory per-card proof rejects the whole contract (and its cards).
 * This describes a provisional shortlist, not full interchangeability.
 */
export function guardedStructuralSelectionContract(input: {
  profile: StructuralReplacementProfile;
  candidates: ProductFull[];
  customerCutoutMm: number | null;
  budgetCap: number | null;
  requested: ResultCardinalityContract;
}): GuardedStructuralSelectionContract | null {
  const { profile, candidates, customerCutoutMm, budgetCap, requested } = input;
  if (!hasVerifiedRecessedStructuralMount(profile) || candidates.length === 0) {
    return null;
  }
  const sourceCutout = extractReplacementDimensions(profile.source)
    .mounting_cutout_mm;
  const expectedCutout = customerCutoutMm ?? sourceCutout.mm;
  if (
    !Number.isFinite(expectedCutout) || expectedCutout === null ||
    expectedCutout <= 0 || expectedCutout > 10_000 ||
    sourceCutout.status === "conflicting" ||
    (customerCutoutMm !== null && sourceCutout.mm !== null &&
      sourceCutout.mm !== customerCutoutMm) ||
    (budgetCap !== null && (!Number.isFinite(budgetCap) || budgetCap <= 0))
  ) return null;

  const seen = new Set<string>();
  const perCandidateEvidence: Array<
    Extract<StructuralReplacementFit, { ok: true }>["evidence"]
  > = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) return null;
    seen.add(candidate.id);
    if (budgetCap !== null && candidate.price > budgetCap) return null;
    const structural = evaluateStructuralReplacementCandidate(
      profile,
      candidate,
      {
        dimensionPolicy: "verified_mounting_cutout",
        customerCutoutMm,
      },
    );
    if (!structural.ok) return null;
    const fit = evaluateReplacementCandidateFit(profile.source, candidate, {
      customer_cutout_mm: customerCutoutMm,
    });
    if (
      fit.status !== "provisional_candidate" ||
      fit.checks.mounting_cutout_mm.status !== "match" ||
      extractReplacementDimensions(candidate).mounting_cutout_mm.mm !==
        expectedCutout
    ) return null;
    perCandidateEvidence.push(structural.evidence);
  }

  const commonObligations = profile.obligations.filter((obligation) =>
    obligation.role !== "diameter" &&
    perCandidateEvidence.every((evidence) =>
      evidence.some((item) =>
        item.role === obligation.role && item.caption === obligation.caption
      )
    )
  );
  if (
    commonObligations.length !==
      profile.obligations.filter(({ role }) => role !== "diameter").length
  ) return null;

  const criteria: Criterion[] = commonObligations.map((obligation) => ({
    key: obligation.caption,
    op: obligation.op,
    value: obligation.value,
    ...(obligation.unit ? { unit: obligation.unit } : {}),
    level: "A",
    evidence: "derived_required",
  }));
  criteria.push({
    key: "Монтажное отверстие",
    op: "eq",
    value: expectedCutout,
    unit: "мм",
    level: "A",
    evidence: customerCutoutMm === null ? "derived_required" : "user_explicit",
  });
  if (budgetCap !== null) {
    criteria.push({
      key: "Цена",
      op: "max",
      value: budgetCap,
      unit: "₸",
      level: "A",
      evidence: "user_explicit",
    });
  }
  const plan = extendSelectionCriteriaPlan(null, criteria, "guarded_search");
  return {
    hash: plan.hash,
    mandatory_criteria: plan.mandatory_criteria.map(({
      key,
      op,
      value,
      unit,
      evidence,
    }) => ({
      key,
      op,
      value,
      ...(unit ? { unit } : {}),
      evidence: evidence === "user_explicit"
        ? "user_explicit" as const
        : "derived_required" as const,
    })),
    visible_requirements: [
      {
        kind: "mounting_cutout",
        label: "Диаметр монтажного отверстия",
        op: "eq",
        value: expectedCutout,
        unit: "мм",
      },
      {
        kind: "availability",
        label: "Подтверждённый положительный остаток",
      },
    ],
    result_cardinality: { ...requested },
  };
}
