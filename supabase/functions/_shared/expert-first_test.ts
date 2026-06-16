// expert-first_test.ts — юнит-тесты модуля expert-first (надстройка-эксперт на входе).
// Не ходит в реальный OpenRouter: подменяем fetchImpl.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { expertFirstJudgment } from "./expert-first.ts";

function mockFetchOk(toolArgs: Record<string, unknown>): typeof fetch {
  return ((_url: string, _init?: RequestInit) =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{
            message: {
              tool_calls: [{
                function: {
                  name: "expert_judgment",
                  arguments: JSON.stringify(toolArgs),
                },
              }],
            },
          }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )) as unknown as typeof fetch;
}

function mockFetchStatus(status: number): typeof fetch {
  return ((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response("nope", { status }))) as unknown as typeof fetch;
}

function mockFetchThrow(err: Error): typeof fetch {
  return ((_url: string, _init?: RequestInit) =>
    Promise.reject(err)) as unknown as typeof fetch;
}

Deno.test("expert-first: empty query → empty result, no LLM call", async () => {
  let called = false;
  const res = await expertFirstJudgment({
    originalQuery: "   ",
    openrouterKey: "k",
    fetchImpl: (() => {
      called = true;
      return Promise.resolve(new Response("", { status: 200 }));
    }) as unknown as typeof fetch,
  });
  assertEquals(called, false);
  assertEquals(res.intent, "unknown");
  assertEquals(res.llmOk, false);
});

Deno.test("expert-first: missing key → empty result", async () => {
  const res = await expertFirstJudgment({
    originalQuery: "кабель 3 кВт",
    openrouterKey: "",
  });
  assertEquals(res.llmOk, false);
  assertEquals(res.intent, "unknown");
});

Deno.test("expert-first: happy path — catalog intent, facets parsed", async () => {
  const res = await expertFirstJudgment({
    originalQuery: "кабель для кондиционера 3 кВт",
    openrouterKey: "k",
    fetchImpl: mockFetchOk({
      intent: "catalog",
      productNoun: "кабель",
      facetHints: {
        material: ["медь"],
        sechenie: ["2.5"],
        kolichestvo_zhil: ["3"],
      },
      apiHints: { min_price: null, max_price: null, priceIntent: null, brand: null },
      reasoning: "3 кВт ≈ 14 А, для бытовой проводки беру медь 2.5 мм² 3 жилы.",
      confidence: "high",
    }),
  });
  assertEquals(res.llmOk, true);
  assertEquals(res.intent, "catalog");
  assertEquals(res.productNoun, "кабель");
  assertEquals(res.confidence, "high");
  assertEquals(res.facetHints.material, ["медь"]);
  assertEquals(res.facetHints.sechenie, ["2.5"]);
  assertEquals(res.facetHints.kolichestvo_zhil, ["3"]);
});

Deno.test("expert-first: price intent + max_price hint", async () => {
  const res = await expertFirstJudgment({
    originalQuery: "самый дешёвый удлинитель до 5000 тг",
    openrouterKey: "k",
    fetchImpl: mockFetchOk({
      intent: "price",
      productNoun: "удлинитель",
      facetHints: {},
      apiHints: { min_price: null, max_price: 5000, priceIntent: "cheapest", brand: null },
      reasoning: "Бюджетный сегмент, сортировка по возрастанию цены.",
      confidence: "high",
    }),
  });
  assertEquals(res.intent, "price");
  assertEquals(res.apiHints.priceIntent, "cheapest");
  assertEquals(res.apiHints.max_price, 5000);
});

Deno.test("expert-first: unknown intent value → coerced to 'unknown'", async () => {
  const res = await expertFirstJudgment({
    originalQuery: "что-то странное",
    openrouterKey: "k",
    fetchImpl: mockFetchOk({
      intent: "totally_made_up",
      productNoun: "x",
      facetHints: {},
      apiHints: { min_price: null, max_price: null, priceIntent: null, brand: null },
      reasoning: "n/a",
      confidence: "low",
    }),
  });
  assertEquals(res.intent, "unknown");
  assertEquals(res.llmOk, true);
});

Deno.test("expert-first: sanitize — non-array facet values dropped, max 3 values, max 8 keys", async () => {
  const bigFacets: Record<string, unknown> = {};
  for (let i = 0; i < 20; i++) bigFacets["k" + i] = ["v"];
  bigFacets.bad = "not-array";
  bigFacets.material = ["медь", "алюминий", "сталь", "латунь"]; // должно урезаться до 3
  const res = await expertFirstJudgment({
    originalQuery: "кабель",
    openrouterKey: "k",
    fetchImpl: mockFetchOk({
      intent: "catalog",
      productNoun: "кабель",
      facetHints: bigFacets,
      apiHints: { min_price: null, max_price: null, priceIntent: null, brand: null },
      reasoning: "",
      confidence: "low",
    }),
  });
  assertEquals(Object.keys(res.facetHints).length <= 8, true);
  if (res.facetHints.material) {
    assertEquals(res.facetHints.material.length <= 3, true);
  }
  assertEquals(res.facetHints.bad, undefined);
});

Deno.test("expert-first: priceIntent invalid value → null", async () => {
  const res = await expertFirstJudgment({
    originalQuery: "кабель",
    openrouterKey: "k",
    fetchImpl: mockFetchOk({
      intent: "catalog",
      productNoun: "кабель",
      facetHints: {},
      apiHints: { min_price: -5, max_price: "abc", priceIntent: "weird", brand: "  " },
      reasoning: "",
      confidence: "low",
    }),
  });
  assertEquals(res.apiHints.priceIntent, null);
  assertEquals(res.apiHints.min_price, null);
  assertEquals(res.apiHints.max_price, null);
  assertEquals(res.apiHints.brand, null);
});

Deno.test("expert-first: HTTP error → empty result, no throw", async () => {
  const res = await expertFirstJudgment({
    originalQuery: "кабель",
    openrouterKey: "k",
    fetchImpl: mockFetchStatus(500),
  });
  assertEquals(res.llmOk, false);
  assertEquals(res.intent, "unknown");
});

Deno.test("expert-first: network throw → empty result, no throw", async () => {
  const res = await expertFirstJudgment({
    originalQuery: "кабель",
    openrouterKey: "k",
    fetchImpl: mockFetchThrow(new Error("boom")),
  });
  assertEquals(res.llmOk, false);
});

Deno.test("expert-first: no tool_calls in response → empty result", async () => {
  const fetchImpl = ((_url: string) =>
    Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: "no tools" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )) as unknown as typeof fetch;
  const res = await expertFirstJudgment({
    originalQuery: "кабель",
    openrouterKey: "k",
    fetchImpl,
  });
  assertEquals(res.llmOk, false);
});
