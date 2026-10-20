// Production-handler regression for a customer-measured object and a live
// before/after product facet pair. All outbound calls are fixture-only.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  offlineHandler,
  restoreOfflineModuleSetup,
} from "./model-no-search-integration-fixture.ts";
import { resolveDerivedSelectionReasoning } from "../_shared/v3-tools/selection-actionability.ts";
import { terminalPairedFitDecision } from "./selection-jargon-policy.ts";
import "./index.ts";

const catalogLeaf = "Трубки термоусаживаемые";
const before = "Внутренний диаметр до усадки, мм";
const after = "Внутренний диаметр после усадки, мм";
const pairedReasoning =
  "Клиент запросил подбор, сначала проверю фасеты. Для кабеля диаметром 10 мм внутренний диаметр трубки до усадки должен быть не менее 12 мм, а внутренний диаметр после усадки должен быть строго меньше 10 мм.";
const products = [
  { id: 101, pagetitle: "Трубка ТТУ 12/6 мм", before: "12 мм", after: "6 мм" },
  { id: 102, pagetitle: "Трубка ТТУ 14/7 мм", before: "14 мм", after: "7 мм" },
  { id: 103, pagetitle: "Трубка ТТУ 16/8 мм", before: "16 мм", after: "8 мм" },
  { id: 104, pagetitle: "Трубка ТТУ 10/5 мм", before: "10 мм", after: "5 мм" },
].map((product) => ({
  ...product,
  url: `https://220volt.kz/catalog/cables/ttu/item-${product.id}/`,
  category: catalogLeaf,
  price: 600,
  warehouses: [{ city: "Караганда", amount: 3 }],
  options: [
    { key: "diameter_before", caption_ru: before, value_ru: product.before },
    { key: "diameter_after", caption_ru: after, value_ru: product.after },
  ],
}));

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function eventsFromSse(text: string): Array<Record<string, unknown>> {
  return text.split("\n\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

Deno.test("symbolic paired proof survives declaration sanitization unchanged in meaning", () => {
  const customer = "подбери трубку ТТУ на кабель диаметром 10 мм";
  const facets = [
    {
      key: "diameter_before",
      caption: before,
      unit: "мм",
      values: [{ value: "12 мм" }, { value: "14 мм" }],
    },
    {
      key: "diameter_after",
      caption: after,
      unit: "мм",
      values: [{ value: "6 мм" }, { value: "7 мм" }],
    },
  ];
  const raw =
    "Для кабеля диаметром 10 мм внутренний диаметр трубки до усадки ≥ 12 мм. Внутренний диаметр после усадки < 10 мм.";
  const pair = { value: 10, unit: "мм" };
  assertEquals(
    terminalPairedFitDecision(pair, customer, raw, facets, catalogLeaf).state,
    "required",
  );
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning: raw,
      measurement_scope: "per_product",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: [],
      explicit_customer_classifications: [],
    },
    facets,
    customer,
    catalogLeaf,
    { ...pair, facetKeys: ["diameter_before", "diameter_after"] },
  );
  assert(resolved?.reasoningEvidence.includes("≥ 12 мм"), JSON.stringify(resolved));
  assert(resolved?.reasoningEvidence.includes("‹ 10 мм"));
  assertEquals(
    terminalPairedFitDecision(
      pair,
      customer,
      resolved?.reasoningEvidence ?? "",
      facets,
      catalogLeaf,
    ).state,
    "required",
  );
});

Deno.test({
  name: "terminal paired recovery does not claim that facet-proven sizes appear in titles",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
    assert(source.includes("где оба размера подтверждены данными каталога"));
    assert(!source.includes("где обе границы видны в названии"));
  },
});

