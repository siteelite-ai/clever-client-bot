import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractClientQuantities,
  joinMeasurementEvidenceSegments,
} from "../_shared/v3-tools/criteria-consistency.ts";

// Import the production composer without opening a handler socket or reading
// credentials. The test exercises the same string passed to all three derived
// selection measurement guards.
const originalServe = Deno.serve;
const originalEnvGet = Deno.env.get;
Deno.serve = (() => ({
  finished: Promise.resolve(),
  shutdown() {},
})) as unknown as typeof Deno.serve;
Deno.env.get = (() => undefined) as typeof Deno.env.get;
const { composeModelDeclarationMeasurementEvidence } = await import(
  "./index.ts"
)
  .finally(() => {
    Deno.serve = originalServe;
    Deno.env.get = originalEnvGet;
  });

Deno.test("independent model fields cannot invent a measurement at their boundary", () => {
  const evidence = composeModelDeclarationMeasurementEvidence(
    "Кабель 1,5",
    "А",
  );
  assertEquals(extractClientQuantities(evidence), []);
});

Deno.test("a line break within either model field remains a valid unit separator", () => {
  assertEquals(
    extractClientQuantities(composeModelDeclarationMeasurementEvidence(
      "Номинальный ток 16\nА",
      "Раздел каталога подтверждён",
    )),
    [{ value: 16, unit: "а" }],
  );
  assertEquals(
    extractClientQuantities(composeModelDeclarationMeasurementEvidence(
      "Категория подтверждена",
      "Комната 25\nкв. м",
    )),
    [{ value: 25, unit: "м²" }],
  );
});

Deno.test("facet reasoning fields cannot fabricate a unit across their boundary", () => {
  const declaredReasoning = joinMeasurementEvidenceSegments([
    "Текущий запрос: кабель",
    "Кабель 1,5",
    "А",
    "Комната 25\nкв. м",
  ]);
  assertEquals(extractClientQuantities(declaredReasoning), [
    { value: 25, unit: "м²" },
  ]);
});
