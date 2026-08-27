import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  alignCompatibilityRelationsWithReasoning,
  compatibilityRelationsToCriteria,
  completePairedCompatibilityRelations,
  commonCompatibilityReference,
  enforceFinalPairedCompatibility,
  extractSingleMeasuredReference,
  filterProductsByPairedTitleFit,
  hasOppositeCompatibilityDirections,
  mergeCompatibilityCriteria,
  minimumCompatibilityRelationCount,
  parseCompatibilityRelations,
  projectPairedTitleEvidence,
  projectCompatibilityFacetOptions,
  reasoningNeedsCompatibilityRelations,
  subsumeCriteriaProvenByCompatibility,
  subsumeCriteriaProvenByPairedTitleRatio,
  subsumePairedStateCriteria,
  uncoveredReasoningBounds,
} from "./compatibility-contract.ts";
import { applyCriteriaGate } from "./criteria-gate.ts";
import type { ProductRef } from "./types.ts";

function product(id: string, pagetitle: string): ProductRef {
  return { id, pagetitle, vendor: null, price: 1, stock: "in_stock", short_traits: [] };
}

Deno.test("compatibility contract compiles generic strict relations", () => {
  const relations = parseCompatibilityRelations([
    { product_key: "Параметр до установки", relation: "gt", reference_value: 12, unit: "мм", level: "A" },
    { product_key: "Параметр после установки", relation: "lt", reference_value: 12, unit: "мм", level: "A" },
  ]);
  assertEquals(compatibilityRelationsToCriteria(relations), [
    { key: "Параметр до установки", op: "min", value: 12, unit: "мм", level: "A", exclusive: true },
    { key: "Параметр после установки", op: "max", value: 12, unit: "мм", level: "A", exclusive: true },
  ]);
});

Deno.test("strict prose tightens inclusive machine relations", () => {
  const relations = parseCompatibilityRelations([
    { product_key: "Параметр до установки", relation: "gte", reference_value: 10, unit: "мм" },
    { product_key: "Параметр после установки", relation: "lte", reference_value: 10, unit: "мм" },
  ]);
  const aligned = alignCompatibilityRelationsWithReasoning(
    relations,
    "до установки больше 10 мм, после установки меньше 10 мм",
  );
  assertEquals(aligned.relations.map((relation) => relation.relation), ["gt", "lt"]);
  assertEquals(aligned.alignments.length, 2);
  assertEquals(uncoveredReasoningBounds(aligned.relations, "до установки больше 10 мм, после установки меньше 10 мм"), []);
});

Deno.test("qualitative fit reasoning makes boundary relations strict", () => {
  const relations = parseCompatibilityRelations([
    { product_key: "Параметр входа", relation: "gte", reference_value: 12, unit: "мм" },
    { product_key: "Параметр фиксации", relation: "lte", reference_value: 12, unit: "мм" },
  ]);
  const aligned = alignCompatibilityRelationsWithReasoning(
    relations,
    "изделие должно свободно надеваться на объект 12 мм, а затем плотно обжимать его",
  );
  assertEquals(aligned.relations.map((relation) => relation.relation), ["gt", "lt"]);
});

Deno.test("infinitive fit verbs also make inclusive bounds strict", () => {
  const relations = parseCompatibilityRelations([
    { product_key: "Параметр до установки", relation: "gte", reference_value: 12, unit: "мм" },
    { product_key: "Параметр после установки", relation: "lte", reference_value: 12, unit: "мм" },
  ]);
  const aligned = alignCompatibilityRelationsWithReasoning(
    relations,
    "нужно свободно надеть на объект 12 мм, а затем плотно обжать его",
  );
  assertEquals(aligned.relations.map((relation) => relation.relation), ["gt", "lt"]);
});

