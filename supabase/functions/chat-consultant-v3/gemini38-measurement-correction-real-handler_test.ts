import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  offlineHandler,
  restoreOfflineModuleSetup,
} from "./model-no-search-integration-fixture.ts";
import { gemini38MeasurementCohort } from "../_shared/v3-tools/product-measurement-gemini38-canary.ts";
import "./index.ts";

type Step = { step?: string; meta?: Record<string, unknown> };
type CorrectionCall = {
  model: unknown;
  provider: unknown;
  metadataHeader: string | null;
  hasTemperature: boolean;
  temperature: unknown;
};
const canarySession = "0439c735-1e87-4a32-8a6f-4f2a71986292";

function json(
  value: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function runCase(
  newTopic: boolean,
  originalSessionId = canarySession,
): Promise<{
  steps: Step[];
  correctionCalls: CorrectionCall[];
  productSearches: number;
  stream: string;
}> {
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  const correctionCalls: CorrectionCall[] = [];
  let steps: Step[] = [];
  let productSearches = 0;
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
            return json({ id: "canary-fixture" }, 201);
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
          throw new Error("Unverified canary must stop before product search");
        }
      }
      if (url.toString() === "https://openrouter.ai/api/v1/chat/completions") {
        const body = await request.json() as {
          model?: string;
          provider?: unknown;
          temperature?: number;
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
            correctionCalls.push({
              model: body.model,
              provider: body.provider,
              metadataHeader: request.headers.get("X-OpenRouter-Metadata"),
              hasTemperature: "temperature" in body,
              temperature: body.temperature,
            });
            return json(
              {
                id: "gen-abcdef1234567890",
                choices: [],
                openrouter_metadata: {
                  summary: "PRIVATE_PROVIDER_TEXT",
                  attempts: [{ provider: "Google AI Studio", status: 200 }],
                },
              },
              200,
              { "X-Generation-Id": "gen-abcdef1234567890" },
            );
          }
          return json({
            choices: [{
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [{
                  id: "first-declaration",
                  type: "function",
                  function: {
                    name: "declare_selection_reasoning",
                    arguments: JSON.stringify({
                      reasoning:
                        "Для применения проверяю характеристику каждого товара по живому каталогу.",
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
                  id: "discovery",
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
        throw new Error("Unexpected model phase before measurement correction");
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
            message: newTopic
              ? "Новая тема. Нужен ИБП для оборудования мощностью 250 Вт"
              : "Нужен ИБП для оборудования мощностью 250 Вт",
            messageId: crypto.randomUUID(),
            sessionId: originalSessionId,
            history: [],
          }),
        },
      ),
    );
    assertEquals(response.status, 200);
    const stream = await response.text();
    return {
      steps,
      correctionCalls,
      productSearches,
      stream,
    };
  } finally {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
  }
}

Deno.test({
  name:
    "Gemini 3.8 production canary makes one correction call and fails closed on HTTP 200 missing choices",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      for (const newTopic of [false, true]) {
        const result = await runCase(newTopic);
        assertEquals(
          result.correctionCalls.length,
          1,
          JSON.stringify(result.steps),
        );
        assertEquals(
          result.correctionCalls[0].model,
          "google/gemini-3.8-flash",
        );
        assertEquals(result.correctionCalls[0].metadataHeader, "enabled");
        assertEquals(result.correctionCalls[0].hasTemperature, false);
        assertEquals(result.correctionCalls[0].provider, {
          require_parameters: true,
          order: ["google-ai-studio", "google-vertex/global"],
          only: ["google-ai-studio", "google-vertex/global"],
        });
        assert(
          result.steps.some(({ step }) =>
            step === "v3_product_measurement_gemini38_canary_route"
          ),
        );
        const upstream = result.steps.find(({ step }) =>
          step === "v3_product_measurement_gemini38_upstream"
        );
        assertEquals(upstream?.meta?.envelope_status, "missing_choice");
        assertEquals(upstream?.meta?.generation_id, "gen-abcdef1234567890");
        assertEquals(upstream?.meta?.provider, "google_ai_studio");
        assert(!JSON.stringify(result.steps).includes("PRIVATE_PROVIDER_TEXT"));
        assert(
          result.steps.some(({ step }) =>
            step === "v3_product_measurement_unverified"
          ),
        );
        assertEquals(result.productSearches, 0);
        assert(!result.stream.includes("products_block"));
        assert(
          !result.steps.some(({ step }) =>
            step === "v3_product_measurement_correction_http_retry"
          ),
        );
      }
      const baselineSession = "b7cecb57-97e6-46f1-b86f-0f1dd2bc78fe";
      assertEquals(gemini38MeasurementCohort(baselineSession, 1), false);
      const baseline = await runCase(false, baselineSession);
      assertEquals(baseline.correctionCalls.length, 1);
      assertEquals(
        baseline.correctionCalls[0].model,
        "google/gemini-2.5-flash",
      );
      assertEquals(baseline.correctionCalls[0].metadataHeader, null);
      assertEquals(baseline.correctionCalls[0].provider, undefined);
      assertEquals(baseline.correctionCalls[0].hasTemperature, true);
      assertEquals(baseline.correctionCalls[0].temperature, 0);
      assert(
        !baseline.steps.some(({ step }) =>
          step === "v3_product_measurement_gemini38_canary_route" ||
          step === "v3_product_measurement_gemini38_upstream"
        ),
      );
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});
