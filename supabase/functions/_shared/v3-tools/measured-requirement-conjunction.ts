import type { Criterion } from "./criteria-gate.ts";
import { projectCriteriaFacetOptions } from "./criteria-gate.ts";
import {
  canonicalMeasurementUnit,
  compileMeasuredReasoningSearchContract,
  filterPerProductMeasuredCriteria,
  hasMeasuredSelectionRequirement,
  projectLiteralMeasuredCriteria,
} from "./criteria-reasoning.ts";
import { extractClientQuantities } from "./criteria-consistency.ts";
import {
  certificateCoversSoleUnprojectedMeasurement,
  type MeasuredPointRangeCertificate,
  verifiedMeasuredPointRangeEvidence,
} from "./measured-point-range-relation.ts";

type Facet = Parameters<
  typeof compileMeasuredReasoningSearchContract
>[3][number];

/** A conjunction, not an "at least one numeric filter" readiness test.
 * The existing point/range certificate proves only its own clause. Every
 * other measured clause must independently compile to executable live options.
 * No product/category names or numeric thresholds are defined here. */
export function compileMeasuredRequirementConjunction(input: {
  evidence: string;
  customerText: string;
  facets: Facet[];
  measurementScope: string | null | undefined;
  certificate: MeasuredPointRangeCertificate;
  requiredFacetValues: ReadonlyArray<{ key: string; value: string }>;
}):
  | { criteria: Criterion[]; obligations: number; customerImplications: number }
  | null {
  if (input.measurementScope !== "per_product") return null;
  const relation = verifiedMeasuredPointRangeEvidence(input.certificate);
  if (
    !relation || !certificateCoversSoleUnprojectedMeasurement({
      certificate: input.certificate,
      measurementEvidence: relation,
      requiredFacetValues: input.requiredFacetValues,
      customerEvidence: input.customerText,
    })
  ) return null;
  const clauses = input.evidence.split(/(?<!\d)[.!?;]+(?!\d)|\n+/u)
    .map((clause) => clause.trim()).filter(Boolean);
  const criteria: Criterion[] = [];
  let obligations = 0;
  let customerImplications = 0;
  let relationCovered = false;
  for (const clause of clauses) {
    if (
      certificateCoversSoleUnprojectedMeasurement({
        certificate: input.certificate,
        measurementEvidence: clause,
        requiredFacetValues: [],
        customerEvidence: input.customerText,
      })
    ) {
      relationCovered = true;
      obligations++;
      continue;
    }
    if (!hasMeasuredSelectionRequirement(clause)) {
      if (/[<>=≤≥]/u.test(clause)) return null;
      if (
        !certificateCoversSoleUnprojectedMeasurement({
          certificate: input.certificate,
          measurementEvidence: `${relation}\n${clause}`,
          requiredFacetValues: [],
          customerEvidence: input.customerText,
        })
      ) return null;
      continue;
    }
    obligations++;
    // A clause with several physical quantities needs a richer relation;
    // never let one successfully projected number stand in for the others.
    const projected = compileMeasuredReasoningSearchContract(
      [],
      clause,
      [],
      input.facets,
      {
        measurementScope: input.measurementScope,
        customerText: input.customerText,
      },
    );
    if (
      fullyProjected(projected.mandatory_criteria, input.facets) &&
      singleMeasuredObligation(clause)
    ) {
      criteria.push(...projected.mandatory_criteria);
      continue;
    }
    // A model-authored weaker bound must not overwrite an exact customer
    // requirement. Accept the stronger customer contract ONLY when every
    // live value it admits independently satisfies the complete model bound.
    // Both projections use the SAME exact facet key; equal units alone are
    // insufficient. Unknown values, empty sets and a truncated OR never prove
    // an implication. The retained customer criterion also gates final cards.
    const customer = filterPerProductMeasuredCriteria(
      projectLiteralMeasuredCriteria(
        [],
        input.customerText,
        input.customerText,
        input.facets,
      ).matched,
      input.customerText,
      input.customerText,
      input.measurementScope,
      input.facets,
    ).criteria;
    const desired = compileMeasuredReasoningSearchContract(
      [],
      clause,
      [],
      input.facets,
      { measurementScope: input.measurementScope, customerText: clause },
    );
    if (
      !singleMeasuredObligation(clause) ||
      !fullyProjected(desired.mandatory_criteria, input.facets)
    ) return null;
    const desiredProjection = projectCriteriaFacetOptions(
      desired.mandatory_criteria,
      input.facets,
    );
    const keys = Object.keys(desiredProjection.options);
    if (keys.length !== 1) return null;
    const key = keys[0];
    const stronger = customer.filter((candidate) => {
      if (candidate.op !== "eq" || !fullyProjected([candidate], input.facets)) {
        return false;
      }
      const projection = projectCriteriaFacetOptions([candidate], input.facets);
      const values = projection.options[key];
      return projection.proven_criteria.length === 1 &&
        Object.keys(projection.options).length === 1 &&
        values?.length > 0 && values.every((value) =>
          desiredProjection.options[key].includes(value)
        );
    });
    if (stronger.length !== 1) return null;
    criteria.push({ ...stronger[0], evidence: "user_explicit" });
    customerImplications++;
  }
  return relationCovered && obligations > 0
    ? { criteria, obligations, customerImplications }
    : null;
}

function fullyProjected(criteria: Criterion[], facets: Facet[]): boolean {
  if (criteria.length === 0) return false;
  const projected = projectCriteriaFacetOptions(criteria, facets);
  // The legacy projector bounds options to 12. Reconstruct the accepted
  // domain one enum at a time, without that cap. The full facet can be large;
  // only the actual satisfying OR family must be complete and bounded.
  return projected.unmatched_keys.length === 0 &&
    projected.proven_criteria.length === criteria.length &&
    Object.entries(projected.options).every(([key, values]) => {
      const facet = facets.find((f) => f.key === key);
      if (!facet) return false;
      const owned = criteria.filter((c) =>
        projectCriteriaFacetOptions([c], [facet]).proven_criteria.length === 1
      );
      const full = facet.values.filter((value) =>
        projectCriteriaFacetOptions(owned, [{ ...facet, values: [value] }])
          .options[key]?.includes(value.value)
      );
      return full.length > 0 && full.length <= 12 &&
        full.length === values.length && full.every(({ value }) =>
          values.includes(value)
        );
    });
}

// An atomic scalar/range can be projected by the existing contract. Compound
// or unscoped multi-property prose must not acquire proof from one scalar.
function singleMeasuredObligation(text: string): boolean {
  const quantities = extractClientQuantities(text);
  if (/[<>=≤≥]\s*[^\s\d=<>≤≥]/u.test(text)) return false;
  if (quantities.length === 1) return true;
  if (
    quantities.length !== 2 ||
    canonicalMeasurementUnit(quantities[0].unit) !==
      canonicalMeasurementUnit(quantities[1].unit)
  ) return false;
  const interval = text.match(
    /(?:от\s+)?(\d+(?:[.,]\d+)?)\s*(?:[-–—]|до)\s*(\d+(?:[.,]\d+)?)/iu,
  );
  return Boolean(
    interval && Number(interval[1].replace(",", ".")) === quantities[0].value &&
      Number(interval[2].replace(",", ".")) === quantities[1].value,
  );
}
