import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateReplacementCandidateFit } from "./replacement-candidate-fit.ts";
import type { ProductFull } from "./types.ts";
import type { VerifiedManufacturerFacts } from "./verified-manufacturer-facts.ts";

const traits = [
  ["mount", "Способ монтажа", "встраиваемый"],
  ["voltage", "Напряжение, В", "220-240"],
  ["ip", "Степень защиты, IP", "20"],
  ["diameter", "Диаметр, см", "9"],
  ["power", "Мощность ламп, Вт", "7"],
  ["flux", "Световой поток, Лм", "600"],
  ["cct", "Цветовая температура, К", "4000"],
  ["kind", "Вид светильника", "даунлайт"],
  ["technology", "Тип лампы", "LED"],
  ["socket", "Тип цоколя", "нет"],
  ["driver", "ПРА", "в комплекте"],
] as const;

function product(
  id: string,
  changed: Record<string, string> = {},
  overrides: Partial<ProductFull> = {},
): ProductFull {
  const entries = traits.map(([key, caption, value]) =>
    [
      key,
      caption,
      changed[key] ?? value,
    ] as const
  );
  return {
    id,
    pagetitle: id === "source"
      ? "Светильник DN027B G2 LED6/NW 7W 220-240V D90 R"
      : "Встраиваемый светильник, альтернативная модель",
    url: `https://220volt.kz/catalog/svetotexnika/svetilniki/${id}/`,
    article: id,
    vendor: "catalogue brand",
    price: 2000,
    stock: "in_stock",
    warehouse_evidence: "positive",
    warehouses: [{ city: "Караганда", qty: 7 }],
    leaf_category: "Светильники",
    description_excerpt:
      "Монтажное отверстие: 90 мм. Наружный диаметр: 115 мм.",
    short_traits: entries.map(([, caption, value]) => `${caption}: ${value}`),
    facet_values: Object.fromEntries(
      entries.map(([key, , value]) => [key, [value]]),
    ),
    facet_captions: Object.fromEntries(
      entries.map(([key, caption]) => [key, caption]),
    ),
    ...overrides,
  };
}

function withManufacturerDimensions(
  item: ProductFull,
  min_mm: number,
  max_mm: number,
  outer_diameter_mm: number | null = null,
): ProductFull {
  const verified_manufacturer_facts: VerifiedManufacturerFacts = {
    binding: {
      product_id: item.id,
      article: item.article!,
      catalog_url: item.url,
    },
    provenance: {
      source_url: "https://manufacturer.example.com/datasheets/downlight.pdf",
      document_version: "Rev 2026-08",
      document_page: 3,
      verified_at: "2026-10-20T08:00:00Z",
      valid_until: "2027-01-20T08:00:00Z",
      approved_at: "2026-10-20T09:00:00Z",
      approved_by: "QA",
    },
    technical: {
      cutout: {
        shape: "round",
        kind: min_mm === max_mm ? "exact" : "range",
        min_mm,
        max_mm,
      },
      outer_diameter_mm,
      color_temperature_k: null,
      integrated_led: null,
      socket: null,
      driver: null,
      supply_v: null,
    },
  };
  return { ...item, verified_manufacturer_facts };
}

function withManufacturerSupply(
  item: ProductFull,
  min: number,
  max: number,
): ProductFull {
  const withFacts = withManufacturerDimensions(item, 90, 90);
  withFacts.verified_manufacturer_facts!.technical.supply_v = { min, max };
  return withFacts;
}

Deno.test("measured Ø80 cut-out cannot replace a verified Ø90 cut-out", () => {
  const result = evaluateReplacementCandidateFit(
    product("source"),
    product("meson-080", {}, {
      description_excerpt:
        "Монтажное отверстие: 80 мм. Наружный диаметр: 95 мм.",
    }),
  );
  assertEquals(result.status, "hard_mismatch");
  assertEquals(result.checks.mounting_cutout_mm.status, "mismatch");
  assertEquals(
    result.checks.mounting_cutout_mm.source[0].origin,
    "catalog_content",
  );
  assertEquals(result.checks.mounting_cutout_mm.candidate[0].value, 80);
});

