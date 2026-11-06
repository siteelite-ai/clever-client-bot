import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildMeasurementRepairContext } from "./measurement-repair-context.ts";
import {
  compileMeasuredRequirementConjunction,
  type MeasuredConjunctionDiagnostic,
} from "./measured-requirement-conjunction.ts";
import {
  compileMeasuredPointRangeRelation,
  focusedRepairPreservesLoadPoint,
} from "./measured-point-range-relation.ts";
import {
  materializeStructuredMeasurementDeclaration,
  MEASUREMENT_REPAIR_TOOL_NAME,
  mergeStructuredMeasurementRepair,
  parseMeasurementRepairArguments,
  validateMeasurementRepairResponse,
} from "./structured-measurement-declaration.ts";

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

Deno.test("focused repair cannot turn certified range endpoints into a different load or scalar rating", () => {
  for (const requirement of [
    "Диапазон уставки тока должен включать рабочий ток 10 А.",
    "Номинальный ток автомата должен быть равен 10 A.",
    "Уставка должна быть не менее 10 амперов.",
    "Рабочий ток равен 10000 мА.",
    "Рабочий ток равен 0,01 kA.",
    "Номинальный ток изделия равен 4–6 А.",
    "Номинальный ток изделия равен 6–10 А.",
    "Диапазон уставки тока 6–10 А должен включать 6 А, отключающий ток 10 А.",
  ]) {
    assert(!focusedRepairPreservesLoadPoint([requirement], certificate), requirement);
  }
  for (const requirement of [
    relation,
    working,
    "Рабочий ток нагрузки 6000 mA.",
    "Рабочий ток нагрузки 0,006 кА.",
    "Диапазон уставки тока 6–10 А должен включать рабочий ток 6 А.",
  ]) {
    assert(focusedRepairPreservesLoadPoint([requirement], certificate), requirement);
  }
  assert(!focusedRepairPreservesLoadPoint([relation, "Номинальный ток автомата 10 А."], certificate));
  const differentPoint = compileMeasuredPointRangeRelation({
    point: { value: 10, unit: "А", source: "customer_load" },
    facets,
  })!;
  assert(focusedRepairPreservesLoadPoint([
    "Диапазон уставки тока должен включать рабочий ток 10 А.",
  ], differentPoint));
  assert(!focusedRepairPreservesLoadPoint([relation], differentPoint));
});

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

Deno.test("measurement repair reports bounded wire failures without retaining raw arguments", () => {
  const name = MEASUREMENT_REPAIR_TOOL_NAME;
  const parseCall = (raw: unknown) => ({ name, ...parseMeasurementRepairArguments(raw) });
  const valid = parseCall(JSON.stringify({ product_requirements: [working] }));
  assertEquals(validateMeasurementRepairResponse([valid]), {
    ok: true,
    args: { product_requirements: [working] },
  });
  const cases = [
    { calls: [], reason: "missing_tool_call" },
    { calls: [valid, valid], reason: "multiple_tool_calls" },
    { calls: [{ ...valid, name: "declare_selection_reasoning" }], reason: "unexpected_tool" },
    { calls: [parseCall(undefined)], reason: "missing_arguments" },
    { calls: [parseCall('{"private":"must not be copied"')], reason: "malformed_json" },
    { calls: [parseCall("null")], reason: "non_object_arguments" },
    { calls: [parseCall("[]")], reason: "non_object_arguments" },
    { calls: [parseCall("{}")], reason: "missing_requirements" },
    { calls: [parseCall('{"product_requirements":null}')], reason: "requirements_type" },
    { calls: [parseCall('{"product_requirements":[]}')], reason: "unresolved" },
    { calls: [parseCall('{"product_requirements":[false]}')], reason: "invalid_requirement_item" },
    { calls: [parseCall(JSON.stringify({ product_requirements: Array(9).fill(working) }))], reason: "requirements_limit" },
    { calls: [parseCall('{"product_requirements":[],"private":"must not be copied"}')], reason: "unexpected_fields" },
  ] as const;
  for (const { calls, reason } of cases) {
    assertEquals(validateMeasurementRepairResponse(calls), { ok: false, reason });
  }
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
