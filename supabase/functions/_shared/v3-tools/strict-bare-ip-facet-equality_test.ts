import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  applyCriteriaGate,
  checkCriterion,
  type CriteriaFacet,
  type Criterion,
  projectCriteriaFacetOptions,
} from "./criteria-gate.ts";
import type { ProductRef } from "./types.ts";

const bareIp44: Criterion = {
  key: "Степень защиты, IP",
  op: "eq",
  value: "44",
  level: "A",
  evidence: "derived_required",
};

function product(id: string, traits: string[], title = `Прибор ${id}`): ProductRef {
  return {
    id,
    pagetitle: title,
    vendor: null,
    price: 100,
    stock: "in_stock",
    short_traits: traits,
  };
}

Deno.test("bare numeric IP proves only the complete code on its named IP facet", () => {
  assertEquals(
    checkCriterion(product("bare", ["Степень защиты, IP: 44"]), bareIp44)
      .verdict,
    "pass",
  );
  assertEquals(
    checkCriterion(product("prefixed", ["Степень защиты, IP: IP44"]), bareIp44)
      .verdict,
    "pass",
  );
  for (
    const value of [
      "44-20",
      "44 / 20",
      "IP44-IP20",
      "IP44 / IP20",
      "144",
      "54",
      "44 Вт",
    ]
  ) {
    assertEquals(
      checkCriterion(
        product(value, [`Степень защиты, IP: ${value}`]),
        bareIp44,
      ).verdict,
      "fail",
    );
  }
});

Deno.test("bare IP digits require a named IP trait, not title or unrelated numeric fields", () => {
  assertEquals(
    checkCriterion(product("title", [], "Прибор IP44, 44 Вт"), bareIp44)
      .verdict,
    "unknown",
  );
  assertEquals(
    checkCriterion(product("wattage", ["Мощность, Вт: 44"]), bareIp44)
      .verdict,
    "unknown",
  );
  assertEquals(
    checkCriterion(product("no-label", ["Степень защиты: 44"]), bareIp44)
      .verdict,
    "fail",
  );
  assertEquals(
    checkCriterion(
      product("machine-key", ["stepeny_zaschity__ip: 44"]),
      { ...bareIp44, key: "stepeny_zaschity__ip" },
    ).verdict,
    "pass",
  );
});

Deno.test("IP facet projection and final OR gate preserve exact bare enum alternatives", () => {
  const facets: CriteriaFacet[] = [{
    key: "stepeny_zaschity__ip",
    caption: "Степень защиты, IP",
    unit: null,
    values: [
      { value: "44" },
      { value: "54" },
      { value: "44-20" },
      { value: "IP44-IP20" },
    ],
  }];
  const criteria = [bareIp44, { ...bareIp44, value: "54" }];
  assertEquals(projectCriteriaFacetOptions(criteria, facets).options, {
    stepeny_zaschity__ip: ["44", "54"],
  });
  assertEquals(
    applyCriteriaGate([
      product("44", ["Степень защиты, IP: 44"]),
      product("54", ["Степень защиты, IP: 54"]),
      product("compound", ["Степень защиты, IP: 44-20"]),
      product("title", [], "Прибор IP44"),
    ], criteria).passed_ids,
    ["44", "54"],
  );
});

Deno.test("fully prefixed IP criterion still proves a bare scalar on a named IP trait", () => {
  assertEquals(
    checkCriterion(
      product("bare", ["Степень защиты, IP: 44"]),
      { ...bareIp44, value: "IP44" },
    ).verdict,
    "pass",
  );
});

Deno.test("other numeric facets preserve prior numeric-span semantics", () => {
  assertEquals(
    checkCriterion(
      product("poles", ["Количество полюсов: 2-3"]),
      { key: "Количество полюсов", op: "eq", value: "2", level: "A" },
    ).verdict,
    "pass",
  );
  assertEquals(
    checkCriterion(
      product("generic", ["Степень защиты: 20-25"]),
      { key: "Степень защиты", op: "eq", value: "25", level: "A" },
    ).verdict,
    "pass",
  );
});
