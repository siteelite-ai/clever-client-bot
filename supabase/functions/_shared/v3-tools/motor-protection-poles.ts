import { type CriteriaFacet, normalizeKey } from "./criteria-gate.ts";
import type { ProductFull } from "./types.ts";

const threePhase =
  /(?<![\p{L}\p{N}])(?:3\s*фаз\p{L}*|три\s+фазы|тр[её]хфазн\p{L}*\s+(?:двигател|питан|сет)\p{L}*)(?!\p{L})/iu;
const onePhase =
  /(?<![\p{L}\p{N}])(?:1\s*фаз\p{L}*|одна\s+фаза|однофазн\p{L}*\s+(?:двигател|питан|сет)\p{L}*)(?!\p{L})/iu;
const polesCaption =
  /^(?:(?:количество|число)\s+полюсов|полюсность|(?:number of )?poles)$/u;
const titlePoleCount =
  /(?<![\p{L}\p{N}])([1-4])\s*(?:p|р|п)(?![\p{L}\p{N}])/giu;
const literalThree = /^3(?:\s*(?:p|р|п|полюса))?$/iu;

type MotorPoleProof =
  | { status: "not_applicable" }
  | {
    status: "unverified";
    reason: "ambiguous_input" | "missing_catalog_evidence";
  }
  | { status: "verified"; key: string; caption: string; values: string[] };

/** An explicitly three-phase motor branch needs a proven three-pole device.
 * Phase count is not inferred from a voltage, nameplate wattage, or prose
 * from a different product family. */
export function compileMotorProtectionPoleProof(
  customerEvidence: string,
  category: string,
  facets: readonly CriteriaFacet[],
): MotorPoleProof {
  if (
    !/^автоматы\s+защиты\s+двигателя$/u.test(normalizeKey(category)) ||
    !threePhase.test(customerEvidence)
  ) return { status: "not_applicable" };
  if (
    onePhase.test(customerEvidence) ||
    [...customerEvidence.matchAll(titlePoleCount)].some((match) =>
      match[1] !== "3"
    ) ||
    /(?:не\s+3\s*фаз|не\s+три\s+фаз|(?:1|3)\s*\/\s*(?:1|3)\s*фаз)/iu.test(
      customerEvidence,
    )
  ) {
    return { status: "unverified", reason: "ambiguous_input" };
  }
  const axes = facets.filter(({ key, caption }) =>
    polesCaption.test(normalizeKey(caption || key))
  );
  if (axes.length !== 1) {
    return { status: "unverified", reason: "missing_catalog_evidence" };
  }
  const [axis] = axes;
  const values = [
    ...new Set(
      axis.values.map(({ value }) => String(value))
        .filter((value) => literalThree.test(value.trim())),
    ),
  ];
  return values.length
    ? { status: "verified", key: axis.key, caption: axis.caption, values }
    : { status: "unverified", reason: "missing_catalog_evidence" };
}

export function productProvesMotorProtectionPoles(
  product: ProductFull | undefined,
  proof: MotorPoleProof,
): boolean {
  if (proof.status === "not_applicable") return true;
  if (proof.status !== "verified" || !product) return false;
  const values = product.facet_values?.[proof.key];
  if (
    normalizeKey(product.facet_captions?.[proof.key] ?? "") !==
      normalizeKey(proof.caption) ||
    !values || values.length !== 1 || !proof.values.includes(values[0])
  ) return false;
  return ![...product.pagetitle.matchAll(titlePoleCount)].some((match) =>
    match[1] !== "3"
  );
}
