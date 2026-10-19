import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractVisibleSystemTotalMinimum,
  resolveVisibleSystemTotalRequirement,
  visibleSystemTotalHasProvenance,
  type SystemCapacityPlanLine,
  type SystemTotalCapacityRequirement,
  verifySystemTotalCapacityPlan as verifyRawSystemTotalCapacityPlan,
  visiblePlanProvesSkuQuantity,
} from "./system-total-capacity.ts";

const fluxRequirement: SystemTotalCapacityRequirement = {
  measurementScope: "system_total",
  outputFacet: { key: "flux", caption: "Световой поток, лм", unit: "лм" },
  unit: "лм",
  minimumTotal: 1800,
  minimumUnits: 2,
  aggregationProof: "verified_additive_plan",
};

function fluxProduct(id: string, value: string) {
  return {
    id,
    pagetitle: `Fixture ${id} ${value} lm`,
    facet_values: { flux: [value] },
    short_traits: [`Световой поток: ${value} лм`],
  };
}

function verifySystemTotalCapacityPlan(
  requirement: SystemTotalCapacityRequirement,
  lines: SystemCapacityPlanLine[],
) {
  const visiblePlanText = lines
    .filter((line) =>
      line.quantitySource === "visible_plan" && line.quantity !== null &&
      Boolean(line.product.pagetitle)
    )
    .map((line) => `${line.quantity} шт × ${line.product.pagetitle}`)
    .join(". ");
  return verifyRawSystemTotalCapacityPlan(
    requirement,
    lines,
    visiblePlanText,
  );
}

Deno.test("visible hard system minimum wins over a higher advisory range", () => {
  const reasoning =
    "Для двора площадью 120 м² нужен световой поток. Световой поток = 120 м² × 150 лк = 18 000 лм (минимум). С учётом высоты рекомендую световой поток не менее 20 000–24 000 лм. Это суммарная потребность всей системы.";
  assertEquals(
    extractVisibleSystemTotalMinimum({
      measurementScope: "system_total",
      reasoningText: reasoning,
      customerEvidence:
        "Для двора площадью 120 м² нужны варианты освещения. Требуемая освещенность не менее 150 лк.",
      outputFacet: fluxRequirement.outputFacet,
      unit: "lm",
    }),
    {
      minimumTotal: 18000,
      unit: "лм",
      strictMinimum: false,
      evidence: "Световой поток = 120 м² × 150 лк = 18 000 лм (минимум)",
    },
  );
});

Deno.test("system minimum parser does not promote advice, ranges or wrong axes", () => {
  const input = {
    measurementScope: "system_total",
    outputFacet: fluxRequirement.outputFacet,
    unit: "лм",
    customerEvidence: "Нужны варианты для участка 120 м².",
  };
  assertEquals(
    extractVisibleSystemTotalMinimum({
      ...input,
      reasoningText: "Рекомендую световой поток не менее 20 000 лм.",
    }),
    null,
  );
  assertEquals(
    extractVisibleSystemTotalMinimum({
      ...input,
      reasoningText: "Ориентир: световой поток 20 000–24 000 лм.",
    }),
    null,
  );
  assertEquals(
    extractVisibleSystemTotalMinimum({
      ...input,
      reasoningText: "Нужна мощность не менее 2000 Вт.",
    }),
    null,
  );
  assertEquals(
    extractVisibleSystemTotalMinimum({
      ...input,
      measurementScope: "per_product",
      reasoningText: "Нужен световой поток не менее 2000 лм.",
    }),
    null,
  );
});

Deno.test("system minimum parser is generic and distinguishes physical roles", () => {
  const outputFacet = {
    key: "throughput",
    caption: "Выходная производительность, кг",
    unit: "кг",
  };
  assertEquals(
    extractVisibleSystemTotalMinimum({
      measurementScope: "system_total",
      reasoningText:
        "Для установки нужна входная производительность не менее 60 кг. Выходная производительность должна быть более 35 кг суммарно.",
      customerEvidence:
        "Для установки нужна суммарная выходная производительность более 35 кг.",
      outputFacet,
      unit: "кг",
    }),
    {
      minimumTotal: 35,
      unit: "кг",
      strictMinimum: true,
      evidence: "Выходная производительность должна быть более 35 кг суммарно",
    },
  );
  assertEquals(
    extractVisibleSystemTotalMinimum({
      measurementScope: "system_total",
      reasoningText: "Нужна входная производительность не менее 60 кг.",
      customerEvidence:
        "Для установки нужна суммарная выходная производительность более 35 кг.",
      outputFacet,
      unit: "кг",
    }),
    null,
  );
});

