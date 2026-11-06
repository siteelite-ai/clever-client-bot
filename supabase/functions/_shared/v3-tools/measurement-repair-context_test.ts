import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildMeasurementRepairContext } from "./measurement-repair-context.ts";
import {
  compileMeasuredRequirementConjunction,
  type MeasuredConjunctionDiagnostic,
} from "./measured-requirement-conjunction.ts";
import { compileMeasuredPointRangeRelation } from "./measured-point-range-relation.ts";
import { materializeStructuredMeasurementDeclaration, mergeStructuredMeasurementRepair } from "./structured-measurement-declaration.ts";

const relation = "Диапазон уставки тока должен включать рабочий ток 6 А.";
const working = "Рабочее напряжение изделия должно соответствовать 380 В.";
const unsupported = "Световой поток изделия должен быть не менее 2000 лм.";
const facets = [{
  key: "trip",
  caption: "Диапазон уставки тока расцепления, А",
  type: "string",
  unit: "А",
  values: [{ value: "4-6" }, { value: "6-10" }],
}, {
  key: "voltage",
  caption: "Рабочее напряжение, В",
  type: "string",
  unit: "В",
  values: [{ value: "380" }, { value: "220" }],
}];
const certificate = compileMeasuredPointRangeRelation({
  point: { value: 6, unit: "А", source: "customer_load" },
  facets,
})!;
const customer =
  "Нужна защита нагрузки. Питание 380 В. Рабочий ток нагрузки 6 А.";
const input = {
  customerText: customer,
  facets,
  certificate,
  measurementScope: "per_product",
  requiredFacetValues: [],
};

Deno.test("measurement repair preserves accepted fields and every untouched requirement", () => {
  const later = "Максимальная рабочая температура изделия не менее 60 °C.";
  const initial = {
    selection_readiness: { decision: "ready" },
    required_facet_values: ["v1"],
    product_requirements: [relation, unsupported, later],
  };
  const repaired = mergeStructuredMeasurementRepair(
    initial, { product_requirements: [working] }, unsupported.slice(0, -1),
  );
  assertEquals(repaired, {
    ...initial,
    product_requirements: [working, relation, later],
  });
  assertEquals(initial.product_requirements, [relation, unsupported, later]);
  const compound = { ...initial, product_requirements: [`${unsupported} ${later}`] };
  assertEquals(mergeStructuredMeasurementRepair(
    compound, { product_requirements: [working] }, unsupported,
  )?.product_requirements, [working, ...compound.product_requirements]);
  assertEquals(mergeStructuredMeasurementRepair(
    initial, { product_requirements: [working], required_facet_values: [] }, unsupported,
  ), null);
  assertEquals(mergeStructuredMeasurementRepair(
    initial, { product_requirements: Array(9).fill(working) }, unsupported,
  ), null);
});

Deno.test("repair freezes only individually proven numeric obligations and identifies the actual failed clause", () => {
  const evidence = [relation, working, unsupported].join("\n");
  let diagnostic: MeasuredConjunctionDiagnostic | null = null;
  assertEquals(
    compileMeasuredRequirementConjunction({ ...input, evidence }, (d) => {
      diagnostic = d;
    }),
    null,
  );
  const context = buildMeasurementRepairContext(evidence, diagnostic);
  assertEquals(context.provenObligations, [
    relation.slice(0, -1),
    working.slice(0, -1),
  ]);
  assertEquals(context.failedObligation, unsupported.slice(0, -1));
  assertEquals(context.reason, "unprojected_measured_clause");
  const fixed = materializeStructuredMeasurementDeclaration(
    { product_requirements: [relation], measurement_scope: "per_product" },
    relation,
    context.provenObligations,
  )!;
  const finalEvidence = String(fixed.args.reasoning);
  assert(finalEvidence.includes(working));
  assert(!finalEvidence.includes(unsupported));
  const result = compileMeasuredRequirementConjunction({
    ...input,
    evidence: finalEvidence,
  });
  assert(result);
  assert(
    result.criteria.some((c) =>
      c.key === "Рабочее напряжение, В" && c.value === "380"
    ),
  );
});

Deno.test("retained obligations are rechecked rather than serving as reusable card proof", () => {
  const repaired = materializeStructuredMeasurementDeclaration(
    { product_requirements: [relation] },
    relation,
    [working],
  )!;
  assertEquals(
    compileMeasuredRequirementConjunction({
      ...input,
      evidence: String(repaired.args.reasoning),
      facets: [facets[0], { ...facets[1], values: [{ value: "220" }] }],
    }),
    null,
  );
  const conflicting = materializeStructuredMeasurementDeclaration(
    {
      product_requirements: [
        relation,
        "Рабочее напряжение изделия должно соответствовать 220 В.",
      ],
    },
    relation,
    [working],
  )!;
  assertEquals(
    compileMeasuredRequirementConjunction({
      ...input,
      evidence: String(conflicting.args.reasoning),
    }),
    null,
  );
});

Deno.test("model or browser fields cannot forge the internal retained-obligation parameter", () => {
  const forged = materializeStructuredMeasurementDeclaration({
    product_requirements: [relation],
    serverVerifiedObligations: [working],
    proven_obligations: [working],
  })!;
  assert(!String(forged.args.reasoning).includes(working));
  const legitimate = materializeStructuredMeasurementDeclaration(
    { product_requirements: [relation] },
    relation,
    [working, working],
  )!;
  assertEquals(String(legitimate.args.reasoning).split(working).length, 2);
  assertEquals(
    materializeStructuredMeasurementDeclaration(
      { product_requirements: [relation] },
      relation,
      ["x".repeat(1601)],
    ),
    null,
  );
  assertEquals(
    materializeStructuredMeasurementDeclaration(
      { product_requirements: [relation] },
      relation,
      ["x".repeat(1590)],
    ),
    null,
  );
});

Deno.test("repair context is bounded and unavailable or already-covered diagnostics cannot preserve stale obligations", () => {
  const d: MeasuredConjunctionDiagnostic = {
    code: "unprojected_measured_clause",
    operating_domains_resolved: 0,
    operating_domains_projected: 0,
    operating_domains_unresolved: 0,
    clause_index: 1,
    proven_clause_indices: [-1, 0, 0, 1, 999, 0.5],
  };
  assertEquals(
    buildMeasurementRepairContext(relation + "\n" + unsupported, d)
      .provenObligations,
    [relation.slice(0, -1)],
  );
  assertEquals(
    buildMeasurementRepairContext(relation, null).provenObligations,
    [],
  );
  assertEquals(
    buildMeasurementRepairContext(relation, { ...d, code: "covered" })
      .provenObligations,
    [],
  );
  assertEquals(
    buildMeasurementRepairContext(Array(33).fill(relation).join("\n"), d)
      .provenObligations,
    [],
  );
  assertEquals(
    buildMeasurementRepairContext("x".repeat(1601), d).failedObligation,
    null,
  );
});
