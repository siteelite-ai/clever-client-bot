// Unit tests for expert-interpretation.ts
// Запускать через supabase--test_edge_functions { functions: ["_shared"] } или прямой `deno test`.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { interpretRequirement, type ExpertOption } from "./expert-interpretation.ts";

const SAMPLE_SCHEMA: ExpertOption[] = [
  {
    key: "material",
    caption_ru: "Материал жилы",
    values: [{ value_ru: "медь" }, { value_ru: "алюминий" }],
  },
  {
    key: "kolichestvo_zhil",
    caption_ru: "Количество жил",
    values: [{ value_ru: "2" }, { value_ru: "3" }, { value_ru: "4" }, { value_ru: "5" }],
  },
  {
    key: "sechenie",
    caption_ru: "Сечение",
    values: [
      { value_ru: "1.5 мм²" },
      { value_ru: "2.5 мм²" },
      { value_ru: "4 мм²" },
      { value_ru: "6 мм²" },
      { value_ru: "10 мм²" },
    ],
  },
];

// Стаб-сервер OpenRouter для unit-тестов.
function withMockedFetch(
  responseBuilder: (req: Request) => Response | Promise<Response>,
  testFn: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input as RequestInfo, init);
      return Promise.resolve(responseBuilder(req));
    };
    try {
      await testFn();
    } finally {
      globalThis.fetch = orig;
    }
  };
}

function mockOpenRouterResponse(toolArgs: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      choices: [{
        message: {
          tool_calls: [{
            function: {
              name: "interpret_requirement",
              arguments: JSON.stringify(toolArgs),
            },
          }],
        },
      }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

Deno.test("expert: returns EMPTY when schema is missing", async () => {
  const res = await interpretRequirement({
    originalQuery: "кабель для кондиционера 3 кВт",
    productCategory: "кабель",
    optionSchema: [],
    openrouterKey: "test-key",
  });
  assertEquals(res.llmOk, false);
  assertEquals(res.targetFacets, {});
  assertEquals(res.confidence, "none");
});

Deno.test("expert: returns EMPTY when openrouterKey is missing", async () => {
  const res = await interpretRequirement({
    originalQuery: "кабель для кондиционера 3 кВт",
    productCategory: "кабель",
    optionSchema: SAMPLE_SCHEMA,
    openrouterKey: "",
  });
  assertEquals(res.llmOk, false);
  assertEquals(res.targetFacets, {});
});

Deno.test("expert: maps load → section via schema (happy path)", withMockedFetch(
  () => mockOpenRouterResponse({
    targetFacets: {
      material: ["медь"],
      kolichestvo_zhil: ["3"],
      sechenie: ["2.5"], // schema хранит "2.5 мм²" — должен сматчиться substring
    },
    reasoning: "Для 3 кВт нагрузки нужен медный кабель ВВГнг 3×2.5 мм².",
    confidence: "high",
  }),
  async () => {
    const res = await interpretRequirement({
      originalQuery: "кабель для подключения кондиционера мощностью 3 кВт",
      productCategory: "кабель",
      searchModifiers: ["подключения", "кондиционера", "мощностью", "3", "кВт"],
      optionSchema: SAMPLE_SCHEMA,
      openrouterKey: "test-key",
    });
    assertEquals(res.llmOk, true);
    assertEquals(res.confidence, "high");
    assertEquals(res.targetFacets.material, ["медь"]);
    assertEquals(res.targetFacets.kolichestvo_zhil, ["3"]);
    assertEquals(res.targetFacets.sechenie, ["2.5 мм²"]); // resolved to real value
    assert(res.reasoning.length > 0);
  },
));

Deno.test("expert: drops hallucinated facet key not in schema", withMockedFetch(
  () => mockOpenRouterResponse({
    targetFacets: {
      material: ["медь"],
      brand: ["Кабэкс"], // НЕТ в schema → dropped
    },
    reasoning: "...",
    confidence: "medium",
  }),
  async () => {
    const res = await interpretRequirement({
      originalQuery: "медный кабель",
      productCategory: "кабель",
      optionSchema: SAMPLE_SCHEMA,
      openrouterKey: "k",
    });
    assertEquals(res.llmOk, true);
    assertEquals(res.targetFacets.material, ["медь"]);
    assertEquals(res.targetFacets.brand, undefined);
    assertEquals(res.droppedKeys, ["brand"]);
  },
));

Deno.test("expert: drops hallucinated value not in schema", withMockedFetch(
  () => mockOpenRouterResponse({
    targetFacets: {
      material: ["золото"],   // галлюцинация
      sechenie: ["100 мм²"],  // галлюцинация
      kolichestvo_zhil: ["3"], // ok
    },
    reasoning: "...",
    confidence: "low",
  }),
  async () => {
    const res = await interpretRequirement({
      originalQuery: "x",
      productCategory: "кабель",
      optionSchema: SAMPLE_SCHEMA,
      openrouterKey: "k",
    });
    assertEquals(res.targetFacets.material, undefined);
    assertEquals(res.targetFacets.sechenie, undefined);
    assertEquals(res.targetFacets.kolichestvo_zhil, ["3"]);
    assertEquals(res.droppedValues.length, 2);
  },
));

Deno.test("expert: empty targetFacets → preserved (no facets to apply)", withMockedFetch(
  () => mockOpenRouterResponse({
    targetFacets: {},
    reasoning: "Запрос слишком общий, не могу подобрать конкретные параметры.",
    confidence: "low",
  }),
  async () => {
    const res = await interpretRequirement({
      originalQuery: "нужен кабель",
      productCategory: "кабель",
      optionSchema: SAMPLE_SCHEMA,
      openrouterKey: "k",
    });
    assertEquals(res.llmOk, true);
    assertEquals(res.targetFacets, {});
    assertEquals(res.confidence, "low");
    assert(res.reasoning.length > 0);
  },
));

Deno.test("expert: HTTP error → EMPTY result, no throw", withMockedFetch(
  () => new Response("rate limited", { status: 429 }),
  async () => {
    const res = await interpretRequirement({
      originalQuery: "x",
      productCategory: "кабель",
      optionSchema: SAMPLE_SCHEMA,
      openrouterKey: "k",
    });
    assertEquals(res.llmOk, false);
    assertEquals(res.targetFacets, {});
  },
));

Deno.test("expert: missing tool_calls → EMPTY", withMockedFetch(
  () => new Response(
    JSON.stringify({ choices: [{ message: { content: "no tools" } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  ),
  async () => {
    const res = await interpretRequirement({
      originalQuery: "x",
      productCategory: "кабель",
      optionSchema: SAMPLE_SCHEMA,
      openrouterKey: "k",
    });
    assertEquals(res.llmOk, false);
  },
));
