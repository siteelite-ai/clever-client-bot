// Real handler, synthetic transport: no OpenRouter or catalog request is paid.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  offlineHandler,
  restoreOfflineModuleSetup,
} from "./model-no-search-integration-fixture.ts";
import "./index.ts";

type Step = { step?: string; meta?: Record<string, unknown> };
type Scenario = "recovers" | "stays_malformed";
const canarySession = "0439c735-1e87-4a32-8a6f-4f2a71986292";
const message = "Нужен ИБП для оборудования мощностью 250 Вт";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function events(text: string): Array<Record<string, unknown>> {
  return text.split("\n\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

function declaration(reasoning: string): Response {
  return json({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: null,
        tool_calls: [{
          id: "fixture-declaration",
          type: "function",
          function: {
            name: "declare_selection_reasoning",
            arguments: JSON.stringify({
              reasoning,
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

async function run(scenario: Scenario): Promise<{
  steps: Step[];
  events: Array<Record<string, unknown>>;
  correctionModels: string[];
  productSearches: number;
}> {
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  let steps: Step[] = [];
  let correctionCalls = 0;
  let productSearches = 0;
  const correctionModels: string[] = [];
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
      if (url.origin === "https://fixture.supabase.invalid") {
        if (url.pathname === "/rest/v1/chat_request_logs") {
          if (request.method === "POST") {
            return json({ id: `gemini-${scenario}` }, 201);
          }
          if (request.method === "PATCH") {
            steps = ((await request.json()) as { steps?: Step[] }).steps ?? [];
            return new Response(null, { status: 204 });
          }
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
        if (request.method === "GET" && url.pathname.startsWith("/rest/v1/")) {
          return json([]);
        }
        if (request.method === "POST" && url.pathname.startsWith("/rest/v1/")) {
          return json({}, 201);
        }
      }
      if (url.origin === "https://fixture.catalog.invalid") {
        if (url.pathname === "/api/categories") {
          return json({
            data: {
              results: [{ id: 1, pagetitle: "ИБП", children: [] }],
              pagination: { page: 1, per_page: 200, pages: 1, total: 1 },
            },
          });
        }
        if (url.pathname === "/api/categories/options") {
          return json({
            data: {
              category: { id: 1, pagetitle: "ИБП", total_products: 2 },
              options: [{
                key: "rated_va",
                caption_ru: "Номинальная мощность, ВА",
                type: "number",
                unit: "ВА",
                values: [{ value_ru: "500", products_count: 2 }],
              }],
            },
          });
        }
        if (url.pathname === "/api/products") {
          productSearches++;
          return json({
            data: {
              results: [],
              pagination: { page: 1, per_page: 50, pages: 1, total: 0 },
            },
          });
        }
      }
      if (url.toString() === "https://openrouter.ai/api/v1/chat/completions") {
        const body = await request.json() as {
          model?: string;
          provider?: { require_parameters?: boolean };
          tool_choice?: { function?: { name?: string } };
          tools?: Array<{ function?: { name?: string } }>;
          messages?: Array<{ content?: string }>;
        };
        if (
          body.tool_choice?.function?.name === "declare_selection_reasoning"
        ) {
          const correction = body.messages?.some(({ content }) =>
            content?.includes("<correction>")
          ) ?? false;
          if (correction) {
            correctionCalls++;
            correctionModels.push(String(body.model));
            assertEquals(body.model, "google/gemini-2.5-flash");
            assertEquals(body.provider?.require_parameters, true);
            if (correctionCalls === 1 || scenario === "stays_malformed") {
              return json({ choices: [] });
            }
            return declaration(
              "Для нагрузки 250 Вт выбираю ИБП с номинальной мощностью не менее 500 ВА на каждое устройство.",
            );
          }
          return declaration(
            "Для применения проверяю подходящее значение характеристики каждого товара по живому каталогу.",
          );
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
                  candidates: [{ pagetitle: "ИБП", confidence: 0.99 }],
                }),
              },
            }],
          });
        }
        if (
          body.tools?.some(({ function: schema }) =>
            schema?.name === "discover_category"
          )
        ) {
          return json({
            choices: [{
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [{
                  id: "offline-discovery",
                  type: "function",
                  function: {
                    name: "discover_category",
                    arguments: JSON.stringify({ noun: "ИБП" }),
                  },
                }],
              },
            }],
          });
        }
        throw new Error("Unexpected model phase");
      }
      throw new Error(`Unexpected outbound request: ${request.method} ${url}`);
    };
    const response = await offlineHandler()(
      new Request(
        "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            messageId: crypto.randomUUID(),
            sessionId: canarySession,
            history: [],
          }),
        },
      ),
    );
    assertEquals(response.status, 200);
    const streamed = events(await response.text());
    assertEquals(correctionCalls, 2, JSON.stringify(steps));
    return { steps, events: streamed, correctionModels, productSearches };
  } finally {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
  }
}

Deno.test({
  name:
    "one malformed Gemini envelope is retried on the same model, repeated malformed fails closed",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      for (const scenario of ["recovers", "stays_malformed"] as const) {
        const result = await run(scenario);
        assertEquals(result.correctionModels, [
          "google/gemini-2.5-flash",
          "google/gemini-2.5-flash",
        ]);
        assert(
          result.steps.some(({ step }) =>
            step === "v3_product_measurement_gemini_canary_route"
          ),
        );
        assert(
          result.steps.some(({ step }) =>
            step === "v3_product_measurement_gemini_envelope_retry"
          ),
        );
        if (scenario === "stays_malformed") {
          assertEquals(result.productSearches, 0);
          assert(
            result.steps.some(({ step }) =>
              step === "v3_product_measurement_unverified"
            ),
          );
          assertEquals(
            result.events.some((event) =>
              (event.v3_event as { type?: string } | undefined)?.type ===
                "products_block"
            ),
            false,
          );
        }
      }
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});
