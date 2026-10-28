import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  certificateCoversSoleUnprojectedMeasurement,
  compileMeasuredPointRangeRelation,
  type LiveAdjustableRangeFacet,
  type MeasuredPointRangeCertificate,
  productProvesMeasuredPointRangeRelation,
  type TrustedCustomerLoadPoint,
} from "./measured-point-range-relation.ts";

const point: TrustedCustomerLoadPoint = {
  value: 10,
  unit: "А",
  source: "customer_load",
};
const setting: LiveAdjustableRangeFacet = {
  key: "thermal_trip_setting",
  caption: "Диапазон уставки тока расцепления, А",
  unit: "А",
  values: [
    { value: "0,63–1 А" },
    { value: "6–10 А" },
    { value: "10–16 А" },
    { value: "16–20 А" },
  ],
};

function compile(
  facets: readonly LiveAdjustableRangeFacet[] = [setting],
  customerPoint: TrustedCustomerLoadPoint = point,
) {
  return compileMeasuredPointRangeRelation({ point: customerPoint, facets });
}

Deno.test("a verified customer point compiles to every inclusive exact live option", () => {
  assertEquals(compile(), {
    source: "customer_load",
    value: 10,
    unit: "A",
    facetKey: "thermal_trip_setting",
    facetCaption: "Диапазон уставки тока расцепления, А",
    acceptedValues: ["6–10 А", "10–16 А"],
  });
});

Deno.test("comma decimals, declared facet unit, and unitful values are supported", () => {
  assertEquals(
    compile([{
      key: "range",
      caption: "Диапазон регулировки тока",
      unit: "A",
      values: [{ value: "6,3-10" }, { value: "10,1-16" }],
    }], { ...point, value: 6.3, unit: "A" })?.acceptedValues,
    ["6,3-10"],
  );
  assertEquals(
    compile([{
      key: "range",
      caption: "Current trip setting range",
      values: [{ value: "6-10 A" }],
    }], { ...point, unit: "ampere" })?.acceptedValues,
    ["6-10 A"],
  );
  assertEquals(
    compile([{ ...setting, values: [{ value: "0–10 А" }] }])
      ?.acceptedValues,
    ["0–10 А"],
  );
});

Deno.test("a scalar nominal-current facet cannot substitute for a setting range", () => {
  const scalar: LiveAdjustableRangeFacet = {
    key: "nominal_current",
    caption: "Номинальный ток, А",
    unit: "А",
    values: [{ value: "10 А" }],
  };
  assertEquals(compile([scalar]), null);
  assertEquals(compile([scalar, setting])?.facetKey, setting.key);
});

Deno.test("two plausible live facets make the relation ambiguous", () => {
  assertEquals(
    compile([
      setting,
      {
        key: "other_trip_setting",
        caption: "Диапазон регулировки тока расцепления, А",
        values: [{ value: "6–10 А" }],
      },
    ]),
    null,
  );
  assertEquals(compile([setting, { ...setting }]), null);
});

Deno.test("caption must explicitly describe a range of current setting or trip", () => {
  for (
    const caption of [
      "Диапазон измерения тока, А",
      "Диапазон уставки напряжения, А",
      "Номинальный ток расцепления, А",
      "Регулируемый ток, А",
      "Диапазон частоты, А",
    ]
  ) {
    assertEquals(compile([{ ...setting, caption }]), null, caption);
  }
});

Deno.test("a trusted finite positive ampere point is required", () => {
  for (
    const customerPoint of [
      { ...point, value: NaN },
      { ...point, value: Infinity },
      { ...point, value: 0 },
      { ...point, value: -1 },
      { ...point, unit: "кА" },
      { ...point, unit: "Вт" },
      { ...point, source: "model_inference" as "customer_load" },
    ]
  ) {
    assertEquals(compile([setting], customerPoint), null);
  }
});

Deno.test("a value without any ampere declaration is not projected", () => {
  assertEquals(
    compile([{
      key: "range",
      caption: "Диапазон уставки тока",
      values: [{ value: "6–10" }],
    }]),
    null,
  );
});

Deno.test("conflicting declared units block even superficially matching values", () => {
  assertEquals(compile([{ ...setting, unit: "В" }]), null);
  assertEquals(
    compile([{ ...setting, caption: "Диапазон уставки тока, В" }]),
    null,
  );
  assertEquals(compile([{ ...setting, values: [{ value: "6–10 В" }] }]), null);
});

Deno.test("only complete, closed, single-interval enum values are eligible", () => {
  const invalid = [
    "10 А",
    "до 10 А",
    "от 6 А",
    ">6–10 А",
    "6–10/10–16 А",
    "6–10 А, 16 А",
    "6–6 А",
    "16–10 А",
    "6–10 В",
    "6–10 А / AC",
  ];
  assertEquals(
    compile([{
      ...setting,
      values: [
        ...invalid.map((value) => ({ value })),
        { value: "6–10 А" },
      ],
    }])?.acceptedValues,
    ["6–10 А"],
  );
  assertEquals(
    compile([{ ...setting, values: invalid.map((value) => ({ value })) }]),
    null,
  );
});

