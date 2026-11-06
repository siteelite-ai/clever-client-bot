import type { Criterion } from "./criteria-gate.ts";
import {
  checkCriterion,
  projectCriteriaFacetOptions,
} from "./criteria-gate.ts";
import {
  canonicalMeasurementUnit,
  compileMeasuredReasoningSearchContract,
  extractReasoningBounds,
  filterPerProductMeasuredCriteria,
  hasMeasuredSelectionRequirement,
  projectLiteralMeasuredCriteria,
} from "./criteria-reasoning.ts";
import { extractClientQuantities } from "./criteria-consistency.ts";
import {
  clauseStatesOperatingPoint,
  type OperatingPointDomain,
  resolveCustomerOperatingPointDomains,
} from "./operating-point-domain.ts";
import {
  certificateCoversSoleUnprojectedMeasurement,
  type CoverageDiagnostic,
  type MeasuredPointRangeCertificate,
  measurementQuantityDiagnostics,
  verifiedMeasuredPointRangeEvidence,
} from "./measured-point-range-relation.ts";

type Facet = Parameters<
  typeof compileMeasuredReasoningSearchContract
>[3][number];

/** Fixed codes and bounded technical facts only. In particular, an empty
 * returned contract must not erase evidence that a customer operating point
 * was resolved before a later model clause failed. No sentences, facet names,
 * identifiers or arbitrary model strings belong in this diagnostic. */
