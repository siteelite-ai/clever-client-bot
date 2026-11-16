import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isReservedStabilizerApplicationSlot,
  isStabilizerApplicationReply,
  resolveStabilizerApplication,
} from "./stabilizer-application.ts";
import {
  agreesWithStabilizerPassport,
  qualifyingStabilizerPassports,
} from "./stabilizer-passport-proof.ts";
import type { ProductFull } from "./types.ts";

export const stabilizerRequest =
  "Мне нужен стабилизатор напряжения для дома, если напряжение часто падает до 170 вольт. Что посоветуете?";
function asked(result: ReturnType<typeof resolveStabilizerApplication>) {
  assert(result?.status === "ask");
  return result.clarification;
}

Deno.test("stabilizer: measured input survives clarifications; watts are not converted to VA by default", () => {
  const first = asked(resolveStabilizerApplication(stabilizerRequest, null));
  assertStringIncludes(first.question, "170 В");
  assertStringIncludes(first.question, "Сеть однофазная");
  assert(
    isReservedStabilizerApplicationSlot(
      first as unknown as Record<string, unknown>,
    ),
  );
  const second = asked(
    resolveStabilizerApplication("1 фаза, нагрузка 1 кВт, без пусковых токов", {
      ...first,
    }),
  );
  assertStringIncludes(second.question, "ватты равны вольт-амперам");
  assertEquals(
    resolveStabilizerApplication("полная нагрузка 1,2 кВА", { ...second }),
    {
      status: "ready",
      application: {
        inputV: 170,
        phases: 1,
        loadVa: 1200,
        peakVa: 1200,
        kind: "steady",
      },
    },
  );
  assert(
    !isStabilizerApplicationReply("Кабель для насоса на 1 кВт", { ...first }),
  );
  assertEquals(
    resolveStabilizerApplication("Новая тема. Нагрузка 1,2 кВА", { ...second }),
    null,
  );
  assertEquals(
    resolveStabilizerApplication("1 фаза, нагрузка не 3 кВА", { ...first })
      ?.status,
    "ask",
  );
  assertEquals(
    resolveStabilizerApplication("1 фаза, 3 фазы, нагрузка 1 кВА", { ...first })
      ?.status,
    "ask",
  );
  assertEquals(
    resolveStabilizerApplication("Не знаю", { ...first })?.status,
    "stop",
  );
  assertEquals(
    resolveStabilizerApplication("3 фазы, 1 кВА", { ...first })?.status,
    "stop",
  );
});

Deno.test("stabilizer: peak confirmed separately; explicitly new purchase constraints do not enter generic route", () => {
  const first = asked(resolveStabilizerApplication(stabilizerRequest, null));
  const second = asked(
    resolveStabilizerApplication("Одна фаза, нагрузка 1 кВА, есть насос", {
      ...first,
    }),
  );
  assertStringIncludes(second.question, "пиковую нагрузку");
  assertEquals(
    resolveStabilizerApplication("пиковая 0,9 кВА", { ...second })?.status,
    "ask",
  );
  const ready = resolveStabilizerApplication("пиковая 2 кВА", { ...second });
  assertEquals(ready, {
    status: "ready",
    application: {
      inputV: 170,
      phases: 1,
      loadVa: 1000,
      peakVa: 2000,
      kind: "motor",
    },
  });
  for (
    const raw of [
      "Покажи стабилизатор на 5 кВт, напряжение падает до 170 В",
      "Мне нужен стабилизатор для газового котла, падает до 170 В",
      "Нужен ИБП для насоса при просадке до 170 В",
      "Нужен стабилизатор Ресанта при просадке до 170 В",
      "Нужен инверторный стабилизатор при просадке до 170 В",
    ]
  ) assertEquals(resolveStabilizerApplication(raw, null), null);
});

Deno.test("stabilizer: corrected input replaces only the recorded minimum, not the remaining load facts", () => {
  const first = asked(resolveStabilizerApplication(stabilizerRequest, null));
  const details = "одна фаза, нагрузка 1 кВА, без пусковых токов";
  for (
    const [input, expectedV] of [
      ["Поправка: 150 В", 150],
      ["Поправка: 150В", 150],
      ["Минимум 150 В", 150],
      ["На входе 150 В, на выходе 220 В", 150],
      ["Напряжение падает с 220 В до 150 В", 150],
      ["Номинал 220 В", 170],
      ["Поправка: 150 В на выходе", 170],
    ] as const
  ) {
    assertEquals(
      resolveStabilizerApplication(`${input}; ${details}`, { ...first }),
      {
        status: "ready",
        application: {
          inputV: expectedV,
          phases: 1,
          loadVa: 1000,
          peakVa: 1000,
          kind: "steady",
        },
      },
      input,
    );
  }
  const pendingLoad = asked(
    resolveStabilizerApplication("1 фаза, нагрузка 1 кВА", { ...first }),
  );
  const clarified = resolveStabilizerApplication(
    "На входе 150 В, нагрузка 1,05 кВА, без пусковых токов",
    { ...pendingLoad },
  );
  assert(clarified?.status === "ready");
  assertEquals(clarified.application, {
    inputV: 150,
    phases: 1,
    loadVa: 1050,
    peakVa: 1050,
    kind: "steady",
  });
  assert(
    !qualifyingStabilizerPassports(clarified.application).some(
      ({ article }) => article === "IVS21-1-002-13",
    ),
  );
});