Deno.test("visible total binds only to a unique live output facet", () => {
  const reasoning =
    "Для объекта световой поток должен быть не менее 5000 лм суммарно.";
  const facet = { key: "flux", caption: "Световой поток, лм", unit: null };
  assertEquals(
    resolveVisibleSystemTotalRequirement({
      measurementScope: "system_total",
      reasoningText: reasoning,
      customerEvidence:
        "Для объекта нужен световой поток не менее 5000 лм суммарно.",
      facets: [
        { key: "area", caption: "Площадь, м²", unit: "м²" },
        facet,
      ],
      minimumUnits: 2,
    }),
    {
      measurementScope: "system_total",
      outputFacet: facet,
      unit: "лм",
      minimumTotal: 5000,
      strictMinimum: false,
      minimumUnits: 2,
    },
  );
  assertEquals(
    resolveVisibleSystemTotalRequirement({
      measurementScope: "system_total",
      reasoningText: reasoning,
      customerEvidence:
        "Для объекта нужен световой поток не менее 5000 лм суммарно.",
      facets: [facet, { ...facet, key: "other_flux" }],
    }),
    null,
  );
});

Deno.test("bare model system totals never become hard requirements, while customer totals and transparent arithmetic do", () => {
  const facet = { key: "throughput", caption: "Выходная производительность, кг", unit: "кг" };
  const base = {
    measurementScope: "system_total",
    facets: [facet],
  };
  assertEquals(
    resolveVisibleSystemTotalRequirement({
      ...base,
      customerEvidence: "Нужно обработать участок площадью 120 м². Предложи варианты.",
      reasoningText: "Выходная производительность всей системы должна быть не менее 24 000 кг.",
    }),
    null,
  );
  assertEquals(
    resolveVisibleSystemTotalRequirement({
      ...base,
      customerEvidence: "Нужна суммарная выходная производительность не менее 24 000 кг.",
      reasoningText: "Выходная производительность всей системы должна быть не менее 24 000 кг.",
    })?.minimumTotal,
    24000,
  );
  assertEquals(
    resolveVisibleSystemTotalRequirement({
      ...base,
      customerEvidence: "Каждому прибору нужна производительность не менее 24 000 кг.",
      reasoningText: "Выходная производительность всей системы должна быть не менее 24 000 кг.",
    }),
    null,
  );
  assertEquals(
    resolveVisibleSystemTotalRequirement({
      ...base,
      customerEvidence: "На каждый прибор производительность до 24 000 кг.",
      reasoningText: "Выходная производительность всей системы должна быть не менее 24 000 кг.",
    }),
    null,
  );
  assertEquals(
    resolveVisibleSystemTotalRequirement({
      ...base,
      customerEvidence: "Ориентир по суммарной производительности — около 24 000 кг.",
      reasoningText: "Выходная производительность всей системы должна быть не менее 24 000 кг.",
    }),
    null,
  );
  for (const customerEvidence of [
    "Сейчас стоит прибор с производительностью 24 000 кг, покажи другие варианты.",
    "Не более 24 000 кг должно быть у всей системы.",
    "Максимальная суммарная производительность — 24 000 кг.",
  ]) {
    assertEquals(
      resolveVisibleSystemTotalRequirement({
        ...base,
        customerEvidence,
        reasoningText:
          "Выходная производительность всей системы должна быть не менее 24 000 кг.",
      }),
      null,
    );
  }
  assertEquals(
    resolveVisibleSystemTotalRequirement({
      ...base,
      customerEvidence:
        "Нужно обработать участок площадью 120 м². Нужна плотность не менее 15 кг/м². Предложи варианты.",
      reasoningText:
        "Выходная производительность должна быть не менее 1800 кг: 120 м² × 15 кг/м² = 1800 кг.",
    })?.minimumTotal,
    1800,
  );
  assertEquals(
    resolveVisibleSystemTotalRequirement({
      ...base,
      customerEvidence:
        "Нужно обработать участок площадью 120 м². Нужна плотность не менее 15 кг/м². Предложи варианты.",
      reasoningText:
        "Выходная производительность должна быть не менее 24 000 кг: 120 м² × 15 кг/м² = 24 000 кг.",
    }),
    null,
  );
});

