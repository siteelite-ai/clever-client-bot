import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Facet } from "./discover-category.ts";
import {
  evaluateLedLampCandidate,
  ledLampCandidateDisclosure,
  parseStrictLampRange,
  parseStrictLampScalar,
  rankLedLampCandidates,
  resolveLedLampCompatibilityProfile,
} from "./replacement-compatibility.ts";
import type { ProductFull } from "./types.ts";

const fields = [
  ["base", "Тип цоколя", "GX53"],
  ["technology", "Вид лампы (принцип работы)", "светодиодная"],
  ["supply", "Тип напряжения", "АС"],
  ["voltage", "Напряжение, В", "170-264"],
  ["shape", "Форма колбы", "таблетка"],
  ["diameter", "Диаметр, мм", "74"],
  ["power", "Мощность, Вт", "6"],
  ["length", "Длина, мм", "29"],
  ["colorTemperature", "Цветовая температура, К", "6500"],
  ["luminousFlux", "Световой поток, Лм", "600"],
] as const;

const facets: Facet[] = fields.map(([key, caption, value]) => ({
  key,
  caption,
  type: "string",
  unit: null,
  values: [{ value, products_count: 10 }],
}));

function lamp(
  overrides: Partial<ProductFull> = {},
  values: Record<string, string> = {},
): ProductFull {
  const complete = Object.fromEntries(fields.map(([key, , value]) => [
    key,
    values[key] ?? value,
  ]));
  return {
    id: "source",
    pagetitle: "Лампа светодиодная ECO T75 таблетка 6Вт 230В 6500К GX53 IEK",
    article: "source-article",
    url: "https://220volt.kz/catalog/svetotexnika/lampyi/source/",
    vendor: "IEK",
    price: 500,
    stock: "in_stock",
    warehouse_evidence: "positive",
    warehouses: [{ city: "Караганда", qty: 5 }],
    leaf_category: "Лампы",
    facet_values: Object.fromEntries(
      Object.entries(complete).map(([key, value]) => [key, [value]]),
    ),
    facet_captions: Object.fromEntries(fields.map(([key, caption]) => [
      key,
      caption,
    ])),
    short_traits: fields.map(([key, caption]) =>
      `${caption}: ${complete[key]}`
    ),
    ...overrides,
  };
}

function candidate(
  overrides: Partial<ProductFull> = {},
  values: Record<string, string> = {},
): ProductFull {
  const source = lamp({}, values);
  return {
    ...source,
    id: "candidate",
    article: "candidate-article",
    pagetitle: "Лампа светодиодная T75 таблетка 6Вт 230В 4000К GX53 IEK",
    url: "https://220volt.kz/catalog/svetotexnika/lampyi/candidate/",
    ...overrides,
  };
}

function readyProfile() {
  const resolved = resolveLedLampCompatibilityProfile(lamp(), facets);
  assertEquals(resolved.status, "ready");
  if (resolved.status !== "ready") throw new Error("profile not ready");
  return resolved.profile;
}

Deno.test("LED lamp family profile maps dynamic live keys, not a GX53/SKU dictionary", () => {
  const profile = readyProfile();
  assertEquals(profile.required.base.key, "base");
  assertEquals(profile.sourceNominalVoltage, 230);
  assertEquals(profile.sourceDiameterMm, 74);
  assertEquals(profile.sourcePowerW, 6);
  assertEquals(profile.sourceSupply, "AC");
  const secondSchema = facets.map((facet) => ({
    ...facet,
    key: `live_${facet.key}_v2`,
  }));
  const source = lamp();
  source.facet_values = Object.fromEntries(
    Object.entries(source.facet_values!).map(([key, values]) => [
      `live_${key}_v2`, values,
    ]),
  );
  source.facet_captions = Object.fromEntries(
    Object.entries(source.facet_captions!).map(([key, caption]) => [
      `live_${key}_v2`, caption,
    ]),
  );
  assertEquals(
    resolveLedLampCompatibilityProfile(source, secondSchema).status,
    "ready",
  );
});

Deno.test("two verified 6W LED lamps remain provisional candidates with exact differences", () => {
  const profile = readyProfile();
  const warm = candidate({ id: "warm" }, {
    voltage: "175-250",
    colorTemperature: "4000",
  });
  const navigator = candidate({
    id: "navigator",
    vendor: "Navigator",
    pagetitle: "Лампа NLL-GX53-6-230-6,5K 61 247 Navigator",
  }, {
    voltage: "220-240",
    length: "28",
    luminousFlux: "510",
  });
  const first = evaluateLedLampCandidate(profile, warm);
  const second = evaluateLedLampCandidate(profile, navigator);
  assert(first.ok && second.ok);
  assertEquals(first.differences.map(({ role }) => role), ["colorTemperature"]);
  assertEquals(second.differences.map(({ role }) => role), [
    "length", "luminousFlux",
  ]);
  const disclosure = ledLampCandidateDisclosure(profile, [first, second]);
  assertStringIncludes(disclosure, "4000 К вместо 6500 К");
  assertStringIncludes(disclosure, "510 лм вместо 600 лм");
  assertStringIncludes(disclosure, "28 мм вместо 29 мм");
  assertStringIncludes(disclosure, "максимально допустимую мощность");
  assertStringIncludes(disclosure, "Полная взаимозаменяемость не подтверждена");
});

