import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { customerOwnsAbsentFacetValue } from "./facet-value-semantics.ts";
import { buildDerivedSelectionReasoningToolSchema } from "./selection-actionability.ts";
import { guardSearchFilters } from "./search-filter-guard.ts";

Deno.test("comparison and optional preference never authorize an absent facet", () => {
  const outlets = { key: "outlets", caption: "Количество розеток" };
  const grounding = { key: "ground", caption: "Наличие заземления" };
  for (const message of [
    "Нужны розетки, розеток не менее двух",
    "Розеток не более четырёх",
    "Розетки не принципиальны",
  ]) {
    assertEquals(customerOwnsAbsentFacetValue(outlets, "нет", message), false);
  }
  for (const message of [
    "Нет предпочтений по заземлению",
    "Без ограничений по заземлению",
    "Заземление не принципиально",
  ]) {
    assertEquals(customerOwnsAbsentFacetValue(grounding, "нет", message), false);
  }
});

Deno.test("explicit absence is axis-specific, including short feature codes", () => {
  const grounding = { key: "ground", caption: "Наличие заземления" };
  const usb = { key: "usb", caption: "Наличие USB" };
  for (const message of [
    "Нужен вариант без заземления",
    "Заземления нет",
    "Заземление не нужно",
    "Заземления не должно быть",
  ]) {
    assertEquals(customerOwnsAbsentFacetValue(grounding, "нет", message), true);
  }
  for (const message of ["Розетка без USB", "USB не нужен"]) {
    assertEquals(customerOwnsAbsentFacetValue(usb, "нет", message), true);
  }
  assertEquals(customerOwnsAbsentFacetValue(usb, "не указано", "Без USB"), false);
  assertEquals(customerOwnsAbsentFacetValue(usb, "нет", "Без заземления"), false);
});

Deno.test("negative facet provenance is consistent from reasoning schema through search", () => {
  const outlets = [{
    key: "outlets",
    caption: "Количество розеток",
    values: ["нет", "2", "3"].map((value) => ({ value })),
  }];
  const minimumTwo = "Нужны розетки, розеток не менее двух";
  const schema = buildDerivedSelectionReasoningToolSchema(outlets, minimumTwo);
  const properties = schema.function.parameters.properties as Record<
    string,
    { items?: { enum?: string[] } }
  >;
  assertEquals(
    properties.required_facet_values.items?.enum?.includes("f0v0") ?? false,
    false,
  );
  const guarded = guardSearchFilters(
    { mode: "by_filter", options: { outlets: ["нет"] } },
    outlets,
    "Количество розеток: нет",
    minimumTwo,
  );
  assertEquals(guarded.args.options, undefined);

  const usb = [{
    key: "usb",
    caption: "Наличие USB",
    values: ["да", "нет"].map((value) => ({ value })),
  }];
  const noUsb = "Нужна розетка без USB";
  const usbSchema = buildDerivedSelectionReasoningToolSchema(usb, noUsb);
  const usbProperties = usbSchema.function.parameters.properties as Record<
    string,
    { items?: { enum?: string[] } }
  >;
  assertEquals(
    usbProperties.required_facet_values.items?.enum?.includes("f0v1") ?? false,
    false, // pure boolean metadata is intentionally absent from model schema
  );
  const usbGuarded = guardSearchFilters(
    { mode: "by_filter", options: { usb: ["нет"] } },
    usb,
    "Наличие USB: нет",
    noUsb,
  );
  assertEquals(usbGuarded.args.options, { usb: ["нет"] });
});