Deno.test("generic diameter and a model D90 never prove a missing cut-out", () => {
  const result = evaluateReplacementCandidateFit(
    product("source", {}, {
      description_excerpt: "Модель D90. Диаметр: 90 мм.",
    }),
    product("unknown", {}, {
      description_excerpt: "Диаметр: 90 мм. Модель D90.",
    }),
  );
  assertEquals(result.status, "insufficient_evidence");
  assertEquals(result.checks.mounting_cutout_mm.status, "unknown");
  assertEquals(result.checks.mounting_cutout_mm.source, []);
  assertEquals(result.checks.mounting_cutout_mm.candidate, []);
});

Deno.test("equal cut-out with different outer bezel remains provisional, never verified", () => {
  const result = evaluateReplacementCandidateFit(
    product("source"),
    product("iek-1612", { power: "9", flux: "620", diameter: "11.8" }, {
      description_excerpt:
        "Монтажное отверстие: 90 мм. Наружный диаметр: 118 мм.",
    }),
  );
  assertEquals(result.status, "provisional_candidate");
  assertEquals(result.checks.mounting_cutout_mm.status, "match");
  assertEquals(result.checks.outer_diameter_mm.status, "different");
  assertEquals(result.soft_differences.map(({ field }) => field).sort(), [
    "generic_diameter",
    "luminous_flux",
    "power",
  ]);
  assertEquals(result.remaining_checks.includes("outer_bezel_coverage"), true);
  assertEquals(
    result.remaining_checks.includes("driver_wiring_and_controls"),
    true,
  );
});

Deno.test("verified opening cannot be covered by an equal or smaller outer bezel", () => {
  for (const diameter of [80, 90]) {
    const result = evaluateReplacementCandidateFit(
      product("source"),
      product(`bezel-${diameter}`, {}, {
        description_excerpt:
          `Монтажное отверстие: 90 мм. Наружный диаметр: ${diameter} мм.`,
      }),
    );
    assertEquals(result.status, "hard_mismatch");
    assertEquals(result.checks.mounting_cutout_mm.status, "match");
    assertEquals(result.checks.outer_diameter_mm.status, "mismatch");
    assertEquals(
      result.checks.outer_diameter_mm.reason,
      "outer_bezel_does_not_cover_mounting_cutout",
    );
  }
});

Deno.test("confirmed mounting and disjoint electrical supply are hard mismatches", () => {
  const surface = evaluateReplacementCandidateFit(
    product("source"),
    product("surface", { mount: "накладной" }, {
      pagetitle: "Светильник накладной, альтернативная модель",
    }),
  );
  assertEquals(surface.status, "hard_mismatch");
  assertEquals(surface.checks.mounting_kind.status, "mismatch");
  assertEquals(
    surface.checks.mounting_kind.candidate[0].origin,
    "catalog_option",
  );

  const lowVoltage = evaluateReplacementCandidateFit(
    product("source"),
    product("low-voltage", { voltage: "12-24" }),
  );
  assertEquals(lowVoltage.status, "hard_mismatch");
  assertEquals(lowVoltage.checks.voltage_v.status, "mismatch");
});

Deno.test("different leaf, same source identity and explicit zero stock reject", () => {
  const source = product("source");
  const elsewhere = evaluateReplacementCandidateFit(
    source,
    product("elsewhere", {}, { leaf_category: "Прожекторы" }),
  );
  assertEquals(elsewhere.status, "hard_mismatch");
  assertEquals(elsewhere.checks.leaf_category.status, "mismatch");
  assertEquals(elsewhere.checks.leaf_category.candidate[0].value, "Прожекторы");

  const soldOut = evaluateReplacementCandidateFit(
    source,
    product("sold-out", {}, {
      stock: "out",
      warehouse_evidence: "explicit_zero",
      warehouses: [],
    }),
  );
  assertEquals(soldOut.status, "hard_mismatch");
  assertEquals(soldOut.checks.stock_and_price.status, "mismatch");

  const identical = evaluateReplacementCandidateFit(source, source);
  assertEquals(identical.status, "hard_mismatch");
  assertEquals(identical.checks.source_identity.status, "mismatch");
});

Deno.test("missing warehouse proof is insufficient, not a confirmed zero", () => {
  const result = evaluateReplacementCandidateFit(
    product("source"),
    product("uncertain-stock", {}, {
      stock: "unknown",
      warehouse_evidence: "unverified",
      warehouses: [],
    }),
  );
  assertEquals(result.status, "insufficient_evidence");
  assertEquals(result.checks.stock_and_price.status, "unknown");

  const contradictory = evaluateReplacementCandidateFit(
    product("source"),
    product("contradictory", {}, { stock: "out" }),
  );
  assertEquals(contradictory.status, "insufficient_evidence");
  assertEquals(contradictory.checks.stock_and_price.status, "unknown");
});

