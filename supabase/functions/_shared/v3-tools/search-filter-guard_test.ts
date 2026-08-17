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
  assertEquals(result.args, { mode: "by_filter", category: "Светильники" });
  assertEquals(result.dropped[0].reason, "negated_by_user");
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
