// The real HTTP/SSE handler must keep Pro scoped to product-measurement
// correction, with one bounded legacy-model fallback on a transient Pro
// failure. All outbound traffic uses fixture responses; no paid request is made.
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
type Variant =
  | "http_502"
  | "unusable_http_200"
  | "valid_correction"
  | "fallback_success"
  | "malformed_tool_200_fallback_success";
type CorrectionRequest = { model?: string; models?: string[] };
const productionHandler = offlineHandler();
const offlineEnvGet = Deno.env.get;

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
  handler: (request: Request) => Promise<Response> = productionHandler,
  previewSecret?: string,
): Promise<{
  steps: Step[];
  events: Array<Record<string, unknown>>;
  correctionRequests: number;
  correctionBodies: CorrectionRequest[];
  modelBodies: CorrectionRequest[];
  catalogProductRequests: number;
}> {
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  let steps: Step[] = [];
  let correctionRequests = 0;
  const correctionBodies: CorrectionRequest[] = [];
  const modelBodies: CorrectionRequest[] = [];
  let declarationRequests = 0;
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
          if (
            variant === "valid_correction" || variant === "fallback_success" ||
            variant === "malformed_tool_200_fallback_success"
          ) {
            return json({
              data: { results: [], pagination: { total: 0 } },
            });
          }
          throw new Error(
            "Correction failure must stop before catalog product search",
          );
        }
      }
      if (url.toString() === "https://openrouter.ai/api/v1/chat/completions") {
        const body = await request.json() as {
          model?: string;
          models?: string[];
          tool_choice?: { function?: { name?: string } };
          tools?: Array<{ function?: { name?: string } }>;
          messages?: Array<{ content?: string }>;
        };
        modelBodies.push(body);
        if (
          body.tool_choice?.function?.name === "declare_selection_reasoning"
        ) {
          declarationRequests++;
          const correction = body.messages?.some(({ content }) =>
            content?.includes("<correction>")
          ) ?? false;
          if (correction) {
            correctionRequests++;
            correctionBodies.push(body);
            if (
              variant === "valid_correction" ||
              ((variant === "fallback_success" ||
                variant === "malformed_tool_200_fallback_success") &&
                body.model === "google/gemini-2.5-flash")
            ) {
              return json({
                choices: [{
                  finish_reason: "tool_calls",
                  message: {
                    content: null,
                    tool_calls: [{
                      id: "offline-pro-corrected-declaration",
                      type: "function",
                      function: {
                        name: "declare_selection_reasoning",
                        arguments: JSON.stringify({
                          reasoning:
                            "Для оборудования мощностью 250 Вт проверяю общую мощность системы ИБП с запасом и наличие каждого товара по каталогу.",
                          measurement_scope: "system_total",
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
            if (variant === "malformed_tool_200_fallback_success") {
              // A nominally successful completion with a choice and text is
              // still unusable for this forced structured declaration.
              return json({
                choices: [{
                  finish_reason: "stop",
                  message: {
                    content: "I would choose a 500 VA UPS.",
                    tool_calls: [],
                  },
                }],
              });
            }
            return variant === "http_502" || variant === "fallback_success"
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
        if (
          variant === "valid_correction" || variant === "fallback_success" ||
          variant === "malformed_tool_200_fallback_success"
        ) {
          return json({
            choices: [{
              finish_reason: "stop",
              message: {
                content: "В каталоге нет подтверждённых вариантов.",
                tool_calls: [],
              },
            }],
          });
        }
        throw new Error("Unexpected model phase before measurement correction");
      }
      throw new Error(`Unexpected outbound request: ${request.method} ${url}`);
    };

    const response = await handler(
      new Request(
        "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(previewSecret
              ? { "x-volt-preview-secret": previewSecret }
              : {}),
          },
          body: JSON.stringify({
            message,
            messageId: crypto.randomUUID(),
            sessionId: crypto.randomUUID(),
            history: [],
          }),
        },
      ),
    );
    assertEquals(response.status, 200);
    const events = sseEvents(await response.text());
    assertEquals(
      declarationRequests,
      1 + correctionRequests,
      JSON.stringify(steps),
    );
    return {
      steps,
      events,
      correctionRequests,
      correctionBodies,
      modelBodies,
      catalogProductRequests,
    };
  } finally {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
  }
}

Deno.test({
  name:
    "production handler tries Pro only for measurement correction, then one legacy fallback on retryable failure",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      for (const variant of ["http_502", "unusable_http_200"] as const) {
        const result = await runFailure(variant);
        const route = result.steps.find(({ step }) =>
          step === "v3_product_measurement_pro_correction_route"
        );
        assertEquals(
          route?.meta?.requested_model,
          "deepseek/deepseek-v4-pro-0813",
        );
        assertEquals(route?.meta?.requested_provider_route, "openrouter_only");
        const fallback = result.steps.find(({ step }) =>
          step === "v3_product_measurement_pro_correction_fallback"
        );
        assert(fallback, JSON.stringify(result.steps));
        assertEquals(
          fallback.meta?.initial_requested_model,
          "deepseek/deepseek-v4-pro-0813",
        );
        assertEquals(
          fallback.meta?.fallback_requested_model,
          "google/gemini-2.5-flash",
        );
        assertEquals(fallback.meta?.upstream_status, 502);
        assertEquals(
          fallback.meta?.upstream_origin,
          variant === "http_502" ? "http_response" : "completion_envelope",
        );
        assertEquals(
          fallback.meta?.observed_http_status,
          variant === "http_502" ? 502 : 200,
        );
        assertEquals(result.correctionRequests, 2);
        assertEquals(
          result.correctionBodies.map(({ model }) => model),
          ["deepseek/deepseek-v4-pro-0813", "google/gemini-2.5-flash"],
        );
        assert(
          result.modelBodies.filter((body) =>
            !result.correctionBodies.includes(body)
          ).every((body) =>
            body.model !== "deepseek/deepseek-v4-pro-0813" &&
            !body.models?.includes("deepseek/deepseek-v4-pro-0813")
          ),
          "Classification and primary reasoning must not switch to Pro",
        );
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
        assertEquals(failure.meta?.requested_model, "google/gemini-2.5-flash");
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

      for (
        const variant of [
          "fallback_success",
          "malformed_tool_200_fallback_success",
        ] as const
      ) {
        const recovered = await runFailure(variant);
        assertEquals(
          recovered.correctionBodies.map(({ model }) => model),
          ["deepseek/deepseek-v4-pro-0813", "google/gemini-2.5-flash"],
        );
        const fallback = recovered.steps.find(({ step }) =>
          step === "v3_product_measurement_pro_correction_fallback"
        );
        assert(fallback, JSON.stringify(recovered.steps));
        assertEquals(fallback.meta?.upstream_status, 502);
        assertEquals(
          fallback.meta?.upstream_origin,
          variant === "fallback_success"
            ? "http_response"
            : "completion_envelope",
        );
        assertEquals(
          fallback.meta?.observed_http_status,
          variant === "fallback_success" ? 502 : 200,
        );
        const corrected = recovered.steps.find(({ step, meta }) =>
          step === "v3_derived_selection_measurement_retry" &&
          meta?.repair_reason === "product_measurement"
        );
        assert(corrected, JSON.stringify(recovered.steps));
        assertEquals(
          corrected.meta?.requested_model,
          "google/gemini-2.5-flash",
        );
        assertEquals(corrected.meta?.recovered, true);
        assert(recovered.catalogProductRequests > 0);
        assertEquals(
          recovered.steps.some(({ step }) =>
            step === "v3_product_measurement_correction_failed" ||
            step === "v3_product_measurement_unverified"
          ),
          false,
        );
      }

      const firstTry = await runFailure("valid_correction");
      assertEquals(firstTry.correctionRequests, 1);
      assertEquals(
        firstTry.correctionBodies[0].model,
        "deepseek/deepseek-v4-pro-0813",
      );
      assertEquals(
        firstTry.steps.some(({ step }) =>
          step === "v3_product_measurement_pro_correction_fallback"
        ),
        false,
      );
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});

Deno.test({
  name:
    "closed preview pins only measurement correction to DeepSeek Pro and continues after a valid forced tool call",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const marker = globalThis as typeof globalThis & {
      __VOLT220_ADMISSION_SCOPE__?: "preview";
      __VOLT220_CLOSURE_TEST_SCOPE__?: "closure_preview";
    };
    const originalEnvGet = Deno.env.get;
    const originalServe = Deno.serve;
    const previewSecret = "offline-preview-secret-000000000000000001";
    let previewHandler: ((request: Request) => Promise<Response>) | null = null;
    try {
      marker.__VOLT220_ADMISSION_SCOPE__ = "preview";
      marker.__VOLT220_CLOSURE_TEST_SCOPE__ = "closure_preview";
      Deno.env.get = (name: string) =>
        name === "VOLT220_PRODUCT_MEASUREMENT_PRO_CLOSURE_PREVIEW_ENABLED"
          ? "true"
          : name === "VOLT220_PRODUCT_MEASUREMENT_HTTP_RETRY_PREVIEW_ENABLED"
          ? "true"
          : name === "VOLT220_V3_PREVIEW_SECRET"
          ? previewSecret
          : offlineEnvGet(name);
      (Deno as unknown as { serve: typeof Deno.serve }).serve = ((
        callback: (request: Request) => Promise<Response>,
      ) => {
        previewHandler = callback;
        return { shutdown() {}, finished: Promise.resolve() };
      }) as unknown as typeof Deno.serve;
      await import("./index.ts?product-measurement-pro-closure-preview");
      assert(previewHandler, "closed preview handler did not register");

      for (const variant of ["http_502", "unusable_http_200"] as const) {
        const result = await runFailure(variant, previewHandler, previewSecret);
        assertEquals(result.correctionRequests, 1);
        assertEquals(
          result.steps.some(({ step }) =>
            step === "v3_product_measurement_correction_http_retry"
          ),
          false,
        );
        assertEquals(
          result.correctionBodies[0].model,
          "deepseek/deepseek-v4-pro-0813",
        );
        assertEquals(result.correctionBodies[0].models, undefined);
        const route = result.steps.find(({ step }) =>
          step === "v3_product_measurement_pro_correction_route"
        );
        assertEquals(
          route?.meta?.requested_model,
          "deepseek/deepseek-v4-pro-0813",
        );
        assertEquals(route?.meta?.requested_provider_route, "openrouter_only");
        const failure = result.steps.find(({ step }) =>
          step === "v3_product_measurement_correction_failed"
        );
        assertEquals(
          failure?.meta?.requested_model,
          "deepseek/deepseek-v4-pro-0813",
        );
        assertEquals(failure?.meta?.upstream_provider, "openrouter");
        assertEquals(
          failure?.meta?.observed_http_status,
          variant === "http_502" ? 502 : 200,
        );
        assertEquals(result.catalogProductRequests, 0);
      }

      const recovered = await runFailure(
        "valid_correction",
        previewHandler,
        previewSecret,
      );
      assertEquals(recovered.correctionRequests, 1);
      assertEquals(
        recovered.correctionBodies[0].model,
        "deepseek/deepseek-v4-pro-0813",
      );
      assertEquals(recovered.correctionBodies[0].models, undefined);
      assert(
        recovered.modelBodies.filter((body) =>
          body !== recovered.correctionBodies[0]
        ).every((body) =>
          body.model !== "deepseek/deepseek-v4-pro-0813" &&
          !body.models?.includes("deepseek/deepseek-v4-pro-0813")
        ),
        "The Pro model must not be requested by classification, primary reasoning, or finalization",
      );
      const correction = recovered.steps.find(({ step, meta }) =>
        step === "v3_derived_selection_measurement_retry" &&
        meta?.repair_reason === "product_measurement"
      );
      assert(correction, JSON.stringify(recovered.steps));
      assertEquals(
        correction.meta?.requested_model,
        "deepseek/deepseek-v4-pro-0813",
      );
      assertEquals(correction.meta?.response_provider, "openrouter");
      assertEquals(correction.meta?.observed_http_status, 200);
      assertEquals(correction.meta?.recovered, true);
      assert(recovered.catalogProductRequests > 0);
      assertEquals(
        recovered.events.some((event) =>
          (event.v3_event as { type?: string } | undefined)?.type ===
            "products_block"
        ),
        false,
      );
      assertEquals(
        recovered.steps.some(({ step }) =>
          step === "v3_product_measurement_correction_failed" ||
          step === "v3_product_measurement_unverified"
        ),
        false,
      );
      assert(
        recovered.events.some((event) => {
          const diagnostic = event.v3_event as {
            type?: string;
            phase?: string;
            error?: string | null;
          } | undefined;
          return diagnostic?.type === "diagnostic" &&
            diagnostic.phase === "complete" && diagnostic.error === null;
        }),
        JSON.stringify(recovered.events),
      );
    } finally {
      Deno.env.get = originalEnvGet;
      (Deno as unknown as { serve: typeof Deno.serve }).serve = originalServe;
      delete marker.__VOLT220_ADMISSION_SCOPE__;
      delete marker.__VOLT220_CLOSURE_TEST_SCOPE__;
      restoreOfflineModuleSetup();
    }
  },
});