Deno.test("transparent aggregate equations require compatible dimensions and scaled arithmetic", () => {
  const areaRequest = "Для участка площадью 120 м² нужны варианты.";
  const hasProof = (
    reasoningText: string,
    value: number,
    unit: string,
    customerEvidence = areaRequest,
  ) =>
    visibleSystemTotalHasProvenance({
      customerEvidence,
      reasoningText,
      value,
      unit,
    });

  assertEquals(
    hasProof(
      "Световой поток: 120 м² × 15 лк = 1800 лм.",
      1800,
      "лм",
      `${areaRequest} Нужна освещенность не менее 15 лк.`,
    ),
    true,
  );
  assertEquals(
    hasProof(
      "Выходная масса: 120 м² × 2 кг/м² = 240 кг.",
      240,
      "кг",
      `${areaRequest} Нужна плотность не менее 2 кг/м².`,
    ),
    true,
  );
  assertEquals(
    hasProof(
      "Мощность: 120 м² × 15 Вт/м² = 1800 Вт.",
      1800,
      "Вт",
      `${areaRequest} Требуется удельная мощность 15 Вт/м².`,
    ),
    true,
  );
  for (const reasoningText of [
    "Световой поток: 120 м² × 200 Вт = 24 000 лм.",
    "Световой поток: 120 м² × 200 Вт/м² = 24 000 лм.",
    "Световой поток: 120 м² × 200 абв/м² = 24 000 лм.",
  ]) {
    assertEquals(hasProof(reasoningText, 24000, "лм"), false);
  }
  assertEquals(hasProof("Световой поток: 120 м² × 15 = 1800 лм.", 1800, "лм"), false);
  assertEquals(hasProof("Масса: 120 м² × 15 лк = 1800 кг.", 1800, "кг"), false);

  assertEquals(
    visibleSystemTotalHasProvenance({
      customerEvidence: "Площадь 120 см²; нужна освещенность 15 лк.",
      reasoningText: "Световой поток: 120 см² × 15 лк = 1800 лм.",
      value: 1800,
      unit: "лм",
    }),
    false,
  );
  assertEquals(
    visibleSystemTotalHasProvenance({
      customerEvidence: "Площадь 120 см²; нужна освещенность 15 лк.",
      reasoningText: "Световой поток: 120 см² × 15 лк = 0,18 лм.",
      value: 0.18,
      unit: "лм",
    }),
    true,
  );
});

Deno.test("plain area exponents and inflected lux retain typed provenance", () => {
  for (const area of ["м²", "м2", "кв. м"]) {
    for (const lux of ["лк", "люкс", "люксов"]) {
      assertEquals(
        visibleSystemTotalHasProvenance({
          customerEvidence:
            `Участок площадью 120 ${area}; нужна освещенность 15 ${lux}.`,
          reasoningText:
            `Световой поток: 120 ${area} × 15 ${lux} = 1800 лм.`,
          value: 1800,
          unit: "лм",
        }),
        true,
      );
    }
  }
  assertEquals(
    visibleSystemTotalHasProvenance({
      customerEvidence:
        "Объем резервуара 10 м3. Нужна плотность не менее 2 кг/м3.",
      reasoningText: "Масса: 10 м3 × 2 кг/м3 = 20 кг.",
      value: 20,
      unit: "кг",
    }),
    true,
  );
});

Deno.test("area notation cannot become a customer-owned length or voltage", () => {
  for (const area of ["м2", "кв. м"]) {
    assertEquals(
      visibleSystemTotalHasProvenance({
        customerEvidence:
          `Нужна суммарная площадь не менее 120 ${area}.`,
        reasoningText: "Общая длина должна быть не менее 120 м.",
        value: 120,
        unit: "м",
      }),
      false,
    );
    assertEquals(
      visibleSystemTotalHasProvenance({
        customerEvidence:
          `Нужна суммарная площадь не менее 120 ${area}.`,
        reasoningText:
          "Напряжение всей системы должно быть не менее 120 кВ.",
        value: 120,
        unit: "кВ",
      }),
      false,
    );
  }
});