Deno.test("a different ID with the same catalog URL is not a second candidate", () => {
  const source = product("source");
  const result = evaluateReplacementCandidateFit(
    source,
    product("alias", {}, { url: source.url }),
  );
  assertEquals(result.status, "hard_mismatch");
  assertEquals(result.checks.source_identity.status, "mismatch");
  assertEquals(result.checks.source_identity.source[1].field, "url");
});

Deno.test("a customer-stated cut-out can establish the target without guessing from the model", () => {
  const source = product("source", {}, {
    description_excerpt: "Светильник D90. Диаметр: 9 см.",
  });
  const candidate = product("other", {}, {
    description_excerpt: "Монтажный вырез: 90 мм.",
  });
  const result = evaluateReplacementCandidateFit(source, candidate, {
    customer_cutout_mm: 90,
  });
  assertEquals(result.status, "provisional_candidate");
  assertEquals(result.checks.mounting_cutout_mm.source[0].origin, "customer");
  assertEquals(result.checks.mounting_cutout_mm.status, "match");
});

Deno.test("customer and source cut-out conflict requires clarification", () => {
  const result = evaluateReplacementCandidateFit(
    product("source"),
    product("other"),
    { customer_cutout_mm: 95 },
  );
  assertEquals(result.status, "insufficient_evidence");
  assertEquals(result.checks.mounting_cutout_mm.status, "unknown");
  assertEquals(
    result.checks.mounting_cutout_mm.reason,
    "customer_and_source_cutout_conflict",
  );
});

Deno.test("missing candidate cut-out stays insufficient despite matching generic diameter", () => {
  const result = evaluateReplacementCandidateFit(
    product("source"),
    product("unknown", {}, { description_excerpt: "Диаметр: 90 мм." }),
  );
  assertEquals(result.status, "insufficient_evidence");
  assertEquals(result.checks.mounting_cutout_mm.status, "unknown");
});

Deno.test("a verified IP downgrade rejects; an overlap-only voltage needs confirmation", () => {
  const wet = product("source", { ip: "44" });
  const indoor = evaluateReplacementCandidateFit(
    wet,
    product("indoor", { ip: "20" }),
  );
  assertEquals(indoor.status, "hard_mismatch");
  assertEquals(indoor.checks.ip_grade.status, "mismatch");

  const partialSupply = evaluateReplacementCandidateFit(
    product("source"),
    product("partial", { voltage: "220" }),
  );
  assertEquals(partialSupply.status, "insufficient_evidence");
  assertEquals(partialSupply.checks.voltage_v.status, "different");
});

Deno.test("approved manufacturer supply reconciles nominal 220 and 230 only with both exact bound rows", () => {
  const source = product("source", { voltage: "220" });
  const candidate = product("nominal-230", { voltage: "230" }, {
    pagetitle: "Встраиваемый светильник LED 230V",
  });
  assertEquals(evaluateReplacementCandidateFit(source, candidate).checks.voltage_v.status, "mismatch");
  const supported = evaluateReplacementCandidateFit(
    withManufacturerSupply(source, 220, 240),
    withManufacturerSupply(candidate, 220, 240),
  );
  assertEquals(supported.checks.voltage_v.status, "match");
  assertEquals(supported.checks.voltage_v.reason, "manufacturer_candidate_voltage_covers_source");
  assertEquals(supported.status, "provisional_candidate");
  assertEquals(supported.checks.voltage_v.source.some(({ origin, provenance }) =>
    origin === "manufacturer" && Boolean(provenance?.source_url)), true);
  const oneSided = evaluateReplacementCandidateFit(
    withManufacturerSupply(source, 220, 240), candidate,
  );
  assertEquals(oneSided.checks.voltage_v.status, "mismatch");
  const wrongBinding = withManufacturerSupply(candidate, 220, 240);
  wrongBinding.verified_manufacturer_facts!.binding.article = "other-article";
  assertEquals(evaluateReplacementCandidateFit(
    withManufacturerSupply(source, 220, 240), wrongBinding,
  ).checks.voltage_v.status, "mismatch");
});

