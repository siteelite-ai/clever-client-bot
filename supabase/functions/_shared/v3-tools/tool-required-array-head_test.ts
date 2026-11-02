import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { compileToolRequiredArrayHead } from "./tool-required-array-head.ts";
import { compileToolArrayBounds } from "./tool-array-bounds.ts";
const canonical = {
  function: {
    parameters: {
      type: "object",
      properties: {
        state: {
          type: "object",
          properties: {
            inputs: {
              type: "array",
              maxItems: 2,
              items: {
                type: "object",
                properties: { quote: { type: "string" } },
                required: ["quote"],
                additionalProperties: false,
              },
            },
          },
          required: ["inputs"],
        },
      },
    },
  },
};
const compile = () =>
  compileToolRequiredArrayHead(canonical, ["state", "inputs"]);
Deno.test("required array head preserves canonical schema and decodes first plus every remaining input", () => {
  const before = JSON.stringify(canonical), c = compile();
  const args = {
    state: {
      decision: "ready",
      inputs: { first: { quote: "8 мм" }, rest: [{ quote: "Бетон" }] },
    },
    other: true,
  };
  const snapshot = JSON.stringify(args);
  assertEquals(c.decode(args), {
    state: {
      decision: "ready",
      inputs: [{ quote: "8 мм" }, { quote: "Бетон" }],
    },
    other: true,
  });
  assertEquals(JSON.stringify(canonical), before);
  assertEquals(JSON.stringify(args), snapshot);
  const wire = compileToolArrayBounds(c.tool);
  assertEquals(wire.validate(args), null);
  assertEquals(
    wire.validate({ state: { inputs: { first: {}, rest: [{}, {}] } } }),
    { path: "state.inputs.rest", reason: "maxItems" },
  );
});
Deno.test("required array head rejects missing first, extra fields, wrong types and overflow without slicing", () => {
  const c = compile();
  for (
    const inputs of [
      { rest: [] },
      { first: {}, rest: [], extra: 1 },
      { first: null, rest: [] },
      { first: {}, rest: {} },
      { first: {}, rest: [{}, {}] },
    ]
  ) {
    assertEquals(c.decode({ state: { inputs } }), null);
  }
});
Deno.test("required array head does not bless canonical empty arrays or populate absent state", () => {
  const c = compile();
  assertEquals(c.decode({ state: { inputs: [] } }), { state: { inputs: [] } });
  assertEquals(c.decode({}), {});
  assertEquals(c.decode({ state: null }), null);
  assertThrows(() =>
    compileToolRequiredArrayHead(canonical, ["state", "missing"])
  );
  assertThrows(() => compileToolRequiredArrayHead(canonical, ["__proto__"]));
});
