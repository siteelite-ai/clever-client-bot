import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { compileSocketFunctionRequirements } from "./socket-function-contract.ts";
import { productSupportsVisibleRequestContract } from "./visible-request-contract.ts";
import { applyCriteriaGate, type Criterion } from "./criteria-gate.ts";
import {
  verifySelectionTargetWithNamedEntityCategory,
  verifySelectionTargetWithVisibleTitle,
} from "./selection-contract.ts";
import type { ProductRef } from "./types.ts";

const compile = (
  current = "Нужны розетки",
  priorQueriesNewestFirst: string[] = [],
) =>
  compileSocketFunctionRequirements({
    productClass: "розетки",
    current,
    priorQueriesNewestFirst,
  });
const matches = (title: string, traits: string[] = [], current?: string) =>
  productSupportsVisibleRequestContract({
    pagetitle: title,
    short_traits: traits,
  }, compile(current));

Deno.test("ordinary socket class vetoes positive data, telephone, TV and USB-only siblings across spellings", () => {
  for (
    const title of [
      "Розетка Ethernet RJ-45 /W1181006 (серебряный)",
      "Розетка RJ45",
      "Розетка RJ‑45",
      "Розетка RJ 45",
      "Розетка компьютерная",
      "Розетка интернет двойная",
      "Розетка телефонная RJ11",
      "Розетка RJ-12",
      "Розетка TV",
      "Розетка антенная SAT",
      "Розетка телевизионная",
      "Розетка USB 5В",
      "Розетка Type-C",
      "Розетка электрическая RJ45",
      "Розетка компьютерная с заземлением RJ45",
    ]
  ) assertEquals(matches(title), false, title);
});

Deno.test("ordinary mains wording retains existing target proof without inventing new electrical properties", () => {
  for (
    const title of [
      "Розетка двойная Gallant",
      "Розетка с заземлением",
      "Розетка 16А",
      "Розетка силовая",
      "Розетка скрытого монтажа",
    ]
  ) {
    assertEquals(matches(title), true, title);
  }
  assertEquals(matches("Розетка USB с заземлением"), true);
  assertEquals(matches("Розетка силовая + RJ45"), true);
  assertEquals(matches("Розетка USB", ["Заземление: да"]), true);
  assertEquals(matches("Розетка USB", ["Заземление: нет"]), false);
});

Deno.test("same-card identity traits can expose a sibling behind a generic title, not compatibility prose", () => {
  for (
    const trait of [
      "Тип: компьютерная",
      "Тип розетки: RJ45",
      "Интерфейс: Ethernet",
      "Назначение: телефонная",
      "Количество USB портов: 2",
    ]
  ) {
    assertEquals(matches("Розетка серебристая", [trait]), false, trait);
  }
  assertEquals(matches("Розетка", ["Совместимость: USB кабель"]), true);
  assertEquals(matches("Розетка", ["USB: нет"]), true);
  assertEquals(matches("Розетка без USB"), true);
  assertEquals(matches("Розетка", ["Количество USB портов: 0"]), true);
  assertEquals(matches("Розетка RJ45", ["Тип: силовая"]), true);
  assertEquals(matches("Розетка RJ45", ["Заземление: да"]), false);
});

Deno.test("explicit interface requests stay searchable, rather than banning RJ45 in the whole catalogue", () => {
  for (
    const [request, title, wrong] of [
      ["Покажи розетки RJ‑45", "Розетка Ethernet RJ45", "Розетка силовая"],
      [
        "Нужна компьютерная розетка",
        "Розетка компьютерная",
        "Розетка телефонная",
      ],
      ["Нужна телефонная розетка", "Розетка RJ11", "Розетка RJ45"],
      ["Покажи TV розетки", "Розетка антенная", "Розетка RJ45"],
      ["Покажи информационные розетки", "Розетка RJ45", "Розетка силовая"],
      [
        "Покажи информационные розетки",
        "Розетка телефонная",
        "Розетка силовая",
      ],
      ["Розетка с USB", "Розетка USB 5В", "Розетка силовая"],
    ]
  ) {
    assertEquals(matches(title, [], request), true, request);
    assertEquals(matches(wrong, [], request), false, request);
  }
});

