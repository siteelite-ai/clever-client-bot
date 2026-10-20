import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  type Criterion,
  extendSelectionCriteriaPlan,
} from "./criteria-gate.ts";
import { filterFinalCardsByMandatoryFacetEvidence } from "./final-card-facet-gate.ts";
import type { ProductFull } from "./types.ts";

function card(
  id: string,
  title: string,
  traits: string[] = [],
): ProductFull {
  return {
    id,
    pagetitle: title,
    vendor: null,
    price: 100,
    stock: "in_stock",
    short_traits: traits,
    url: `https://example.test/${id}`,
  };
}

const kind: Criterion = {
  key: "Вид изделия",
  op: "eq",
  value: "силовой",
  evidence: "user_explicit",
  level: "A",
};
const color: Criterion = {
  key: "Цвет",
  op: "eq",
  value: "черный",
  evidence: "derived_required",
  level: "A",
};
const facets = [{
  key: "item_kind",
  caption: "Вид изделия",
  values: [{ value: "силовой" }, { value: "сетевой" }],
}];

Deno.test("final-card guard reapplies a frozen mandatory facet after recovery", () => {
  const plan = extendSelectionCriteriaPlan(
    null,
    [kind, color],
    "guarded_search",
  );
  const valid = card("valid", "Изделие А", [
    "Вид изделия: силовой",
    "Цвет: черный",
  ]);
  const recoveredSibling = card("sibling", "Изделие Б", [
    "Вид изделия: сетевой",
    "Цвет: черный",
  ]);
  const report = filterFinalCardsByMandatoryFacetEvidence(
    [valid, recoveredSibling],
    plan.mandatory_criteria,
    facets,
  );
  assertEquals(report.products.map(({ id }) => id), ["valid"]);
  assertEquals(report.rejected, [{
    id: "sibling",
    key: "Вид изделия",
    actual: "сетевой",
    source: "card_trait",
  }]);
});

Deno.test("final-card guard checks complete catalog facets when compact traits are absent", () => {
  const valid = card("valid", "Изделие А");
  valid.facet_values = { item_kind: ["силовой"] };
  valid.facet_captions = { item_kind: "Вид изделия" };
  const sibling = card("sibling", "Изделие Б");
  sibling.facet_values = { item_kind: ["сетевой"] };
  sibling.facet_captions = { item_kind: "Вид изделия" };
  const report = filterFinalCardsByMandatoryFacetEvidence(
    [valid, sibling],
    [kind],
    facets,
  );
  assertEquals(report.products.map(({ id }) => id), ["valid"]);
  assertEquals(report.rejected, [{
    id: "sibling",
    key: "Вид изделия",
    actual: "сетевой",
    source: "catalog_facet",
  }]);
});

Deno.test("final-card guard prefers explicit contradiction over a stale compact trait", () => {
  const stale = card("stale", "Изделие А", ["Вид изделия: силовой"]);
  stale.facet_values = { item_kind: ["сетевой"] };
  stale.facet_captions = { item_kind: "Вид изделия" };
  const report = filterFinalCardsByMandatoryFacetEvidence(
    [stale],
    [kind],
    facets,
  );
  assertEquals(report.products, []);
  assertEquals(report.rejected[0]?.source, "catalog_facet");
});

Deno.test("final-card guard uses the live facet caption when card caption is absent", () => {
  const sparse = card("sparse", "Изделие А");
  sparse.facet_values = { item_kind: ["сетевой"] };
  const report = filterFinalCardsByMandatoryFacetEvidence(
    [sparse],
    [kind],
    facets,
  );
  assertEquals(report.products, []);
  assertEquals(report.rejected[0]?.source, "catalog_facet");
});

Deno.test("final-card guard does not invent a mismatch from missing or unrelated traits", () => {
  const sparse = card("sparse", "Изделие А", ["Цвет корпуса: белый"]);
  const captionConflict = card("caption", "Изделие Б");
  captionConflict.facet_values = { item_kind: ["сетевой"] };
  captionConflict.facet_captions = { item_kind: "Вид упаковки" };
  const report = filterFinalCardsByMandatoryFacetEvidence(
    [sparse, captionConflict],
    [kind],
    facets,
  );
  assertEquals(report.products.map(({ id }) => id), ["sparse", "caption"]);
  assertEquals(report.rejected, []);
});

Deno.test("final-card guard preserves OR values and rejects a visible sibling title", () => {
  const alternate: Criterion = { ...kind, value: "сетевой" };
  const validAlternative = card("alternative", "Изделие А", [
    "Вид изделия: сетевой",
  ]);
  const contradictoryTitle = card("title", "Сетевой модуль", [
    "Вид изделия: силовой",
  ]);
  const report = filterFinalCardsByMandatoryFacetEvidence(
    [validAlternative, contradictoryTitle],
    [kind, alternate],
    facets,
  );
  assertEquals(report.products.map(({ id }) => id), ["alternative", "title"]);

  const strict = filterFinalCardsByMandatoryFacetEvidence(
    [contradictoryTitle],
    [kind],
    facets,
  );
  assertEquals(strict.products, []);
  assertEquals(strict.rejected[0]?.source, "visible_title");
});

Deno.test("final-card guard keeps first-class price and advisory criteria separate", () => {
  const under = card("under", "Изделие А");
  const over = card("over", "Изделие Б");
  over.price = 600;
  const report = filterFinalCardsByMandatoryFacetEvidence(
    [under, over],
    [{
      key: "Цена",
      op: "max",
      value: 500,
      evidence: "user_explicit",
    }, {
      key: "Материал",
      op: "eq",
      value: "металл",
      level: "B",
      evidence: "model_assumption",
    }],
  );
  assertEquals(report.products.map(({ id }) => id), ["under"]);
  assertEquals(report.rejected[0]?.source, "other_card_evidence");
});