Deno.test("an explicit square-metre total in reasoning retains its original visible clause", () => {
  const reasoningText = "Общая площадь должна быть не менее 120 кв. м.";
  assertEquals(
    extractVisibleSystemTotalMinimum({
      measurementScope: "system_total",
      reasoningText,
      customerEvidence: "Нужна суммарная общая площадь не менее 120 кв. м.",
      outputFacet: { key: "area", caption: "Общая площадь, м2", unit: "м2" },
      unit: "м2",
    }),
    {
      minimumTotal: 120,
      unit: "м²",
      strictMinimum: false,
      evidence: "Общая площадь должна быть не менее 120 кв. м",
    },
  );
});

Deno.test("whole-unit lexing rejects square-area prefixes as voltage or length", () => {
  for (const area of [
    "кв. мм",
    "кв. см",
    "кв. дм",
    "м^2",
    "м**2",
    "м^4",
    "м^123",
    "м^abc",
    "м**abc",
    "кв. ярд",
  ]) {
    const customerEvidence =
      `Нужна суммарная площадь не менее 120 ${area}.`;
    assertEquals(
      visibleSystemTotalHasProvenance({
        customerEvidence,
        reasoningText: "Общее напряжение должно быть не менее 120 кВ.",
        value: 120,
        unit: "кВ",
      }),
      false,
    );
    assertEquals(
      visibleSystemTotalHasProvenance({
        customerEvidence,
        reasoningText: "Общая длина должна быть не менее 120 м.",
        value: 120,
        unit: "м",
      }),
      false,
    );
  }
  assertEquals(
    visibleSystemTotalHasProvenance({
      customerEvidence: "Нужно суммарное напряжение не менее 120 кВ.",
      reasoningText: "Общее напряжение должно быть не менее 120 кВ.",
      value: 120,
      unit: "кВ",
    }),
    true,
  );
});

Deno.test("whole-unit lexing preserves typed square-area equations", () => {
  const areas = [
    { written: "кв. мм", flux: 0.0018 },
    { written: "кв. см", flux: 0.18 },
    { written: "кв. дм", flux: 18 },
    { written: "м^2", flux: 1800 },
    { written: "м**2", flux: 1800 },
  ];
  for (const area of areas) {
    assertEquals(
      visibleSystemTotalHasProvenance({
        customerEvidence:
          `Площадь 120 ${area.written}. Нужна освещенность 15 лк.`,
        reasoningText:
          `Световой поток: 120 ${area.written} × 15 лк = ${String(area.flux).replace(".", ",")} лм.`,
        value: area.flux,
        unit: "лм",
      }),
      true,
    );
  }
  assertEquals(
    visibleSystemTotalHasProvenance({
      customerEvidence: "Площадь 120 м^4. Нужна освещенность 15 лк.",
      reasoningText: "Световой поток: 120 м^4 × 15 лк = 1800 лм.",
      value: 1800,
      unit: "лм",
    }),
    false,
  );
});

Deno.test("minimum parser binds full area units without promoting prefixes", () => {
  const areaFacet = { key: "area", caption: "Общая площадь, мм²", unit: "мм²" };
  assertEquals(
    extractVisibleSystemTotalMinimum({
      measurementScope: "system_total",
      reasoningText: "Общая площадь должна быть не менее 120 кв. мм.",
      customerEvidence: "Нужна суммарная общая площадь не менее 120 кв. мм.",
      outputFacet: areaFacet,
      unit: "мм²",
    })?.minimumTotal,
    120,
  );
  assertEquals(
    extractVisibleSystemTotalMinimum({
      measurementScope: "system_total",
      reasoningText: "Общая длина должна быть не менее 120 м^2.",
      customerEvidence: "Нужна суммарная общая площадь не менее 120 м^2.",
      outputFacet: { key: "length", caption: "Общая длина, м", unit: "м" },
      unit: "м",
    }),
    null,
  );
  assertEquals(
    extractVisibleSystemTotalMinimum({
      measurementScope: "system_total",
      reasoningText: "Общее напряжение должно быть не менее 120 кв. мм.",
      customerEvidence: "Нужна суммарная общая площадь не менее 120 кв. мм.",
      outputFacet: { key: "voltage", caption: "Общее напряжение, кВ", unit: "кВ" },
      unit: "кВ",
    }),
    null,
  );
});

