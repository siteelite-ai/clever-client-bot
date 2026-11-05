import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { compileMeasuredRequirementConjunction } from "./measured-requirement-conjunction.ts";
import { compileMeasuredPointRangeRelation } from "./measured-point-range-relation.ts";
import { projectCriteriaFacetOptions } from "./criteria-gate.ts";

const setting = {
  key: "setting",
  caption: "Диапазон уставки тока расцепления, А",
  type: "string",
  unit: "А",
  values: [{ value: "4–6 А" }, { value: "6–10 А" }, { value: "7–10 А" }],
};
const voltage = {
  key: "voltage",
  caption: "Номинальное рабочее напряжение, В",
  type: "string",
  unit: "В",
  values: [{ value: "220" }, { value: "380" }, { value: "400" }, {
    value: "690",
  }],
};
const relation = "Диапазон уставки тока должен включать рабочий ток 6 А.";
const certificate = compileMeasuredPointRangeRelation({
  point: { value: 6, unit: "A", source: "customer_load" },
  facets: [setting],
})!;
const base = {
  customerText: "Питание 380 В, 3 фазы, рабочий ток по шильдику 6 А",
  facets: [setting, voltage],
  measurementScope: "per_product",
  certificate,
  requiredFacetValues: [],
};

Deno.test("conjunction keeps the existing sole current-range certificate", () => {
  assertEquals(
    compileMeasuredRequirementConjunction({
      ...base,
      customerText: "Рабочий ток по шильдику 6 А",
      evidence: relation,
    }),
    { criteria: [], obligations: 1, customerImplications: 0 },
  );
  assertEquals(
    compileMeasuredRequirementConjunction({
      ...base,
      customerText: "Рабочий ток по шильдику 6 А",
      evidence: relation,
      requiredFacetValues: [{ key: "setting", value: "4–6 А" }, {
        key: "Цвет",
        value: "черный",
      }],
    }),
    { criteria: [], obligations: 1, customerImplications: 0 },
  );
});

Deno.test("literal supply voltage can own working voltage but never insulation or output voltage", () => {
  for (const caption of ["Напряжение изоляции, В", "Выходное напряжение, В"]) {
    assertEquals(
      compileMeasuredRequirementConjunction({
        ...base,
        facets: [setting, { ...voltage, caption }],
        evidence: relation +
          `\n${
            caption.replace(", В", "")
          } каждого изделия должно быть не менее 380 В.`,
      }),
      null,
      caption,
    );
  }
});

Deno.test("conjunction is dimension/schema based, not tied to voltage or a catalog branch", () => {
  const flux = {
    key: "flux",
    caption: "Световой поток, лм",
    type: "string",
    unit: "лм",
    values: [{ value: "1000" }, { value: "2000" }, { value: "3000" }],
  };
  const result = compileMeasuredRequirementConjunction({
    ...base,
    facets: [setting, flux],
    customerText:
      "Рабочий ток по шильдику 6 А. Световой поток изделия 2000 лм.",
    evidence: relation +
      "\nСветовой поток изделия должен быть не менее 2000 лм.",
  });
  assert(result);
  assertEquals(
    projectCriteriaFacetOptions(result.criteria, [setting, flux]).options,
    { flux: ["2000"] },
  );
});

Deno.test("an exact customer value may prove a weaker model bound only while the stronger equality is frozen", () => {
  const result = compileMeasuredRequirementConjunction({
    ...base,
    evidence: relation +
      "\nРабочее напряжение каждого изделия должно быть не менее 380 В.",
  });
  assert(result);
  assertEquals(result.customerImplications, 1);
  assertEquals(
    result.criteria.map((c) => ({
      op: c.op,
      value: c.value,
      evidence: c.evidence,
    })),
    [{ op: "eq", value: "380", evidence: "user_explicit" }],
  );
  assertEquals(
    projectCriteriaFacetOptions(result.criteria, base.facets).options,
    { voltage: ["380"] },
  );
});

Deno.test("a separately owned lower bound compiles independently of the current relation", () => {
  const result = compileMeasuredRequirementConjunction({
    ...base,
    customerText:
      "Рабочий ток по шильдику 6 А. Рабочее напряжение изделия не менее 380 В.",
    evidence: relation +
      "\nРабочее напряжение изделия должно быть не менее 380 В.",
  });
  assert(result);
  assertEquals(result.criteria[0].op, "min");
  assertEquals(
    projectCriteriaFacetOptions(result.criteria, base.facets).options,
    { voltage: ["380", "400", "690"] },
  );
});

