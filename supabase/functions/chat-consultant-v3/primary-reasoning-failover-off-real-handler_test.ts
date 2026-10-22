// Exercise the production HTTP/SSE handler, not a duplicate retry predicate.
// All database, catalog, and model traffic stays in the offline fixture.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  configureClosureRetryWithoutMarkerInOfflineFixture,
  offlineHandler,
  restoreOfflineModuleSetup,
} from "./model-no-search-integration-fixture.ts";
configureClosureRetryWithoutMarkerInOfflineFixture();
await import("./index.ts");

type Variant = "unusable_http_200" | "http_502" | "http_429";
type Step = { step?: string; meta?: Record<string, unknown> };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function eventsFromSse(body: string): Array<Record<string, unknown>> {
  return body.split("\n\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

async function runTurn(variant: Variant): Promise<{
  steps: Step[];
  events: Array<Record<string, unknown>>;
  declarationRequests: number;
  correctionRequests: number;
  modelRequests: number;
}> {
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  let steps: Step[] = [];
  let declarationRequests = 0;
  let correctionRequests = 0;
  let modelRequests = 0;
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
            return json({ id: `offline-reasoning-${variant}` }, 201);
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
          return json({
            data: { results: [], pagination: { total: 0 } },
          });
        }
      }
      if (url.toString() === "https://openrouter.ai/api/v1/chat/completions") {
        modelRequests++;
        const body = await request.json() as {
          tool_choice?: { function?: { name?: string } };
          tools?: Array<{ function?: { name?: string } }>;
          messages?: Array<{ content?: string }>;
        };
        if (
          body.tool_choice?.function?.name === "declare_selection_reasoning"
        ) {
          declarationRequests++;
          if (
            body.messages?.some(({ content }) =>
              content?.includes("<correction>")
            )
          ) {
            correctionRequests++;
          }
          if (declarationRequests === 1) {
            if (variant === "unusable_http_200") return json({ choices: [] });
            if (variant === "http_502") {
              return json({ error: "fixture-502" }, 502);
            }
            return json({ error: "fixture-429" }, 429);
          }
          return json({
            choices: [{
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [{
                  id: "offline-recovered-declaration",
                  type: "function",
                  function: {
                    name: "declare_selection_reasoning",
                    arguments: JSON.stringify({
                      reasoning:
                        "Для оборудования мощностью 250 Вт нужна общая мощность системы ИБП с запасом; каждую карточку проверяю по каталогу.",
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
        // A normal no-results turn may ask the general model to finalize.
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
      throw new Error(`Unexpected outbound request: ${request.method} ${url}`);
    };

    const response = await offlineHandler()(
      new Request(
        "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-volt-derived-reasoning-retry-scope": "closure_preview",
          },
          body: JSON.stringify({
            message: "Нужен ИБП для оборудования мощностью 250 Вт",
            messageId: crypto.randomUUID(),
            sessionId: crypto.randomUUID(),
            history: [],
          }),
        },
      ),
    );
    assertEquals(response.status, 200);
    const events = eventsFromSse(await response.text());
    return {
      steps,
      events,
      declarationRequests,
      correctionRequests,
      modelRequests,
    };
  } finally {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
  }
}

Deno.test({
  name:
    "real handler retries only recoverable primary reasoning failure once, not 429 or correction",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const spoofedBody = await offlineHandler()(
        new Request(
          "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: "Нужен ИБП для оборудования мощностью 250 Вт",
              messageId: crypto.randomUUID(),
              sessionId: crypto.randomUUID(),
              history: [],
              __VOLT220_DERIVED_REASONING_RETRY_SCOPE__: "closure_preview",
            }),
          },
        ),
      );
      assertEquals(spoofedBody.status, 400);
      const result = await runTurn("unusable_http_200");
      assertEquals(result.declarationRequests, 2, JSON.stringify(result));
      assertEquals(result.correctionRequests, 0);
      assertEquals(result.modelRequests >= 2, true);
      const retry = result.steps.find(({ step }) =>
        step === "v3_derived_selection_reasoning_retry"
      );
      assert(retry, JSON.stringify(result.steps));
      assertEquals(retry.meta?.upstream_origin, "completion_envelope");
      assertEquals(retry.meta?.observed_http_status, 200);
      assert(
        result.steps.some(({ step }) =>
          step === "v3_derived_selection_reasoning_retry_recovered"
        ),
      );
      assertEquals(
        result.steps.some(({ step }) =>
          step === "v3_product_measurement_correction_http_retry"
        ),
        false,
      );
      assertEquals(
        result.steps.some(({ step, meta }) =>
          step === "v3_turn_end" && meta?.reason === "error"
        ),
        false,
        JSON.stringify(result.steps),
      );
      assert(
        result.events.some((event) => {
          const diagnostic = event.v3_event as {
            type?: string;
            phase?: string;
            error?: string | null;
          } | undefined;
          return diagnostic?.type === "diagnostic" &&
            diagnostic.phase === "complete" && diagnostic.error === null;
        }),
        JSON.stringify(result.events),
      );
      const recovered = await runTurn("http_502");
      assertEquals(
        recovered.declarationRequests,
        2,
        JSON.stringify(recovered.steps),
      );
      assert(
        recovered.steps.some(({ step, meta }) =>
          step === "v3_derived_selection_reasoning_retry" &&
          meta?.upstream_origin === "http_response" &&
          meta?.observed_http_status === 502
        ),
      );
      assert(
        recovered.steps.some(({ step }) =>
          step === "v3_derived_selection_reasoning_retry_recovered"
        ),
      );
      const limited = await runTurn("http_429");
      assertEquals(
        limited.declarationRequests,
        1,
        JSON.stringify(limited.steps),
      );
      assertEquals(limited.correctionRequests, 0);
      assertEquals(
        limited.steps.some(({ step }) =>
          step === "v3_derived_selection_reasoning_retry"
        ),
        false,
      );
      assert(
        limited.steps.some(({ step, meta }) =>
          step === "v3_turn_end" &&
          meta?.public_error === "upstream_rate_limited"
        ),
      );
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});
