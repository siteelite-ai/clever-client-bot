import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Facet } from "./discover-category.ts";
import {
  evaluateStructuralReplacementCandidate,
  resolveStructuralReplacementProfile,
} from "./replacement-structural-proof.ts";
import type { ProductFull } from "./types.ts";

const specs = [
  ["kind", "Вид светильника", "даунлайт"],
  ["mount", "Способ монтажа", "встраиваемый"],
  ["technology", "Тип лампы", "LED"],
  ["lightColor", "Цвет свечения", "нейтральный"],
  ["colorTemperature", "Цветовая температура, К", "4000"],
  ["socket", "Тип цоколя", "нет"],
  ["driver", "ПРА", "в комплекте"],
  ["diameter", "Диаметр, см", "9"],
  ["power", "Мощность ламп, Вт", "7"],
  ["flux", "Световой поток, Лм", "600"],
  ["voltage", "Напряжение, В", "220"],
  ["ip", "Степень защиты, IP", "20"],
] as const;

const facets: Facet[] = specs.map(([key, caption, value]) => ({
  key: `live_${key}`,
  caption,
  type: "string",
  unit: null,
  values: [{ value, products_count: 12 },
    ...key === "kind" ? [{ value: "бытовые линейные светильники" }] : [],
    ...key === "mount" ? [{ value: "накладной" }] : [],
    ...key === "socket" ? [{ value: "GU10" }] : [],
    ...key === "driver" ? [{ value: "не в комплекте" }] : [],
    ...key === "technology" ? [{ value: "люминесцентная" }] : [],
    ...key === "lightColor" ? [{ value: "холодный" }] : [],
    ...key === "colorTemperature" ? [{ value: "6500" }] : [],
  ],
}));

function product(
  id: string,
  values: Record<string, string> = {},
  overrides: Partial<ProductFull> = {},
): ProductFull {
  const complete = Object.fromEntries(specs.map(([key, , value]) => [
    `live_${key}`,
    values[key] ?? value,
  ]));
  return {
    id,
    pagetitle: id === "source"
      ? "Светильник DN027B G2 LED6/NW 7W 220-240V D90 R"
      : "Светильник встраиваемый альтернативный LED 7W",
    url: `https://220volt.kz/catalog/svetotexnika/svetilniki/${id}/`,
    article: id,
    vendor: "catalog vendor",
    price: 1500,
    stock: "in_stock",
    warehouse_evidence: "positive",
    warehouses: [{ city: "Караганда", qty: 5 }],
    leaf_category: "Светильники",
    short_traits: specs.map(([key, caption]) =>
      `${caption}: ${complete[`live_${key}`]}`
    ),
    facet_values: Object.fromEntries(
      Object.entries(complete).map(([key, value]) => [key, [value]]),
    ),
    facet_captions: Object.fromEntries(specs.map(([key, caption]) => [
      `live_${key}`,
      caption,
    ])),
    ...overrides,
  };
}

function profile() {
  const result = resolveStructuralReplacementProfile(product("source"), facets);
  assertEquals(result.status, "ready");
  if (result.status !== "ready") throw new Error("profile not ready");
  return result.profile;
}

Deno.test("structural profile derives unique live roles, exact search options and numeric obligations", () => {
  const resolved = profile();
  assertEquals(resolved.leafCategory, "Светильники");
  assertEquals(resolved.searchOptions.live_kind, ["даунлайт"]);
  assertEquals(resolved.searchOptions.live_mount, ["встраиваемый"]);
  assertEquals(resolved.searchOptions.live_socket, ["нет"]);
  assertEquals(resolved.searchOptions.live_driver, ["в комплекте"]);
  assertEquals(resolved.searchOptions.live_lightColor, ["нейтральный"]);
  assertEquals(resolved.searchOptions.live_colorTemperature, ["4000"]);
  assertEquals(Object.keys(resolved.searchOptions).length, 7);
  assertEquals(resolved.obligations.find(({ role }) => role === "diameter")?.value, [8, 10]);
  assertEquals(resolved.obligations.find(({ role }) => role === "diameter")?.unit, "см");
  assertEquals(resolved.obligations.find(({ role }) => role === "power")?.value, [6, 8]);
  assertEquals(resolved.obligations.find(({ role }) => role === "flux")?.value, [400, 800]);
  assertEquals(resolved.obligations.find(({ role }) => role === "ip")?.value, 20);
  assertEquals(resolved.obligations.some(({ caption }) => /бренд|цвет корпуса/ui.test(caption)), false);
});

