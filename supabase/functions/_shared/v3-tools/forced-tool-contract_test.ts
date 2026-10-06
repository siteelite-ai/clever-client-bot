import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveDerivedSelectionReasoning } from "./selection-actionability.ts";
import {
  forcedToolAttemptDecision,
  hasRepairableObligationShape,
  validatedForcedToolContract,
} from "./forced-tool-contract.ts";

const forcedName = "declare_selection_reasoning";
const validArgs = {
  reasoning:
    "Для выбора товара сначала нужно подтвердить все обязательные параметры отдельного изделия.",
  mandatory_properties: [],
};
const invalidArgs = {
  reasoning: "Для каждого прибора необходим световой поток не менее 3000 лм.",
  mandatory_properties: [{
    key: "Световой поток",
    op: "min",
    value: 9000,
    unit: "лм",
    scope: "per_product",
    source_span:
      "Для каждого прибора необходим световой поток не менее 3000 лм.",
  }],
};
const validate = (args: Record<string, unknown>) => {
  const resolved = resolveDerivedSelectionReasoning(args, []);
  return resolved?.text.trim() ? resolved : null;
};

Deno.test("forced reasoning rejects HTTP 200 length with an unrelated tool", () => {
  const response = {
    finishReason: "length",
    toolCalls: [{ name: "google:python_interpreter", args: {} }],
  };
  assertEquals(
    validatedForcedToolContract(response, forcedName, validate),
    null,
  );
  assertEquals(forcedToolAttemptDecision(false, 1, 8000), "retry");
  assertEquals(forcedToolAttemptDecision(false, 2, 8000), "unavailable");
});

Deno.test("forced reasoning validates the declaration, not merely its name", () => {
  assertEquals(
    validatedForcedToolContract(
      {
        toolCalls: [{ name: forcedName, args: invalidArgs }],
      },
      forcedName,
      validate,
    ),
    null,
  );
  const selected = validatedForcedToolContract(
    {
      toolCalls: [
        { name: forcedName, args: invalidArgs },
        { name: forcedName, args: validArgs },
      ],
    },
    forcedName,
    validate,
  );
  assertEquals(selected?.call.args, validArgs);
  assertEquals(forcedToolAttemptDecision(Boolean(selected), 1, null), "accept");
});

Deno.test("forced reasoning cannot retry with no budget or malformed arguments", () => {
  assertEquals(forcedToolAttemptDecision(false, 1, null), "unavailable");
  assertEquals(
    validatedForcedToolContract(
      {
        toolCalls: [{ name: forcedName, args: null }],
      },
      forcedName,
      validate,
    ),
    null,
  );
  assertEquals(
    validatedForcedToolContract(
      {
        toolCalls: [{
          name: forcedName,
          args: { reasoning: { broken: true } },
        }],
      },
      forcedName,
      () => {
        throw new Error("bad provider args");
      },
    ),
    null,
  );
});

Deno.test("missing or malformed original obligation lists use a fresh forced-tool retry", () => {
  const complete = {
    reasoning: "Обязателен номинальный ток 16 А.",
    mandatory_properties: [{
      key: "Номинальный ток",
      op: "eq",
      value: 16,
      unit: "А",
      scope: "per_product",
      source_span: "Обязателен номинальный ток 16 А.",
    }],
  };
  assertEquals(hasRepairableObligationShape(complete), true);
  for (const invalid of [
    null,
    { reasoning: complete.reasoning },
    { reasoning: complete.reasoning, mandatory_properties: [] },
    { reasoning: complete.reasoning, mandatory_properties: "bad" },
    { ...complete, mandatory_properties: [{ key: "Номинальный ток" }] },
  ]) {
    assertEquals(hasRepairableObligationShape(invalid), false);
  }
  // The backup may still recover the request with a complete independent
  // declaration; a missing primary list must never force same-list repair.
  assertEquals(Boolean(validatedForcedToolContract(
    { toolCalls: [{ name: forcedName, args: complete }] },
    forcedName,
    validate,
  )), true);
});