Deno.test("equal-power verified lamps outrank earlier lower-power catalogue rows", () => {
  const profile = readyProfile();
  const lower = evaluateLedLampCandidate(profile, candidate({
    id: "lower",
    price: 100,
  }, { power: "4", luminousFlux: "400" }));
  const equal = evaluateLedLampCandidate(profile, candidate({
    id: "equal",
    price: 900,
  }, { power: "6", colorTemperature: "4000" }));
  assert(lower.ok && equal.ok);
  assertEquals(rankLedLampCandidates([lower, equal]).map(({ candidate }) =>
    candidate.id
  ), ["equal", "lower"]);
});

Deno.test("lamp compatibility rejects wrong base, supply, voltage, class, size and power", () => {
  const profile = readyProfile();
  for (const [label, modified, values] of [
    ["E27", {}, { base: "E27" }],
    ["12V", {}, { voltage: "12" }],
    ["DC", {}, { supply: "DC" }],
    ["halogen", {}, { technology: "галогенная" }],
    ["round", {}, { shape: "шар" }],
    ["95mm", {}, { diameter: "95" }],
    ["30W", {}, { power: "30" }],
    ["power-range", {}, { power: "8-30" }],
    ["bad-voltage", {}, { voltage: "240-220" }],
    ["partial-voltage", {}, { voltage: "150-170" }],
    ["other-category", { leaf_category: "Светильники" }, {}],
  ] as Array<[string, Partial<ProductFull>, Record<string, string>]>) {
    const result = evaluateLedLampCandidate(profile, candidate(modified, values));
    assertEquals(result.ok, false, label);
  }
});

Deno.test("missing or contradictory raw option, zero-stock card and source itself fail closed", () => {
  const profile = readyProfile();
  const missing = candidate();
  delete missing.facet_values!.base;
  assertEquals(evaluateLedLampCandidate(profile, missing).ok, false);
  const contradictory = candidate();
  contradictory.facet_captions!.base = "Цвет корпуса";
  assertEquals(evaluateLedLampCandidate(profile, contradictory).ok, false);
  const hiddenStock = candidate({ warehouse_evidence: "explicit_zero" });
  assertEquals(evaluateLedLampCandidate(profile, hiddenStock).ok, false);
  const noPositiveCity = candidate({ warehouses: [] });
  assertEquals(evaluateLedLampCandidate(profile, noPositiveCity).ok, false);
  assertEquals(evaluateLedLampCandidate(profile, lamp()).ok, false);
});

Deno.test("profile is not silently generalized to other product families or incomplete lamp data", () => {
  assertEquals(resolveLedLampCompatibilityProfile(
    lamp({ leaf_category: "Автоматические выключатели" }), facets,
  ).status, "not_applicable");
  assertEquals(resolveLedLampCompatibilityProfile(
    lamp({ leaf_category: "Светильники" }), facets,
  ).status, "not_applicable");
  assertEquals(resolveLedLampCompatibilityProfile(
    lamp(), facets.filter(({ key }) => key !== "base"),
  ).status, "unverifiable");
  const missingSource = lamp();
  delete missingSource.facet_values!.power;
  assertEquals(resolveLedLampCompatibilityProfile(
    missingSource, facets,
  ).status, "unverifiable");
  const missingOptional = lamp();
  delete missingOptional.facet_values!.colorTemperature;
  assertEquals(resolveLedLampCompatibilityProfile(
    missingOptional, facets,
  ).status, "unverifiable");
  assertEquals(resolveLedLampCompatibilityProfile(
    lamp({ pagetitle: "Лампа GX53 12В 230В" }), facets,
  ).status, "unverifiable");
});

Deno.test("strict numeric and range parsing never interprets composite values as one fit", () => {
  assertEquals(parseStrictLampScalar("6", ["вт"]), 6);
  assertEquals(parseStrictLampScalar("6 Вт", ["вт"]), 6);
  assertEquals(parseStrictLampScalar("8-30", ["вт"]), null);
  assertEquals(parseStrictLampScalar("6/15", ["вт"]), null);
  assertEquals(parseStrictLampScalar("6 кВт", ["вт"]), null);
  assertEquals(parseStrictLampRange("175-250"), { min: 175, max: 250 });
  assertEquals(parseStrictLampRange("220–240 В"), { min: 220, max: 240 });
  for (const malformed of ["240-220", "8-30/12", "220/240", "12 В AC", "12-", "0-240", "230-∞", "230;12"]) {
    assertEquals(parseStrictLampRange(malformed), null, malformed);
  }
});
