import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extractBudgetCap } from "./budget-cap.ts";

Deno.test("budget ceiling recognizes Cyrillic and symbol currency endings", () => {
  assertEquals(extractBudgetCap("по цене не дороже 1000 тг"), 1000);
  assertEquals(extractBudgetCap("бюджет до 12 500 тенге"), 12_500);
  assertEquals(extractBudgetCap("максимум 900 ₸, включая налог"), 900);
});

Deno.test("an ordinary price mention is not a ceiling", () => {
  assertEquals(extractBudgetCap("цена товара 1000 тг"), null);
});
