// Runs the unchanged v3 HTTP/SSE handler in the preview provider variant.
// All Supabase, catalog, and model requests are fixture-only: no live network
// and no paid AI request can escape the unknown-URL guard below.
import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  offlineProviderFailoverHandler,
  restoreOfflineProviderFailoverFixture,
} from "./provider-failover-real-handler-fixture.ts";
import "./index.ts";

addEventListener("unload", restoreOfflineProviderFailoverFixture);

const leaf = "Электрические удлинители";
const products = [
  { id: 101, pagetitle: "Электрический удлинитель Alpha 3 м", price: 2100 },
  { id: 102, pagetitle: "Электрический удлинитель Beta 5 м", price: 2900 },
  { id: 103, pagetitle: "Электрический удлинитель Gamma 10 м", price: 3900 },
].map((product) => ({
  ...product,
  url: `https://220volt.kz/catalog/electric/udliniteli/${product.id}/`,
  category: leaf,
  warehouses: [{ city: "Караганда", amount: 3 }],
  options: [{ key: "brend__brend", caption_ru: "Бренд", value_ru: "Fixture" }],
}));

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface Event {
  v3_event?: { type?: string; count?: number; markdown?: string };
  choices?: Array<{ delta?: { content?: string } }>;
}

function eventsFromSse(body: string): Event[] {
  return body.split("\n\n")
    .filter((part) => part.startsWith("data: ") && part !== "data: [DONE]")
    .map((part) => JSON.parse(part.slice(6)) as Event);
}

Deno.test({
  name:
    "preview HTTP handler replaces unusable primary HTTP 200 once, then renders grounded catalog cards",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const originalFetch = globalThis.fetch;
    const originalSetInterval = globalThis.setInterval;
    const intervals = new Set<number>();
    const providers: string[] = [];
    const modelBodies: Array<Record<string, unknown>> = [];
    const requestUrls: string[] = [];
    let steps: Array<{ step: string; meta?: Record<string, unknown> }> = [];
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
        requestUrls.push(`${request.method} ${url.origin}${url.pathname}`);

        if (url.origin === "https://fixture.supabase.invalid") {
          if (url.pathname === "/rest/v1/chat_request_logs") {
            if (request.method === "POST") {
              return json({ id: "offline-failover-log" }, 201);
            }
            if (request.method === "PATCH") {
              steps =
                (await request.json() as { steps?: typeof steps }).steps ?? [];
              return new Response(null, { status: 204 });
            }
          }
          if (
            url.pathname === "/rest/v1/app_settings" && request.method === "GET"
          ) {
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
                results: [{ id: 1, pagetitle: leaf, children: [] }],
                pagination: { page: 1, per_page: 200, pages: 1, total: 1 },
              },
            });
          }
          if (url.pathname === "/api/categories/options") {
            return json({
              data: {
                category: { id: 1, pagetitle: leaf, total_products: 3 },
                options: [{
                  key: "tip",
                  caption_ru: "Тип",
                  type: "string",
                  values: [{ value_ru: "обычный", products_count: 3 }],
                }],
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
          url.toString() === "https://openrouter.ai/api/v1/chat/completions" ||
          url.toString() ===
            "https://ai.gateway.lovable.dev/v1/chat/completions"
        ) {
          providers.push(url.hostname);
          modelBodies.push(await request.json() as Record<string, unknown>);
          if (url.hostname === "openrouter.ai") {
            // An OpenAI-compatible gateway can report provider failure with
            // HTTP 200, so status-only fallback would miss this regression.
            return json({
              choices: [{ finish_reason: "error", message: { content: null } }],
            });
          }
          assertEquals(
            request.headers.get("Authorization"),
            "Bearer offline-lovable",
          );
          return json({
            choices: [{
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [{
                  id: "offline-reasoning",
                  type: "function",
                  function: {
                    name: "declare_selection_reasoning",
                    arguments: JSON.stringify({
                      reasoning:
                        "Покажу несколько электрических удлинителей из каталога для выбора.",
                      measurement_scope: "not_applicable",
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

        throw new Error(
          `Unexpected outbound request: ${request.method} ${url}`,
        );
      };

      const response = await offlineProviderFailoverHandler()(
        new Request(
          "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3-preview",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-volt-preview-secret":
                "offline-preview-secret-000000000000000001",
            },
            body: JSON.stringify({
              message: "Предложи несколько электрических удлинителей на выбор",
              messageId: crypto.randomUUID(),
              sessionId: crypto.randomUUID(),
              history: [],
            }),
          },
        ),
      );
      assertEquals(response.status, 200);
      const sse = await response.text();
      const events = eventsFromSse(sse);
      assert(sse.includes("data: [DONE]"));
      assertEquals(providers, ["openrouter.ai", "ai.gateway.lovable.dev"]);
      assertEquals(
        modelBodies.length,
        2,
        "one primary and one fallback, no correction retry",
      );
      assertEquals(modelBodies[1].model, "offline-lovable-model");
      assertEquals(modelBodies[1].messages, modelBodies[0].messages);
      assertEquals(modelBodies[1].tools, modelBodies[0].tools);
      assertEquals(modelBodies[1].tool_choice, modelBodies[0].tool_choice);
      const cards = events.filter((event) =>
        event.v3_event?.type === "products_block"
      );
      assertEquals(cards.length, 1);
      assert((cards[0].v3_event?.count ?? 0) >= 2);
      assert(
        products.filter((product) =>
          cards[0].v3_event?.markdown?.includes(product.pagetitle)
        ).length >= 2,
      );
      assert(
        requestUrls.some((request) =>
          request.startsWith("GET https://fixture.catalog.invalid/api/products")
        ),
      );
      assert(steps.some(({ step }) => step === "v3_settings_loaded"));
      assertFalse(steps.some(({ step }) =>
        step.includes("correction_retry") ||
        step.includes("reasoning_retry") ||
        step.includes("correction_failed")
      ));
    } finally {
      for (const id of intervals) clearInterval(id);
      globalThis.setInterval = originalSetInterval;
      globalThis.fetch = originalFetch;
    }
  },
});