Deno.test("candidate gate accepts corroborated downlight with comparable fit, not a linear surface fixture", () => {
  const resolved = profile();
  assertEquals(evaluateStructuralReplacementCandidate(resolved, product("good", {
    diameter: "8", flux: "400", power: "6", voltage: "220-240",
  })).ok, true);
  const linear = evaluateStructuralReplacementCandidate(resolved, product("linear", {
    kind: "бытовые линейные светильники", mount: "накладной",
  }));
  assertEquals(linear, { ok: false, reason: "candidate_mismatch:kind" });
  assertEquals(evaluateStructuralReplacementCandidate(resolved, product("surface", {
    mount: "накладной",
  })), { ok: false, reason: "candidate_mismatch:mount" });
});

Deno.test("candidate gate rejects oversized and missing diameter, and deficient luminous flux", () => {
  const resolved = profile();
  assertEquals(evaluateStructuralReplacementCandidate(resolved, product("edge", {
    diameter: "10", flux: "800",
  })).ok, true);
  for (const diameter of ["10.5", "12", "12/9", "unknown"]) {
    assertEquals(evaluateStructuralReplacementCandidate(resolved, product("wide", {
      diameter,
    })), { ok: false, reason: "candidate_outside_window:diameter" });
  }
  const missing = product("missing");
  delete missing.facet_values?.live_diameter;
  assertEquals(evaluateStructuralReplacementCandidate(resolved, missing), {
    ok: false,
    reason: "candidate_value_unverified:diameter",
  });
  assertEquals(evaluateStructuralReplacementCandidate(resolved, product("dim", {
    flux: "360",
  })), { ok: false, reason: "candidate_outside_window:flux" });
  assertEquals(evaluateStructuralReplacementCandidate(resolved, product("below", {
    flux: "399",
  })), { ok: false, reason: "candidate_outside_window:flux" });
});

Deno.test("verified cut-out opt-in ignores only generic outer diameter without changing the source profile", () => {
  const resolved = profile();
  const originalProfile = JSON.stringify(resolved);
  const candidate = product("wider-bezel", { diameter: "12" }, {
    description_excerpt: "Монтажное отверстие: 90 мм",
  });
  assertEquals(evaluateStructuralReplacementCandidate(resolved, candidate), {
    ok: false,
    reason: "candidate_outside_window:diameter",
  });
  const matched = evaluateStructuralReplacementCandidate(resolved, candidate, {
    dimensionPolicy: "verified_mounting_cutout",
    customerCutoutMm: 90,
  });
  assertEquals(matched.ok, true);
  if (matched.ok) {
    assertEquals(matched.evidence.some(({ role }) => role === "diameter"), false);
    assertEquals(matched.evidence.some(({ role }) => role === "power"), true);
  }
  assertEquals(JSON.stringify(resolved), originalProfile);
  assertEquals(resolved.obligations.find(({ role }) => role === "diameter")?.value, [8, 10]);
});

