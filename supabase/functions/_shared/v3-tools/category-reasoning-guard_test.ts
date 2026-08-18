import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  groundedCategoryRecoveryQueries,
  groundedTokenRecoveryQueries,
  guardCategoryScopeByReasoning,
  selectGroundedTokenRecoveryCandidate,
} from "./category-reasoning-guard.ts";

const discovered = {
  category: { pagetitle: "Светильники" },
  leaf_categories: [
    { pagetitle: "Уличные светильники" },
    { pagetitle: "Бытовые светильники накладные" },
  ],
};

Deno.test("category reasoning guard drops a real but unsupported sibling leaf", () => {
  const result = guardCategoryScopeByReasoning(
    { mode: "by_filter", category_in: ["Уличные светильники"], options: { mounting: ["Накладной"] } },
    discovered,
    "Подбираю бытовой накладной светильник для дома, внутри помещения.",
  );
  assertEquals(result.args, { mode: "by_filter", options: { mounting: ["Накладной"] } });
  assertEquals(result.dropped, [{ category: "Уличные светильники", reason: "not_declared_in_reasoning" }]);
});

Deno.test("category reasoning guard keeps a morphologically supported leaf", () => {
  const result = guardCategoryScopeByReasoning(
    { mode: "by_filter", category_in: ["Бытовые светильники накладные"] },
    discovered,
    "Нужен бытовой накладной светильник.",
  );
  assertEquals(result.args, { mode: "by_filter", category_in: ["Бытовые светильники накладные"] });
  assertEquals(result.kept, ["Бытовые светильники накладные"]);
  assertEquals(result.dropped, []);
});

Deno.test("category reasoning guard preserves supported leaves and removes unsupported ones", () => {
  const result = guardCategoryScopeByReasoning(
    { mode: "by_filter", category_in: ["Уличные светильники", "Бытовые светильники накладные"] },
    discovered,
    "Ищу бытовой накладной светильник.",
  );
  assertEquals(result.args, { mode: "by_filter", category: "Бытовые светильники накладные" });
});

Deno.test("category reasoning guard does not accept a wrong modifier through a shared feature", () => {
  const result = guardCategoryScopeByReasoning(
    { mode: "by_filter", category_in: ["Уличные светильники с датчиком движения"] },
    {
      category: { pagetitle: "Светильники" },
      leaf_categories: [{ pagetitle: "Уличные светильники с датчиком движения" }],
    },
    "Нужен светильник с датчиком движения для дома, внутри помещения.",
  );
  assertEquals(result.args, { mode: "by_filter" });
});

Deno.test("terminal category retry uses only leaves grounded in the reasoning", () => {
  const queries = groundedCategoryRecoveryQueries({
    category: { pagetitle: "Светотехника" },
    leaf_categories: [
      { pagetitle: "Люстры" },
      { pagetitle: "Уличные светильники" },
    ],
  }, "Ищу современную люстру для зала.");
  assertEquals(queries, ["Люстры"]);
});

Deno.test("terminal token ladder decomposes a failed semantic phrase", () => {
  assertEquals(groundedTokenRecoveryQueries("современные люстры"), ["современные", "люстры"]);
});

Deno.test("token recovery keeps the consultant's selective title token and rejects a broad substitute", () => {
  const selected = selectGroundedTokenRecoveryCandidate([
    { query: "canonical-form", total: 25 },
    { query: "generic-type", total: 410 },
  ], 703);
  assertEquals(selected, { query: "canonical-form", total: 25 });
  assertEquals(selectGroundedTokenRecoveryCandidate([
    { query: "generic-a", total: 180 },
    { query: "generic-b", total: 410 },
  ], 703), null);
});
