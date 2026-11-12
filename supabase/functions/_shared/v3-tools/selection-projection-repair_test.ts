import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildDerivedSelectionReasoningToolSchema,
  resolveDerivedSelectionReasoning,
} from "./selection-actionability.ts";
import { compileToolArrayBounds } from "./tool-array-bounds.ts";
import {
  mergeSelectionProjectionRepair,
  SELECTION_PROJECTION_REPAIR_TOOL,
  selectionProjectionRepairTool,
} from "./selection-projection-repair.ts";

const destinations = [
  "для гостиной",
  "для офиса",
  "для склада",
  "для улицы",
  "для производства",
  "для гаража",
  "для стадиона",
  "для тоннеля",
  "для теплицы",
  "для магазина",
  "для больницы",
  "для школы",
  "для мастерской",
];
const facets = [{
  key: "purpose",
  caption: "Назначение",
  type: "string" as const,
  values: destinations.map((value) => ({ value })),
}];
const strictSchema = buildDerivedSelectionReasoningToolSchema(
  facets,
  "для гостиной 30 м²",
  null,
  { requireReadiness: true },
);
const tool = selectionProjectionRepairTool(strictSchema);
const base = {
  selection_readiness: {
    decision: "ready",
    critical_inputs: [{
      parameter: "Площадь",
      customer_quote: "30 м²",
      question: "",
      impact: "Проверяется площадь освещения.",
    }],
  },
  selection_subject: { immutable: "original subject" },
  explicit_customer_classifications: [{
    customer_phrase: "исходная фраза",
    classification_id: "f0v0",
  }],
  reasoning: "",
  measurement_scope: "per_product",
  compatible_classifications: [],
  excluded_classifications: [],
  required_facet_values: [],
  server_owned_excluded_urls: ["https://example.invalid/previous-card"],
};
const patch = {
  reasoning:
    "Для гостиной проверяю назначение и площадь освещения каждого светильника не менее 30 м².",
  measurement_scope: "per_product",
  compatible_classifications: ["f0v0"],
  excluded_classifications: Array.from({ length: 12 }, (_, i) => `f0v${i + 1}`),
  required_facet_values: [],
};
const call = (args: unknown = patch) => ({
  name: SELECTION_PROJECTION_REPAIR_TOOL,
  args,
});

Deno.test("projection repair freezes accepted facts, subject, customer mappings and previous cards without mutating the base", () => {
  const before = structuredClone(base);
  const result = mergeSelectionProjectionRepair(base, [call()], tool);
  assert(result.ok);
  assertEquals(result.excludedCount, 12);
  for (
    const key of [
      "selection_readiness",
      "selection_subject",
      "explicit_customer_classifications",
      "server_owned_excluded_urls",
    ] as const
  ) assertEquals(result.args[key], base[key]);
  assertEquals(result.args.reasoning, patch.reasoning);
  assertEquals(base, before);
  (result.args.selection_readiness as { decision: string }).decision =
    "needs_input";
  assertEquals(base, before);
});

Deno.test("exclusion capacity comes from the exact live schema, not a first-eight slice or an arbitrary larger cap", () => {
  const properties = strictSchema.function.parameters.properties as Record<
    string,
    { maxItems?: number }
  >;
  assertEquals(
    properties.excluded_classifications.maxItems,
    destinations.length,
  );
  assertEquals(compileToolArrayBounds(tool).validate(patch), null);
  const legacy = buildDerivedSelectionReasoningToolSchema(facets).function
    .parameters.properties as typeof properties;
  assertEquals(
    legacy.excluded_classifications.maxItems,
    8,
    "released OFF wire must not change",
  );
  const result = mergeSelectionProjectionRepair(base, [call()], tool);
  assert(result.ok);
  const resolved = resolveDerivedSelectionReasoning(
    result.args,
    facets,
    "для гостиной 30 м²",
    "Светильники",
    null,
    { completeClassificationExclusions: true },
  );
  assert(resolved);
  assertEquals(resolved.excluded.length, 12);
  assertEquals(resolved.excluded.at(-1), {
    key: "Назначение",
    value: "для мастерской",
  });
});