Deno.test("verified cut-out opt-in requires labelled candidate evidence and rejects missing or conflicting cut-outs", () => {
  const resolved = profile();
  const option = { dimensionPolicy: "verified_mounting_cutout" } as const;
  assertEquals(evaluateStructuralReplacementCandidate(resolved, product("no-cutout", {
    diameter: "12",
  }), { ...option, customerCutoutMm: 90 }), {
    ok: false,
    reason: "candidate_mounting_cutout_unverified:mounting_cutout_unverified",
  });
  assertEquals(evaluateStructuralReplacementCandidate(resolved, product("wrong-cutout", {
    diameter: "12",
  }, { description_excerpt: "Монтажное отверстие: 80 мм" }), {
    ...option, customerCutoutMm: 90,
  }), {
    ok: false,
    reason: "candidate_mounting_cutout_unverified:mounting_cutout_conflicts",
  });
  assertEquals(evaluateStructuralReplacementCandidate(resolved, product("title-only", {
    diameter: "12",
  }, { pagetitle: "Даунлайт монтажный D90 LED 7W" }), {
    ...option, customerCutoutMm: 90,
  }), {
    ok: false,
    reason: "candidate_mounting_cutout_unverified:mounting_cutout_unverified",
  });
  assertEquals(evaluateStructuralReplacementCandidate(resolved, product("source-cutout-unknown", {
    diameter: "12",
  }, { description_excerpt: "Монтажное отверстие: 90 мм" }), option), {
    ok: false,
    reason: "candidate_mounting_cutout_unverified:mounting_cutout_unverified",
  });
  assertEquals(evaluateStructuralReplacementCandidate(resolved, product("invalid-customer-cutout", {
    diameter: "12",
  }, { description_excerpt: "Монтажное отверстие: 90 мм" }), {
    ...option, customerCutoutMm: Number.NaN,
  }), { ok: false, reason: "customer_mounting_cutout_invalid" });
  const sourceWithCutout = product("source", {}, {
    description_excerpt: "Монтажное отверстие: 90 мм",
  });
  const sourceResolution = resolveStructuralReplacementProfile(sourceWithCutout, facets);
  assertEquals(sourceResolution.status, "ready");
  if (sourceResolution.status !== "ready") throw new Error("cutout source not ready");
  const noGenericDiameter = product("matching-cutout", {}, {
    description_excerpt: "Монтажное отверстие: 90 мм",
  });
  delete noGenericDiameter.facet_values?.live_diameter;
  assertEquals(evaluateStructuralReplacementCandidate(
    sourceResolution.profile,
    noGenericDiameter,
  ), { ok: false, reason: "candidate_value_unverified:diameter" });
  assertEquals(evaluateStructuralReplacementCandidate(
    sourceResolution.profile,
    noGenericDiameter,
    option,
  ).ok, true);
  assertEquals(evaluateStructuralReplacementCandidate(
    sourceResolution.profile,
    product("source-conflict", { diameter: "12" }, {
      description_excerpt: "Монтажное отверстие: 90 мм",
    }),
    { ...option, customerCutoutMm: 80 },
  ), {
    ok: false,
    reason: "candidate_mounting_cutout_unverified:customer_and_source_cutout_conflict",
  });
});

Deno.test("verified cut-out opt-in retains structural kind, mounting, interface, power and stock gates", () => {
  const resolved = profile();
  const options = {
    dimensionPolicy: "verified_mounting_cutout",
    customerCutoutMm: 90,
  } as const;
  const candidate = (id: string, values: Record<string, string> = {},
    overrides: Partial<ProductFull> = {}) => product(id, {
      diameter: "12", ...values,
    }, { description_excerpt: "Монтажное отверстие: 90 мм", ...overrides });
  assertEquals(evaluateStructuralReplacementCandidate(resolved, candidate("wrong-kind", {
    kind: "бытовые линейные светильники",
  }), options), { ok: false, reason: "candidate_mismatch:kind" });
  assertEquals(evaluateStructuralReplacementCandidate(resolved, candidate("wrong-mount", {
    mount: "накладной",
  }), options), { ok: false, reason: "candidate_mismatch:mount" });
  assertEquals(evaluateStructuralReplacementCandidate(resolved, candidate("wrong-socket", {
    socket: "GU10",
  }), options), { ok: false, reason: "candidate_mismatch:socket" });
  assertEquals(evaluateStructuralReplacementCandidate(resolved, candidate("wrong-power", {
    power: "9",
  }), options), { ok: false, reason: "candidate_outside_window:power" });
  assertEquals(evaluateStructuralReplacementCandidate(resolved, candidate("no-stock", {}, {
    warehouse_evidence: "explicit_zero",
    warehouses: [],
    stock: "out",
  }), options), { ok: false, reason: "candidate_stock_or_price_unverified" });
});

Deno.test("socket, driver, technology, electrical range and IP remain critical", () => {
  const resolved = profile();
  assertEquals(evaluateStructuralReplacementCandidate(resolved, product("socket", {
    socket: "GU10",
  })), { ok: false, reason: "candidate_mismatch:socket" });
  assertEquals(evaluateStructuralReplacementCandidate(resolved, product("driver", {
    driver: "не в комплекте",
  })), { ok: false, reason: "candidate_mismatch:driver" });
  assertEquals(evaluateStructuralReplacementCandidate(resolved, product("lamp", {
    technology: "люминесцентная",
  })), { ok: false, reason: "candidate_mismatch:technology" });
  assertEquals(evaluateStructuralReplacementCandidate(resolved, product("voltage", {
    voltage: "230",
  })), { ok: false, reason: "candidate_voltage_unverified" });
  assertEquals(evaluateStructuralReplacementCandidate(resolved, product("ip", {
    ip: "10",
  })), { ok: false, reason: "candidate_ip_below_source" });
  assertEquals(evaluateStructuralReplacementCandidate(resolved, product("power", {
    power: "9",
  })), { ok: false, reason: "candidate_outside_window:power" });
});