Deno.test("generic before/after keys repair duplicated machine directions", () => {
  const relations = parseCompatibilityRelations([
    { product_key: "Внутренний размер до преобразования", relation: "gte", reference_value: 12, unit: "мм" },
    { product_key: "Внутренний размер после преобразования", relation: "gte", reference_value: 12, unit: "мм" },
  ]);
  const aligned = alignCompatibilityRelationsWithReasoning(
    relations,
    "изделие должно свободно надеваться на объект 12 мм до преобразования и плотно обжимать его после преобразования",
  );
  assertEquals(aligned.relations.map((relation) => relation.relation), ["gt", "lt"]);
  assertEquals(hasOppositeCompatibilityDirections(aligned.relations), true);
});

Deno.test("missing paired relation is completed only from a unique live state facet", () => {
  const completed = completePairedCompatibilityRelations(
    parseCompatibilityRelations([
      { product_key: "after", relation: "lt", reference_value: 12, unit: "мм" },
    ]),
    "до преобразования нужно свободно надеть на объект 12 мм, после преобразования плотно обжать",
    [
      { key: "before", caption: "Размер до преобразования", unit: "мм", values: [{ value: "16" }] },
      { key: "after", caption: "Размер после преобразования", unit: "мм", values: [{ value: "8" }] },
    ],
    { value: 12, unit: "мм" },
  );
  assertEquals(completed.added, [{
    product_key: "before",
    relation: "gt",
    reference_value: 12,
    unit: "мм",
    level: "A",
  }]);
  assertEquals(hasOppositeCompatibilityDirections(completed.relations), true);
});

Deno.test("missing paired relation stays missing when live state facets are ambiguous", () => {
  const completed = completePairedCompatibilityRelations(
    [],
    "до преобразования нужно свободно надеть на объект 12 мм, после преобразования плотно обжать",
    [
      { key: "before_a", caption: "Размер до преобразования A", unit: "мм", values: [{ value: "16" }] },
      { key: "before_b", caption: "Размер до преобразования B", unit: "мм", values: [{ value: "20" }] },
    ],
    { value: 12, unit: "мм" },
  );
  assertEquals(completed.relations, []);
});

Deno.test("relative equality is resolved from the opposite relation and qualitative fit", () => {
  const relations = parseCompatibilityRelations([
    { product_key: "Параметр входа", relation: "eq", reference_value: 12, unit: "мм" },
    { product_key: "Параметр фиксации", relation: "lte", reference_value: 12, unit: "мм" },
  ]);
  const aligned = alignCompatibilityRelationsWithReasoning(
    relations,
    "изделие должно свободно надеваться на объект 12 мм и плотно обжимать его после установки меньше 12 мм",
  );
  assertEquals(aligned.relations.map((relation) => relation.relation), ["gt", "lt"]);
});

Deno.test("paired states require two independent relations", () => {
  assertEquals(minimumCompatibilityRelationCount("до установки больше 10 мм, после установки плотно фиксируется"), 2);
  assertEquals(minimumCompatibilityRelationCount("должно свободно надеваться на 10 мм и плотно обжимать объект"), 2);
  assertEquals(minimumCompatibilityRelationCount("для объекта 12 мм размер берём чуть больше, чтобы свободно наделся и плотно обожмёт объект"), 2);
  assertEquals(minimumCompatibilityRelationCount("устройство выдерживает нагрузку не менее 250 Вт"), 1);
  assertEquals(minimumCompatibilityRelationCount("мощность товара не менее 40 Вт"), 0);
});

Deno.test("proven pair subsumes only duplicate compatibility criteria", () => {
  const relations = parseCompatibilityRelations([
    { product_key: "Размер до установки", relation: "gt", reference_value: 12, unit: "мм" },
    { product_key: "Размер после установки", relation: "lt", reference_value: 12, unit: "мм" },
  ]);
  assertEquals(subsumeCriteriaProvenByCompatibility([
    { key: "Размер до установки, мм", op: "min", value: 12, unit: "мм" },
    { key: "Материал", op: "eq", value: "медь" },
  ], relations), [{ key: "Материал", op: "eq", value: "медь" }]);
  assertEquals(subsumeCriteriaProvenByCompatibility([
    { key: "Внутренний размер", op: "eq", value: 12, unit: "мм" },
    { key: "Длина", op: "eq", value: 12, unit: "мм" },
    { key: "Материал", op: "eq", value: "медь" },
  ], relations), [
    { key: "Длина", op: "eq", value: 12, unit: "мм" },
    { key: "Материал", op: "eq", value: "медь" },
  ]);
  assertEquals(subsumePairedStateCriteria([
    { key: "Внутренний размер до преобразования", op: "min", value: 12, unit: "мм" },
    { key: "Внутренний размер после преобразования", op: "max", value: 12, unit: "мм" },
    { key: "Материал", op: "eq", value: "медь" },
  ]), [{ key: "Материал", op: "eq", value: "медь" }]);
});