Deno.test("duplicate exact live values are not repeated in search options", () => {
  assertEquals(
    compile([{
      ...setting,
      values: [
        { value: "6–10 А" },
        { value: "6–10 А" },
      ],
    }])?.acceptedValues,
    ["6–10 А"],
  );
});

Deno.test("more than 12 covering options fails closed without truncation", () => {
  const values = Array.from({ length: 13 }, (_, index) => ({
    value: `1–${index + 11} А`,
  }));
  assertEquals(compile([{ ...setting, values }]), null);
});

Deno.test("a final product requires one exact matching live facet value", () => {
  const certificate = compile() as MeasuredPointRangeCertificate;
  assertEquals(
    productProvesMeasuredPointRangeRelation({
      facet_values: { [setting.key]: ["6–10 А"] },
      facet_captions: { [setting.key]: setting.caption },
    }, certificate),
    true,
  );
  assertEquals(
    productProvesMeasuredPointRangeRelation({
      facet_values: { [setting.key]: ["10–16 А"] },
      facet_captions: { [setting.key]: setting.caption },
    }, certificate),
    true,
  );
  for (
    const product of [
      { facet_values: {} },
      { facet_values: { other: ["6–10 А"] } },
      { facet_values: { [setting.key]: ["6–10 А"] } },
      { facet_values: { [setting.key]: ["10 А"] } },
      { facet_values: { [setting.key]: ["6–10 В"] } },
      { facet_values: { [setting.key]: ["16–20 А"] } },
      { facet_values: { [setting.key]: ["6–10 А", "10–16 А"] } },
      {
        facet_values: { [setting.key]: ["6–10 А"] },
        facet_captions: {
          [setting.key]: "Номинальный ток, А",
        },
      },
    ]
  ) {
    assertEquals(
      productProvesMeasuredPointRangeRelation(product, certificate),
      false,
    );
  }
});

Deno.test("forged search membership cannot prove a range that misses the point", () => {
  const certificate = compile() as MeasuredPointRangeCertificate;
  assertEquals(
    productProvesMeasuredPointRangeRelation({
      facet_values: { [setting.key]: ["16–20 А"] },
    }, { ...certificate, acceptedValues: ["16–20 А"] }),
    false,
  );
  assertEquals(
    productProvesMeasuredPointRangeRelation({
      facet_values: { [setting.key]: ["6–10 В"] },
    }, { ...certificate, acceptedValues: ["6–10 В"] }),
    false,
  );
});

Deno.test("certificate waives only its own explicit setting-range coverage clause", () => {
  const certificate = compile() as MeasuredPointRangeCertificate;
  assertEquals(
    certificateCoversSoleUnprojectedMeasurement({
      certificate,
      measurementEvidence:
        "Диапазон уставки тока расцепления 6–10 А покрывает рабочий ток 10 А.",
      requiredFacetValues: [{ key: setting.key, value: "6–10 А" }],
    }),
    true,
  );
  assertEquals(
    certificateCoversSoleUnprojectedMeasurement({
      certificate,
      measurementEvidence:
        "Ток 10 А входит в диапазон уставки тока расцепления.",
      requiredFacetValues: [],
    }),
    true,
  );
});

Deno.test("setting coverage can be explicit without repeating the word range", () => {
  const certificate = compile() as MeasuredPointRangeCertificate;
  assertEquals(
    certificateCoversSoleUnprojectedMeasurement({
      certificate,
      measurementEvidence: "Уставка тока охватывает 10 А.",
      requiredFacetValues: [],
    }),
    true,
  );
});

Deno.test("equivalent dash and spacing do not change a certified interval", () => {
  const certificate = compile() as MeasuredPointRangeCertificate;
  for (
    const evidence of [
      "Диапазон уставки тока 6-10 А покрывает ток 10 А.",
      "Диапазон уставки тока 6 - 10 A покрывает ток 10 А.",
      "Диапазон уставки тока 6—10А покрывает ток 10 А.",
    ]
  ) {
    assertEquals(
      certificateCoversSoleUnprojectedMeasurement({
        certificate,
        measurementEvidence: evidence,
        requiredFacetValues: [],
      }),
      true,
      evidence,
    );
  }
});

Deno.test("separate descriptive load and supply facts need no product-side waiver", () => {
  const certificate = compile() as MeasuredPointRangeCertificate;
  assertEquals(
    certificateCoversSoleUnprojectedMeasurement({
      certificate,
      measurementEvidence:
        "Двигатель 3 кВт. Питание 380 В. Диапазон уставки тока расцепления 6–10 А охватывает ток 10 А.",
      requiredFacetValues: [{ key: "Цвет корпуса", value: "черный" }],
    }),
    true,
  );
});

