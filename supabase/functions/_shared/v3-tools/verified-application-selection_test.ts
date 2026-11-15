import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveApplicationLoadReadiness,
  resolveVerifiedApplicationSelection,
} from "./verified-application-selection.ts";
import { joinCustomerTurns } from "./criteria-consistency.ts";

const weldingRequest =
  "Подберите удлинитель для подключения сварочного аппарата на улице, длина 30 метров.";

function compilePlan(
  message: string,
  category: string,
  facets: Parameters<typeof resolveVerifiedApplicationSelection>[2],
) {
  const load = resolveApplicationLoadReadiness(
    message,
    "12 А",
    true,
  );
  return resolveVerifiedApplicationSelection(
    message,
    category,
    facets,
    load?.status === "ready" ? load : null,
  );
}

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
    const plan = compilePlan(
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
    assertStringIncludes(plan?.reasoning ?? "", "длину кабеля — 30 м");
    assertStringIncludes(plan?.reasoning ?? "", "тип КГ");
    assertStringIncludes(plan?.reasoning ?? "", "3 жилы");
    assertStringIncludes(plan?.reasoning ?? "", "сечение жилы 2,5 мм²");
    assertStringIncludes(plan?.reasoning ?? "", "16 А");
    assertStringIncludes(plan?.reasoning ?? "", "IP44");
  }
});

Deno.test("verified application rule fails closed when one live proof axis is absent or ambiguous", () => {
  assertEquals(
    compilePlan(
      "Нужен уличный удлинитель 30 м для сварочного аппарата",
      "Удлинители",
      facets.filter(({ key }) => key !== "ip"),
    ),
    null,
  );
  assertEquals(
    compilePlan(
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
    compilePlan(
      "Нужен уличный удлинитель 30 м для сварочного аппарата",
      "Удлинители",
      facets.filter(({ key }) => key !== "length"),
    ),
    null,
  );
  assertEquals(
    compilePlan(
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
    compilePlan(
      "Нужен удлинитель 30 м",
      "Удлинители",
      facets,
    ),
    null,
  );
  assertEquals(
    compilePlan(
      "Нужен уличный удлинитель для газонокосилки",
      "Удлинители",
      facets,
    ),
    null,
  );
  assertEquals(
    compilePlan(
      "Нужен уличный удлинитель для сварочного аппарата",
      "Удлинители",
      facets,
    ),
    null,
  );
  assertEquals(
    compilePlan(
      "Нужен уличный удлинитель 30 м для сварочного аппарата",
      "Сетевые фильтры",
      facets,
    ),
    null,
  );
});

Deno.test("application load does not accept output, reel rating, approximations or an unverified short reply", () => {
  for (
    const answer of [
      "сварочный ток 190 А",
      "модель САИ-190",
      "удлинитель на 16 А",
      "I1eff 12 А",
      "входной ток 12–16 А",
      "входной ток примерно 12 А",
      "входной ток 12 А или 16 А",
      "входной ток 0 А",
      "16",
      "входной ток не более 16 А",
      "не входной ток 12 А",
    ]
  ) {
    assertEquals(
      resolveApplicationLoadReadiness(
        joinCustomerTurns([weldingRequest, `Уточнение клиента: ${answer}`]),
        answer,
        true,
      )?.status,
      "ask",
      answer,
    );
  }
  assertEquals(
    resolveApplicationLoadReadiness(weldingRequest, "12 А")?.status,
    "ask",
  );
  assertEquals(
    resolveVerifiedApplicationSelection(
      weldingRequest,
      "Удлинители",
      facets,
      null,
    ),
    null,
  );
});

Deno.test("verified input current is a capacity prerequisite, not a product rating", () => {
  for (
    const answer of [
      "12 А",
      "По шильдику: 12 A",
      "I₁max: 12 А",
      "Входной ток аппарата 12 А",
    ]
  ) {
    assertEquals(
      resolveApplicationLoadReadiness(
        joinCustomerTurns([weldingRequest, `Уточнение клиента: ${answer}`]),
        answer,
        true,
      ),
      {
        status: "ready",
        rule: "outdoor_welding_extension_16a",
        amps: 12,
        catalogRequest: weldingRequest,
      },
    );
  }
  assertEquals(
    resolveApplicationLoadReadiness(weldingRequest, "16 А", true)?.status,
    "ready",
  );
  assertEquals(
    resolveApplicationLoadReadiness(weldingRequest, "16,1 А", true)?.status,
    "unsupported",
  );
  const complete = `${weldingRequest} Входной ток 12,5 А; длина 30 м`;
  const ready = resolveApplicationLoadReadiness(complete);
  assertEquals(ready?.status, "ready");
  assertEquals(ready?.status === "ready" ? ready.amps : null, 12.5);
  assertStringIncludes(
    ready?.status === "ready" ? ready.catalogRequest : "",
    "длина 30 м",
  );
  assertEquals(
    resolveApplicationLoadReadiness("Нужен удлинитель 30 м для газонокосилки"),
    null,
  );
  assertEquals(
    resolveApplicationLoadReadiness(
      "К сварочному инвертору нужен уличный удлинитель 30 м",
    )?.status,
    "ask",
  );
  assertEquals(
    compilePlan(
      "Нужен уличный удлинитель 20–30 м для сварочника",
      "Удлинители",
      facets,
    ),
    null,
  );
});
