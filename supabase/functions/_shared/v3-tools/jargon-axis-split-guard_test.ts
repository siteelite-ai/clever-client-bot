import { filterProductIdsByNamedSeries } from "./category-reasoning-guard.ts";
import {
  type ActiveNamedSeriesSectionScope,
  productMatchesActiveSection,
} from "./active-selection-scope.ts";
import { guardJargonAxisSplitSections } from "./jargon-axis-split-guard.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const gallantScope: ActiveNamedSeriesSectionScope = {
  kind: "named_series_section",
  entity: "Gallant",
  leaf: "Розетки",
  source_slot_id: "gallant-chip",
};
const products = new Map([
  ["g-base", { pagetitle: "Розетка Gallant CORN", leaf_category: "Розетки" }],
  ["s-base", { pagetitle: "Розетка Schneider CORN", leaf_category: "Розетки" }],
  ["g-axis", {
    pagetitle: "Розетка Gallant двойная",
    leaf_category: "Розетки",
  }],
  ["s-axis", {
    pagetitle: "Розетка Schneider двойная",
    leaf_category: "Розетки",
  }],
  ["g-other-leaf", {
    pagetitle: "Выключатель Gallant двойной",
    leaf_category: "Выключатели",
  }],
]);

const finalCardGuard = (ids: string[]): string[] =>
  filterProductIdsByNamedSeries(
    ids.filter((id) =>
      productMatchesActiveSection(
        products.get(id)?.leaf_category,
        gallantScope,
      )
    ),
    products,
    gallantScope.entity,
  );

Deno.test("Gallant split may emit only the active section and named series", () => {
  const guarded = guardJargonAxisSplitSections([
    { label: "CORN", ids: ["s-base", "g-base"], total: 22 },
    {
      label: "двойная",
      ids: ["s-axis", "g-other-leaf", "g-axis"],
      total: 57,
    },
  ], finalCardGuard);
  assertEquals(guarded?.map((section) => section.ids), [
    ["g-base"],
    ["g-axis"],
  ]);
});

Deno.test("a scoped split fails closed if any independent segment has no safe card", () => {
  assertEquals(
    guardJargonAxisSplitSections([
      { label: "CORN", ids: ["g-base"], total: 1 },
      { label: "двойная", ids: ["s-axis", "g-other-leaf"], total: 2 },
    ], finalCardGuard),
    null,
  );
  assertEquals(
    guardJargonAxisSplitSections([
      { label: "CORN", ids: ["s-base"], total: 1 },
      { label: "двойная", ids: ["g-axis"], total: 1 },
    ], finalCardGuard),
    null,
  );
});

Deno.test("a different current-turn entity cannot replace the Gallant scope", () => {
  const scopeAndCurrentEntityGuard = (ids: string[]): string[] =>
    filterProductIdsByNamedSeries(
      finalCardGuard(ids),
      products,
      "Schneider",
    );
  assertEquals(
    guardJargonAxisSplitSections([
      { label: "CORN", ids: ["g-base", "s-base"], total: 2 },
      { label: "двойная", ids: ["g-axis", "s-axis"], total: 2 },
    ], scopeAndCurrentEntityGuard),
    null,
  );
});

Deno.test("split guard cannot introduce a card absent from its original segment", () => {
  assertEquals(
    guardJargonAxisSplitSections([
      { label: "base", ids: ["g-base"], total: 1 },
      { label: "axis", ids: ["g-axis"], total: 1 },
    ], (ids) => [...ids, "s-axis"]),
    null,
  );
});