Deno.test({
  name:
    "TTU fit publishes certified bounds, cards and honest empty through SSE and replay",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const originalFetch = globalThis.fetch;
    const originalSetInterval = globalThis.setInterval;
    const intervals = new Set<number>();
    const requests: string[] = [];
    const steps: Array<{ step?: string; meta?: unknown }> = [];
    let persistedEvents: Array<Record<string, unknown>> = [];
    let modelCalls = 0;
    let mockNoCandidates = false;
    const queuedReasoning: string[] = [];
    try {
      globalThis.setInterval = ((callback, delay, ...args) => {
        const id = originalSetInterval(callback, delay, ...args);
        intervals.add(id);
        return id;
      }) as typeof setInterval;
      globalThis.fetch = async (input, init) => {
        const request = input instanceof Request
          ? input
          : new Request(input, init);
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.toString()}`);

        if (url.origin === "https://fixture.supabase.invalid") {
          if (
            url.pathname === "/rest/v1/chat_request_logs" &&
            request.method === "POST"
          ) return json({ id: "offline-ttu-log" }, 201);
          if (
            url.pathname === "/rest/v1/chat_request_logs" &&
            request.method === "PATCH"
          ) {
            const body = await request.json() as {
              steps?: Array<{ step?: string; meta?: unknown }>;
              response_events?: Array<Record<string, unknown>>;
            };
            steps.push(...(body.steps ?? []));
            if (Array.isArray(body.response_events)) {
              persistedEvents = body.response_events;
            }
            return new Response(null, { status: 204 });
          }
          if (url.pathname === "/rest/v1/app_settings") {
            return json({
              openrouter_api_key: "offline-openrouter",
              volt220_api_token: "offline-catalog",
              classifier_model: "offline-model",
              v3_anchor_filter_enabled: true,
              v3_relaxation_hints_enabled: true,
              v3_jargon_category_context_enabled: true,
              v3_jargon_axial_modifiers_enabled: true,
              v3_criteria_gate_enabled: true,
            });
          }
          if (
            request.method === "GET" && url.pathname.startsWith("/rest/v1/")
          ) {
            return json([]);
          }
        }

        if (url.origin === "https://fixture.catalog.invalid") {
          if (url.pathname === "/api/categories") {
            return json({
              data: {
                results: [{ id: 1, pagetitle: catalogLeaf, children: [] }],
                pagination: { page: 1, per_page: 200, pages: 1, total: 1 },
              },
            });
          }
          if (url.pathname === "/api/categories/options") {
            return json({
              data: {
                category: { id: 1, pagetitle: catalogLeaf, total_products: 4 },
                options: [
                  {
                    key: "diameter_before",
                    caption_ru: before,
                    type: "number",
                    unit: "мм",
                    values: ["10 мм", "12 мм", "14 мм", "16 мм"].map((
                      value_ru,
                    ) => ({ value_ru, products_count: 1 })),
                  },
                  {
                    key: "diameter_after",
                    caption_ru: after,
                    type: "number",
                    unit: "мм",
                    values: ["5 мм", "6 мм", "7 мм", "8 мм"].map((
                      value_ru,
                    ) => ({ value_ru, products_count: 1 })),
                  },
                ],
              },
            });
          }
          if (url.pathname === "/api/products") {
            return json({
              data: {
                results: mockNoCandidates ? [] : products,
                pagination: { total: mockNoCandidates ? 0 : products.length },
              },
            });
          }
        }

        if (
          url.toString() === "https://openrouter.ai/api/v1/chat/completions"
        ) {
          modelCalls++;
          const body = await request.json() as {
            tool_choice?: { function?: { name?: string } };
            tools?: Array<{ function?: { name?: string } }>;
            messages?: Array<{ content?: string }>;
          };
          const forced = body.tool_choice?.function?.name;
          if (forced === "declare_selection_reasoning") {
            return json({
              choices: [{
                finish_reason: "tool_calls",
                message: {
                  content: null,
                  tool_calls: [{
                    id: "offline-ttu-reasoning",
                    type: "function",
                    function: {
                      name: forced,
                      arguments: JSON.stringify({
                        reasoning: queuedReasoning.shift() ?? pairedReasoning,
                        measurement_scope: "per_product",
                        compatible_classifications: [],
                        excluded_classifications: [],
                        required_facet_values: [],
                        explicit_customer_classifications: [],
                      }),
                    },
                  }],
                },
              }],
            });
          }
          if (
            !body.tools?.length &&
            body.messages?.some(({ content }) =>
              content?.includes("CATEGORY MATCHER")
            )
          ) {
            return json({
              choices: [{
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    candidates: [{ pagetitle: catalogLeaf, confidence: 0.99 }],
                  }),
                },
              }],
            });
          }
          const toolNames = body.tools?.map((tool) => tool.function?.name) ??
            [];
          if (toolNames.includes("search_catalog")) {
            return json({
              choices: [{
                finish_reason: "tool_calls",
                message: {
                  content: null,
                  tool_calls: [{
                    id: "offline-ttu-search",
                    type: "function",
                    function: {
                      name: "search_catalog",
                      arguments: JSON.stringify({
                        mode: "by_filter",
                        category: catalogLeaf,
                        per_page: 50,
                      }),
                    },
                  }],
                },
              }],
            });
          }
          // Deliberately leave terminal rendering to the production handler's
          // server-owned recovery; no model-authored card ID is trusted here.
          return json({
            choices: [{
              finish_reason: "stop",
              message: { content: "", tool_calls: [] },
            }],
          });
        }

        throw new Error(
          `Unexpected outbound request: ${request.method} ${url}`,
        );
      };

      const response = await offlineHandler()(
        new Request(
          "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: "подбери трубку ТТУ на кабель диаметром 10 мм",
              messageId: crypto.randomUUID(),
              sessionId: crypto.randomUUID(),
              history: [],
            }),
          },
        ),
      );
      assertEquals(response.status, 200);
      const events = eventsFromSse(await response.text());
      const publicDeltas = events.flatMap((event) =>
        (event.choices as Array<{ delta?: { content?: string } }> | undefined)
          ?.map((choice) => choice.delta?.content ?? "") ?? []
      ).filter(Boolean).join("\n");
      assert(publicDeltas.length > 0, JSON.stringify(events));
      assert(!publicDeltas.includes(pairedReasoning), publicDeltas);
      assert(!/Клиент запросил|сначала проверю фасеты/iu.test(publicDeltas));
      assert(/Внутренний диаметр до усадки, мм\s*≥\s*1,2\s*×\s*10\s*мм/iu.test(publicDeltas), publicDeltas);
      assert(/Внутренний диаметр после усадки, мм\s*<\s*10\s*мм/iu.test(publicDeltas), publicDeltas);
      assert(!/diameter_(?:before|after)/iu.test(publicDeltas), publicDeltas);
      const persistedDeltas = persistedEvents.filter((event) =>
        event.type === "delta"
      ).map((event) => String(event.content ?? "")).join("\n");
      assertEquals(persistedDeltas, publicDeltas);
      assert(!JSON.stringify(persistedEvents).includes(pairedReasoning));
      assert(steps.some((entry) => entry.step === "v3_assistant_text" &&
        Number((entry.meta as { reasoning_chars?: unknown } | undefined)
          ?.reasoning_chars ?? 0) > 0), JSON.stringify(steps));
      const blocks = events.map((event) =>
        event.v3_event as {
          type?: string;
          count?: number;
          markdown?: string;
          selection_contract?: {
            mandatory_criteria?: Array<{
              key: string;
              op: string;
              value: unknown;
              unit?: string;
              exclusive?: boolean;
            }>;
          };
        }
      ).filter((event) => event?.type === "products_block");
      assertEquals(
        blocks.length,
        1,
        JSON.stringify({ steps, modelCalls, requests, events }),
      );
      const block = blocks[0];
      assert((block.count ?? 0) >= 2);
      assert(block.markdown?.includes("ТТУ 12/6"));
      assert(!block.markdown?.includes("ТТУ 10/5"));
      const criteria = block.selection_contract?.mandatory_criteria ?? [];
      assert(
        criteria.some((criterion) =>
          criterion.key === "diameter_before" && criterion.op === "min" &&
          criterion.value === 10 && criterion.unit === "мм" &&
          criterion.exclusive === true
        ),
        JSON.stringify(criteria),
      );
      assert(
        criteria.some((criterion) =>
          criterion.key === "diameter_after" && criterion.op === "max" &&
          criterion.value === 10 && criterion.unit === "мм" &&
          criterion.exclusive === true
        ),
        JSON.stringify(criteria),
      );
      assert(
        !criteria.some((criterion) =>
          criterion.value === 4000 || /(?:светов|люмен)/iu.test(criterion.key)
        ),
      );
      // The same live flow must not merely describe the new clearance while
      // still rendering a 14/7 card for a 12 mm cable (16.7% clearance).
      steps.length = 0;
      persistedEvents = [];
      queuedReasoning.push(
        "Для кабеля диаметром 12 мм внутренний диаметр трубки до усадки должен быть не менее 14,4 мм, а внутренний диаметр после усадки должен быть строго меньше 12 мм.",
      );
      const strictResponse = await offlineHandler()(
        new Request(
          "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: "подбери термоусадочную трубку для кабеля диаметром 12 мм",
              messageId: crypto.randomUUID(),
              sessionId: crypto.randomUUID(),
              history: [],
            }),
          },
        ),
      );
      assertEquals(strictResponse.status, 200);
      const strictEvents = eventsFromSse(await strictResponse.text());
      const strictMarkdown = strictEvents.filter((event) =>
        (event.v3_event as { type?: string } | undefined)?.type === "products_block"
      ).map((event) => String((event.v3_event as { markdown?: string }).markdown ?? "")).join("\n");
      assert(strictMarkdown.includes("ТТУ 16/8"), JSON.stringify({ strictEvents, steps }));
      assert(!strictMarkdown.includes("ТТУ 14/7"), strictMarkdown);
      mockNoCandidates = true;
      steps.length = 0;
      persistedEvents = [];
      const secondResponse = await offlineHandler()(
        new Request(
          "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: "подбери трубку ТТУ на кабель диаметром 10 мм",
              messageId: crypto.randomUUID(),
              sessionId: crypto.randomUUID(),
              history: [],
            }),
          },
        ),
      );
      assertEquals(secondResponse.status, 200);
      const secondEvents = eventsFromSse(await secondResponse.text());
      const emptyDeltas = secondEvents.flatMap((event) =>
        (event.choices as Array<{ delta?: { content?: string } }> | undefined)
          ?.map((choice) => choice.delta?.content ?? "") ?? []
      ).filter(Boolean).join("\n");
      assert(/Внутренний диаметр до усадки, мм\s*≥\s*1,2\s*×\s*10\s*мм/iu.test(emptyDeltas));
      assert(/Внутренний диаметр после усадки, мм\s*<\s*10\s*мм/iu.test(emptyDeltas));
      assert(emptyDeltas.includes("Не нашёл подходящие товары"));
      assert(!emptyDeltas.includes(pairedReasoning));
      assertEquals(secondEvents.some((event) =>
        (event.v3_event as { type?: string } | undefined)?.type ===
          "products_block"
      ), false);
      assertEquals(
        persistedEvents.filter((event) => event.type === "delta")
          .map((event) => String(event.content ?? "")).join("\n"),
        emptyDeltas,
      );

      // A model may use mathematical operators. The resolver escapes them
      // for safe prose, but that must not erase either strict fit direction.
      mockNoCandidates = false;
      steps.length = 0;
      persistedEvents = [];
      queuedReasoning.push(
        "Для кабеля диаметром 10 мм внутренний диаметр трубки до усадки ≥ 12 мм. Внутренний диаметр после усадки < 10 мм.",
      );
      const symbolicResponse = await offlineHandler()(
        new Request(
          "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: "подбери трубку ТТУ на кабель диаметром 10 мм",
              messageId: crypto.randomUUID(),
              sessionId: crypto.randomUUID(),
              history: [],
            }),
          },
        ),
      );
      assertEquals(symbolicResponse.status, 200);
      const symbolicEvents = eventsFromSse(await symbolicResponse.text());
      assert(symbolicEvents.some((event) =>
        (event.v3_event as { type?: string; count?: number } | undefined)
          ?.type === "products_block" &&
        ((event.v3_event as { count?: number }).count ?? 0) >= 2
      ));
      assertEquals(steps.some((entry) =>
        entry.step === "v3_derived_selection_measurement_retry"
      ), false);

      // The raw declaration appears to prove both sides, but its extra
      // product-size assertion invalidates the resolved evidence. A single
      // bounded correction must happen before search; the raw tool argument
      // must not authorize the public fit claim or bypass the final gate.
      mockNoCandidates = false;
      steps.length = 0;
      persistedEvents = [];
      queuedReasoning.push(
        "Для кабеля диаметром 10 мм внутренний диаметр трубки до усадки должен быть строго больше 10 мм, а после усадки строго меньше 10 мм, поэтому нужен типоразмер 16 мм.",
        pairedReasoning,
      );
      const correctedResponse = await offlineHandler()(
        new Request(
          "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: "подбери трубку ТТУ на кабель диаметром 10 мм",
              messageId: crypto.randomUUID(),
              sessionId: crypto.randomUUID(),
              history: [],
            }),
          },
        ),
      );
      assertEquals(correctedResponse.status, 200);
      const correctedEvents = eventsFromSse(await correctedResponse.text());
      const correctionStep = steps.find((entry) =>
        entry.step === "v3_derived_selection_measurement_retry"
      );
      assertEquals(
        (correctionStep?.meta as { recovered?: boolean } | undefined)
          ?.recovered,
        true,
        JSON.stringify(steps),
      );
      assert(correctedEvents.some((event) =>
        (event.v3_event as { type?: string; count?: number } | undefined)
          ?.type === "products_block" &&
        ((event.v3_event as { count?: number }).count ?? 0) >= 2
      ));

      // A measured object can still leave a live before/after graph without
      // a uniquely selected property. One corrective attempt is warranted,
      // but even a fluent model paragraph cannot manufacture that missing
      // customer-side proof. The public caption must not claim the pair.
      steps.length = 0;
      persistedEvents = [];
      queuedReasoning.push(pairedReasoning, pairedReasoning);
      const ambiguousResponse = await offlineHandler()(
        new Request(
          "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: "подбери трубку ТТУ на кабель 10 мм",
              messageId: crypto.randomUUID(),
              sessionId: crypto.randomUUID(),
              history: [],
            }),
          },
        ),
      );
      assertEquals(ambiguousResponse.status, 200);
      const ambiguousEvents = eventsFromSse(await ambiguousResponse.text());
      const ambiguousDeltas = ambiguousEvents.flatMap((event) =>
        (event.choices as Array<{ delta?: { content?: string } }> | undefined)
          ?.map((choice) => choice.delta?.content ?? "") ?? []
      ).filter(Boolean).join("\n");
      assert(
        steps.some((entry) =>
          entry.step === "v3_derived_selection_measurement_retry"
        ),
        JSON.stringify(steps),
      );
      assertEquals(ambiguousEvents.some((event) =>
        (event.v3_event as { type?: string } | undefined)?.type ===
          "products_block"
      ), false);
      assert(ambiguousDeltas.includes("Уточните, какой именно параметр объекта"));
      assert(!ambiguousDeltas.includes("ошибка соединения"));
      assert(!/Внутренний диаметр до усадки, мм\s*≥\s*1,2\s*×\s*10\s*мм/iu.test(ambiguousDeltas));
      assert(!/Внутренний диаметр после усадки, мм\s*<\s*10\s*мм/iu.test(ambiguousDeltas));
    } finally {
      for (const id of intervals) clearInterval(id);
      globalThis.setInterval = originalSetInterval;
      globalThis.fetch = originalFetch;
      restoreOfflineModuleSetup();
    }
  },
});