Deno.test("explicit customer aggregate minimum remains authoritative without model equation", () => {
  assertEquals(
    visibleSystemTotalHasProvenance({
      customerEvidence: "Нужен суммарный световой поток не менее 24 000 лм.",
      reasoningText: "Световой поток: 120 м² × 200 Вт = 24 000 лм.",
      value: 24000,
      unit: "лм",
    }),
    true,
  );
});

Deno.test("a model-selected coefficient cannot prove a hard aggregate total", () => {
  const equation = "Световой поток: 120 м² × 200 лк = 24 000 лм.";
  const area = "Участок площадью 120 м². Покажи варианты.";
  assertEquals(
    visibleSystemTotalHasProvenance({
      customerEvidence: area,
      reasoningText: equation,
      value: 24000,
      unit: "лм",
    }),
    false,
  );
  assertEquals(
    visibleSystemTotalHasProvenance({
      customerEvidence: `${area} Нужна освещенность не менее 200 лк.`,
      reasoningText: equation,
      value: 24000,
      unit: "лм",
    }),
    true,
  );
  assertEquals(
    visibleSystemTotalHasProvenance({
      customerEvidence:
        `${area} У старого прибора освещенность 200 лк.`,
      reasoningText: equation,
      value: 24000,
      unit: "лм",
    }),
    false,
  );
});

Deno.test("a proven smaller total is not displaced by a larger unsupported model assertion", () => {
  const customerEvidence =
    "Участок 120 м². Нужна освещенность не менее 15 лк. Покажи варианты.";
  const reasoningText =
    "Световой поток нужен не менее 1800 лм: 120 м² × 15 лк = 1800 лм. Световой поток должен быть не менее 24 000 лм.";
  assertEquals(
    resolveVisibleSystemTotalRequirement({
      measurementScope: "system_total",
      reasoningText,
      customerEvidence,
      facets: [{ key: "flux", caption: "Световой поток, лм", unit: "лм" }],
    })?.minimumTotal,
    1800,
  );
  assertEquals(
    visibleSystemTotalHasProvenance({
      customerEvidence,
      reasoningText,
      value: 24000,
      unit: "лм",
    }),
    false,
  );
});

Deno.test("visible plan counts must be tied to the exact live SKU title", () => {
  const title = "Прожектор СДО 06-30 светодиодный IP65";
  assertEquals(
    visiblePlanProvesSkuQuantity(
      `Для системы: 8 шт × ${title}; суммарную мощность нужно проверить отдельно.`,
      title,
      8,
    ),
    true,
  );
  assertEquals(
    visiblePlanProvesSkuQuantity(`8 × ${title}`, title, 8),
    true,
  );
  assertEquals(
    visiblePlanProvesSkuQuantity(
      `- **[${title}](https://example.test/item)** Цена: 2390 ₸. Наличие: 8 шт.`,
      title,
      8,
    ),
    false,
  );
  assertEquals(
    visiblePlanProvesSkuQuantity(
      `8 шт × другой прожектор. ${title}`,
      title,
      8,
    ),
    false,
  );
  assertEquals(
    visiblePlanProvesSkuQuantity(
      `Наличие предыдущего товара: 8 шт. ${title}`,
      title,
      8,
    ),
    false,
  );
  assertEquals(
    visiblePlanProvesSkuQuantity(`8 шт × ${title}`, title, 2),
    false,
  );
  const missingVisiblePlan = verifyRawSystemTotalCapacityPlan(
    fluxRequirement,
    [{
      product: fluxProduct("A", "1000"),
      quantity: 2,
      quantitySource: "visible_plan",
    }],
  );
  assertEquals(missingVisiblePlan.status, "unverified");
  assertEquals(missingVisiblePlan.issues, [{
    code: "unverified_quantity",
    productId: "A",
  }]);
});

