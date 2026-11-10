import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyTextualShapeContract,
  compileTextualShapeState,
  hasCatalogShapeAxis,
  productProvesTextualShape,
} from "./textual-selection-contract.ts";
import {
  buildVisibleRequestContract,
  productSupportsVisibleRequestContract,
} from "./visible-request-contract.ts";

const state = (
  current: string,
  priorQueriesNewestFirst: string[] = [
    "Покажи круглые белые светильники IP65.",
  ],
  productClass = "Светильники",
) =>
  compileTextualShapeState({ productClass, current, priorQueriesNewestFirst });

Deno.test("text axis replaces only current-owned geometry across unrelated product classes", () => {
  for (const productClass of ["Светильники", "Зеркала", "Столы", "Коробки"]) {
    assertEquals(
      state("А есть овальные? Бюджет до 6000 тенге", [
        `Нужны круглые ${productClass}.`,
      ], productClass),
      { axis: "text:shape", allowed: ["oval"], excluded: [] },
      productClass,
    );
    assertEquals(
      state(
        "Нужны прямоугольные",
        [`Нужны овальные ${productClass}.`],
        productClass,
      )?.allowed,
      ["rectangular"],
      productClass,
    );
  }
});
Deno.test("latest owned shape survives unrelated color, budget and mounting changes", () => {
  assertEquals(
    state("А есть белые?", ["А есть овальные?", "Нужны круглые светильники"])
      ?.allowed,
    ["oval"],
  );
  assertEquals(
    state("Бюджет до 6000 тенге", ["Нужны квадратные светильники"])?.allowed,
    ["square"],
  );
  assertEquals(
    state("Только настенные", ["Нужны треугольные светильники"])?.allowed,
    ["triangular"],
  );
});
Deno.test("same-turn geometry alternatives replace the old family rather than history-wide OR", () => {
  assertEquals(state("Покажи овальные или прямоугольные")?.allowed, [
    "oval",
    "rectangular",
  ]);
  assertEquals(
    state("Нужны квадратные", [
      "Покажи овальные или прямоугольные",
      "Нужны круглые светильники",
    ])?.allowed,
    ["square"],
  );
});
Deno.test("room, installation dimensions and old-source geometry cannot override product shape", () => {
  for (
    const message of [
      "Для круглого зала 30 квадратов",
      "Форма помещения: круглая",
      "У меня старая люстра круглая",
      "Площадь 30 квадратных метров",
    ]
  ) {
    assertEquals(state(message, ["Нужны овальные светильники"])?.allowed, [
      "oval",
    ], message);
  }
  assertEquals(state("Покажи круги отрезные", [], "Круги отрезные"), null);
});
Deno.test("explicit withdrawal and a later positive choice update the same axis without admitting unknown shapes", () => {
  const excluded = state("Не круглые");
  assertEquals(excluded?.allowed, []);
  assertEquals(excluded?.excluded, ["round"]);
  assert(excluded);
  assertEquals(productProvesTextualShape("Светильник ABC", excluded), false);
  assertEquals(
    productProvesTextualShape("Светильник овальный", excluded),
    true,
  );
  assertEquals(
    state("Нужны круглые", ["Не круглые", "Нужны круглые светильники"])
      ?.excluded,
    [],
  );
});
Deno.test("unknown adjectives never erase an inherited known axis", () => {
  assertEquals(state("А есть необычные?")?.allowed, ["round"]);
  assertEquals(state("Форма: нестандартная")?.allowed, ["round"]);
});
Deno.test("new geometry is mandatory even when no candidate title knows its vocabulary", () => {
  const s = state("А есть овальные?");
  assert(s);
  const contract = applyTextualShapeContract([], s);
  assertEquals(contract.length, 1);
  assertEquals(
    productSupportsVisibleRequestContract(
      { pagetitle: "Светильник ABC" },
      contract,
    ),
    false,
  );
  assertEquals(
    productSupportsVisibleRequestContract(
      { pagetitle: "Светильник круглый" },
      contract,
    ),
    false,
  );
  assertEquals(
    productSupportsVisibleRequestContract(
      { pagetitle: "Светильник овал" },
      contract,
    ),
    true,
  );
  assertEquals(
    productSupportsVisibleRequestContract(
      { pagetitle: "Светильник Oval-120" },
      contract,
    ),
    false,
  );
});
Deno.test("shape proof rejects conflicting fields, mixed bodies, negations and subpart/room evidence", () => {
  const s = state("А есть овальные?");
  assert(s);
  for (
    const text of [
      "Светильник круглый",
      "Светильник круглый овальный",
      "Светильник не овальный",
      "Светильник для овального помещения",
      "Светильник с овальным датчиком",
      "Светильник серия Овал",
      "Светильник «Овал»",
      "Светильник овальный\nФорма: круглая",
      "Светильник овальный\nФорма: неизвестна",
      "Светильник ABC\nФорма помещения: овальная",
    ]
  ) {
    assertEquals(productProvesTextualShape(text, s), false, text);
  }
  for (
    const text of [
      "Светильник овальный белый IP65",
      "Светильник 1402 Банник IP65 овал мал. белый",
      "Светильник ABC\nФорма корпуса: овальная",
    ]
  ) {
    assertEquals(productProvesTextualShape(text, s), true, text);
  }
});
Deno.test("replacing text shape retains independent literal color and all nontext requirements", () => {
  const input = buildVisibleRequestContract("круглые черные светильники", {
    productClass: "Светильники",
    taxonomyClass: "Светильники",
    candidateTitles: [
      "Светильник круглый черный",
      "Светильник овальный черный",
    ],
  });
  const s = state("А есть овальные?");
  assert(s);
  const next = applyTextualShapeContract(input, s);
  assert(
    !next.some((r) => r.kind === "literal_modifier" && /круг/iu.test(r.label)),
  );
  assert(
    next.some((r) => r.kind === "literal_modifier" && /черн/iu.test(r.label)),
  );
  assertEquals(
    productSupportsVisibleRequestContract({
      pagetitle: "Светильник овальный черный",
    }, next),
    true,
  );
  assertEquals(
    productSupportsVisibleRequestContract({
      pagetitle: "Светильник овальный белый",
    }, next),
    false,
  );
  assertEquals(applyTextualShapeContract(input, null), input);
});
Deno.test("a text axis is never projected into API filters or confused with other live facets", () => {
  assertEquals(hasCatalogShapeAxis([{ key: "shape", values: [] }]), true);
  assertEquals(
    hasCatalogShapeAxis([{ key: "x", caption: "Форма корпуса", values: [] }]),
    true,
  );
  assertEquals(
    hasCatalogShapeAxis([{
      key: "color",
      caption: "Цвет корпуса",
      values: [],
    }]),
    false,
  );
});
