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
import "./index.ts";

const catalogLeaf = "Трубки термоусаживаемые";
const before = "Внутренний диаметр до усадки, мм";
const after = "Внутренний диаметр после усадки, мм";
const pairedReasoning =
  "Для кабеля диаметром 10 мм внутренний диаметр трубки до усадки должен быть строго больше 10 мм, а внутренний диаметр после усадки должен быть строго меньше 10 мм.";
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

Deno.test({
  name:
    "TTU fit keeps certified before/after criteria in the emitted selection contract",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const originalFetch = globalThis.fetch;
    const originalSetInterval = globalThis.setInterval;
    const intervals = new Set<number>();
    const requests: string[] = [];
    const steps: Array<{ step?: string; meta?: unknown }> = [];
    let modelCalls = 0;
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
            };
            steps.push(...(body.steps ?? []));
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
                results: products,
                pagination: { total: products.length },
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
                        reasoning: pairedReasoning,
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
    } finally {
      for (const id of intervals) clearInterval(id);
      globalThis.setInterval = originalSetInterval;
      globalThis.fetch = originalFetch;
      restoreOfflineModuleSetup();
    }
  },
});