Deno.test("source-backed light color and color temperature are exact candidate obligations", () => {
  const resolved = profile();
  assertEquals(evaluateStructuralReplacementCandidate(resolved, product("neutral", {
    lightColor: "нейтральный", colorTemperature: "4000",
  })).ok, true);
  assertEquals(evaluateStructuralReplacementCandidate(resolved, product("cold", {
    lightColor: "холодный", colorTemperature: "6500",
  })), { ok: false, reason: "candidate_mismatch:lightColor" });
  assertEquals(evaluateStructuralReplacementCandidate(resolved, product("cold-temperature", {
    colorTemperature: "6500",
  })), { ok: false, reason: "candidate_mismatch:colorTemperature" });
});

Deno.test("absent source color facts do not create a fabricated color obligation", () => {
  const source = product("source");
  for (const role of ["lightColor", "colorTemperature"]) {
    delete source.facet_values?.[`live_${role}`];
    delete source.facet_captions?.[`live_${role}`];
  }
  source.short_traits = source.short_traits.filter((trait) =>
    !["Цвет свечения:", "Цветовая температура, К:"].some((prefix) =>
      trait.startsWith(prefix)
    )
  );
  const resolved = resolveStructuralReplacementProfile(source, facets);
  assertEquals(resolved.status, "ready");
  if (resolved.status !== "ready") throw new Error("color-absent profile not ready");
  assertEquals(resolved.profile.obligations.some(({ role }) =>
    role === "lightColor" || role === "colorTemperature"), false);
  assertEquals(evaluateStructuralReplacementCandidate(resolved.profile, product("cold", {
    lightColor: "холодный", colorTemperature: "6500",
  })).ok, true);
});

Deno.test("noninformative source color is not an exact filter, contradictory color fails closed", () => {
  const uninformative = resolveStructuralReplacementProfile(product("source", {
    lightColor: "нет", colorTemperature: "не указано",
  }), facets);
  assertEquals(uninformative.status, "ready");
  if (uninformative.status !== "ready") throw new Error("uninformative profile not ready");
  assertEquals(uninformative.profile.obligations.some(({ role }) =>
    role === "lightColor" || role === "colorTemperature"), false);
  assertEquals(Object.keys(uninformative.profile.searchOptions).some((key) =>
    key === "live_lightColor" || key === "live_colorTemperature"), false);

  const contradictory = product("source");
  contradictory.short_traits = contradictory.short_traits.map((trait) =>
    trait === "Цвет свечения: нейтральный" ? "Цвет свечения: холодный" : trait
  );
  assertEquals(resolveStructuralReplacementProfile(contradictory, facets), {
    status: "unverifiable",
    reason: "source_value_conflicting:lightColor",
  });
});

Deno.test("applicable structural profile fails closed on missing or ambiguous live proof", () => {
  const missing = product("source");
  delete missing.facet_values?.live_diameter;
  assertEquals(resolveStructuralReplacementProfile(missing, facets), {
    status: "unverifiable",
    reason: "source_value_unverified:diameter",
  });
  const missingPower = product("source");
  delete missingPower.facet_values?.live_power;
  assertEquals(resolveStructuralReplacementProfile(missingPower, facets), {
    status: "unverifiable",
    reason: "source_value_unverified:power",
  });
  const conflict = product("source");
  conflict.facet_captions!.live_kind = "Вид упаковки";
  assertEquals(resolveStructuralReplacementProfile(conflict, facets), {
    status: "unverifiable",
    reason: "source_value_unverified:kind",
  });
  assertEquals(resolveStructuralReplacementProfile(product("source"), [
    ...facets,
    { ...facets[0], key: "alternate_kind" },
  ]).status, "ready");
  const duplicateSource = product("source");
  duplicateSource.facet_values!.alternate_kind = ["даунлайт"];
  duplicateSource.facet_captions!.alternate_kind = "Вид светильника";
  assertEquals(resolveStructuralReplacementProfile(duplicateSource, [
    ...facets,
    { ...facets[0], key: "alternate_kind" },
  ]), {
    status: "unverifiable",
    reason: "facet_role_ambiguous:kind",
  });
  const additionalPower = { ...facets.find(({ key }) => key === "live_power")!,
    key: "alternative_power", caption: "Мощность, Вт" };
  assertEquals(resolveStructuralReplacementProfile(product("source"), [
    ...facets,
    additionalPower,
  ]).status, "ready");
  const contradictory = product("candidate");
  contradictory.short_traits[0] = "Вид светильника: бытовые линейные светильники";
  assertEquals(evaluateStructuralReplacementCandidate(profile(), contradictory), {
    ok: false,
    reason: "candidate_value_unverified:kind",
  });
  const ambiguousColor = product("source");
  ambiguousColor.facet_values!.alternate_light_color = ["нейтральный"];
  ambiguousColor.facet_captions!.alternate_light_color = "Цвет свечения";
  assertEquals(resolveStructuralReplacementProfile(ambiguousColor, [
    ...facets,
    { ...facets.find(({ key }) => key === "live_lightColor")!,
      key: "alternate_light_color" },
  ]), { status: "unverifiable", reason: "facet_role_ambiguous:lightColor" });
});

