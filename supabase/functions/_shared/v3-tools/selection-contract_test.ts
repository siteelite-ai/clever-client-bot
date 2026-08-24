import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { initialSelectionDeclaration, parseSelectionTarget, selectionTargetIsDeclared, verifySelectionTarget, verifySelectionTargetWithGroundedSearch } from "./selection-contract.ts";
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

Deno.test("description cannot rename a sibling product class", () => {
  const sibling = product("stabilizer", "Стабилизатор напряжения 500 ВА", "Стабилизаторы напряжения");
  sibling.description_excerpt = "Может применяться совместно с ИБП для защиты оборудования";
  sibling.short_traits = ["Назначение: резервное питание ИБП"];
  const report = verifySelectionTarget("ИБП", [sibling]);
  assertEquals(report.passed_ids, []);
  assertEquals(report.rejected_ids, ["stabilizer"]);
});

Deno.test("selection projection separates product class from application context", () => {
  const projection = parseSelectionTarget({
    product_class: "светодиодный светильник",
    application_context: ["основное освещение гостиной"],
  });
  assertEquals(projection, {
    product_class: "светодиодный светильник",
    application_context: ["основное освещение гостиной"],
  });
  const report = verifySelectionTarget(projection.product_class, [
    product("indoor", "Светодиодный светильник для гостиной", "Интерьерное освещение"),
    product("street", "Светодиодный светильник Avenue IP65", "Уличное освещение"),
  ]);
  assertEquals(report.passed_ids, ["indoor", "street"]);
  assertEquals(report.rejected_ids, []);
});

Deno.test("selection target accepts inflected Russian catalog evidence", () => {
  const report = verifySelectionTarget("термоусадочная трубка", [
    product("ttu", "Набор трубок термоусадочных ТТУ 12/6"),
  ]);
  assertEquals(report.passed_ids, ["ttu"]);
});

Deno.test("two-token class requires both identity signals", () => {
  const report = verifySelectionTarget("светодиодный светильник", [
    product("fixture", "Светодиодный светильник потолочный"),
    product("flood", "Светодиодный прожектор IP65"),
    product("lamp", "Светодиодная лампа E27"),
  ]);
  assertEquals(report.passed_ids, ["fixture"]);
  assertEquals(report.rejected_ids, ["flood", "lamp"]);
});

Deno.test("render target cannot drift to a sibling mentioned only by later search tactics", () => {
  const initial = "Какой ИБП подойдет?\nВы ищете источник бесперебойного питания для котла.";
  assertEquals(selectionTargetIsDeclared("ИБП", initial), true);
  assertEquals(selectionTargetIsDeclared("источник бесперебойного питания", initial), true);
  assertEquals(selectionTargetIsDeclared("стабилизатор напряжения", initial), false);
  const prose = "Понял задачу. Для котла нужен источник бесперебойного питания с чистой синусоидой. По мощности нужен запас. Искать буду среди стабилизаторов и ИБП.";
  const declaration = initialSelectionDeclaration(prose);
  assertEquals(declaration, "Понял задачу. Для котла нужен источник бесперебойного питания с чистой синусоидой. По мощности нужен запас.");
  assertEquals(selectionTargetIsDeclared("стабилизатор", declaration), false);
  assertEquals(
    initialSelectionDeclaration("Понял задачу. Нужен потолочный светильник для гостиной. Смотрю варианты в каталоге."),
    "Понял задачу. Нужен потолочный светильник для гостиной.",
  );
});

Deno.test("live taxonomy may complete a partially declared class but cannot authorize a sibling", () => {
  const initial = "Хочу заменить люстру на светодиодное освещение.\nПонял задачу: нужно светодиодное освещение для гостиной.";
  assertEquals(selectionTargetIsDeclared(
    "светодиодный светильник",
    `${initial}\nСветильники\nПотолочные светильники`,
  ), true);
  assertEquals(selectionTargetIsDeclared(
    "стабилизатор напряжения",
    "Нужен ИБП для котла.\nИсточники бесперебойного питания",
  ), false);
  assertEquals(selectionTargetIsDeclared(
    "уличный светильник",
    `${initial}\nСветильники`,
  ), false);
});

Deno.test("literal model-owned search evidence can prove a subtype inside the live base class", () => {
  const products = [
    product("proved", "ALPHA modular controller", "Controllers"),
    product("broad", "BETA modular controller", "Controllers"),
  ];
  const report = verifySelectionTargetWithGroundedSearch({
    target: "smart controller",
    products,
    live_class: "controller",
    grounded_label: "ALPHA",
    grounded_ids: ["proved", "broad"],
  });
  assertEquals(report.passed_ids, ["proved"]);
  assertEquals(report.rejected_ids, ["broad"]);
});

Deno.test("generic base-class query cannot weaken a structured target", () => {
  const products = [product("broad", "outdoor controller", "Controllers")];
  const report = verifySelectionTargetWithGroundedSearch({
    target: "smart controller",
    products,
    live_class: "controller",
    grounded_label: "controller",
    grounded_ids: ["broad"],
  });
  assertEquals(report.passed_ids, []);
});

Deno.test("grounded label cannot authorize a sibling live class", () => {
  const products = [product("sibling", "ALPHA relay", "Relays")];
  const report = verifySelectionTargetWithGroundedSearch({
    target: "smart controller",
    products,
    live_class: "controller",
    grounded_label: "ALPHA",
    grounded_ids: ["sibling"],
  });
  assertEquals(report.passed_ids, []);
});