Deno.test("USB and mains together require both functions and cannot be satisfied by a charger alone", () => {
  assertEquals(
    matches(
      "Розетка USB с заземлением",
      [],
      "Нужна электрическая розетка с USB",
    ),
    true,
  );
  assertEquals(
    matches("Розетка USB 5В", [], "Нужна электрическая розетка с USB"),
    false,
  );
  assertEquals(
    matches("Розетка с заземлением", [], "Нужна электрическая розетка с USB"),
    false,
  );
});

Deno.test("functional purpose survives colour/count refinements from verified dialogue, and explicit new purpose replaces it", () => {
  const ordinary = compile("А есть серебристые?", [
    "Розетки скрытого монтажа черного цвета",
  ]);
  const network = compile("Нужны двойные", [
    "А есть серебристые?",
    "Покажи компьютерные розетки",
  ]);
  assertEquals(ordinary[0].value, "mains");
  assertEquals(network[0].value, "data");
  assertEquals(
    compile("Теперь нужны обычные электрические розетки", [
      "Покажи RJ45 розетки",
    ])[0].value,
    "mains",
  );
  assertEquals(
    compile("А есть RJ45?", ["Покажи обычные розетки"])[0].value,
    "data",
  );
  assertEquals(compile("Розетки без RJ45")[0].value, "mains");
  assertEquals(compile("Не USB, а обычные розетки")[0].value, "mains");
});

Deno.test("functional veto cannot be bypassed by feature equivalence, a named series or generic live leaf", () => {
  const product: ProductRef = {
    id: "rj",
    pagetitle: "Розетка RJ45 Gallant",
    leaf_category: "Розетки",
    vendor: null,
    price: 1,
    stock: "in_stock",
    short_traits: [],
  };
  assertEquals(
    verifySelectionTargetWithNamedEntityCategory({
      target: "розетка",
      products: [product],
      named_entity: "Gallant",
    }).passed_ids,
    ["rj"],
  );
  assertEquals(
    productSupportsVisibleRequestContract(product, compile(), () => true),
    false,
  );
  const hidden = {
    ...product,
    pagetitle: "Розетка Gallant",
    short_traits: ["Тип: компьютерная"],
  };
  assertEquals(productSupportsVisibleRequestContract(hidden, compile()), false);
});

Deno.test("functional veto only intersects existing class/colour/mount checks; it never admits a new card", () => {
  const criteria: Criterion[] = [{
    key: "Цвет",
    op: "eq",
    value: "серебристый",
    level: "A",
  }, { key: "Тип монтажа", op: "eq", value: "скрытый", level: "A" }];
  const product = (
    id: string,
    title: string,
    color = "серебристый",
    mount = "скрытый",
  ): ProductRef => ({
    id,
    pagetitle: title,
    vendor: null,
    price: 1000,
    stock: "in_stock",
    short_traits: [`Цвет: ${color}`, `Тип монтажа: ${mount}`],
  });
  const products = [
    product("ok", "Розетка с заземлением"),
    product("rj", "Розетка RJ45"),
    product("wrong-color", "Розетка с заземлением", "черный"),
    product("wrong-mount", "Розетка с заземлением", "серебристый", "открытый"),
    product("switch", "Выключатель"),
  ];
  const classIds = new Set(
    verifySelectionTargetWithVisibleTitle("розетка", products).passed_ids,
  );
  const criteriaIds = new Set(applyCriteriaGate(products, criteria).passed_ids);
  const passed = products.filter((p) =>
    classIds.has(p.id) && criteriaIds.has(p.id) &&
    productSupportsVisibleRequestContract(p, compile())
  );
  assertEquals(passed.map((p) => p.id), ["ok"]);
  assertEquals(
    compileSocketFunctionRequirements({
      productClass: "светильник",
      current: "для розетки с USB",
    }),
    [],
  );
  assertEquals(
    compileSocketFunctionRequirements({
      productClass: "рамка для компьютерной розетки",
      current: "Покажи рамки для RJ45 розетки",
    }),
    [],
  );
});