Deno.test("projection repair rejects whole patches with foreign or duplicate IDs, overflow, bad types, missing fields or overlong prose", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{
      ...patch,
      excluded_classifications: [...patch.excluded_classifications, "f0v999"],
    }, "invalid_live_id"],
    [{
      ...patch,
      excluded_classifications: [
        ...patch.excluded_classifications.slice(0, 9),
        "f0v999",
      ],
    }, "invalid_live_id"],
    [{
      ...patch,
      excluded_classifications: [
        ...patch.excluded_classifications,
        "f0v1",
        "f0v2",
      ],
    }, "array_bound"],
    [
      { ...patch, excluded_classifications: ["f0v1", "f0v1"] },
      "duplicate_live_id",
    ],
    [{ ...patch, required_facet_values: ["f0v0"] }, "invalid_live_id"],
    [{ ...patch, compatible_classifications: [42] }, "invalid_live_id"],
    [{ ...patch, excluded_classifications: "f0v1" }, "array_bound"],
    [{ ...patch, reasoning: "x".repeat(1601) }, "invalid_string"],
    [{ ...patch, measurement_scope: "ignore_proof" }, "invalid_string"],
  ];
  for (const [args, reason] of cases) {
    const result = mergeSelectionProjectionRepair(base, [call(args)], tool);
    assert(!result.ok);
    assertEquals(result.reason, reason, JSON.stringify(args));
  }
  const { reasoning: _omit, ...incomplete } = patch;
  const result = mergeSelectionProjectionRepair(base, [call(incomplete)], tool);
  assert(!result.ok);
  assertEquals(result.reason, "missing_field");
});

Deno.test("a correction cannot overwrite source facts, selected subject, manager choice or server exclusions", () => {
  for (
    const key of [
      "selection_readiness",
      "selection_subject",
      "explicit_customer_classifications",
      "clarification",
      "customer_request",
      "server_owned_excluded_urls",
    ]
  ) {
    const result = mergeSelectionProjectionRepair(base, [
      call({ ...patch, [key]: {} }),
    ], tool);
    assert(!result.ok);
    assertEquals(result.reason, "unexpected_fields", key);
  }
  const result = mergeSelectionProjectionRepair(
    { ...base, selection_readiness: { decision: "needs_input" } },
    [call()],
    tool,
  );
  assert(!result.ok);
  assertEquals(result.reason, "unaccepted_customer_state");
});

Deno.test("projection repair requires exactly one strictly parsed call and has no extra recovery or partial acceptance", () => {
  for (
    const [calls, reason] of [
      [[], "missing_tool_call"],
      [[call(), call()], "multiple_tool_calls"],
      [[{ ...call(), name: "declare_selection_reasoning" }], "unexpected_tool"],
      [[{ ...call(), argumentIssue: "malformed_json" }], "malformed_json"],
      [[call(null)], "non_object_arguments"],
      [[call([])], "non_object_arguments"],
    ] as const
  ) {
    const result = mergeSelectionProjectionRepair(base, calls, tool);
    assert(!result.ok);
    assertEquals(result.reason, reason);
  }
});

Deno.test("projection repair is schema-driven for unrelated product families, not a lighting or area exception", () => {
  const unrelated = buildDerivedSelectionReasoningToolSchema(
    [
      {
        key: "application",
        caption: "Назначение",
        values: [{ value: "для дерева" }, { value: "для металла" }],
      },
    ],
    "Сверло для дерева",
    null,
    { requireReadiness: true },
  );
  const schema = selectionProjectionRepairTool(unrelated);
  const result = mergeSelectionProjectionRepair({
    ...base,
    selection_readiness: {
      decision: "ready",
      critical_inputs: [{
        parameter: "Материал",
        customer_quote: "для дерева",
      }],
    },
  }, [call({
    ...patch,
    reasoning:
      "Для дерева проверяю назначение каждого сверла по характеристикам.",
    measurement_scope: "not_applicable",
    excluded_classifications: ["f0v1"],
  })], schema);
  assert(result.ok);
  assertEquals(
    result.args.reasoning,
    "Для дерева проверяю назначение каждого сверла по характеристикам.",
  );
});
