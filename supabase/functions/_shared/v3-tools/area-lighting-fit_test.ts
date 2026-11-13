import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  areaLightingCardIssue,
  areaLightingFitText,
  compileAreaLightingFit,
  isOpenAreaLightingProtection,
} from "./area-lighting-fit.ts";
import { deriveEnvironmentalProtectionRange } from "./environmental-protection-range.ts";
import type { ProductFull } from "./types.ts";

const yard = "Подберите прожектор для двора";
const example = `${yard} 35 м², высота установки 2,5 м`;
const product: ProductFull = {
  id: "fixture",
  pagetitle: "Прожектор Fixture 30 Вт IP65",
  url: "https://fixture.invalid/floodlight",
  price: 1000,
  vendor: null,
  stock: "in_stock",
  short_traits: [],
  facet_values: { height: ["2,5"], coverage: ["40"], ip: ["IP65"] },
  facet_captions: {
    height: "Рекомендуемая высота монтажа, м",
    coverage: "Максимальная площадь освещения, м²",
    ip: "Степень защиты IP",
  },
};

Deno.test("verified customer dimensions are separate, scoped and updated independently", () => {
  const fit = compileAreaLightingFit(example, [], example)!;
  assertEquals(fit, {
    area: { min: 35, max: 35 },
    height: { min: 2.5, max: 2.5 },
    exposed: true,
  });
  assertEquals(compileAreaLightingFit("35 м²", ["2,5 м", yard], yard), fit);
  assertEquals(
    compileAreaLightingFit("Площадь 5×7 м", ["2,5 м", yard], yard),
    fit,
  );
  assertEquals(
    compileAreaLightingFit("Высота установки 3 м", [example], example),
    { ...fit, height: { min: 3, max: 3 } },
  );
  assertEquals(
    compileAreaLightingFit("Высоту пока не знаю", [example], example),
    { ...fit, height: null },
  );
  assertEquals(
    compileAreaLightingFit("Длина кабеля 2,5 м", [yard], yard),
    null,
  );
  assertEquals(
    compileAreaLightingFit("Кабель 2,5 м", [example], "Кабель 2,5 м"),
    null,
  );
  assertEquals(
    compileAreaLightingFit("35 м², высота 2,5 м", [], yard),
    null,
  );
});

Deno.test("an IP match alone cannot prove coverage or mounting height", () => {
  const fit = compileAreaLightingFit(example, [], example)!;
  assertEquals(areaLightingCardIssue(product, fit), null);
  assertEquals(
    areaLightingCardIssue({ ...product, facet_values: {} }, fit),
    "coverage",
  );
  assertEquals(
    areaLightingCardIssue({
      ...product,
      facet_values: { ...product.facet_values, height: ["4"] },
    }, fit),
    "height",
  );
  assertEquals(
    areaLightingCardIssue({
      ...product,
      facet_values: { ...product.facet_values, coverage: ["25"] },
    }, fit),
    "coverage",
  );
  assertEquals(
    areaLightingCardIssue({
      ...product,
      facet_values: { ...product.facet_values, height: ["2–4"] },
    }, fit),
    "coverage",
  );
  assertEquals(
    areaLightingCardIssue({
      ...product,
      facet_captions: {
        ...product.facet_captions,
        height: "Высота изделия, м",
      },
    }, fit),
    "coverage",
  );
  assertEquals(
    areaLightingCardIssue({
      ...product,
      facet_captions: {
        ...product.facet_captions,
        height: "Высота монтажа, м",
        coverage: "Площадь освещения при высоте 2,5 м, м²",
      },
      facet_values: { ...product.facet_values, height: ["2–4"] },
    }, fit),
    null,
  );
  assertEquals(
    areaLightingCardIssue({
      ...product,
      facet_values: { ...product.facet_values, ip: ["IP44"] },
    }, fit),
    "protection",
  );
  assertEquals(areaLightingFitText(fit, false).includes("35 м²"), true);
  assertEquals(areaLightingFitText(fit, false).includes("2,5 м"), true);
});

Deno.test("a different site uses its own geometry; the open-yard IP floor does not replace generic IP policy", () => {
  const parking = "Прожектор для парковки 80–120 м², высота монтажа 3,5 м";
  const fit = compileAreaLightingFit(parking, [], parking)!;
  assertEquals(fit.area, { min: 80, max: 120 });
  assertEquals(areaLightingCardIssue(product, fit), "height");
  const parkingFixture = {
    ...product,
    facet_values: {
      ...product.facet_values,
      height: ["3–4"],
      coverage: ["120"],
    },
    facet_captions: {
      ...product.facet_captions,
      coverage: "Площадь освещения при высоте 3,5 м",
    },
  };
  assertEquals(areaLightingCardIssue(parkingFixture, fit), null);
  const range = `${yard} до 50 м², высота 2–4 м`;
  const rangeFit = compileAreaLightingFit(range, [], range)!;
  assertEquals(
    areaLightingCardIssue({
      ...product,
      facet_values: {
        ...product.facet_values,
        height: ["2–4"],
        coverage: ["60"],
      },
      facet_captions: {
        ...product.facet_captions,
        coverage: "Площадь освещения при высоте 2–4 м, м²",
      },
    }, rangeFit),
    null,
  );
  const facets = [{
    key: "ip",
    caption: "IP",
    values: ["IP44", "IP54", "IP65", "IP66", "IP67"].map((value) => ({
      value,
    })),
  }];
  assertEquals(
    deriveEnvironmentalProtectionRange(
      yard,
      facets,
      isOpenAreaLightingProtection,
    ).acceptedValues,
    ["IP65", "IP66"],
  );
  assertEquals(
    deriveEnvironmentalProtectionRange(yard, facets).acceptedValues,
    ["IP44", "IP54", "IP65", "IP66", "IP67"],
  );
});
