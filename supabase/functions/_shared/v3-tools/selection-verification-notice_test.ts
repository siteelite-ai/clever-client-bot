import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  measurementFailureUnits,
  selectionVerificationNotice,
} from "./selection-verification-notice.ts";

Deno.test("a later unprojected clause never borrows voltage from the sole-current checker", () => {
  const singleRelation = {
    code: "unprojected_measured_requirement" as const,
    clause_index: 2,
    quantities: [{ value: 380, unit: "в", matches_customer_quantity: true }],
  };
  const conjunction = {
    code: "unprojected_measured_clause" as const,
    clause_index: 3,
    clause_quantities: [],
    operating_domains_resolved: 1,
    operating_domains_projected: 1,
    operating_domains_unresolved: 0,
  };
  assertEquals(
    measurementFailureUnits({
      failed: true,
      structuredConjunction: true,
      singleRelation,
      conjunction,
    }),
    [],
  );
  const notice = selectionVerificationNotice({
    customerInputsAccepted: true,
    uncoveredUnits: measurementFailureUnits({
      failed: true,
      structuredConjunction: true,
      singleRelation,
      conjunction,
    }),
  });
  assert(!notice.includes("напряжение"));
  assert(notice.includes("исходные данные учтены"));
  assert(notice.includes("Не удалось подтвердить пригодность"));
});

Deno.test("complete-contract attribution reports only the actually failing measurement and clears stale success", () => {
  const singleRelation = {
    code: "unprojected_measured_requirement" as const,
    quantities: [{ unit: "в", value: 380, matches_customer_quantity: true }],
  };
  const conjunction = {
    code: "unprojected_measured_clause" as const,
    clause_quantities: [{
      unit: "мм",
      value: 12,
      matches_customer_quantity: true,
    }],
    operating_domains_resolved: 1,
    operating_domains_projected: 1,
    operating_domains_unresolved: 0,
  };
  assertEquals(
    measurementFailureUnits({
      failed: true,
      structuredConjunction: true,
      singleRelation,
      conjunction,
    }),
    ["мм"],
  );
  assertEquals(
    measurementFailureUnits({
      failed: true,
      structuredConjunction: true,
      singleRelation,
    }),
    [],
  );
  assertEquals(
    measurementFailureUnits({
      failed: true,
      structuredConjunction: true,
      singleRelation,
      conjunction: { ...conjunction, code: "covered" },
    }),
    [],
  );
  assertEquals(
    measurementFailureUnits({
      failed: false,
      structuredConjunction: true,
      singleRelation,
      conjunction,
    }),
    [],
  );
  assertEquals(
    measurementFailureUnits({
      failed: true,
      structuredConjunction: false,
      singleRelation,
    }),
    ["в"],
  );
});

Deno.test("a catalog proof gap does not ask the customer to repeat accepted inputs", () => {
  const result = selectionVerificationNotice({
    customerInputsAccepted: true,
    uncoveredUnits: ["в", "В"],
    managerPhone: "+77762206220",
  });
  assert(result.includes("исходные данные учтены"));
  assert(result.includes("напряжение"));
  assertEquals(result.match(/напряжение/gu)?.length, 1);
  assert(result.includes("+77762206220"));
  assert(!/уточните|повторите|укажите|не найден/iu.test(result));
});

Deno.test("a malformed declaration does not claim the inputs or product fit were verified", () => {
  const result = selectionVerificationNotice({
    customerInputsAccepted: false,
    uncoveredUnits: ["<untrusted>"],
    managerPhone: "https://evil.invalid",
  });
  assert(!result.includes("исходные данные учтены"));
  assert(!result.includes("<untrusted>"));
  assert(!result.includes("evil"));
  assert(result.includes("страницу контактов"));
});
