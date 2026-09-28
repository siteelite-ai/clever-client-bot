import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveVerifiedApplicationSelection } from "./verified-application-selection.ts";

const facets = [
  {
    key: "length",
    caption: "Длина кабеля, м",
    unit: "м",
    values: [{ value: "20" }, { value: "30" }],
  },
  {
    key: "section",
    caption: "Сечение жилы, мм2",
    unit: "мм2",
    values: [{ value: "1.5" }, { value: "2.5" }],
  },
  {
    key: "cores",
    caption: "Количество жил",
    values: [{ value: "2" }, { value: "3" }],
  },
  {
    key: "ip",
    caption: "Степень защиты",
    values: [{ value: "20" }, { value: "44" }],
  },
  {
    key: "current",
    caption: "Номинальный ток, А",
    unit: "А",
    values: [{ value: "10" }, { value: "16" }],
  },
  {
    key: "cable_type",
    caption: "Тип кабеля",
    values: [{ value: "ПВС" }, { value: "КГ" }],
  },
];

Deno.test("outdoor welding extension becomes one complete live-facet safety contract", () => {
  for (
    const message of [
      "Подберите удлинитель для подключения сварочного аппарата на улице, длина 30 метров.",
      "Нужен уличный удлинитель 30 м для сварочного аппарата. Подбери варианты",
    ]
  ) {
    const plan = resolveVerifiedApplicationSelection(
      message,
      "Удлинители",
      facets,
    );
    assertEquals(plan?.rule, "outdoor_welding_extension_16a");
    assertEquals(plan?.criteria.map(({ value }) => value), [
      "30",
      "2.5",
      "3",
      "44",
      "16",
      "КГ",
    ]);
    assertStringIncludes(plan?.reasoning ?? "", "длина кабеля — 30 м");
    assertStringIncludes(plan?.reasoning ?? "", "тип кабеля — КГ");
    assertStringIncludes(plan?.reasoning ?? "", "количество жил — 3");
    assertStringIncludes(plan?.reasoning ?? "", "сечение жилы — 2,5 мм²");
    assertStringIncludes(plan?.reasoning ?? "", "16 А");
    assertStringIncludes(plan?.reasoning ?? "", "IP44");
  }
});

Deno.test("verified application rule fails closed when one live proof axis is absent or ambiguous", () => {
  assertEquals(
    resolveVerifiedApplicationSelection(
      "Нужен уличный удлинитель 30 м для сварочного аппарата",
      "Удлинители",
      facets.filter(({ key }) => key !== "ip"),
    ),
    null,
  );
  assertEquals(
    resolveVerifiedApplicationSelection(
      "Нужен уличный удлинитель 30 м для сварочного аппарата",
      "Удлинители",
      [...facets, {
        key: "ip2",
        caption: "Степень защиты",
        values: [{ value: "44" }],
      }],
    ),
    null,
  );
  assertEquals(
    resolveVerifiedApplicationSelection(
      "Нужен уличный удлинитель 30 м для сварочного аппарата",
      "Удлинители",
      facets.filter(({ key }) => key !== "length"),
    ),
    null,
  );
  assertEquals(
    resolveVerifiedApplicationSelection(
      "Нужен уличный удлинитель 30 м для сварочного аппарата",
      "Удлинители",
      facets.map((facet) =>
        facet.key === "length"
          ? { ...facet, values: [{ value: "20" }, { value: "50" }] }
          : facet
      ),
    ),
    null,
  );
});

Deno.test("verified application rule does not intercept adjacent selection requests", () => {
  assertEquals(
    resolveVerifiedApplicationSelection(
      "Нужен удлинитель 30 м",
      "Удлинители",
      facets,
    ),
    null,
  );
  assertEquals(
    resolveVerifiedApplicationSelection(
      "Нужен уличный удлинитель для газонокосилки",
      "Удлинители",
      facets,
    ),
    null,
  );
  assertEquals(
    resolveVerifiedApplicationSelection(
      "Нужен уличный удлинитель для сварочного аппарата",
      "Удлинители",
      facets,
    ),
    null,
  );
  assertEquals(
    resolveVerifiedApplicationSelection(
      "Нужен уличный удлинитель 30 м для сварочного аппарата",
      "Сетевые фильтры",
      facets,
    ),
    null,
  );
});