Deno.test("unrelated catalogue family does not inherit the structural replacement gate", () => {
  const cable = product("source", {}, { leaf_category: "Кабели" });
  const cableFacets = facets.filter(({ key }) =>
    !["live_kind", "live_mount", "live_diameter"].includes(key)
  );
  assertEquals(resolveStructuralReplacementProfile(cable, cableFacets), {
    status: "not_applicable",
  });
  assertEquals(evaluateStructuralReplacementCandidate(profile(), product("wrong", {}, {
    leaf_category: "Лампы",
  })), { ok: false, reason: "candidate_category_unverified" });
});

Deno.test("kind, mounting and interface alone cannot certify an unrelated family", () => {
  const outletFacets: Facet[] = [
    { key: "outlet_kind", caption: "Вид розетки", type: "string", unit: null,
      values: [{ value: "силовая" }, { value: "информационная" }] },
    { key: "outlet_mount", caption: "Способ монтажа", type: "string", unit: null,
      values: [{ value: "встраиваемый" }, { value: "накладной" }] },
    { key: "outlet_interface", caption: "Тип подключения", type: "string", unit: null,
      values: [{ value: "винтовой" }, { value: "безвинтовой" }] },
  ];
  const outlet = (id: string, connection = "винтовой"): ProductFull => ({
    ...product(id),
    leaf_category: "Розетки",
    facet_values: {
      outlet_kind: ["силовая"], outlet_mount: ["встраиваемый"],
      outlet_interface: [connection],
    },
    facet_captions: {
      outlet_kind: "Вид розетки", outlet_mount: "Способ монтажа",
      outlet_interface: "Тип подключения",
    },
    short_traits: ["Вид розетки: силовая", "Способ монтажа: встраиваемый",
      `Тип подключения: ${connection}`],
  });
  const resolved = resolveStructuralReplacementProfile(outlet("source"), outletFacets);
  assertEquals(resolved, { status: "not_applicable" });
  assertEquals(resolveStructuralReplacementProfile(outlet("source"), [
    ...outletFacets,
    { key: "outlet_diameter", caption: "Диаметр, мм", type: "number", unit: "мм", values: [] },
  ]), { status: "not_applicable" });
});

Deno.test("a complete signature applies without a category or model allowlist", () => {
  const otherFacets = facets.map((facet) => facet.key === "live_kind"
    ? { ...facet, caption: "Вид прибора", values: [{ value: "сигнальный" }] }
    : facet);
  const otherProduct = (id: string): ProductFull => {
    const item = product(id, { kind: "сигнальный" }, {
      leaf_category: "Сигнальные приборы",
      pagetitle: `Сигнальный прибор ${id}`,
    });
    item.facet_captions!.live_kind = "Вид прибора";
    item.short_traits[0] = "Вид прибора: сигнальный";
    return item;
  };
  const resolved = resolveStructuralReplacementProfile(otherProduct("source"), otherFacets);
  assertEquals(resolved.status, "ready");
  if (resolved.status !== "ready") throw new Error("generic profile not ready");
  assertEquals(evaluateStructuralReplacementCandidate(resolved.profile, otherProduct("other")).ok, true);
});