Deno.test("manufacturer voltage proof fails closed on explicit 12V, unsupported range and ambiguous claims", () => {
  const source = withManufacturerSupply(product("source", { voltage: "220" }), 220, 240);
  const checked = (candidate: ProductFull) => evaluateReplacementCandidateFit(
    source, withManufacturerSupply(candidate, 220, 240),
  ).checks.voltage_v;
  assertEquals(checked(product("catalog-12", { voltage: "12" })).status, "unknown");
  assertEquals(checked(product("title-12", { voltage: "230" }, {
    pagetitle: "Встраиваемый светильник LED 12V",
  })).status, "unknown");
  assertEquals(checked(product("content-12", { voltage: "230" }, {
    description_excerpt: "Напряжение: 12 В. Монтажное отверстие: 90 мм. Наружный диаметр: 115 мм.",
  })).status, "unknown");
  assertEquals(checked(product("unsupported-catalog", { voltage: "220-250" })).status, "unknown");
  assertEquals(checked(product("ambiguous-content", { voltage: "230" }, {
    description_excerpt: "Напряжение: 220/240 В. Монтажное отверстие: 90 мм. Наружный диаметр: 115 мм.",
  })).status, "unknown");
  const outputVoltage = checked(product("separate-output", { voltage: "230" }, {
    description_excerpt: "Выходное напряжение: 12 В. Монтажное отверстие: 90 мм. Наружный диаметр: 115 мм.",
  }));
  assertEquals(outputVoltage.status, "match");
});

Deno.test("manufacturer partial supply overlap remains a confirmation, not a matched replacement", () => {
  const source = withManufacturerSupply(product("source", { voltage: "220" }), 220, 240);
  const candidate = withManufacturerSupply(
    product("partial-official", { voltage: "230" }), 220, 230,
  );
  const result = evaluateReplacementCandidateFit(source, candidate);
  assertEquals(result.checks.voltage_v.status, "different");
  assertEquals(result.status, "insufficient_evidence");
  const disjoint = evaluateReplacementCandidateFit(
    source,
    withManufacturerSupply(product("low-voltage", { voltage: "12" }), 12, 24),
  );
  assertEquals(disjoint.checks.voltage_v.status, "mismatch");
});

Deno.test("explicit 12V title or supply-content contradicts a 220–240V option without becoming fit proof", () => {
  const source = product("source");
  for (
    const candidate of [
      product("title-12v", {}, {
        pagetitle: "Встраиваемый светильник LED 12V",
      }),
      product("content-12v", {}, {
        description_excerpt:
          "Напряжение: 12 В. Монтажное отверстие: 90 мм. Наружный диаметр: 115 мм.",
      }),
    ]
  ) {
    const result = evaluateReplacementCandidateFit(source, candidate);
    assertEquals(result.status, "insufficient_evidence");
    assertEquals(result.checks.voltage_v.status, "unknown");
    assertEquals(
      result.checks.voltage_v.reason,
      "candidate_voltage_evidence_conflicts",
    );
    assertEquals(
      result.checks.voltage_v.candidate.some(({ origin }) =>
        origin === "catalog_field" || origin === "catalog_content"
      ),
      true,
    );
  }
  const missingOption = product("missing-voltage", {}, {
    pagetitle: "Встраиваемый светильник LED 220V",
  });
  delete missingOption.facet_values?.voltage;
  const unproven = evaluateReplacementCandidateFit(source, missingOption);
  assertEquals(unproven.checks.voltage_v.status, "unknown");
  assertEquals(unproven.checks.voltage_v.reason, "voltage_unverified");

  const sourceContradiction = evaluateReplacementCandidateFit(
    product("source", {}, {
      description_excerpt:
        "Напряжение питания: 12 В. Монтажное отверстие: 90 мм. Наружный диаметр: 115 мм.",
    }),
    product("candidate"),
  );
  assertEquals(sourceContradiction.status, "insufficient_evidence");
  assertEquals(
    sourceContradiction.checks.voltage_v.reason,
    "source_voltage_evidence_conflicts",
  );

  const separateDriverOutput = evaluateReplacementCandidateFit(
    source,
    product("driver-output", {}, {
      description_excerpt:
        "Выходное напряжение: 12 В. Монтажное отверстие: 90 мм. Наружный диаметр: 115 мм.",
    }),
  );
  assertEquals(separateDriverOutput.checks.voltage_v.status, "match");
  assertEquals(separateDriverOutput.status, "provisional_candidate");
});