export type MeasuredConjunctionDiagnostic = {
  code:
    | "unsupported_scope"
    | "invalid_load_relation"
    | "unresolved_customer_operating_point"
    | "operating_domain_projection_mismatch"
    | "unscoped_comparison"
    | "uncovered_context_clause"
    | "compound_measured_clause"
    | "unprojected_measured_clause"
    | "ambiguous_desired_facet"
    | "customer_implication_not_proven"
    | "missing_coverage_relation"
    | "covered";
  operating_domains_resolved: number;
  operating_domains_unresolved: number;
  operating_domains_projected: number;
  proven_clause_indices?: number[];
  unresolved_operating_units?: string[];
  clause_index?: number;
  clause_quantities?: ReturnType<typeof measurementQuantityDiagnostics>;
  bound_operators?: Array<
    "min_inclusive" | "min_exclusive" | "max_inclusive" | "max_exclusive"
  >;
  source_coverage_code?: CoverageDiagnostic["code"];
  projection?: {
    mandatory: number;
    proven: number;
    unmatched: number;
    facets: number;
  };
};

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
}, observe?: (diagnostic: MeasuredConjunctionDiagnostic) => void):
  | {
    criteria: Criterion[];
    obligations: number;
    customerImplications: number;
    operatingDomains?: OperatingPointDomain[];
  }
  | null {
  let operatingDomainsResolved = 0;
  let operatingDomainsUnresolved = 0;
  let operatingDomainsProjected = 0;
  let unresolvedOperatingUnits: string[] = [];
  const provenClauses: number[] = [];
  const report = (
    code: MeasuredConjunctionDiagnostic["code"],
    clauseIndex?: number,
    criteria?: Criterion[],
    sourceCoverageCode?: CoverageDiagnostic["code"],
  ) => {
    if (!observe) return;
    const clause = clauseIndex === undefined ? undefined : clauses[clauseIndex];
    const projection = criteria
      ? projectCriteriaFacetOptions(criteria, input.facets)
      : null;
    observe({
      code,
      operating_domains_resolved: Math.min(operatingDomainsResolved, 16),
      operating_domains_unresolved: Math.min(operatingDomainsUnresolved, 16),
      operating_domains_projected: Math.min(operatingDomainsProjected, 16),
      proven_clause_indices: provenClauses.slice(0, 32),
      ...(unresolvedOperatingUnits.length
        ? { unresolved_operating_units: unresolvedOperatingUnits.slice(0, 16) }
        : {}),
      ...(clause === undefined ? {} : {
        clause_index: Math.min(clauseIndex!, 255),
        clause_quantities: measurementQuantityDiagnostics(
          clause,
          input.customerText,
        ),
        bound_operators: extractReasoningBounds(clause).slice(0, 16).map((b) =>
          `${b.op}_${b.strict ? "exclusive" : "inclusive"}` as NonNullable<
            MeasuredConjunctionDiagnostic["bound_operators"]
          >[number]
        ),
      }),
      ...(sourceCoverageCode
        ? { source_coverage_code: sourceCoverageCode }
        : {}),
      ...(projection
        ? {
          projection: {
            mandatory: Math.min(criteria!.length, 64),
            proven: Math.min(projection.proven_criteria.length, 64),
            unmatched: Math.min(projection.unmatched_keys.length, 64),
            facets: Math.min(Object.keys(projection.options).length, 64),
          },
        }
        : {}),
    });
  };
  const reject = (...args: Parameters<typeof report>): null => {
    report(...args);
    return null;
  };
  // Defined before any diagnostic can run, including early scope rejection.
  const clauses = input.evidence.split(/(?<!\d)[.!?;]+(?!\d)|\n+/u)
    .map((clause) => clause.trim()).filter(Boolean);
  if (input.measurementScope !== "per_product") {
    return reject("unsupported_scope");
  }
  const relation = verifiedMeasuredPointRangeEvidence(input.certificate);
  if (
    !relation || !certificateCoversSoleUnprojectedMeasurement({
      certificate: input.certificate,
      measurementEvidence: relation,
      requiredFacetValues: input.requiredFacetValues,
      customerEvidence: input.customerText,
    })
  ) return reject("invalid_load_relation");
  const operatingPointCompilation = resolveCustomerOperatingPointDomains(
    input.customerText,
    input.facets,
  );
  operatingDomainsResolved = operatingPointCompilation.domains.length;
  operatingDomainsUnresolved = operatingPointCompilation.unresolved;
  unresolvedOperatingUnits = operatingPointCompilation.unresolvedUnits;
  if (operatingPointCompilation.unresolved > 0) {
    return reject("unresolved_customer_operating_point");
  }
  const operatingDomains = operatingPointCompilation.domains.filter(
    (domain) => {
      const projection = projectCriteriaFacetOptions(
        [domain.criterion],
        input.facets,
      );
      const values = projection.options[domain.facetKey];
      return values?.length === domain.acceptedValues.length &&
        values.every((v) => domain.acceptedValues.includes(v));
    },
  );
  operatingDomainsProjected = operatingDomains.length;
  if (operatingDomains.length !== operatingPointCompilation.domains.length) {
    return reject("operating_domain_projection_mismatch");
  }
  // Customer-owned operating points survive even when model prose cleanup
  // removes an unsupported equality. The LLM cannot delete this obligation.
  const criteria: Criterion[] = operatingDomains.map((domain) =>
    domain.criterion
  );
  const retainedDomains: OperatingPointDomain[] = [...operatingDomains];
  let obligations = 0;
  let customerImplications = 0;
  let relationCovered = false;
  for (const [clauseIndex, clause] of clauses.entries()) {
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
      provenClauses.push(clauseIndex);
      continue;
    }
    if (!hasMeasuredSelectionRequirement(clause)) {
      if (/[<>=≤≥]/u.test(clause)) {
        return reject("unscoped_comparison", clauseIndex);
      }
      let sourceCoverageCode: CoverageDiagnostic["code"] | undefined;
      if (
        !certificateCoversSoleUnprojectedMeasurement(
          {
            certificate: input.certificate,
            measurementEvidence: `${relation}\n${clause}`,
            requiredFacetValues: [],
            customerEvidence: input.customerText,
          },
          observe
            ? (diagnostic) => {
              sourceCoverageCode = diagnostic.code;
            }
            : undefined,
        )
      ) {
        return reject(
          "uncovered_context_clause",
          clauseIndex,
          undefined,
          sourceCoverageCode,
        );
      }
      continue;
    }
    obligations++;
    const literalDomain = extractReasoningBounds(clause).length === 0
      ? operatingDomains.filter((domain) =>
        clauseStatesOperatingPoint(clause, domain)
      )
      : [];
    if (
      literalDomain.length === 1 &&
      fullyProjected([literalDomain[0].criterion], input.facets)
    ) {
      criteria.push(literalDomain[0].criterion);
      retainedDomains.push(literalDomain[0]);
      provenClauses.push(clauseIndex);
      continue;
    }
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
      provenClauses.push(clauseIndex);
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
      ).matched.concat(operatingDomains.map((domain) => domain.criterion)),
      input.customerText,
      input.customerText,
      input.measurementScope,
      input.facets,
    ).criteria.filter((candidate, index, all) =>
      all.findIndex((other) =>
        other.key === candidate.key && other.op === candidate.op &&
        String(other.value) === String(candidate.value) &&
        canonicalMeasurementUnit(other.unit ?? "") ===
          canonicalMeasurementUnit(candidate.unit ?? "")
      ) === index
    );
    const desired = compileMeasuredReasoningSearchContract(
      [],
      clause,
      [],
      input.facets,
      { measurementScope: input.measurementScope, customerText: clause },
    );
    if (!singleMeasuredObligation(clause)) {
      return reject(
        "compound_measured_clause",
        clauseIndex,
        desired.mandatory_criteria,
      );
    }
    if (!fullyProjected(desired.mandatory_criteria, input.facets)) {
      return reject(
        "unprojected_measured_clause",
        clauseIndex,
        desired.mandatory_criteria,
      );
    }
    const desiredProjection = projectCriteriaFacetOptions(
      desired.mandatory_criteria,
      input.facets,
    );
    const keys = Object.keys(desiredProjection.options);
    if (keys.length !== 1) {
      return reject(
        "ambiguous_desired_facet",
        clauseIndex,
        desired.mandatory_criteria,
      );
    }
    const key = keys[0];
    const stronger = customer.filter((candidate) => {
      if (candidate.op !== "eq" || !fullyProjected([candidate], input.facets)) {
        return false;
      }
      const projection = projectCriteriaFacetOptions([candidate], input.facets);
      const values = projection.options[key];
      // One interval enum may contain both 380 and 400. Enum-set inclusion
      // alone cannot prove 380 >= 400: check the source point against the
      // model operator too. The separate SKU certificate proves its domain.
      const point = {
        id: "customer-point",
        pagetitle: "",
        vendor: null,
        price: 1,
        stock: "unknown" as const,
        short_traits: [
          `${candidate.key}: ${candidate.value} ${candidate.unit ?? ""}`,
        ],
      };
      if (
        !desired.mandatory_criteria.every((wanted) =>
          checkCriterion(point, wanted).verdict === "pass"
        )
      ) return false;
      return projection.proven_criteria.length === 1 &&
        Object.keys(projection.options).length === 1 &&
        values?.length > 0 && values.every((value) =>
          desiredProjection.options[key].includes(value)
        );
    });
    if (stronger.length !== 1) {
      return reject(
        "customer_implication_not_proven",
        clauseIndex,
        desired.mandatory_criteria,
      );
    }
    criteria.push({ ...stronger[0], evidence: "user_explicit" });
    retainedDomains.push(
      ...operatingDomains.filter((domain) =>
        domain.criterion.key === stronger[0].key &&
        domain.criterion.value === stronger[0].value
      ),
    );
    customerImplications++;
    provenClauses.push(clauseIndex);
  }
  if (!relationCovered || obligations === 0) {
    return reject("missing_coverage_relation");
  }
  report("covered");
  return {
    criteria: criteria.filter((candidate, index, all) =>
      all.findIndex((other) =>
        other.key === candidate.key && other.op === candidate.op &&
        String(other.value) === String(candidate.value)
      ) === index
    ),
    obligations,
    customerImplications,
    ...(retainedDomains.length
      ? {
        operatingDomains: retainedDomains.filter((domain, index, all) =>
          all.findIndex((other) =>
            other.facetKey === domain.facetKey &&
            other.point === domain.point && other.unit === domain.unit
          ) === index
        ),
      }
      : {}),
  };
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
