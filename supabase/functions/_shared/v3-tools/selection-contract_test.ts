import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { verifySelectionTarget } from "./selection-contract.ts";
import type { ProductRef } from "./types.ts";

function product(id: string, title: string, leaf = ""): ProductRef {
  return { id, pagetitle: title, leaf_category: leaf, vendor: null, price: 1, stock: "in_stock", short_traits: [] };
}

Deno.test("selection target blocks a sibling class even when it serves a related task", () => {
  const report = verifySelectionTarget("источник бесперебойного питания ИБП", [
    product("ups", "ИБП с чистой синусоидой 600 ВА", "Источники бесперебойного питания"),
    product("ats", "Автоматический ввод резерва CHINT NXZM ATS", "Автоматические переключатели"),
  ]);
  assertEquals(report.passed_ids, ["ups"]);
  assertEquals(report.rejected_ids, ["ats"]);
});

Deno.test("selection target carries use context into evidence verification", () => {
  const report = verifySelectionTarget("светодиодный светильник для гостиной", [
    product("indoor", "Светодиодный светильник для гостиной", "Интерьерное освещение"),
    product("street", "Светодиодный светильник Avenue IP65", "Уличное освещение"),
  ]);
  assertEquals(report.passed_ids, ["indoor"]);
  assertEquals(report.rejected_ids, ["street"]);
});

Deno.test("selection target accepts inflected Russian catalog evidence", () => {
  const report = verifySelectionTarget("термоусадочная трубка", [
    product("ttu", "Набор трубок термоусадочных ТТУ 12/6"),
  ]);
  assertEquals(report.passed_ids, ["ttu"]);
});

