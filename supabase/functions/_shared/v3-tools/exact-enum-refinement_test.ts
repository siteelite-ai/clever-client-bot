import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type CriteriaFacet,
  type Criterion,
  projectCriteriaFacetOptions,
} from "./criteria-gate.ts";
import {
  classifyConversationBoundaryLocally,
  isEllipticalAttributeFollowup,
} from "./conversation-boundary.ts";
import { isIndependentNominalRequestOutsideActiveScope } from "./active-selection-scope.ts";
import { filterFinalCardsByMandatoryFacetEvidence } from "./final-card-facet-gate.ts";
import type { ProductFull } from "./types.ts";
import {
  compileDialogueCountRequirements,
  productSupportsVisibleRequestContract,
} from "./visible-request-contract.ts";

const criterion = (key: string, value: string): Criterion => ({
  key,
  value,
  op: "eq",
  level: "A",
  evidence: "user_explicit",
});
const facets: CriteriaFacet[] = [{
  key: "color",
  caption: "Цвет",
  unit: null,
  values: [
    "серый",
    "серебристый",
    "серебряный рифленый",
    "черный с серебром",
    "черный",
    "белый",
  ].map((value) => ({ value })),
}];

Deno.test("an exact live enum cannot fan out into similar roots or composite choices", () => {
  assertEquals(
    projectCriteriaFacetOptions([criterion("Цвет", "серебристый")], facets)
      .options,
    { color: ["серебристый"] },
  );
  assertEquals(
    projectCriteriaFacetOptions([criterion("Цвет", "черный")], facets).options,
    { color: ["черный"] },
  );
  assertEquals(
    projectCriteriaFacetOptions([
      criterion("Цвет", "серебристый"),
      criterion("Цвет", "белый"),
    ], facets).options,
    { color: ["серебристый", "белый"] },
  );
  const material = [{
    key: "material",
    caption: "Материал",
    unit: null,
    values: ["сталь", "нержавеющая сталь", "сталь с пластиком"].map(
      (value) => ({ value }),
    ),
  }];
  assertEquals(
    projectCriteriaFacetOptions([criterion("Материал", "сталь")], material)
      .options,
    { material: ["сталь"] },
  );
});

Deno.test("final card evidence must respect the exact live enum even when the API ignores a filter", () => {
  const products = ["серебристый", "серый", "черный с серебром"].map((
    value,
    index,
  ) => ({
    id: String(index),
    pagetitle: `Изделие ${index}`,
    url: `https://example.invalid/${index}`,
    vendor: null,
    price: 100,
    stock: "in_stock",
    short_traits: [`Цвет: ${value}`],
    facet_values: { color: [value] },
    facet_captions: { color: "Цвет" },
  } as ProductFull));
  assertEquals(
    filterFinalCardsByMandatoryFacetEvidence(products, [
      criterion("Цвет", "серебристый"),
    ], facets)
      .products.map((p) => p.id),
    ["0"],
  );
});

Deno.test("labelled multiword attributes are dependent refinements, not product requests", () => {
  const scope = {
    kind: "named_series_section" as const,
    entity: "Gallant",
    leaf: "Розетки",
    source_slot_id: "server-slot",
  };
  for (
    const message of [
      "Мне нужен цвет слоновой кости",
      "Цвет: слоновая кость",
      "Покажи цвет мокрый асфальт",
      "Нужен материал нержавеющая сталь",
      "Форма: прямоугольная",
      "Тип монтажа: скрытый",
    ]
  ) {
    assertEquals(isEllipticalAttributeFollowup(message), true, message);
    assertEquals(
      classifyConversationBoundaryLocally(message)?.mode,
      "continuation",
      message,
    );
    assertEquals(
      isIndependentNominalRequestOutsideActiveScope(message, scope),
      false,
      message,
    );
  }
  for (
    const message of [
      "Мне нужен кабель цвета слоновой кости",
      "Новая тема: мне нужен цвет слоновой кости",
      "Мне нужен цвет слоновой кости и найди кабель",
      "Мне нужен бренд Другой",
      "Мне нужна серия Другая",
      "Мне нужен цвет слоновой кости. Покажи кабель",
    ]
  ) {
    assertEquals(isEllipticalAttributeFollowup(message), false, message);
  }
});

Deno.test("a count survives intermediate color changes, but a new explicit count replaces it", () => {
  const prior = ["Нужны двойные", "Покажи розетки Gallant"];
  const context = { productClass: "Розетки", taxonomyClass: "Розетки" };
  const state = compileDialogueCountRequirements(
    prior,
    "Мне нужен цвет слоновой кости",
    context,
  );
  assertEquals(state.map((r) => r.value), [2]);
  assertEquals(
    productSupportsVisibleRequestContract({
      pagetitle: "Розетка двойная Gallant",
    }, state),
    true,
  );
  assertEquals(
    productSupportsVisibleRequestContract({
      pagetitle: "Розетка одинарная Gallant",
    }, state),
    false,
  );
  const single = compileDialogueCountRequirements(
    prior,
    "Нужны одинарные",
    context,
  );
  assertEquals(single.map((r) => r.value), [1]);
  assertEquals(
    productSupportsVisibleRequestContract({
      pagetitle: "Розетка одинарная",
      short_traits: ["Количество разъемов: 2"],
    }, single),
    false,
  );
  assertEquals(
    compileDialogueCountRequirements(prior, "Нужно 3 места", context).map((r) =>
      r.value
    ),
    [3],
  );
  assertEquals(
    compileDialogueCountRequirements(prior, "Мне нужен цвет слоновой кости", {})
      .length,
    0,
  );
});
