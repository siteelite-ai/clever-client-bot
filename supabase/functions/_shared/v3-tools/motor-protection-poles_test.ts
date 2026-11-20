import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  compileMotorProtectionPoleProof,
  productProvesMotorProtectionPoles,
} from "./motor-protection-poles.ts";
import type { CriteriaFacet } from "./criteria-gate.ts";
import type { ProductFull } from "./types.ts";

const category = "Автоматы защиты двигателя";
const axis: CriteriaFacet = {
  key: "catalog_poles",
  caption: "Количество полюсов",
  unit: null,
  values: [{ value: "2" }, { value: "3" }],
};
const evidence = "Питание 220 В, 3 фазы; прямой пуск; ток по шильдику 30 А";
const compile = (
  text = evidence,
  facets: CriteriaFacet[] = [axis],
  family = category,
) => compileMotorProtectionPoleProof(text, family, facets);
const card = (value: string, title = "Защита двигателя 3P") =>
  ({
    pagetitle: title,
    facet_values: { [axis.key]: [value] },
    facet_captions: { [axis.key]: axis.caption },
  }) as unknown as ProductFull;

Deno.test("motor poles are derived only from explicit phase evidence and owned live catalog facet", () => {
  assertEquals(compile(), {
    status: "verified",
    key: axis.key,
    caption: axis.caption,
    values: ["3"],
  });
  for (
    const text of [
      "380 В, прямой пуск, 6 А",
      "220 В, 1 фаза",
      "Двигатель 3 кВт",
    ]
  ) {
    assertEquals(compile(text), { status: "not_applicable" }, text);
  }
  assertEquals(compile(evidence, [axis], "Автоматические выключатели"), {
    status: "not_applicable",
  });
  assertEquals(
    compile(evidence, [axis], "Аксессуары автоматов защиты двигателя"),
    { status: "not_applicable" },
  );
});

Deno.test("motor poles refuse conflicting supply and explicit different pole counts", () => {
  for (
    const text of [
      evidence + "; 1 фаза",
      evidence + "; 2P",
      "Не 3 фазы, уточню питание",
      "1/3 фазы",
    ]
  ) {
    assertEquals(compile(text), {
      status: "unverified",
      reason: "ambiguous_input",
    }, text);
  }
});

Deno.test("motor poles never borrow accessory facets or synthesize a missing three-pole value", () => {
  for (
    const facets of [[], [axis, { ...axis, key: "duplicate" }], [{
      ...axis,
      caption: "Количество дополнительных полюсов",
    }], [{ ...axis, values: [{ value: "2" }, { value: "3+N" }] }]]
  ) {
    assertEquals(compile(evidence, facets), {
      status: "unverified",
      reason: "missing_catalog_evidence",
    });
  }
});

Deno.test("motor card egress requires identical owned facet and a single proven value", () => {
  const proof = compile();
  assert(productProvesMotorProtectionPoles(card("3"), proof));
  for (
    const product of [
      undefined,
      card("2"),
      card("3", "Автомат защиты двигателя 2P"),
      { ...card("3"), facet_captions: { [axis.key]: "Полюса аксессуара" } },
      { ...card("3"), facet_values: { other_poles: ["3"] } },
      { ...card("3"), facet_values: { [axis.key]: ["3", "2"] } },
    ]
  ) {
    assertEquals(
      productProvesMotorProtectionPoles(product as ProductFull, proof),
      false,
    );
  }
  assertEquals(
    productProvesMotorProtectionPoles(card("3"), {
      status: "unverified",
      reason: "missing_catalog_evidence",
    }),
    false,
  );
  assert(
    productProvesMotorProtectionPoles(undefined, { status: "not_applicable" }),
  );
});