Deno.test("a partial supply claim conflicts with a wider catalogue voltage option", () => {
  const result = evaluateReplacementCandidateFit(
    product("source"),
    product("partial-supply", {}, {
      description_excerpt:
        "Напряжение питания: 220–230 В. Монтажное отверстие: 90 мм. Наружный диаметр: 115 мм.",
    }),
  );
  assertEquals(result.status, "insufficient_evidence");
  assertEquals(result.checks.voltage_v.status, "unknown");
  assertEquals(
    result.checks.voltage_v.reason,
    "candidate_voltage_evidence_conflicts",
  );
  assertEquals(
    result.checks.voltage_v.candidate.some(({ origin }) =>
      origin === "catalog_content"
    ),
    true,
  );
  const titleRange = evaluateReplacementCandidateFit(
    product("source"),
    product("partial-title-range", {}, {
      pagetitle: "Встраиваемый LED 220-230V",
    }),
  );
  assertEquals(titleRange.status, "insufficient_evidence");
  assertEquals(
    titleRange.checks.voltage_v.reason,
    "candidate_voltage_evidence_conflicts",
  );
  const nominalTitle = evaluateReplacementCandidateFit(
    product("source"),
    product("nominal-title", {}, {
      pagetitle: "Встраиваемый LED 220V",
    }),
  );
  assertEquals(nominalTitle.status, "provisional_candidate");
});

Deno.test("explicit IP20 title or content contradicts an IP65 option", () => {
  const source = product("source", { ip: "65" });
  for (
    const candidate of [
      product("title-ip20", { ip: "65" }, {
        pagetitle: "Встраиваемый светильник LED IP20",
      }),
      product("content-ip20", { ip: "65" }, {
        description_excerpt:
          "Степень защиты: IP20. Монтажное отверстие: 90 мм. Наружный диаметр: 115 мм.",
      }),
    ]
  ) {
    const result = evaluateReplacementCandidateFit(source, candidate);
    assertEquals(result.status, "insufficient_evidence");
    assertEquals(result.checks.ip_grade.status, "unknown");
    assertEquals(
      result.checks.ip_grade.reason,
      "candidate_ip_evidence_conflicts",
    );
  }
  const missingOption = product("missing-ip", {}, {
    pagetitle: "Встраиваемый светильник LED IP20",
  });
  delete missingOption.facet_values?.ip;
  const unproven = evaluateReplacementCandidateFit(
    product("source"),
    missingOption,
  );
  assertEquals(unproven.checks.ip_grade.status, "unknown");
  assertEquals(unproven.checks.ip_grade.reason, "ip_grade_unverified");

  const sourceContradiction = evaluateReplacementCandidateFit(
    product("source", { ip: "65" }, {
      description_excerpt:
        "Степень защиты: IP20. Монтажное отверстие: 90 мм. Наружный диаметр: 115 мм.",
    }),
    product("candidate", { ip: "65" }),
  );
  assertEquals(sourceContradiction.status, "insufficient_evidence");
  assertEquals(
    sourceContradiction.checks.ip_grade.reason,
    "source_ip_evidence_conflicts",
  );
});

Deno.test("an uncorroborated mounting facet is not treated as proof", () => {
  const candidate = product("unknown");
  candidate.short_traits = candidate.short_traits.filter((trait) =>
    !trait.startsWith("Способ монтажа:")
  );
  const result = evaluateReplacementCandidateFit(product("source"), candidate);
  assertEquals(result.status, "insufficient_evidence");
  assertEquals(result.checks.mounting_kind.status, "unknown");
});

Deno.test("different merchandising facet values are soft differences, not proof of failed fit", () => {
  const result = evaluateReplacementCandidateFit(
    product("source"),
    product("other", {
      kind: "декоративный даунлайт",
      driver: "не в комплекте",
    }),
  );
  assertEquals(result.status, "provisional_candidate");
  assertEquals(result.soft_differences.map(({ field }) => field).sort(), [
    "driver",
    "kind",
  ]);
  assertEquals(
    result.remaining_checks.includes("driver_wiring_and_controls"),
    true,
  );
});

