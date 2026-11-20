import { extractClientQuantities, isPhysicalMeasurementUnit } from "./criteria-consistency.ts";
import { canonicalMeasurementUnit } from "./criteria-reasoning.ts";

type Quantity = { value: number; unit: string };
/** An installed server-owned per-card guard can discharge ONLY the exact
 * customer measurements it actually checks. This is a pre-search coverage
 * certificate, never permission to render a card or weaken that guard.
 * Callers must not obtain certificates from request fields or model output. */
export function independentGuardCoversMeasurements(input: {
  customerEvidence: string;
  modelEvidence: string;
  coveredQuantities: readonly Quantity[];
  requiredFacetValues: readonly { key: string; value: string }[];
  facets: readonly { key: string; caption?: string | null; unit?: string | null }[];
}): boolean {
  const physical = (text: string) => extractClientQuantities(text)
    .filter(({ unit }) => isPhysicalMeasurementUnit(unit));
  const quantities = physical(input.customerEvidence);
  const covered = (q: Quantity) => input.coveredQuantities.some(c => c.value === q.value && canonicalMeasurementUnit(c.unit) === canonicalMeasurementUnit(q.unit));
  if (!quantities.length || !input.coveredQuantities.length ||
    input.coveredQuantities.some(q => !Number.isFinite(q.value) || q.value <= 0) ||
    !quantities.every(covered) || physical(input.modelEvidence).length > 0) return false;
  // Equal numbers/units do NOT establish equal properties. If the model
  // states a product-side numeric obligation (even with the customer's own
  // number), the existing typed/scalar relation compiler must prove it.
  // A declaration can hide an unrelated product quantity in an exact facet.
  // The property unit must be included when checking that obligation.
  return input.requiredFacetValues.every(({ key, value }) => {
    const facet = input.facets.find(f => f.key === key || f.caption === key);
    return physical(`${value} ${facet?.unit ?? ""}`).length === 0;
  });
}
