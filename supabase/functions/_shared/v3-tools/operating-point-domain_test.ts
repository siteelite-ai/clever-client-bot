import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  compileCustomerOperatingPointDomains,
  productProvesOperatingPointDomain,
} from "./operating-point-domain.ts";
import { compileMeasuredPointRangeRelation } from "./measured-point-range-relation.ts";
import { compileMeasuredRequirementConjunction } from "./measured-requirement-conjunction.ts";
import { projectCriteriaFacetOptions } from "./criteria-gate.ts";

// Exact public category schema observed 2026-11-05; no runtime SKU aliases.
const voltage = {
  key: "nomin_rab_napryaghenie__v__nominaldy_ghұmys_kerneuі__v",
  caption: "Номин раб напряжение, В",
  type: "string",
  unit: null,
  values: [{ value: "660" }, { value: "690" }, { value: "230-690" }],
};
const setting = {
  key: "diapazon_ustavki_toka_rascepleniya_a__ayyru_toғynyң_ornatu_diapazony_a",
  caption: "Диапазон уставки тока расцепления,А",
  type: "string",
  unit: null,
  values: [{ value: "4-6.3" }, { value: "6-10" }, { value: "6.3-10" }],
};
const customer =
  "Подберите автомат для двигателя асинхронный 3 кВт. Питание 380 В, 3 фазы; прямой пуск; номинальный рабочий ток по шильдику 6 А.";
const range = "Диапазон уставки тока должен включать рабочий ток 6 А.";
const certificate = compileMeasuredPointRangeRelation({
  point: { value: 6, unit: "А", source: "customer_load" },
  facets: [setting],
})!;

Deno.test("real nullable-unit abbreviated caption projects customer point into closed live interval, not higher scalar ratings", () => {
  const domains = compileCustomerOperatingPointDomains(customer, [voltage]);
  assertEquals(domains.length, 1);
  assertEquals(domains[0].acceptedValues, ["230-690"]);
  assertEquals(
    projectCriteriaFacetOptions([domains[0].criterion], [voltage]).options,
    { [voltage.key]: ["230-690"] },
  );
  for (
    const obligation of [
      "Рабочее напряжение изделия должно быть не менее 380 В.",
      "Рабочее напряжение изделия должно соответствовать 380 В.",
    ]
  ) {
    const result = compileMeasuredRequirementConjunction({
      evidence: range + "\n" + obligation,
      customerText: customer,
      facets: [setting, voltage],
      measurementScope: "per_product",
      certificate,
      requiredFacetValues: [],
    });
    assert(result, obligation);
    assertEquals(result.operatingDomains?.length, 1);
    assertEquals(
      projectCriteriaFacetOptions(result.criteria, [setting, voltage]).options,
      { [voltage.key]: ["230-690"] },
    );
  }
});

Deno.test("fresh card proof requires identical live key/caption and one complete accepted raw domain", () => {
  const d = compileCustomerOperatingPointDomains(customer, [voltage])[0];
  const card = (v: string) => ({
    facet_values: { [voltage.key]: [v] },
    facet_captions: { [voltage.key]: voltage.caption },
  });
  assert(productProvesOperatingPointDomain(card("230-690"), d));
  for (
    const v of [
      "660",
      "690",
      "≥380",
      "230/690",
      "400-690",
      "230-690 кВ",
      "для 380 В",
    ]
  ) assertEquals(productProvesOperatingPointDomain(card(v), d), false, v);
  assertEquals(
    productProvesOperatingPointDomain(
      { facet_values: {}, facet_captions: {} },
      d,
    ),
    false,
  );
  assertEquals(
    productProvesOperatingPointDomain({
      ...card("230-690"),
      facet_captions: { [voltage.key]: "Напряжение изоляции, В" },
    }, d),
    false,
  );
});

Deno.test("domain inference rejects wrong roles, ambiguity, open limits, unit changes and unowned model points", () => {
  for (
    const caption of [
      "Напряжение изоляции, В",
      "Выходное напряжение, В",
      "Напряжение катушки управления, В",
      "Испытательное напряжение, В",
    ]
  ) {
    assertEquals(
      compileCustomerOperatingPointDomains(customer, [{ ...voltage, caption }]),
      [],
    );
  }
  for (
    const source of [
      "Напряжение изоляции 380 В.",
      "Питание не менее 380 В.",
      "Питание от 220 до 380 В.",
      "Питание 220 В. Питание 380 В.",
      "Модель предлагает 380 В.",
    ]
  ) {
    assertEquals(
      compileCustomerOperatingPointDomains(source, [voltage]),
      [],
      source,
    );
  }
  assertEquals(
    compileCustomerOperatingPointDomains(customer, [voltage, {
      ...voltage,
      key: "other",
    }]),
    [],
  );
  assertEquals(
    compileCustomerOperatingPointDomains(customer, [{
      ...voltage,
      unit: "кВ",
    }]),
    [],
  );
  assertEquals(
    compileCustomerOperatingPointDomains(customer, [{
      ...voltage,
      values: [{ value: "690" }, { value: "до 690" }, { value: "230/690" }],
    }]),
    [],
  );
  assertEquals(
    compileCustomerOperatingPointDomains(customer, [{
      ...voltage,
      values: [{ value: "380" }, { value: "230-690" }],
    }])[0]?.acceptedValues,
    ["380"],
    "existing exact-literal path remains unchanged",
  );
});

Deno.test("customer operating point survives model omission/cleanup and cannot be discharged by an unsupported higher scalar", () => {
  const result = compileMeasuredRequirementConjunction({
    evidence: range,
    customerText: customer,
    facets: [setting, voltage],
    measurementScope: "per_product",
    certificate,
    requiredFacetValues: [],
  });
  assert(result);
  assertEquals(result.operatingDomains?.[0].acceptedValues, ["230-690"]);
  assertEquals(
    projectCriteriaFacetOptions(result.criteria, [setting, voltage]).options,
    { [voltage.key]: ["230-690"] },
  );
  assertEquals(
    compileMeasuredRequirementConjunction({
      evidence: range,
      customerText: customer,
      facets: [setting, {
        ...voltage,
        values: [{ value: "660" }, { value: "690" }],
      }],
      measurementScope: "per_product",
      certificate,
      requiredFacetValues: [],
    }),
    null,
  );
  assertEquals(
    compileMeasuredRequirementConjunction({
      evidence: range,
      customerText: customer,
      facets: [setting, { ...voltage, unit: "кВ" }],
      measurementScope: "per_product",
      certificate,
      requiredFacetValues: [],
    }),
    null,
    "an unsupported scale must not disappear with model prose",
  );
});

Deno.test("point interval boundaries are inclusive and an unrelated model voltage remains unproved", () => {
  for (const n of [230, 690]) {
    assertEquals(
      compileCustomerOperatingPointDomains(`Питание ${n} В.`, [{
        ...voltage,
        values: [{ value: "230-690" }],
      }])[0]
        ?.acceptedValues,
      ["230-690"],
    );
  }
  for (const n of [229, 691]) {
    assertEquals(
      compileCustomerOperatingPointDomains(`Питание ${n} В.`, [voltage]),
      [],
    );
  }
  assertEquals(
    compileMeasuredRequirementConjunction({
      evidence: range + "\nРабочее напряжение должно быть не менее 400 В.",
      customerText: customer,
      facets: [setting, voltage],
      measurementScope: "per_product",
      certificate,
      requiredFacetValues: [],
    }),
    null,
  );
});
