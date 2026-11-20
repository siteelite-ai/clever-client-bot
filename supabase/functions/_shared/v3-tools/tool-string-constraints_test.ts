import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildDerivedSelectionReasoningToolSchema } from "./selection-actionability.ts";
import { compileToolStringConstraints } from "./tool-string-constraints.ts";
import { compileToolRequiredArrayHead } from "./tool-required-array-head.ts";
import { compileToolArrayBounds } from "./tool-array-bounds.ts";

const facetKey = "fixture_catalog_classification_with_long_key";
const facets = Array.from({ length: 30 }, (_, index) => ({
  key: index === 0 ? facetKey : `fixture_facet_${index}`,
  caption: `Фасет ${index}`,
  values: [],
}));

Deno.test('a narrow correction may retain only bounded server opaque IDs while local enum validation stays mandatory',()=>{
  const ids=Array.from({length:12},(_,i)=>`f0v${i}`);
  const canonical={function:{parameters:{type:'object',properties:{required_facet_values:{type:'array',items:{type:'string',enum:ids}},other:{type:'string',enum:Array.from({length:12},(_,i)=>`public_catalog_label_${i}`)}}}}};
  const primary=compileToolStringConstraints(canonical);
  assert(!('enum' in primary.tool.function.parameters.properties.required_facet_values.items));
  const repair=compileToolStringConstraints(canonical,{retainOpaqueIdEnumPaths:['required_facet_values.*','other']});
  assertEquals(repair.tool.function.parameters.properties.required_facet_values.items.enum,ids);
  assert(!('enum' in repair.tool.function.parameters.properties.other));
  assertEquals(repair.validate({required_facet_values:['f99v99']}),{path:'required_facet_values.*',reason:'enum'});
  assertEquals(repair.validate({required_facet_values:['f0v4']}),null);
  const tooMany={function:{parameters:{type:'string',enum:Array.from({length:161},(_,i)=>`f${Math.floor(i/40)}v${i%40}`)}}};
  assert(!('enum' in compileToolStringConstraints(tooMany,{retainOpaqueIdEnumPaths:['']}).tool.function.parameters));
});

Deno.test("compact declaration defers live enum and lengths, retaining required fields, types and short decisions", () => {
  const canonical = buildDerivedSelectionReasoningToolSchema(
    facets,
    "",
    null,
    { requireReadiness: true, requireSubject: true },
  );
  const before = JSON.stringify(canonical);
  const compiled = compileToolStringConstraints(canonical);
  const withHead = compileToolRequiredArrayHead(compiled.tool, [
    "selection_readiness",
    "critical_inputs",
  ]);
  const wire = compileToolArrayBounds(withHead.tool);
  const wireJson = JSON.stringify(wire.tool);
  assertEquals(JSON.stringify(canonical), before);
  assertEquals(
    wire.tool.function.parameters.required,
    canonical.function.parameters.required,
  );
  assertEquals(wire.tool.function.parameters.additionalProperties, false);
  assert(!wireJson.includes(facetKey));
  assert(!/"(?:minLength|maxLength|minItems|maxItems)":/u.test(wireJson));
  assert(wireJson.includes('"enum":["ready","needs_input"]'));
  assert(
    wireJson.includes('"enum":["per_product","system_total","not_applicable"]'),
  );
  assert(wireJson.includes('"required":["first","rest"]'));
  assert(compiled.deferredCount > 0);
  const previousWire = compileToolArrayBounds(
    compileToolRequiredArrayHead(canonical, [
      "selection_readiness",
      "critical_inputs",
    ]).tool,
  );
  assert(wireJson.length < JSON.stringify(previousWire.tool).length);

  const args = {
    clarification: { facet_key: facetKey },
    selection_subject: null,
  };
  assertEquals(compiled.validate(args), null);
  assertEquals(
    compiled.validate({ clarification: { facet_key: "unlisted" } }),
    {
      path: "clarification.facet_key",
      reason: "enum",
    },
  );
  assertEquals(compiled.validate({ required_facet_values: ["invented"] }), {
    path: "required_facet_values.*",
    reason: "maxLength",
  });
  assertEquals(compiled.validate({ reasoning: "a".repeat(1601) }), {
    path: "reasoning",
    reason: "maxLength",
  });

  const readiness = {
    decision: "ready",
    critical_inputs: {
      first: {
        parameter: "Ток",
        customer_quote: "25 А",
        impact: "",
        question: "",
      },
      rest: [{ parameter: "x", customer_quote: "C", impact: "", question: "" }],
    },
  };
  const raw = { selection_readiness: readiness };
  assertEquals(wire.validate(raw), null);
  assertEquals(compiled.validate(withHead.decode(raw)), {
    path: "selection_readiness.critical_inputs.*.parameter",
    reason: "minLength",
  });
});

Deno.test("compact string validator checks every nested entry without coercing or truncating", () => {
  const tool = {
    function: {
      parameters: {
        type: "object",
        properties: {
          values: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 2 },
          },
          code: { type: "string", enum: ["single_but_very_long_catalog_key"] },
        },
      },
    },
  };
  const { validate } = compileToolStringConstraints(tool);
  assertEquals(
    validate({
      values: ["а", "💡💡"],
      code: "single_but_very_long_catalog_key",
    }),
    null,
  );
  assertEquals(validate({ values: ["а", 1] }), {
    path: "values.*",
    reason: "string_type",
  });
  assertEquals(validate({ values: ["а", ""] }), {
    path: "values.*",
    reason: "minLength",
  });
  assertEquals(validate({ values: ["а", "💡💡💡"] }), {
    path: "values.*",
    reason: "maxLength",
  });
  assertEquals(validate({ code: "forged_id" }), {
    path: "code",
    reason: "enum",
  });
  assertThrows(() =>
    compileToolStringConstraints({
      function: { parameters: { type: "string", minLength: -1 } },
    })
  );
});

Deno.test("compact string validator keeps an independent membership check for each shared schema path", () => {
  for (const count of [0, 10]) {
    const enumValues = Array.from({ length: count }, (_, i) => `f0v${i}`);
    const canonical = buildDerivedSelectionReasoningToolSchema(
      [{
        key: "item_kind",
        caption: "Вид изделия",
        values: enumValues.map((_, i) => ({ value: `Вид крепления ${i + 1}` })),
      }],
      "", null, { requireReadiness: true, requireSubject: true },
    );
    const before = JSON.stringify(canonical);
    const compact = compileToolStringConstraints(canonical);
    const reason = enumValues.length ? "enum" : "maxLength";
    assertEquals(compact.validate({ compatible_classifications: ["bad"] }), {
      path: "compatible_classifications.*", reason,
    });
    assertEquals(compact.validate({ excluded_classifications: ["bad"] }), {
      path: "excluded_classifications.*", reason,
    });
    assertEquals(compact.validate({ explicit_customer_classifications: [{ classification_id: "bad" }] }), {
      path: "explicit_customer_classifications.*.classification_id", reason,
    });
    assertEquals(compact.validate({ excluded_classifications: enumValues }), null);
    assertEquals(JSON.stringify(canonical), before);
  }
});