Deno.test("mounting option contradicted by explicit title or content is insufficient, not provisional", () => {
  const source = product("source");
  const titleConflict = evaluateReplacementCandidateFit(
    source,
    product("title-conflict", {}, {
      pagetitle: "Светильник накладной LED 7W",
    }),
  );
  assertEquals(titleConflict.status, "insufficient_evidence");
  assertEquals(titleConflict.checks.mounting_kind.status, "unknown");
  assertEquals(
    titleConflict.checks.mounting_kind.reason,
    "candidate_mounting_evidence_conflicts",
  );
  assertEquals(
    titleConflict.checks.mounting_kind.candidate.some((item) =>
      item.field === "pagetitle"
    ),
    true,
  );

  const contentConflict = evaluateReplacementCandidateFit(
    source,
    product("content-conflict", {}, {
      description_excerpt:
        "Способ монтажа: накладной. Монтажное отверстие: 90 мм. Наружный диаметр: 115 мм.",
    }),
  );
  assertEquals(contentConflict.status, "insufficient_evidence");
  assertEquals(contentConflict.checks.mounting_kind.status, "unknown");
  assertEquals(
    contentConflict.checks.mounting_kind.candidate.some((item) =>
      item.origin === "catalog_content"
    ),
    true,
  );

  const phraseConflict = evaluateReplacementCandidateFit(
    source,
    product("phrase-conflict", {}, {
      description_excerpt:
        "Накладной светильник для сухих помещений. Монтажное отверстие: 90 мм. Наружный диаметр: 115 мм.",
    }),
  );
  assertEquals(phraseConflict.status, "insufficient_evidence");
  assertEquals(phraseConflict.checks.mounting_kind.status, "unknown");
});

Deno.test("title does not promote an absent mounting option into positive proof", () => {
  const candidate = product("text-only", {}, {
    pagetitle: "Встраиваемый светильник LED",
  });
  delete candidate.facet_values?.mount;
  const result = evaluateReplacementCandidateFit(product("source"), candidate);
  assertEquals(result.status, "insufficient_evidence");
  assertEquals(result.checks.mounting_kind.status, "unknown");
});

Deno.test("integrated LED/no-socket and halogen GU10 are a hard functional mismatch", () => {
  const result = evaluateReplacementCandidateFit(
    product("source"),
    product("halogen-gu10", { technology: "галогенная", socket: "GU10" }, {
      pagetitle: "Встраиваемый светильник галогенный GU10",
    }),
  );
  assertEquals(result.status, "hard_mismatch");
  assertEquals(result.checks.mounting_cutout_mm.status, "match");
  assertEquals(result.checks.mounting_kind.status, "match");
  assertEquals(result.checks.lamp_interface.status, "mismatch");
  assertEquals(
    result.checks.lamp_interface.reason,
    "lamp_socket_interface_conflicts",
  );
  assertEquals(
    result.functional_differences.map((difference) => [
      difference.field,
      difference.status,
    ]),
    [["technology", "incompatible"], ["socket", "incompatible"]],
  );
  assertEquals(result.soft_differences, []);
});

Deno.test("typed LED and no-socket synonyms preserve provisional status", () => {
  const result = evaluateReplacementCandidateFit(
    product("source"),
    product("same-interface", {
      technology: "светодиодная",
      socket: "без цоколя",
    }),
  );
  assertEquals(result.status, "provisional_candidate");
  assertEquals(result.checks.lamp_interface.status, "match");
  assertEquals(result.functional_differences, []);
});

Deno.test("opaque functional terms or contradictory title require confirmation", () => {
  const unknown = evaluateReplacementCandidateFit(
    product("source"),
    product("opaque", {
      technology: "универсальная",
      socket: "универсальный",
    }),
  );
  assertEquals(unknown.status, "insufficient_evidence");
  assertEquals(unknown.checks.lamp_interface.status, "unknown");
  assertEquals(unknown.functional_differences.map(({ status }) => status), [
    "requires_confirmation",
    "requires_confirmation",
  ]);

  const contradictory = evaluateReplacementCandidateFit(
    product("source"),
    product("contradictory-interface", {
      technology: "галогенная",
      socket: "GU10",
    }, { pagetitle: "Встраиваемый светильник LED GU10" }),
  );
  assertEquals(contradictory.status, "insufficient_evidence");
  assertEquals(contradictory.checks.lamp_interface.status, "unknown");
  assertEquals(
    contradictory.checks.lamp_interface.reason,
    "candidate_lamp_interface_evidence_conflicts",
  );
  assertEquals(
    contradictory.functional_differences.map(({ status }) => status),
    ["requires_confirmation", "requires_confirmation"],
  );
});