Deno.test("visible paired values arithmetically prove a duplicate ratio criterion", () => {
  const products = [
    product("a", "Generic component 14/7"),
    product("b", "Generic component 16/8"),
  ];
  const result = subsumeCriteriaProvenByPairedTitleRatio([
    { key: "Transformation ratio", op: "eq", value: "2:1", level: "A" },
    { key: "Color", op: "eq", value: "black", level: "A" },
  ], products);
  assertEquals(result.proven, ["Transformation ratio"]);
  assertEquals(result.criteria, [{ key: "Color", op: "eq", value: "black", level: "A" }]);
  assertEquals(result.products.map((item) => item.id), ["a", "b"]);
});

Deno.test("ratio proof narrows a mixed paired pool instead of launching a disjoint search", () => {
  const products = [
    product("a", "Generic component 14/7"),
    product("b", "Generic component 16/4"),
  ];
  const criterion = { key: "Transformation ratio", op: "eq" as const, value: "2 к 1", level: "A" as const };
  const result = subsumeCriteriaProvenByPairedTitleRatio([criterion], products);
  assertEquals(result.criteria, []);
  assertEquals(result.proven, ["Transformation ratio"]);
  assertEquals(result.products.map((item) => item.id), ["a"]);
});

Deno.test("ratio criterion remains mandatory when no paired title proves it", () => {
  const products = [product("a", "Generic component 16/4")];
  const criterion = { key: "Transformation ratio", op: "eq" as const, value: "2 к 1", level: "A" as const };
  const result = subsumeCriteriaProvenByPairedTitleRatio([criterion], products);
  assertEquals(result.criteria, [criterion]);
  assertEquals(result.proven, []);
  assertEquals(result.products.map((item) => item.id), ["a"]);
});

Deno.test("visible A/B title proves a complete generic before/after relation pair", () => {
  const relations = parseCompatibilityRelations([
    { product_key: "Размер до преобразования", relation: "gt", reference_value: 10, unit: "мм" },
    { product_key: "Размер после преобразования", relation: "lt", reference_value: 10, unit: "мм" },
  ]);
  const products: ProductRef[] = [
    { id: "ok", pagetitle: "Изделие 12/6", vendor: null, price: 100, stock: "unknown", short_traits: [] },
    { id: "edge", pagetitle: "Изделие 10/5", vendor: null, price: 100, stock: "unknown", short_traits: [] },
  ];
  const projected = projectPairedTitleEvidence(products, relations);
  const report = applyCriteriaGate(projected, compatibilityRelationsToCriteria(relations));
  assertEquals(report.passed_ids, ["ok"]);
});

Deno.test("title pair is ignored without a complete opposite relation pair", () => {
  const relations = parseCompatibilityRelations([
    { product_key: "Сечение", relation: "gt", reference_value: 1, unit: "мм" },
  ]);
  const products: ProductRef[] = [
    { id: "cable", pagetitle: "Изделие 2/1,5", vendor: null, price: 100, stock: "unknown", short_traits: [] },
  ];
  assertEquals(projectPairedTitleEvidence(products, relations)[0].short_traits, []);
});