Deno.test("stabilizer: contradictory or unsupported input cannot fall back to a superseded 170 V", () => {
  const first = asked(resolveStabilizerApplication(stabilizerRequest, null));
  const load = asked(
    resolveStabilizerApplication("1 фаза, нагрузка 1 кВА", { ...first }),
  );
  for (
    const phrase of [
      "На входе 150 или 160 В",
      "Поправка: не 170 В, а 150 В",
      "Падает до 150 В и 160 В",
      "На входе 150 В на выходе 220 В",
      "На входе 50 В",
    ]
  ) {
    const updated = asked(resolveStabilizerApplication(phrase, { ...load }));
    const resolved = resolveStabilizerApplication("150 В, без пусковых токов", {
      ...updated,
    });
    assertEquals(resolved, {
      status: "ready",
      application: {
        inputV: 150,
        phases: 1,
        loadVa: 1000,
        peakVa: 1000,
        kind: "steady",
      },
    }, phrase);
  }
});

Deno.test("stabilizer: comparable evidence at the actual input and with the correct curve", () => {
  const sample = {
    inputV: 170,
    phases: 1 as const,
    loadVa: 1000,
    peakVa: 1000,
    kind: "steady" as const,
  };
  const std = qualifyingStabilizerPassports(sample);
  assertEquals(std[0].article, "IVS21-1-002-13");
  assertEquals(std[0].provenVa, 1100);
  assertEquals(
    qualifyingStabilizerPassports({ ...sample, inputV: 150 })[0].provenVa,
    1000,
  );
  assertEquals(
    qualifyingStabilizerPassports({ ...sample, inputV: 169 })[0].provenVa,
    1000,
  );
  assertEquals(qualifyingStabilizerPassports({ ...sample, inputV: 139 }), []);
  assertEquals(qualifyingStabilizerPassports({ ...sample, inputV: 145 }), []);
  assertEquals(qualifyingStabilizerPassports({ ...sample, inputV: 261 }), []);
  assertEquals(qualifyingStabilizerPassports({ ...sample, phases: 3 }), []);
  const motor = qualifyingStabilizerPassports({
    ...sample,
    kind: "motor",
    peakVa: 2000,
  });
  assertEquals(motor.map(({ nominalVa, provenVa }) => [nominalVa, provenVa]), [[
    12000,
    2160,
  ]]);
  assertEquals(
    qualifyingStabilizerPassports({ ...sample, kind: "motor", peakVa: 2200 }),
    [],
  );
});

Deno.test("stabilizer: passport cannot override contradictory catalog data or fake stock", () => {
  const proof = qualifyingStabilizerPassports({
    inputV: 170,
    phases: 1,
    loadVa: 1000,
    peakVa: 1000,
    kind: "steady",
  })[0];
  const p: ProductFull = {
    id: "same",
    article: proof.article,
    vendor: "IEK",
    pagetitle: "Стабилизатор HUB 2кВА IEK",
    leaf_category: "Стабилизаторы",
    url: "https://220volt.kz/catalog/hub-2",
    price: 10800,
    stock: "in_stock",
    warehouse_evidence: "positive",
    warehouses: [{ city: "Караганда", qty: 1 }],
    short_traits: [
      "Количество фаз: 1",
      "Номинальная мощность, кВА: 2",
      "Входное напряжение, В: 140–260",
    ],
  };
  assert(agreesWithStabilizerPassport(p, proof, 170));
  for (
    const invalid of [
      { vendor: null },
      { article: "IVS21-1-002-09" },
      { price: 0 },
      { warehouse_evidence: "unverified" as const },
      { warehouses: [] },
      { short_traits: ["Количество фаз: 3"] },
      { short_traits: ["Номинальная мощность, кВА: 3"] },
      { short_traits: ["Входное напряжение, В: 175–260"] },
      { pagetitle: "Стабилизатор 2кВА EXPAND IEK" },
      { leaf_category: "Реле контроля напряжения" },
    ]
  ) {
    assert(
      !agreesWithStabilizerPassport({ ...p, ...invalid }, proof, 170),
      JSON.stringify(invalid),
    );
  }
});