Deno.test("Cyrillic Е27 and mixed-script ГU10 in titles cannot bypass socket contradiction", () => {
  for (
    const title of [
      "Встраиваемый светильник Е27",
      "Встраиваемый светильник ГU10",
      "Встраиваемый светильник Г13",
    ]
  ) {
    const result = evaluateReplacementCandidateFit(
      product("source"),
      product("mixed-script", {}, { pagetitle: title }),
    );
    assertEquals(result.status, "insufficient_evidence");
    assertEquals(result.checks.lamp_interface.status, "unknown");
    assertEquals(
      result.checks.lamp_interface.reason,
      "candidate_lamp_interface_evidence_conflicts",
    );
  }
  const sameSocket = evaluateReplacementCandidateFit(
    product("source", { socket: "GU10" }),
    product("same-socket", { socket: "ГU10" }, {
      pagetitle: "Встраиваемый светильник ГU10",
    }),
  );
  assertEquals(sameSocket.status, "provisional_candidate");
  assertEquals(sameSocket.checks.lamp_interface.status, "match");
  assertEquals(sameSocket.functional_differences, []);
});

Deno.test("manufacturer-only candidate cut-out range accepts exact source boundaries", () => {
  for (const opening of [90, 95]) {
    const source = product("source", {}, {
      description_excerpt:
        `Монтажное отверстие: ${opening} мм. Наружный диаметр: 115 мм.`,
    });
    const candidate = withManufacturerDimensions(
      product(`manufacturer-${opening}`, {}, {
        description_excerpt: "Модель D90. Диаметр: 9 см.",
      }),
      90,
      95,
      118,
    );
    const result = evaluateReplacementCandidateFit(source, candidate);
    assertEquals(result.status, "provisional_candidate");
    assertEquals(result.checks.mounting_cutout_mm.status, "match");
    assertEquals(
      result.checks.mounting_cutout_mm.candidate[0].origin,
      "manufacturer",
    );
    assertEquals(
      result.checks.mounting_cutout_mm.candidate[0].value,
      "90–95 mm",
    );
    assertEquals(
      result.checks.mounting_cutout_mm.candidate[0].provenance
        ?.document_version,
      "Rev 2026-08",
    );
    assertEquals(
      result.remaining_checks.includes("driver_wiring_and_controls"),
      true,
    );
  }
});

Deno.test("customer exact opening can establish fit inside manufacturer range", () => {
  const source = product("source", {}, {
    description_excerpt: "Модель D90. Диаметр: 9 см.",
  });
  const candidate = withManufacturerDimensions(
    product("manufacturer-candidate", {}, {
      description_excerpt: "Модель D90. Диаметр: 9 см.",
    }),
    90,
    95,
    118,
  );
  const result = evaluateReplacementCandidateFit(source, candidate, {
    customer_cutout_mm: 95,
  });
  assertEquals(result.status, "provisional_candidate");
  assertEquals(result.checks.mounting_cutout_mm.status, "match");
  assertEquals(result.checks.mounting_cutout_mm.source[0].origin, "customer");
  const outside = evaluateReplacementCandidateFit(source, candidate, {
    customer_cutout_mm: 96,
  });
  assertEquals(outside.status, "hard_mismatch");
  assertEquals(outside.checks.mounting_cutout_mm.status, "mismatch");
});

Deno.test("manufacturer source range without measured opening remains unknown or disjoint", () => {
  const source = withManufacturerDimensions(
    product("source", {}, { description_excerpt: "Модель D90." }),
    90,
    95,
    115,
  );
  const inside = evaluateReplacementCandidateFit(
    source,
    product("inside", {}, {
      description_excerpt:
        "Монтажное отверстие: 92 мм. Наружный диаметр: 118 мм.",
    }),
  );
  assertEquals(inside.status, "insufficient_evidence");
  assertEquals(inside.checks.mounting_cutout_mm.status, "unknown");
  assertEquals(
    inside.checks.mounting_cutout_mm.reason,
    "source_cutout_range_requires_actual_opening",
  );
  const disjoint = evaluateReplacementCandidateFit(
    source,
    product("disjoint", {}, {
      description_excerpt:
        "Монтажное отверстие: 80 мм. Наружный диаметр: 118 мм.",
    }),
  );
  assertEquals(disjoint.status, "hard_mismatch");
  assertEquals(
    disjoint.checks.mounting_cutout_mm.reason,
    "mounting_cutout_ranges_disjoint",
  );
  const measured = evaluateReplacementCandidateFit(
    source,
    product("measured", {}, {
      description_excerpt:
        "Монтажное отверстие: 92 мм. Наружный диаметр: 118 мм.",
    }),
    { customer_cutout_mm: 92 },
  );
  assertEquals(measured.status, "provisional_candidate");
  const contradictedCustomer = evaluateReplacementCandidateFit(
    source,
    product("customer-outside-source-range", {}, {
      description_excerpt:
        "Монтажное отверстие: 96 мм. Наружный диаметр: 118 мм.",
    }),
    { customer_cutout_mm: 96 },
  );
  assertEquals(contradictedCustomer.status, "insufficient_evidence");
  assertEquals(
    contradictedCustomer.checks.mounting_cutout_mm.reason,
    "customer_and_source_cutout_conflict",
  );
});

