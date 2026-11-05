import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { selectionVerificationNotice } from "./selection-verification-notice.ts";

Deno.test("a catalog proof gap does not ask the customer to repeat accepted inputs", () => {
  const result = selectionVerificationNotice({ customerInputsAccepted: true, uncoveredUnits: ["в", "В"], managerPhone: "+77762206220" });
  assert(result.includes("исходные данные учтены"));
  assert(result.includes("напряжение"));
  assertEquals(result.match(/напряжение/gu)?.length, 1);
  assert(result.includes("+77762206220"));
  assert(!/уточните|повторите|укажите|не найден/iu.test(result));
});

Deno.test("a malformed declaration does not claim the inputs or product fit were verified", () => {
  const result = selectionVerificationNotice({ customerInputsAccepted: false, uncoveredUnits: ["<untrusted>"], managerPhone: "https://evil.invalid" });
  assert(!result.includes("исходные данные учтены"));
  assert(!result.includes("<untrusted>"));
  assert(!result.includes("evil"));
  assert(result.includes("страницу контактов"));
});