Deno.test("paired title fit follows a single user reference without domain vocabulary", () => {
  assertEquals(extractSingleMeasuredReference("подбери изделие для объекта диаметром 12 мм"), { value: 12, unit: "мм" });
  assertEquals(extractSingleMeasuredReference("нужно 12 мм и длина 1 м"), null);
  const products: ProductRef[] = [
    { id: "edge", pagetitle: "Изделие 12/6", vendor: null, price: 100, stock: "unknown", short_traits: [] },
    { id: "ok", pagetitle: "Изделие 13,0/6,5", vendor: null, price: 100, stock: "unknown", short_traits: [] },
    { id: "unknown", pagetitle: "Изделие без пары", vendor: null, price: 100, stock: "unknown", short_traits: [] },
  ];
  const filtered = filterProductsByPairedTitleFit(products, 12);
  assertEquals(filtered.products.map((product) => product.id), ["ok"]);
  assertEquals(filtered.rejected_ids, ["edge"]);
  assertEquals(filtered.unproven_ids, ["unknown"]);
  assertEquals(commonCompatibilityReference(parseCompatibilityRelations([
    { product_key: "A", relation: "gt", reference_value: 12, unit: "мм" },
    { product_key: "B", relation: "lt", reference_value: 12, unit: "мм" },
  ])), { value: 12, unit: "мм" });
});

Deno.test("late catalog recovery cannot overwrite an already proven paired fit", () => {
  const relations = parseCompatibilityRelations([
    { product_key: "Состояние A", relation: "gt", reference_value: 12, unit: "мм" },
    { product_key: "Состояние B", relation: "lt", reference_value: 12, unit: "мм" },
  ]);
  const recovered: ProductRef[] = [
    { id: "too-small", pagetitle: "Изделие 10/5", vendor: null, price: 100, stock: "unknown", short_traits: [] },
    { id: "equal", pagetitle: "Изделие 12/6", vendor: null, price: 100, stock: "unknown", short_traits: [] },
    { id: "valid", pagetitle: "Изделие 14/7", vendor: null, price: 100, stock: "unknown", short_traits: [] },
    { id: "no-proof", pagetitle: "Изделие без пары", vendor: null, price: 100, stock: "unknown", short_traits: [] },
  ];
  const final = enforceFinalPairedCompatibility(
    recovered,
    relations,
    "Изделие должно свободно надеться до преобразования и плотно зафиксироваться после на объекте 12 мм.",
  );
  assertEquals(final.required, true);
  assertEquals(final.products.map((product) => product.id), ["valid"]);
  assertEquals(final.rejected_ids, ["too-small", "equal"]);
  assertEquals(final.unproven_ids, ["no-proof"]);
});

Deno.test("a server-proven reference survives inconsistent model reference fields", () => {
  const relations = parseCompatibilityRelations([
    { product_key: "Состояние A", relation: "gt", reference_value: 12, unit: "мм" },
    { product_key: "Состояние B", relation: "lt", reference_value: 6, unit: "мм" },
  ]);
  const products: ProductRef[] = [
    { id: "invalid", pagetitle: "Изделие 10/5", vendor: null, price: 100, stock: "unknown", short_traits: [] },
    { id: "valid", pagetitle: "Изделие 14/7", vendor: null, price: 100, stock: "unknown", short_traits: [] },
  ];
  const final = enforceFinalPairedCompatibility(
    products,
    relations,
    "До преобразования изделие должно свободно надеться, после — плотно зафиксироваться на объекте 12 мм.",
    { value: 12, unit: "мм" },
  );
  assertEquals(final.required, true);
  assertEquals(final.products.map((product) => product.id), ["valid"]);
});

Deno.test("compatibility relations compile into live facet values without domain rules", () => {
  const relations = parseCompatibilityRelations([
    { product_key: "Размер до преобразования", relation: "gt", reference_value: 12, unit: "мм" },
    { product_key: "Размер после преобразования", relation: "lt", reference_value: 12, unit: "мм" },
  ]);
  const projected = projectCompatibilityFacetOptions(relations, [{
    key: "size_pair",
    caption: "Размер до преобразования / Размер после преобразования",
    unit: "мм",
    values: [{ value: "12/6" }, { value: "13/6,5" }, { value: "16/8" }, { value: "20/10" }],
  }]);
  assertEquals(projected.unmatched_keys, []);
  assertEquals(projected.options, { size_pair: ["13/6,5", "16/8", "20/10"] });
});

