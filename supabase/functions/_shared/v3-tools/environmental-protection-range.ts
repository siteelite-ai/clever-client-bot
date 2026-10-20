import {
  type DerivedSelectionFacet,
  hasUnresolvedEnvironmentalProtectionObligation,
} from "./selection-actionability.ts";

/**
 * The downstream exact-facet projector currently accepts at most 12 values
 * for one facet. Never silently slice an exposure range to that limit: doing
 * so would turn an inclusive safety floor into an arbitrary narrow choice.
 */
const MAX_PROJECTABLE_FACET_VALUES = 12;

export type EnvironmentalProtectionRangeReason =
  | "live_exposure_floor"
  | "no_exposure"
  | "customer_ip_mentioned"
  | "no_live_facet"
  | "ambiguous_live_facet"
  | "facet_missing_key"
  | "no_eligible_values"
  | "too_many_values";

export interface EnvironmentalProtectionRange {
  status: "enumerated" | "not_applicable" | "unresolved";
  reason: EnvironmentalProtectionRangeReason;
  facetKey: string | null;
  facetCaption: string | null;
  /**
   * Exact, untruncated live enum values; never model-invented IP codes. This
   * is not a prevalidated catalog filter: the caller must intersect any
   * broader projected options with these values and verify each product.
   */
  acceptedValues: string[];
}

const EXPOSURE_PROBE: DerivedSelectionFacet = {
  key: "IP",
  caption: "IP",
  values: [],
};

const EMPTY_DECLARATION = { requiredFacetValues: [] };

function result(
  status: EnvironmentalProtectionRange["status"],
  reason: EnvironmentalProtectionRangeReason,
  facet: DerivedSelectionFacet | null = null,
  acceptedValues: string[] = [],
): EnvironmentalProtectionRange {
  return {
    status,
    reason,
    facetKey: facet?.key?.trim() || null,
    facetCaption: facet?.caption?.trim() || null,
    acceptedValues,
  };
}

/**
 * Projects an environmental exposure obligation to the complete OR-family of
 * eligible values on one uniquely identified live IP facet. The existing
 * obligation checker owns the exposure vocabulary and hazard-specific floors:
 * weather needs water digit >= 4; explicit dust needs solids digit >= 5.
 * This helper only enumerates live values against that same rule, so it does
 * not encode a product category, force IP65, or harden one model suggestion.
 *
 * A customer-mentioned IP code (whether exact or a minimum) is intentionally
 * left to the caller's explicit customer-criteria contract. Mixing it into a
 * generic exposure range here could broaden or override the customer's wish.
 * `enumerated` means only that values passed the existing exposure floor,
 * not that another criteria projector will preserve this exact set. The
 * caller must intersect projected values with this list and require strict
 * per-product proof. `unresolved` must not be projected as a partial filter.
 */
export function deriveEnvironmentalProtectionRange(
  customerEvidence: string,
  facets: DerivedSelectionFacet[],
): EnvironmentalProtectionRange {
  // This is a conservative hand-off, not an attempt to parse whether the
  // customer's own IP code means equality, minimum, or exclusion.
  if (
    /(?:^|[^\p{L}\d])IP\s*[0-6X][0-9X](?=$|[^\p{L}\d])/iu.test(
      String(customerEvidence ?? ""),
    )
  ) {
    return result("not_applicable", "customer_ip_mentioned");
  }

  if (
    !hasUnresolvedEnvironmentalProtectionObligation(
      customerEvidence,
      [EXPOSURE_PROBE],
      EMPTY_DECLARATION,
    )
  ) {
    return result("not_applicable", "no_exposure");
  }

  const protectionFacets = (Array.isArray(facets) ? facets : []).filter(
    (facet) =>
      hasUnresolvedEnvironmentalProtectionObligation(
        customerEvidence,
        [facet],
        EMPTY_DECLARATION,
      ),
  );
  if (protectionFacets.length === 0) {
    return result("unresolved", "no_live_facet");
  }
  if (protectionFacets.length !== 1) {
    return result("unresolved", "ambiguous_live_facet");
  }

  const facet = protectionFacets[0];
  if (!facet.key?.trim()) {
    return result("unresolved", "facet_missing_key", facet);
  }
  const declarationKey = facet.caption?.trim() || facet.key.trim();
  const acceptedValues: string[] = [];
  const seen = new Set<string>();
  for (const item of facet.values ?? []) {
    const value = String(item?.value ?? "").trim();
    // The existing floor checker accepts a parsed leading code so prose
    // declarations can be validated. An exact live enum used for search must
    // instead be a single, complete code: no unknown strings or composites.
    if (!/^IP\s*[0-6X][0-9X]$/iu.test(value) || seen.has(value)) continue;
    if (
      hasUnresolvedEnvironmentalProtectionObligation(
        customerEvidence,
        [facet],
        { requiredFacetValues: [{ key: declarationKey, value }] },
      )
    ) continue;
    seen.add(value);
    acceptedValues.push(value);
  }

  if (acceptedValues.length === 0) {
    return result("unresolved", "no_eligible_values", facet);
  }
  if (acceptedValues.length > MAX_PROJECTABLE_FACET_VALUES) {
    return result("unresolved", "too_many_values", facet, acceptedValues);
  }

  return result("enumerated", "live_exposure_floor", facet, acceptedValues);
}
