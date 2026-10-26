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

type Step = { step?: string; meta?: Record<string, unknown> };
type Variant = "http_502" | "unusable_http_200";

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

async function runFailure(variant: Variant): Promise<{
  steps: Step[];
  events: Array<Record<string, unknown>>;
  correctionRequests: number;
  catalogProductRequests: number;
}> {
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  let steps: Step[] = [];
  let correctionRequests = 0;
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
        };
        if (
          body.tool_choice?.function?.name === "declare_selection_reasoning"
        ) {
          declarationRequests++;
          const correction = body.messages?.some(({ content }) =>
            content?.includes("<correction>")
          ) ?? false;
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
            sessionId: crypto.randomUUID(),
            history: [],
          }),
        },
      ),
    );
    assertEquals(response.status, 200);
    const events = sseEvents(await response.text());
    assertEquals(declarationRequests, 2, JSON.stringify(steps));
    return { steps, events, correctionRequests, catalogProductRequests };
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