Deno.test("a visible two-SKU plan proves its summed output from live cards", () => {
  const result = verifySystemTotalCapacityPlan(fluxRequirement, [
    {
      product: fluxProduct("A", "1 000"),
      quantity: 1,
      quantitySource: "visible_plan",
    },
    {
      product: fluxProduct("B", "800"),
      quantity: 1,
      quantitySource: "visible_plan",
    },
  ]);
  assertEquals(result.status, "sufficient");
  assertEquals(result.canClaimSufficient, true);
  assertEquals(result.disposition, "present_verified_system");
  assertEquals(result.totalUnits, 2);
  assertEquals(result.totalCapacity, 1800);
  assertEquals(result.verifiedLines.map(({ subtotal }) => subtotal), [
    1000,
    800,
  ]);
  assertEquals(result.issues, []);
});

Deno.test("one SKU with an explicit count is a system plan, not one card's output", () => {
  const result = verifySystemTotalCapacityPlan(fluxRequirement, [{
    product: fluxProduct("A", "1 000"),
    quantity: 2,
    quantitySource: "customer_explicit",
  }]);
  assertEquals(result.status, "sufficient");
  assertEquals(result.totalUnits, 2);
  assertEquals(result.totalCapacity, 2000);
});

Deno.test("individual candidate cards cannot masquerade as a sufficient system", () => {
  const noCount = verifySystemTotalCapacityPlan(fluxRequirement, [{
    product: fluxProduct("A", "1 800"),
    quantity: null,
    quantitySource: "unverified",
  }]);
  assertEquals(noCount.status, "unverified");
  assertEquals(noCount.canClaimSufficient, false);
  assertEquals(noCount.disposition, "clarify_or_disclose_unverified");
  assertEquals(noCount.totalCapacity, null);
  assertEquals(noCount.issues, [{ code: "missing_quantity", productId: "A" }]);

  const invisibleCount = verifySystemTotalCapacityPlan(fluxRequirement, [{
    product: fluxProduct("A", "1 800"),
    quantity: 2,
    quantitySource: "unverified",
  }]);
  assertEquals(invisibleCount.status, "unverified");
  assertEquals(invisibleCount.issues, [{
    code: "unverified_quantity",
    productId: "A",
  }]);

  const oneUnit = verifySystemTotalCapacityPlan(fluxRequirement, [{
    product: fluxProduct("A", "2 000"),
    quantity: 1,
    quantitySource: "visible_plan",
  }]);
  assertEquals(oneUnit.status, "insufficient");
  assertEquals(oneUnit.issues, [{ code: "insufficient_units" }]);
});

Deno.test("fully evidenced but undersized plans are honestly insufficient", () => {
  const result = verifySystemTotalCapacityPlan(fluxRequirement, [{
    product: fluxProduct("A", "800"),
    quantity: 2,
    quantitySource: "visible_plan",
  }]);
  assertEquals(result.status, "insufficient");
  assertEquals(result.totalCapacity, 1600);
  assertEquals(result.canClaimSufficient, false);
  assertEquals(result.disposition, "disclose_insufficient_plan");
  assertEquals(result.issues, [{ code: "insufficient_capacity" }]);
});

Deno.test("strict and inclusive system thresholds remain distinct", () => {
  const plan = [{
    product: fluxProduct("A", "900"),
    quantity: 2,
    quantitySource: "visible_plan" as const,
  }];
  assertEquals(
    verifySystemTotalCapacityPlan(fluxRequirement, plan).status,
    "sufficient",
  );
  assertEquals(
    verifySystemTotalCapacityPlan(
      { ...fluxRequirement, strictMinimum: true },
      plan,
    )
      .status,
    "insufficient",
  );
});

Deno.test("missing, conflicting and non-scalar catalog outputs never prove a plan", () => {
  const missing = verifySystemTotalCapacityPlan(fluxRequirement, [{
    product: { id: "A", pagetitle: "Fixture A", short_traits: [] },
    quantity: 2,
    quantitySource: "visible_plan",
  }]);
  assertEquals(missing.status, "unverified");
  assertEquals(missing.issues, [{ code: "missing_output", productId: "A" }]);

  const conflicting = verifySystemTotalCapacityPlan(fluxRequirement, [{
    product: {
      id: "A",
      pagetitle: "Fixture A",
      facet_values: { flux: ["1000"] },
      short_traits: ["Световой поток: 800 лм"],
    },
    quantity: 2,
    quantitySource: "visible_plan",
  }]);
  assertEquals(conflicting.status, "unverified");
  assertEquals(conflicting.issues, [{
    code: "ambiguous_output",
    productId: "A",
  }]);

  const range = verifySystemTotalCapacityPlan(fluxRequirement, [{
    product: {
      id: "A",
      pagetitle: "Fixture A",
      facet_values: { flux: ["800–1000 лм"] },
    },
    quantity: 2,
    quantitySource: "visible_plan",
  }]);
  assertEquals(range.status, "unverified");
  assertEquals(range.issues, [{ code: "ambiguous_output", productId: "A" }]);
});

