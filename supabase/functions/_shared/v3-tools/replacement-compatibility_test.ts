import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Facet } from "./discover-category.ts";
import {
  evaluateLedLampCandidate,
  evaluateLedLampFamilyBrowseCandidate,
  evaluateLedLampNamedSourceFamilyMember,
  ledLampCandidateDisclosure,
  observedLedLampFamilyEnvelope,
  parseStrictLampRange,
  parseStrictLampScalar,
  rankLedLampCandidates,
  rankLedLampFamilyBrowseCandidates,
  resolveLedLampFamilyBrowseProfile,
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

Deno.test("named LED lamp family browse excludes whole source series without choosing a source SKU", () => {
  const resolved = resolveLedLampFamilyBrowseProfile(
    "лампы ECO T75 таблетка GX53",
    "Лампы",
    facets.map((facet) => ({
      ...facet,
      values: facet.key === "base"
        ? [...facet.values, { value: "E27", products_count: 20 }]
        : facet.values,
    })),
  );
  assertEquals(resolved.status, "ready");
  if (resolved.status !== "ready") throw new Error("family profile missing");
  assertEquals(resolved.profile.seriesTokens, ["ECO", "T75"]);
  const sameSeries = candidate({
    id: "same-series",
    pagetitle: "Лампа светодиодная ECO T75 таблетка 6Вт 230В 4000К GX53 IEK",
  });
  const alternative = candidate({
    id: "other-series",
    pagetitle: "Лампа NLL-GX53-6-230-6,5K 61 247 Navigator",
  }, { voltage: "220-240", power: "6" });
  assertEquals(evaluateLedLampFamilyBrowseCandidate(
    resolved.profile,
    sameSeries,
  ).ok, false);
  const sourceMember = evaluateLedLampNamedSourceFamilyMember(
    resolved.profile,
    sameSeries,
  );
  assert(sourceMember.ok);
  assertEquals(sourceMember.powerW, 6);
  const fit = evaluateLedLampFamilyBrowseCandidate(
    resolved.profile,
    alternative,
  );
  assert(fit.ok);
  assertEquals(fit.powerW, 6);
  assertEquals(fit.diameterMm, 74);
});

Deno.test("family browse requires declared live socket, shape and a named series", () => {
  for (const description of [
    "лампа GX53 таблетка",
    "лампа ECO T75 E27 GX53 таблетка",
    "лампа ECO T75 GX53",
    "лампа ECO T75 GX53 таблетка 6Вт 230В",
  ]) {
    assertEquals(resolveLedLampFamilyBrowseProfile(
      description,
      "Лампы",
      facets.map((facet) => facet.key === "base"
        ? { ...facet, values: [...facet.values, { value: "E27", products_count: 2 }] }
        : facet),
    ).status === "ready", false, description);
  }
  assertEquals(resolveLedLampFamilyBrowseProfile(
    "лампы ECO T75 таблетка GX53",
    "Светильники",
    facets,
  ).status, "not_applicable");
});

Deno.test("family browse excludes unsafe or unproven candidates and ranks common size then lower power", () => {
  const resolved = resolveLedLampFamilyBrowseProfile(
    "лампы ECO T75 таблетка GX53",
    "Лампы",
    facets,
  );
  assertEquals(resolved.status, "ready");
  if (resolved.status !== "ready") throw new Error("family profile missing");
  // Omitting a generic series word does not turn the same model code into a
  // proven alternative family.
  const partialSeries = evaluateLedLampFamilyBrowseCandidate(
    resolved.profile,
    candidate({ id: "partial-series", pagetitle: "Лампа T75 таблетка 6Вт 230В GX53" }),
  );
  assertEquals(partialSeries.ok, false);
  if (!partialSeries.ok) assertEquals(partialSeries.reason, "named_source_series");
  for (const [label, altered, values] of [
    ["E27", {}, { base: "E27" }],
    ["DC", {}, { supply: "DC" }],
    ["12V", {}, { voltage: "12" }],
    ["partial mains", {}, { voltage: "220-225" }],
    ["bad range", {}, { voltage: "230-220" }],
    ["composite power", {}, { power: "6-15" }],
    ["composite diameter", {}, { diameter: "74-95" }],
    ["wrong shape", {}, { shape: "шар" }],
    ["other class", { leaf_category: "Светильники" }, {}],
    ["zero stock", { warehouse_evidence: "explicit_zero" }, {}],
  ] as Array<[string, Partial<ProductFull>, Record<string, string>]>) {
    const result = evaluateLedLampFamilyBrowseCandidate(
      resolved.profile,
      candidate({
        id: label,
        pagetitle: "Лампа NLL-GX53-6-230-6,5K Navigator",
        ...altered,
      }, values),
    );
    assertEquals(result.ok, false, label);
  }
  const low = evaluateLedLampFamilyBrowseCandidate(
    resolved.profile,
    candidate({ id: "low", pagetitle: "Лампа NLL-GX53-6-230-6,5K" },
      { power: "6" }),
  );
  const high = evaluateLedLampFamilyBrowseCandidate(
    resolved.profile,
    candidate({ id: "high", pagetitle: "Лампа B-GX53-12-230" },
      { power: "12" }),
  );
  const otherSize = evaluateLedLampFamilyBrowseCandidate(
    resolved.profile,
    candidate({ id: "other-size", pagetitle: "Лампа C-GX53-4-230" },
      { diameter: "80", power: "4" }),
  );
  assert(low.ok && high.ok && otherSize.ok);
  assertEquals(rankLedLampFamilyBrowseCandidates([otherSize, high, low])
    .map(({ candidate }) => candidate.id), ["low", "high", "other-size"]);
});

Deno.test("family comparison envelope comes from multiple named-source cards, never one arbitrary SKU", () => {
  const resolved = resolveLedLampFamilyBrowseProfile(
    "лампы ECO T75 таблетка GX53", "Лампы", facets,
  );
  assertEquals(resolved.status, "ready");
  if (resolved.status !== "ready") throw new Error("family profile missing");
  const source6 = evaluateLedLampNamedSourceFamilyMember(
    resolved.profile,
    candidate({ id: "source6", pagetitle: "Лампа ECO T75 таблетка 6Вт 230В GX53" },
      { power: "6" }),
  );
  const source15 = evaluateLedLampNamedSourceFamilyMember(
    resolved.profile,
    candidate({ id: "source15", pagetitle: "Лампа ECO T75 таблетка 15Вт 230В GX53" },
      { power: "15" }),
  );
  const alt4 = evaluateLedLampFamilyBrowseCandidate(
    resolved.profile,
    candidate({ id: "alt4", pagetitle: "Лампа NLL-GX53-4-230" },
      { power: "4" }),
  );
  const alt6 = evaluateLedLampFamilyBrowseCandidate(
    resolved.profile,
    candidate({ id: "alt6", pagetitle: "Лампа NLL-GX53-6-230" },
      { power: "6" }),
  );
  const alt8 = evaluateLedLampFamilyBrowseCandidate(
    resolved.profile,
    candidate({ id: "alt8", pagetitle: "Лампа XYZ-GX53-8-230" },
      { power: "8" }),
  );
  const alt30 = evaluateLedLampFamilyBrowseCandidate(
    resolved.profile,
    candidate({ id: "alt30", pagetitle: "Лампа XYZ-GX53-30-230" },
      { power: "30" }),
  );
  assert(source6.ok && source15.ok && alt4.ok && alt6.ok && alt8.ok && alt30.ok);
  assertEquals(observedLedLampFamilyEnvelope([source6], [alt6, alt8]), null);
  const envelope = observedLedLampFamilyEnvelope(
    [source6, source15], [alt4, alt6, alt8, alt30],
  );
  assert(envelope);
  assertEquals([envelope.minPowerW, envelope.maxPowerW, envelope.diameterMm],
    [6, 15, 74]);
  assertEquals(envelope.candidates.map(({ candidate }) => candidate.id),
    ["alt6", "alt8"]);
});