Deno.test("facet projection fails closed when a live parameter is ambiguous", () => {
  const relation = parseCompatibilityRelations([
    { product_key: "Размер", relation: "gt", reference_value: 12, unit: "мм" },
  ]);
  const projected = projectCompatibilityFacetOptions(relation, [
    { key: "a", caption: "Размер A", unit: "мм", values: [{ value: "16" }] },
    { key: "b", caption: "Размер B", unit: "мм", values: [{ value: "20" }] },
  ]);
  assertEquals(projected.options, {});
  assertEquals(projected.unmatched_keys, ["Размер"]);
});

Deno.test("structured relation replaces a contradictory raw criterion for the same key", () => {
  const relations = parseCompatibilityRelations([
    { product_key: "Параметр альфа", relation: "gt", reference_value: 12, unit: "мм" },
  ]);
  assertEquals(mergeCompatibilityCriteria([
    { key: "Параметр альфа", op: "eq", value: 12, unit: "мм" },
    { key: "Материал", op: "eq", value: "медь" },
  ], relations), [
    { key: "Материал", op: "eq", value: "медь" },
    { key: "Параметр альфа", op: "min", value: 12, unit: "мм", level: "A", exclusive: true },
  ]);
});

Deno.test("compatibility detection is based on relation shape, not product names", () => {
  assertEquals(reasoningNeedsCompatibilityRelations("До установки параметр альфа должен быть больше 12 мм, после установки параметр бета меньше 12 мм"), false);
  assertEquals(reasoningNeedsCompatibilityRelations("Мощность товара должна быть не менее 40 Вт"), false);
  assertEquals(reasoningNeedsCompatibilityRelations("Мощность товара с запасом должна быть не менее 50 Вт"), false);
  assertEquals(reasoningNeedsCompatibilityRelations("Корпус выдерживает дождь, мощность должна быть не менее 50 Вт"), false);
  assertEquals(reasoningNeedsCompatibilityRelations("Мощность от 20 до 100 Вт, защита IP65"), false);
  assertEquals(reasoningNeedsCompatibilityRelations("Устройство должно выдерживать нагрузку не менее 250 Вт"), true);
  assertEquals(reasoningNeedsCompatibilityRelations("Для комнаты нужен поток 3750–5000 лм"), false);
  assertEquals(reasoningNeedsCompatibilityRelations("До установки диапазон 15–20 мм, после установки 6–8 мм"), false);
});

Deno.test("digits embedded in product identifiers do not manufacture compatibility measurements", () => {
  const ordinaryReplacement =
    "Ищу аналог Schneider Acti9 на 16 А, характеристика C. Сначала проверю исходную модель в каталоге.";
  assertEquals(reasoningNeedsCompatibilityRelations(ordinaryReplacement), false);
  assertEquals(minimumCompatibilityRelationCount(ordinaryReplacement), 0);
  assertEquals(
    reasoningNeedsCompatibilityRelations("Исходный размер 15 мм, конечный размер 8 мм"),
    true,
  );
  assertEquals(
    minimumCompatibilityRelationCount("Исходный размер 15 мм, конечный размер 8 мм"),
    2,
  );
});

Deno.test("all directional prose bounds must be represented", () => {
  const reasoning = "параметр до установки больше 12 мм, после установки меньше 12 мм";
  const one = parseCompatibilityRelations([
    { product_key: "Параметр до установки", relation: "gt", reference_value: 12, unit: "мм" },
  ]);
  assertEquals(uncoveredReasoningBounds(one, reasoning), [
    { op: "max", value: 12, unit: "мм", strict: true },
  ]);
  const both = parseCompatibilityRelations([
    { product_key: "Параметр до установки", relation: "gt", reference_value: 12, unit: "мм" },
    { product_key: "Параметр после установки", relation: "lt", reference_value: 12, unit: "мм" },
  ]);
  assertEquals(uncoveredReasoningBounds(both, reasoning), []);
});
