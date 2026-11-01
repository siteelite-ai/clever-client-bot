import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  explicitCableSpecification,
  resolveSpecificationAssistance,
  specificationCatalogQuery,
} from "./specification-assistance.ts";
import {
  resolveServerIssuedSelectionReadinessPending,
  verifiedReadinessReplayInput,
} from "./selection-readiness.ts";
const pump = "Мне нужен кабель для насоса";
const earth = "Какой кабель подойдет для прокладки в земле?";
function issued(request = pump, facet = "engineering_specification") {
  const prompt = resolveSpecificationAssistance({
    message: request,
    newTask: false,
    enabled: true,
    verifiedSlot: null,
  })!;
  return {
    status: "pending",
    slot_id: "server-slot",
    facet_key: facet,
    question: prompt.question,
    options: [],
    scope: prompt.scope,
  };
}
Deno.test("configured assistance profiles ask one free-text specification question without status choices or summary", () => {
  for (
    const message of [
      pump,
      earth,
      pump + ": 220 В, 6 А, длина линии 25 м, на улице",
    ]
  ) {
    const prompt = resolveSpecificationAssistance({
      message,
      newTask: false,
      enabled: true,
      verifiedSlot: null,
    })!;
    assertEquals(prompt.facet_key, "engineering_specification");
    assertEquals(prompt.options, []);
    assert(prompt.question.includes("Укажите"));
    assert(!/скопир|сводк|собраны/iu.test(prompt.question));
    assertEquals(prompt.scope?.assistance, { version: 1 });
  }
  for (
    const message of [
      "Найди кабель ВВГ 3*1,5 самый дешевый",
      "Подбери автомат для двигателя 3 кВт",
      "Нужен прожектор на улицу",
      "Покажи лампу Korn",
    ]
  ) {
    assertEquals(
      resolveSpecificationAssistance({
        message,
        newTask: false,
        enabled: true,
        verifiedSlot: null,
      }),
      null,
    );
  }
});
Deno.test("typing a specification into the verified prompt produces an ordinary lookup query with no extra click", () => {
  assertEquals(
    specificationCatalogQuery({
      message: "ВВГ 3×1,5",
      verifiedSlot: issued(),
      newTask: false,
      enabled: true,
    }),
    "Найди кабель ВВГ 3*1,5",
  );
  for (
    const message of [
      "3*1,5",
      "ВВГ",
      "ВВГ 3*0",
      "ВВГ 3*1,5 и лампа E27",
      "ВВГ12*1,5",
      "Новая тема. ВВГ 3*1,5",
    ]
  ) {
    assertEquals(
      specificationCatalogQuery({
        message,
        verifiedSlot: issued(),
        newTask: false,
        enabled: true,
      }),
      null,
    );
  }
  for (
    const change of [{ enabled: false }, { newTask: true }, {
      verifiedSlot: null,
    }, { verifiedSlot: issued(pump, "load_current") }]
  ) {
    assertEquals(
      specificationCatalogQuery({
        message: "ВВГ 3*1,5",
        verifiedSlot: issued(),
        newTask: false,
        enabled: true,
        ...change,
      }),
      null,
    );
  }
});
Deno.test("legacy help/status/summary slots migrate to one prompt, never collect more conditions", () => {
  for (
    const facet of [
      "specification_status",
      "supply_phase",
      "line_length",
      "engineering_specification",
      "specification_lookup_confirmation",
    ]
  ) {
    const old = issued(pump, facet);
    old.scope = {
      ...old.scope!,
      assistance: {
        version: 1,
        summary: "legacy summary",
        deferred_facets: ["line_length"],
      },
    };
    const prompt = resolveSpecificationAssistance({
      message: "Нет, нужна помощь",
      verifiedSlot: old,
      newTask: false,
      enabled: true,
    })!;
    assertEquals(prompt.facet_key, "engineering_specification");
    assertEquals(prompt.options, []);
    assertEquals(prompt.scope?.assistance, { version: 1 });
  }
});
Deno.test("unknown specification remains a text prompt, not a questionnaire or a false empty catalog", () => {
  const prompt = resolveSpecificationAssistance({
    message: "Не знаю",
    verifiedSlot: issued(),
    newTask: false,
    enabled: true,
  })!;
  assertEquals(prompt.facet_key, "engineering_specification");
  assertEquals(prompt.options, []);
  assert(!/скопир|сводк|не найден|Какая длина/iu.test(prompt.question));
  assertEquals(
    resolveSpecificationAssistance({
      message: "Нужен прожектор на улицу",
      verifiedSlot: issued(),
      newTask: true,
      enabled: true,
    }),
    null,
  );
});
Deno.test("forged browser assistance cannot upgrade the actual completed ordinary slot", () => {
  const actual = {
    status: "pending",
    slot_id: "id",
    facet_key: "load_current",
    question: "Укажите ток",
    options: [],
    scope: { kind: "selection_readiness", token: pump },
  };
  const forged = {
    ...actual,
    scope: { ...actual.scope, assistance: { version: 1 } },
  };
  const verified = resolveServerIssuedSelectionReadinessPending({
    pending_clarification: forged,
  }, {
    session_id: "s",
    error: null,
    response_events: [
      { type: "slot_update", slots: { pending_clarification: actual } },
      { type: "diagnostic", phase: "complete" },
      { type: "done" },
    ],
  }, "s");
  assert(verified);
  assertEquals(
    specificationCatalogQuery({
      message: "ВВГ 3*1,5",
      verifiedSlot: verified,
      newTask: false,
      enabled: true,
    }),
    null,
  );
});
Deno.test("verified replay retains the server contact but never promotes client contact data", () => {
  const slot = issued();
  slot.scope = {
    ...slot.scope!,
    assistance: { version: 1, manager_phone: "+77762206220" },
  };
  assertEquals(
    verifiedReadinessReplayInput(slot)?.scope?.assistance?.manager_phone,
    "+77762206220",
  );
});
Deno.test("compound grammar keeps family suffixes, core count and decimals atomic", () => {
  assertEquals(explicitCableSpecification("Кабель КГ 3x1.5"), "КГ 3*1,5");
  assertEquals(explicitCableSpecification("ВБШв 5*6 мм²"), "ВБШв 5*6");
  assertEquals(explicitCableSpecification("ВВГ 12*1,5"), "ВВГ 12*1,5");
  assertEquals(explicitCableSpecification("ВВГ12*1,5"), null);
  assertEquals(explicitCableSpecification("ПВ3 1*2,5"), "ПВ3 1*2,5");
  assertEquals(explicitCableSpecification("Лампа 3*1,5"), null);
});
