import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { compileToolArrayBounds } from "./tool-array-bounds.ts";
import { buildDerivedSelectionReasoningToolSchema } from "./selection-actionability.ts";
import { structuredMeasurementTool } from "./structured-measurement-declaration.ts";

const tool = (parameters: Record<string, unknown>) => ({
  function: { parameters },
});
Deno.test("wire array bounds: canonical remains immutable; types, required fields and live enums are preserved", () => {
  const canonical = buildDerivedSelectionReasoningToolSchema(
    [{
      key: "item_kind",
      caption: "Тип изделия",
      values: [{ value: "крепление" }, { value: "зажим" }],
    }],
    "Подбери крепление",
    null,
    { requireReadiness: true, requireSubject: true },
  );
  const before = JSON.stringify(canonical);
  const compiled = compileToolArrayBounds(canonical);
  assertEquals(JSON.stringify(canonical), before);
  assertEquals(compiled.deferredCount, 6);
  const original = canonical.function.parameters.properties as Record<
    string,
    any
  >;
  const wire = compiled.tool.function.parameters.properties as Record<
    string,
    any
  >;
  assertEquals(wire.selection_subject, original.selection_subject);
  assertEquals(
    wire.required_facet_values.items,
    original.required_facet_values.items,
  );
  assertEquals(
    wire.explicit_customer_classifications.items,
    original.explicit_customer_classifications.items,
  );
  assertEquals(wire.reasoning, original.reasoning);
  assertEquals(
    compiled.tool.function.parameters.required,
    canonical.function.parameters.required,
  );
  assertEquals(compiled.tool.function.parameters.additionalProperties, false);
  assert(!JSON.stringify(compiled.tool).includes('"maxItems"'));
  assert(!JSON.stringify(compiled.tool).includes('"minItems"'));
  assert(
    wire.selection_readiness.properties.critical_inputs.description.includes(
      "0..8",
    ),
  );
});

Deno.test("wire array bounds: exact edges pass; over-limit declarations are rejected whole without truncation", () => {
  const canonical = buildDerivedSelectionReasoningToolSchema([], "", null, {
    requireReadiness: true,
  });
  const { validate } = compileToolArrayBounds(canonical);
  const value = {
    selection_readiness: { critical_inputs: Array(8).fill({}) },
    compatible_classifications: Array(6).fill("f1v0"),
  };
  assertEquals(validate(value), null);
  value.selection_readiness.critical_inputs.push({});
  assertEquals(validate(value), {
    path: "selection_readiness.critical_inputs",
    reason: "maxItems",
  });
  assertEquals(value.selection_readiness.critical_inputs.length, 9);
  delete (value as any).selection_readiness;
  value.compatible_classifications.push("f1v0");
  assertEquals(validate(value), {
    path: "compatible_classifications",
    reason: "maxItems",
  });
  assertEquals(value.compatible_classifications.length, 7);
});

Deno.test("wire array bounds: nested arrays and minimum bounds are enforced server-side", () => {
  const compiled = compileToolArrayBounds(
    tool({
      type: "object",
      properties: {
        rows: {
          type: "array",
          maxItems: 2,
          items: {
            type: "object",
            properties: {
              values: {
                type: "array",
                minItems: 1,
                maxItems: 2,
                items: { type: "string" },
              },
            },
          },
        },
      },
    }),
  );
  assertEquals(compiled.validate({ rows: [{ values: ["a"] }] }), null);
  assertEquals(compiled.validate({ rows: [{ values: [] }] }), {
    path: "rows.*.values",
    reason: "minItems",
  });
  assertEquals(compiled.validate({ rows: [{ values: ["a", "b", "c"] }] }), {
    path: "rows.*.values",
    reason: "maxItems",
  });
  assertEquals(compiled.validate({ rows: "wrong" }), {
    path: "rows",
    reason: "array_type",
  });
  // Optional missing fields are still decided by the existing semantic guards.
  assertEquals(compiled.validate({}), null);
});

Deno.test("wire array bounds: atomic measurement adapter shares the same transport and cannot drop its ninth safety obligation", () => {
  const canonical = structuredMeasurementTool(
    buildDerivedSelectionReasoningToolSchema([], "", null, {
      requireReadiness: true,
    }),
  );
  const compiled = compileToolArrayBounds(canonical);
  assertEquals(compiled.deferredCount, 7);
  assertEquals(
    compiled.validate({
      product_requirements: Array(8).fill("Требование безопасности"),
    }),
    null,
  );
  assertEquals(
    compiled.validate({
      product_requirements: Array(9).fill("Требование безопасности"),
    }),
    { path: "product_requirements", reason: "maxItems" },
  );
});

Deno.test("wire array bounds: unsupported unions/refs fail closed instead of silently losing a bound", () => {
  for (
    const schema of [
      { anyOf: [{ type: "array", maxItems: 1 }] },
      { $ref: "#/rows" },
      { type: ["array", "null"], maxItems: 1 },
      { type: "array", maxItems: -1 },
      { type: "object", additionalProperties: { type: "array", maxItems: 1 } },
    ]
  ) assertThrows(() => compileToolArrayBounds(tool(schema)));
});