Deno.test("catalog contradiction and title spoof cannot become manufacturer fit proof", () => {
  const source = product("source");
  const conflict = evaluateReplacementCandidateFit(
    source,
    withManufacturerDimensions(
      product("conflict", {}, {
        description_excerpt:
          "Монтажное отверстие: 80 мм. Наружный диаметр: 118 мм.",
      }),
      90,
      95,
      118,
    ),
  );
  assertEquals(conflict.status, "insufficient_evidence");
  assertEquals(conflict.checks.mounting_cutout_mm.status, "unknown");
  const spoof = evaluateReplacementCandidateFit(
    source,
    product("spoof", {}, {
      pagetitle: "Встраиваемый светильник D90 cut-out 90 mm",
      description_excerpt: "Диаметр: 90 мм.",
    }),
  );
  assertEquals(spoof.status, "insufficient_evidence");
  assertEquals(spoof.checks.mounting_cutout_mm.status, "unknown");
});

Deno.test("conflicting outer diameter requires coverage confirmation", () => {
  const candidate = withManufacturerDimensions(
    product("outer-conflict", {}, {
      description_excerpt:
        "Монтажное отверстие: 90 мм. Наружный диаметр: 110 мм.",
    }),
    90,
    90,
    118,
  );
  const result = evaluateReplacementCandidateFit(product("source"), candidate);
  assertEquals(result.checks.mounting_cutout_mm.status, "match");
  assertEquals(result.checks.outer_diameter_mm.status, "unknown");
  assertEquals(
    result.checks.outer_diameter_mm.candidate.some(({ origin }) =>
      origin === "manufacturer"
    ),
    true,
  );
  assertEquals(result.remaining_checks.includes("outer_bezel_coverage"), true);
});

Deno.test("verified opening still requires the manufacturer bezel to cover it", () => {
  const source = product("source", {}, {
    description_excerpt:
      "Монтажное отверстие: 95 мм. Наружный диаметр: 115 мм.",
  });
  const candidate = withManufacturerDimensions(
    product("small-bezel", {}, { description_excerpt: "Диаметр: 95 мм." }),
    90,
    95,
    95,
  );
  const result = evaluateReplacementCandidateFit(source, candidate);
  assertEquals(result.status, "hard_mismatch");
  assertEquals(result.checks.mounting_cutout_mm.status, "match");
  assertEquals(result.checks.outer_diameter_mm.status, "mismatch");
  assertEquals(
    result.checks.outer_diameter_mm.reason,
    "outer_bezel_does_not_cover_mounting_cutout",
  );
});

Deno.test("manufacturer dimensions never override stock, voltage or socket gates", () => {
  const source = product("source");
  const base = product("manufacturer-candidate", {}, {
    description_excerpt: "Диаметр: 90 мм.",
  });
  const lowVoltage = evaluateReplacementCandidateFit(
    source,
    withManufacturerDimensions(
      product("low-voltage-facts", { voltage: "12-24" }, {
        description_excerpt: "Диаметр: 90 мм.",
      }),
      90,
      90,
      118,
    ),
  );
  assertEquals(lowVoltage.checks.mounting_cutout_mm.status, "match");
  assertEquals(lowVoltage.checks.voltage_v.status, "mismatch");
  const wrongSocket = evaluateReplacementCandidateFit(
    source,
    withManufacturerDimensions(
      product("wrong-socket-facts", { socket: "GU10" }, {
        description_excerpt: "Диаметр: 90 мм.",
      }),
      90,
      90,
      118,
    ),
  );
  assertEquals(wrongSocket.checks.lamp_interface.status, "mismatch");
  const unavailable = evaluateReplacementCandidateFit(
    source,
    withManufacturerDimensions(
      {
        ...base,
        stock: "out",
        warehouse_evidence: "explicit_zero",
        warehouses: [],
        price: 0,
      },
      90,
      90,
      118,
    ),
  );
  assertEquals(unavailable.checks.stock_and_price.status, "mismatch");
  assertEquals(unavailable.status, "hard_mismatch");
});