Deno.test("one mixed clause cannot hide voltage, power or dimension obligations", () => {
  const certificate = compile() as MeasuredPointRangeCertificate;
  for (
    const additional of [
      "и требует напряжения 380 В",
      "и требует мощности 3 кВт",
      "и требует ширины 40 мм",
      "и требует 3 полюса",
      "и требует напряжения 380",
    ]
  ) {
    assertEquals(
      certificateCoversSoleUnprojectedMeasurement({
        certificate,
        measurementEvidence:
          `Диапазон уставки тока расцепления 6–10 А покрывает ток 10 А ${additional}.`,
        requiredFacetValues: [],
      }),
      false,
      additional,
    );
  }
});

Deno.test("another declarative measured sentence remains an obligation", () => {
  const certificate = compile() as MeasuredPointRangeCertificate;
  for (
    const additional of [
      "Номинальное напряжение должно быть 380 В.",
      "Мощность изделия не менее 3 кВт.",
      "Номинальный ток 6 А.",
      "Уставка тока 6 А.",
    ]
  ) {
    assertEquals(
      certificateCoversSoleUnprojectedMeasurement({
        certificate,
        measurementEvidence:
          `Диапазон уставки тока расцепления 6–10 А покрывает ток 10 А. ${additional}`,
        requiredFacetValues: [],
      }),
      false,
      additional,
    );
  }
});

Deno.test("bare nominal current and vague setting prose never count as range coverage", () => {
  const certificate = compile() as MeasuredPointRangeCertificate;
  for (
    const evidence of [
      "Номинальный ток 10 А.",
      "Уставка тока 10 А подходит.",
      "Диапазон уставки тока расцепления 6–10 А.",
      "Диапазон измерения тока 6–10 А покрывает нагрузку 10 А.",
      "",
    ]
  ) {
    assertEquals(
      certificateCoversSoleUnprojectedMeasurement({
        certificate,
        measurementEvidence: evidence,
        requiredFacetValues: [],
      }),
      false,
      evidence,
    );
  }
});

Deno.test("negated coverage and a same-sentence nominal-current claim fail closed", () => {
  const certificate = compile() as MeasuredPointRangeCertificate;
  for (
    const evidence of [
      "Диапазон уставки тока 6–10 А не покрывает ток 10 А.",
      "Диапазон уставки тока 6–10 А не подходит для тока 10 А.",
      "Ток 10 А не входит в диапазон уставки тока 6–10 А.",
      "Диапазон уставки тока 6–10 А покрывает ток 10 А, но номинальный ток 10 А обязателен.",
    ]
  ) {
    assertEquals(
      certificateCoversSoleUnprojectedMeasurement({
        certificate,
        measurementEvidence: evidence,
        requiredFacetValues: [],
      }),
      false,
      evidence,
    );
  }
});

Deno.test("uncertified current values and ranges cannot be erased from the clause", () => {
  const certificate = compile() as MeasuredPointRangeCertificate;
  for (
    const evidence of [
      "Диапазон уставки тока 6–12 А покрывает ток 10 А.",
      "Диапазон уставки тока 6–10 В покрывает ток 10 А.",
      "Диапазон уставки тока 6–10 А покрывает ток 11 А.",
      "Диапазон уставки тока 6–10 А покрывает ток 10 А и 6 А.",
    ]
  ) {
    assertEquals(
      certificateCoversSoleUnprojectedMeasurement({
        certificate,
        measurementEvidence: evidence,
        requiredFacetValues: [],
      }),
      false,
      evidence,
    );
  }
});

Deno.test("unrelated physical facet requirements cannot piggyback on the certificate", () => {
  const certificate = compile() as MeasuredPointRangeCertificate;
  const evidence =
    "Диапазон уставки тока расцепления 6–10 А покрывает ток 10 А.";
  for (
    const requirement of [
      { key: "Номинальное напряжение, В", value: "380 В" },
      { key: "Номинальное напряжение, В", value: "380" },
      { key: "Мощность", value: "3 кВт" },
      { key: "Диаметр", value: "40 мм" },
      { key: "Количество полюсов", value: "3" },
      { key: "Напряжение", value: "переменное" },
      { key: setting.key, value: "10 А" },
    ]
  ) {
    assertEquals(
      certificateCoversSoleUnprojectedMeasurement({
        certificate,
        measurementEvidence: evidence,
        requiredFacetValues: [requirement],
      }),
      false,
      `${requirement.key}: ${requirement.value}`,
    );
  }
});

Deno.test("unitless live enum requires an explicit ampere suffix in model evidence", () => {
  const certificate = compile([{
    key: setting.key,
    caption: setting.caption,
    unit: "A",
    values: [{ value: "6–10" }],
  }]) as MeasuredPointRangeCertificate;
  assertEquals(
    certificateCoversSoleUnprojectedMeasurement({
      certificate,
      measurementEvidence: "Диапазон уставки тока 6–10 А покрывает ток 10 А.",
      requiredFacetValues: [],
    }),
    true,
  );
  assertEquals(
    certificateCoversSoleUnprojectedMeasurement({
      certificate,
      measurementEvidence: "Диапазон уставки тока 6–10 В покрывает ток 10 А.",
      requiredFacetValues: [],
    }),
    false,
  );
});