Deno.test("an independently owned interval remains a two-sided obligation", () => {
  const result = compileMeasuredRequirementConjunction({
    ...base,
    customerText:
      "Рабочий ток по шильдику 6 А. Рабочее напряжение изделия от 380 до 400 В.",
    evidence: relation +
      "\nРабочее напряжение изделия должно быть от 380 до 400 В.",
  });
  assert(result);
  assertEquals(
    projectCriteriaFacetOptions(result.criteria, base.facets).options,
    { voltage: ["380", "400"] },
  );
});

Deno.test("one projected property cannot discharge a second unprojectable property", () => {
  assertEquals(
    compileMeasuredRequirementConjunction({
      ...base,
      evidence: relation +
        "\nРабочее напряжение изделия должно быть не менее 380 В.\nСветовой поток изделия должен быть не менее 2000 лм.",
    }),
    null,
  );
  assertEquals(
    compileMeasuredRequirementConjunction({
      ...base,
      evidence: relation +
        "\nРабочее напряжение изделия должно быть не менее 380 В и световой поток не менее 2000 лм.",
    }),
    null,
  );
});

Deno.test("customer equality cannot authorize a stronger, opposite or non-enumerated bound", () => {
  for (const bound of ["не менее 400 В", "не более 220 В", "больше 380 В"]) {
    assertEquals(
      compileMeasuredRequirementConjunction({
        ...base,
        evidence: relation +
          `\nРабочее напряжение изделия должно быть ${bound}.`,
      }),
      null,
      bound,
    );
  }
  assertEquals(
    compileMeasuredRequirementConjunction({
      ...base,
      facets: [setting, {
        ...voltage,
        values: [{ value: "400" }, { value: "690" }],
      }],
      evidence: relation +
        "\nРабочее напряжение изделия должно быть не менее 380 В.",
    }),
    null,
  );
});

Deno.test("unknown symbolic requirements, a second nominal current and extra declared facets remain blocked", () => {
  for (
    const extra of [
      "Напряжение Ue должно быть >= Uсети.",
      "Номинальный ток изделия должен быть 6 А.",
      "Ток отключения должен быть 6 А.",
    ]
  ) {
    assertEquals(
      compileMeasuredRequirementConjunction({
        ...base,
        evidence: relation + "\n" + extra,
      }),
      null,
      extra,
    );
  }
  assertEquals(
    compileMeasuredRequirementConjunction({
      ...base,
      evidence: relation,
      requiredFacetValues: [{ key: "voltage", value: "690" }],
    }),
    null,
  );
});

Deno.test("system totals, a missing relation and an over-limit live domain cannot inherit a partial proof", () => {
  assertEquals(
    compileMeasuredRequirementConjunction({
      ...base,
      evidence: relation,
      measurementScope: "system_total",
    }),
    null,
  );
  assertEquals(
    compileMeasuredRequirementConjunction({
      ...base,
      evidence: "Рабочее напряжение изделия должно быть не менее 380 В.",
    }),
    null,
  );
  assertEquals(
    compileMeasuredRequirementConjunction({
      ...base,
      facets: [setting, {
        ...voltage,
        values: Array.from(
          { length: 13 },
          (_, i) => ({ value: String(380 + i) }),
        ),
      }],
      evidence: relation +
        "\nРабочее напряжение изделия должно быть не менее 380 В.",
    }),
    null,
  );
});

Deno.test("a large facet with a complete small satisfying family is not arbitrarily truncated or rejected", () => {
  const values = Array.from(
    { length: 20 },
    (_, i) => ({ value: String(i + 1) }),
  );
  const quantity = {
    key: "flux",
    caption: "Световой поток, лм",
    type: "string",
    unit: "лм",
    values,
  };
  const result = compileMeasuredRequirementConjunction({
    ...base,
    facets: [setting, quantity],
    customerText:
      "Рабочий ток по шильдику 6 А. Световой поток изделия не менее 19 лм.",
    evidence: relation + "\nСветовой поток изделия должен быть не менее 19 лм.",
  });
  assert(result);
  assertEquals(
    projectCriteriaFacetOptions(result.criteria, [setting, quantity]).options,
    { flux: ["19", "20"] },
  );
});
