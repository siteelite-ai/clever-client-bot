import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { guardSearchFilters } from "./search-filter-guard.ts";

const facets = [
  { key: "kind", values: [{ value: "Светильники для ЖКХ" }, { value: "Бытовые светильники накладные" }] },
  { key: "brand", values: [{ value: "Gauss" }] },
];

Deno.test("filter guard removes a valid but unrequested catalog value", () => {
  const result = guardSearchFilters(
    { mode: "by_filter", category: "Светильники", options: { kind: ["Светильники для ЖКХ"] } },
    facets,
    "Подбираю бытовой накладной светильник, не для ЖКХ",
    "Нужен бытовой накладной светильник, не для ЖКХ",
  );
  assertEquals(result.args, {
    mode: "by_filter",
    category: "Светильники",
    options: { kind: ["Бытовые светильники накладные"] },
  });
  assertEquals(result.dropped[0].reason, "negated_by_user");
  assertEquals(result.inferred, [{ key: "kind", value: "Бытовые светильники накладные" }]);
});

Deno.test("filter guard canonicalizes and keeps a user-affirmed value", () => {
  const result = guardSearchFilters(
    { mode: "by_filter", options: { brand: ["gauss"] } },
    facets,
    "Для точного совпадения ищу бренд Gauss",
    "Покажи светильник Gauss HALL",
  );
  assertEquals(result.args.options, { brand: ["Gauss"] });
  assertEquals(result.kept, [{ key: "brand", value: "Gauss" }]);
});

Deno.test("filter guard drops unknown facet keys and values", () => {
  const result = guardSearchFilters(
    { mode: "by_filter", options: { invented: ["x"], brand: ["Acme"] } },
    facets,
    "Поищу Acme",
    "Acme",
  );
  assertEquals(result.args, { mode: "by_filter" });
  assertEquals(result.dropped.map((item) => item.reason), ["unknown_facet", "unknown_value"]);
});

Deno.test("filter guard accepts a criterion declared by the consultant", () => {
  const result = guardSearchFilters(
    { mode: "by_filter", options: { kind: ["Бытовые светильники накладные"] } },
    facets,
    "Для бытовой задачи выбираю фасет «Бытовые светильники накладные».",
    "Нужен накладной светильник для дома",
  );
  assertEquals(result.args.options, { kind: ["Бытовые светильники накладные"] });
});

Deno.test("filter guard accepts canonical value when reasoning uses inflected forms", () => {
  const result = guardSearchFilters(
    { mode: "by_filter", options: { kind: ["Бытовые светильники накладные"] } },
    facets,
    "Подбираю бытовой накладной светильник для помещения.",
    "Нужен светильник для дома",
  );
  assertEquals(result.args.options, { kind: ["Бытовые светильники накладные"] });
  assertEquals(result.dropped, []);
});

Deno.test("filter guard accepts a noun value declared through its adjective form", () => {
  const result = guardSearchFilters(
    { mode: "by_filter", options: { material: ["медь"] } },
    [{ key: "material", values: [{ value: "медь" }, { value: "CCA" }] }],
    "Для PoE нужны медные жилы, а не CCA.",
    "Нужен кабель для PoE.",
  );
  assertEquals(result.args.options, { material: ["медь"] });
  assertEquals(result.dropped, []);
});

Deno.test("filter guard completes an explicit user facet omitted by the model", () => {
  const result = guardSearchFilters(
    { mode: "by_filter", options: { sensor: ["да"] } },
    [
      ...facets,
      { key: "mount", values: [{ value: "накладной" }, { value: "встраиваемый" }] },
      { key: "sensor", values: [{ value: "да" }, { value: "нет" }] },
    ],
    "Ищу накладной светильник с датчиком.",
    "Мне нужен бытовой накладной светильник с датчиком движения.",
  );

  assertEquals(result.args.options, {
    sensor: ["да"],
    kind: ["Бытовые светильники накладные"],
    mount: ["накладной"],
  });
  assertEquals(result.inferred, [
    { key: "kind", value: "Бытовые светильники накладные" },
    { key: "mount", value: "накладной" },
  ]);
});

Deno.test("filter guard can build options from unambiguous user evidence", () => {
  const result = guardSearchFilters(
    { mode: "by_filter" },
    facets,
    "Подбираю товар.",
    "Нужен бытовой накладной светильник.",
  );
  assertEquals(result.args.options, { kind: ["Бытовые светильники накладные"] });
  assertEquals(result.inferred, [{ key: "kind", value: "Бытовые светильники накладные" }]);
});

Deno.test("filter guard does not guess when several values are explicit", () => {
  const result = guardSearchFilters(
    { mode: "by_filter" },
    [{ key: "color", values: [{ value: "белый" }, { value: "черный" }] }],
    "Подбираю цвет.",
    "Подойдёт белый или черный.",
  );
  assertEquals(result.args, { mode: "by_filter" });
  assertEquals(result.inferred, []);
});

Deno.test("filter guard never infers generic boolean facet values", () => {
  const result = guardSearchFilters(
    { mode: "by_filter" },
    [{ key: "sensor", values: [{ value: "да" }, { value: "нет" }] }],
    "Подбираю товар.",
    "Да, покажите варианты.",
  );
  assertEquals(result.args, { mode: "by_filter" });
  assertEquals(result.inferred, []);
});
