// Exercise the actual HTTP/SSE handler with an isolate-local closure marker.
// Every external request is intercepted; no paid or live network is used.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  offlineClosureProviderHandler,
  restoreOfflineClosureProviderFixture,
} from "./derived-reasoning-lovable-closure-fixture.ts";
import { derivedReasoningLovableRetryEnabled } from "./index.ts";

type Variant =
  | "timeout_success"
  | "unusable_lovable"
  | "lovable_no_tool"
  | "lovable_malformed_named"
  | "lovable_auth"
  | "lovable_abort"
  | "primary_auth"
  | "primary_malformed_named"
  | "non_derived";
type Step = { step?: string; meta?: Record<string, unknown> };
type ModelBody = Record<string, unknown> & {
  tool_choice?: { function?: { name?: string } };
  tools?: Array<{ function?: { name?: string } }>;
  messages?: Array<{ content?: string }>;
};

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

function validDeclaration(): Response {
  return json({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: null,
        tool_calls: [{
          id: "offline-independent-reasoning",
          type: "function",
          function: {
            name: "declare_selection_reasoning",
            arguments: JSON.stringify({
              reasoning:
                "Для оборудования 250 Вт проверю общую мощность системы ИБП с запасом и наличие каждого товара в каталоге.",
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

function malformedNamedDeclaration(): Response {
  return json({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: null,
        tool_calls: [{
          id: "offline-malformed-reasoning",
          type: "function",
          function: {
            name: "declare_selection_reasoning",
            arguments: "{}",
          },
        }],
      },
    }],
  });
}

async function runTurn(variant: Variant): Promise<{
  steps: Step[];
  events: Array<Record<string, unknown>>;
  declarations: Array<{ provider: string; body: ModelBody }>;
  providers: string[];
}> {
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  const providers: string[] = [];
  const declarations: Array<{ provider: string; body: ModelBody }> = [];
  let steps: Step[] = [];
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
            return json({ id: `offline-closure-${variant}` }, 201);
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
          return json({ data: { results: [], pagination: { total: 0 } } });
        }
      }
      if (
        url.toString() === "https://openrouter.ai/api/v1/chat/completions" ||
        url.toString() === "https://ai.gateway.lovable.dev/v1/chat/completions"
      ) {
        const provider = url.hostname === "openrouter.ai"
          ? "openrouter"
          : "lovable";
        providers.push(provider);
        const body = await request.json() as ModelBody;
        if (
          body.tool_choice?.function?.name === "declare_selection_reasoning"
        ) {
          declarations.push({ provider, body });
          if (provider === "openrouter") {
            if (variant === "primary_auth") {
              return json({ error: "offline auth failure" }, 401);
            }
            if (variant === "timeout_success") {
              throw new DOMException("offline primary timeout", "TimeoutError");
            }
            if (variant === "primary_malformed_named") {
              return declarations.length === 1
                ? malformedNamedDeclaration()
                : validDeclaration();
            }
            return json({ error: "offline upstream outage" }, 502);
          }
          assertEquals(
            request.headers.get("Authorization"),
            "Bearer offline-lovable",
          );
          if (variant === "unusable_lovable") return json({ choices: [] });
          if (variant === "lovable_no_tool") {
            return json({
              choices: [{
                finish_reason: "stop",
                message: { content: "Покажу подходящие варианты." },
              }],
            });
          }
          if (variant === "lovable_malformed_named") {
            return malformedNamedDeclaration();
          }
          if (variant === "lovable_auth") {
            return json({ error: "offline Lovable auth failure" }, 401);
          }
          if (variant === "lovable_abort") {
            throw new DOMException("offline Lovable abort", "AbortError");
          }
          return validDeclaration();
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
        return json({
          choices: [{
            finish_reason: "stop",
            message: {
              content: variant === "non_derived"
                ? "Уточните, пожалуйста, город доставки."
                : "В каталоге нет подтверждённых вариантов.",
              tool_calls: [],
            },
          }],
        });
      }
      throw new Error(`Unexpected outbound request: ${request.method} ${url}`);
    };

    const response = await offlineClosureProviderHandler()(
      new Request(
        "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3-closure-preview",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-volt-preview-secret":
              "offline-preview-secret-000000000000000001",
          },
          body: JSON.stringify({
            message: variant === "non_derived"
              ? "Сколько стоит доставка?"
              : "Нужен ИБП для оборудования мощностью 250 Вт",
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
      declarations,
      providers,
    };
  } finally {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
  }
}

Deno.test({
  name:
    "closure-preview derived reasoning uses at most one independent provider retry and fails closed",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      assertEquals(
        derivedReasoningLovableRetryEnabled({
          scope: "closure_preview",
          enabled: undefined,
          apiKey: "offline-lovable",
        }),
        false,
      );
      assertEquals(
        derivedReasoningLovableRetryEnabled({
          scope: undefined,
          enabled: "true",
          apiKey: "offline-lovable",
        }),
        false,
      );
      assertEquals(
        derivedReasoningLovableRetryEnabled({
          scope: "closure_preview",
          enabled: "true",
          apiKey: null,
        }),
        false,
      );
      assertEquals(
        derivedReasoningLovableRetryEnabled({
          scope: "closure_preview",
          enabled: "true",
          apiKey: "offline-lovable",
        }),
        true,
      );

      const recovered = await runTurn("timeout_success");
      assertEquals(recovered.declarations.map(({ provider }) => provider), [
        "openrouter",
        "lovable",
      ]);
      assertEquals(
        recovered.declarations[1].body.model,
        "offline-lovable-model",
      );
      assertEquals(
        recovered.declarations[1].body.messages,
        recovered.declarations[0].body.messages,
      );
      assertEquals(
        recovered.declarations[1].body.tools,
        recovered.declarations[0].body.tools,
      );
      assertEquals(
        recovered.declarations[1].body.tool_choice,
        recovered.declarations[0].body.tool_choice,
      );
      assert(
        recovered.steps.some(({ step, meta }) =>
          step === "v3_derived_selection_reasoning_retry" &&
          meta?.retry_provider === "lovable" &&
          typeof meta?.retry_timeout_ms === "number" &&
          meta.retry_timeout_ms > 0 && meta.retry_timeout_ms <= 8_000
        ),
        JSON.stringify(
          recovered.steps.filter(({ step }) =>
            step?.includes("derived_selection_reasoning_retry")
          ),
        ),
      );
      assert(
        recovered.steps.some(({ step, meta }) =>
          step === "v3_derived_selection_reasoning_retry_recovered" &&
          meta?.retry_provider === "lovable"
        ),
      );
      assertEquals(
        recovered.steps.some(({ step }) =>
          step === "v3_derived_selection_reasoning_contract_retry"
        ),
        false,
      );
      assertEquals(
        recovered.steps.some(({ step, meta }) =>
          step === "v3_turn_end" && meta?.reason === "error"
        ),
        false,
      );

      for (
        const variant of [
          "unusable_lovable",
          "lovable_no_tool",
          "lovable_malformed_named",
          "lovable_auth",
          "lovable_abort",
        ] as const
      ) {
        const failed = await runTurn(variant);
        assertEquals(
          failed.declarations.map(({ provider }) => provider),
          ["openrouter", "lovable"],
          JSON.stringify({ variant, steps: failed.steps }),
        );
        assertEquals(
          failed.events.some((event) =>
            (event.v3_event as { type?: string } | undefined)?.type ===
              "products_block"
          ),
          false,
          variant,
        );
        assertEquals(
          failed.steps.some(({ step }) =>
            step === "v3_derived_selection_reasoning_contract_retry"
          ),
          false,
          variant,
        );
        if (
          variant === "lovable_no_tool" ||
          variant === "lovable_malformed_named"
        ) {
          assert(
            failed.steps.some(({ step }) =>
              step ===
                "v3_derived_selection_reasoning_retry_contract_unverified"
            ),
          );
          assertEquals(
            failed.steps.some(({ step }) =>
              step === "v3_derived_selection_reasoning_retry_recovered"
            ),
            false,
          );
        }
      }
      const corrected = await runTurn("primary_malformed_named");
      assertEquals(
        corrected.declarations.map(({ provider }) => provider),
        ["openrouter", "openrouter"],
        "A project-wide fallback flag must not add a third provider call",
      );
      assert(
        corrected.declarations[1].body.messages?.some(({ content }) =>
          content?.includes("<correction>")
        ),
      );
      const auth = await runTurn("primary_auth");
      assertEquals(auth.declarations.map(({ provider }) => provider), [
        "openrouter",
      ]);
      assertEquals(
        auth.steps.some(({ step }) =>
          step === "v3_derived_selection_reasoning_retry"
        ),
        false,
      );

      const nonDerived = await runTurn("non_derived");
      assertEquals(nonDerived.declarations.length, 0);
      assertEquals(nonDerived.providers.includes("lovable"), false);
    } finally {
      restoreOfflineClosureProviderFixture();
    }
  },
});