Deno.test("capacity proof requires matching units and an authorized additive system", () => {
  const wrongUnit = verifySystemTotalCapacityPlan(fluxRequirement, [{
    product: {
      id: "A",
      pagetitle: "Fixture A",
      facet_values: { flux: ["1800 Вт"] },
    },
    quantity: 2,
    quantitySource: "visible_plan",
  }]);
  assertEquals(wrongUnit.status, "unverified");
  assertEquals(wrongUnit.canClaimSufficient, false);
  assertEquals(wrongUnit.issues, [{ code: "unit_mismatch", productId: "A" }]);

  const noAdditivity = verifySystemTotalCapacityPlan(
    { ...fluxRequirement, aggregationProof: undefined },
    [{
      product: fluxProduct("A", "1000"),
      quantity: 2,
      quantitySource: "visible_plan",
    }],
  );
  assertEquals(noAdditivity.status, "unverified");
  assertEquals(noAdditivity.issues, [{ code: "missing_additivity_proof" }]);
});

Deno.test("a same-card explicit trait unit can qualify a unitless live facet value", () => {
  const requirement = {
    ...fluxRequirement,
    outputFacet: { key: "flux", caption: "Световой поток", unit: null },
  };
  const evidenced = verifySystemTotalCapacityPlan(requirement, [{
    product: {
      id: "A",
      pagetitle: "Fixture A",
      facet_values: { flux: ["1000"] },
      short_traits: ["Световой поток: 1000 лм"],
    },
    quantity: 2,
    quantitySource: "visible_plan",
  }]);
  assertEquals(evidenced.status, "sufficient");
  assertEquals(evidenced.totalCapacity, 2000);

  const unitless = verifySystemTotalCapacityPlan(requirement, [{
    product: {
      id: "A",
      pagetitle: "Fixture A",
      facet_values: { flux: ["1000"] },
    },
    quantity: 2,
    quantitySource: "visible_plan",
  }]);
  assertEquals(unitless.status, "unverified");
  assertEquals(unitless.issues, [{ code: "ambiguous_output", productId: "A" }]);
});

Deno.test("the contract is unit- and category-neutral", () => {
  const result = verifySystemTotalCapacityPlan({
    measurementScope: "system_total",
    outputFacet: {
      key: "throughput",
      caption: "Производительность, кг",
      unit: "кг",
    },
    unit: "кг",
    minimumTotal: 35,
    aggregationProof: "verified_additive_plan",
  }, [{
    product: {
      id: "machine",
      pagetitle: "Machine 12 kg",
      short_traits: ["Производительность: 12 кг"],
    },
    quantity: 3,
    quantitySource: "visible_plan",
  }]);
  assertEquals(result.status, "sufficient");
  assertEquals(result.unit, "кг");
  assertEquals(result.totalCapacity, 36);
});

Deno.test("duplicate SKUs and invalid counts cannot inflate capacity", () => {
  const duplicate = verifySystemTotalCapacityPlan(fluxRequirement, [
    {
      product: fluxProduct("A", "1000"),
      quantity: 1,
      quantitySource: "visible_plan",
    },
    {
      product: fluxProduct("A", "1000"),
      quantity: 1,
      quantitySource: "visible_plan",
    },
  ]);
  assertEquals(duplicate.status, "unverified");
  assertEquals(duplicate.issues, [{
    code: "duplicate_product",
    productId: "A",
  }]);

  const fractional = verifySystemTotalCapacityPlan(fluxRequirement, [{
    product: fluxProduct("A", "1000"),
    quantity: 1.5,
    quantitySource: "visible_plan",
  }]);
  assertEquals(fractional.status, "unverified");
  assertEquals(fractional.issues, [{
    code: "invalid_quantity",
    productId: "A",
  }]);
});
