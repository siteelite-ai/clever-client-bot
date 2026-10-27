// The real HTTP/SSE handler must persist the provenance of two different
// provider failures during a product-measurement correction. All outbound
// traffic is replaced with fixture responses; no paid request is made.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  offlineHandler,
  restoreOfflineModuleSetup,
} from "./model-no-search-integration-fixture.ts";
import "./index.ts";
const offlineEnvGet = Deno.env.get;

type Step = { step?: string; meta?: Record<string, unknown> };
type Variant = "http_502" | "unusable_http_200" | "first_http_200_error";

const category = "ИБП";
const message = "Нужен ИБП для оборудования мощностью 250 Вт";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseEvents(text: string): Array<Record<string, unknown>> {
  return text.split("\n\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

async function runFailure(
  variant: Variant,
  sessionId = crypto.randomUUID(),
): Promise<{
  steps: Step[];
  events: Array<Record<string, unknown>>;
  correctionRequests: number;
  catalogProductRequests: number;
  declarationRequests: Array<{
    body: Record<string, unknown>;
    metadataHeader: string | null;
  }>;
}> {
  Deno.env.get = offlineEnvGet;
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  let steps: Step[] = [];
  let correctionRequests = 0;
  let declarationRequests = 0;
  const declarationRequestDetails: Array<{
    body: Record<string, unknown>;
    metadataHeader: string | null;
  }> = [];
  let catalogProductRequests = 0;
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
            return json({ id: `offline-origin-${variant}` }, 201);
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
              results: [{ id: 1, pagetitle: category, children: [] }],
              pagination: { page: 1, per_page: 200, pages: 1, total: 1 },
            },
          });
        }
        if (url.pathname === "/api/categories/options") {
          return json({
            data: {
              category: { id: 1, pagetitle: category, total_products: 2 },
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
          catalogProductRequests++;
          throw new Error(
            "Correction failure must stop before catalog product search",
          );
        }
      }
      if (url.toString() === "https://openrouter.ai/api/v1/chat/completions") {
        const body = await request.json() as {
          tool_choice?: { function?: { name?: string } };
          tools?: Array<{ function?: { name?: string } }>;
          messages?: Array<{ content?: string }>;
        } & Record<string, unknown>;
        if (
          body.tool_choice?.function?.name === "declare_selection_reasoning"
        ) {
          declarationRequests++;
          declarationRequestDetails.push({
            body,
            metadataHeader: request.headers.get("X-OpenRouter-Metadata"),
          });
          const correction = body.messages?.some(({ content }) =>
            content?.includes("<correction>")
          ) ?? false;
          if (!correction && variant === "first_http_200_error") {
            return json({
              id: "gen-abcdef1234567890",
              choices: [{
                finish_reason: "error",
                error: {
                  message: "PRIVATE_CUSTOMER_PROMPT_DO_NOT_LOG",
                  metadata: { error_type: "provider_unavailable" },
                },
                message: { content: null },
              }],
            });
          }
          if (correction) {
            correctionRequests++;
            return variant === "http_502"
              ? json({ error: "fixture provider failure" }, 502)
              : json({ choices: [] }, 200);
          }
          return json({
            choices: [{
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [{
                  id: "offline-first-declaration",
                  type: "function",
                  function: {
                    name: "declare_selection_reasoning",
                    arguments: JSON.stringify({
                      reasoning:
                        "Для применения проверяю подходящее значение характеристики каждого товара по живому каталогу.",
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
                  candidates: [{ pagetitle: category, confidence: 0.99 }],
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
                    arguments: JSON.stringify({ noun: category }),
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
            message,
            messageId: crypto.randomUUID(),
            sessionId,
            history: [],
          }),
        },
      ),
    );
    assertEquals(response.status, 200);
    const events = sseEvents(await response.text());
    assertEquals(
      declarationRequests,
      variant === "first_http_200_error" ? 1 : 2,
      JSON.stringify(steps),
    );
    return {
      steps,
      events,
      correctionRequests,
      catalogProductRequests,
      declarationRequests: declarationRequestDetails,
    };
  } finally {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
  }
}

Deno.test({
  name:
    "real handler records HTTP 502 versus unusable HTTP 200 correction origin without an OFF retry",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      for (const variant of ["http_502", "unusable_http_200"] as const) {
        const result = await runFailure(variant);
        const failure = result.steps.find(({ step }) =>
          step === "v3_product_measurement_correction_failed"
        );
        assert(failure, JSON.stringify(result.steps));
        assertEquals(failure.meta?.upstream_status, 502);
        assertEquals(
          failure.meta?.upstream_origin,
          variant === "http_502" ? "http_response" : "completion_envelope",
        );
        assertEquals(
          failure.meta?.observed_http_status,
          variant === "http_502" ? 502 : 200,
        );
        assertEquals(failure.meta?.upstream_provider, "openrouter");
        assertEquals(failure.meta?.provider_failed_over, false);
        assertEquals(result.correctionRequests, 1);
        assertEquals(result.catalogProductRequests, 0);
        assertEquals(
          result.steps.some(({ step }) =>
            step === "v3_product_measurement_correction_http_retry"
          ),
          false,
        );
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
        assert(
          !JSON.stringify(result.events).includes("fixture provider failure"),
        );
      }
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});
Deno.test({
  name: "first unresolved measurement declaration uses Gemini 3.8 only inside deterministic canary and fails closed on provider HTTP 200 error",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const canary = await runFailure(
        "first_http_200_error",
        "5ef79fc0-4c52-48b7-b278-5fa2241039f3",
      );
      const route = canary.steps.find(({ step }) =>
        step === "v3_primary_measurement_gemini38_canary_route"
      );
      assert(route, JSON.stringify(canary.steps));
      const primary = canary.declarationRequests[0];
      assertEquals(primary.body.model, "google/gemini-3.8-flash");
      assertEquals(primary.body.models, undefined);
      assertEquals(primary.body.reasoning_effort, "low");
      assertEquals(primary.body.temperature, undefined);
      assertEquals(primary.body.provider, {
        require_parameters: true,
        order: ["google-ai-studio", "google-vertex/global"],
        only: ["google-ai-studio", "google-vertex/global"],
      });
      assertEquals(primary.metadataHeader, "enabled");
      const upstream = canary.steps.find(({ step }) =>
        step === "v3_primary_measurement_gemini38_upstream"
      );
      assertEquals(upstream?.meta?.http_status, 200);
      assertEquals(upstream?.meta?.envelope_status, "provider_error");
      assertEquals(upstream?.meta?.choice_error_type, "provider_unavailable");
      assertEquals(canary.correctionRequests, 0);
      assertEquals(canary.catalogProductRequests, 0);
      assertEquals(canary.events.some((event) =>
        (event.v3_event as { type?: string } | undefined)?.type ===
          "products_block"
      ), false);
      assert(!JSON.stringify(canary.steps).includes("PRIVATE_CUSTOMER_PROMPT_DO_NOT_LOG"));
      assert(!JSON.stringify(canary.events).includes("PRIVATE_CUSTOMER_PROMPT_DO_NOT_LOG"));

      const offCohort = await runFailure(
        "http_502",
        "11111111-1111-4111-8111-111111111111",
      );
      assertEquals(offCohort.steps.some(({ step }) =>
        step === "v3_primary_measurement_gemini38_canary_route"
      ), false);
      const unchanged = offCohort.declarationRequests[0];
      assertEquals(unchanged.body.models, [
        "offline-model",
        "deepseek/deepseek-v4-flash",
      ]);
      assertEquals(unchanged.body.temperature, 0);
      assertEquals(unchanged.body.reasoning_effort, undefined);
      assertEquals(unchanged.body.provider, undefined);
      assertEquals(unchanged.metadataHeader, null);
      assertEquals(offCohort.correctionRequests, 1);
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});
