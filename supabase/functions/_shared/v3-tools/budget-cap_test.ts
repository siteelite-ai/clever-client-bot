import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  enforceBudgetCapOnSelectionSearch,
  extractBudgetCap,
} from "./budget-cap.ts";

Deno.test("budget ceiling recognizes Cyrillic and symbol currency endings", () => {
  assertEquals(extractBudgetCap("по цене не дороже 1000 тг"), 1000);
  assertEquals(extractBudgetCap("бюджет до 12 500 тенге"), 12_500);
  assertEquals(extractBudgetCap("максимум 900 ₸, включая налог"), 900);
  assertEquals(extractBudgetCap("не более 4000тенге"), 4000);
});

Deno.test("an ordinary price mention is not a ceiling", () => {
  assertEquals(extractBudgetCap("цена товара 1000 тг"), null);
});

Deno.test("budget ceiling is applied before materializing selection candidates", () => {
  assertEquals(
    enforceBudgetCapOnSelectionSearch(
      "Дай несколько светильников не более 4000тенге",
      { mode: "by_filter", options: { sensor: ["да"] }, per_page: 50 },
    ),
    {
      mode: "by_filter",
      options: { sensor: ["да"] },
      per_page: 50,
      max_price: 4000,
    },
  );
  assertEquals(
    enforceBudgetCapOnSelectionSearch(
      "подбери варианты до 4000 тенге",
      { mode: "by_query", query: "светильник", max_price: 3500 },
    ),
    { mode: "by_query", query: "светильник", max_price: 3500 },
  );
});

Deno.test("budget retrieval guard does not hide an exact named product", () => {
  const exact = { mode: "by_article", article: "ABC-1" };
  assertEquals(
    enforceBudgetCapOnSelectionSearch("до 4000 тенге", exact),
    exact,
  );
});
