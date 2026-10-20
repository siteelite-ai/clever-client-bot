// Offline HTTP integration fixture for the uncommon declaration-without-search
// route. The production handler, catalog adapter and terminal renderer run
// unchanged; every outbound request is intercepted, and an unknown URL fails.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
// Keep setup before the production module: ESM evaluates static imports in
// source order, so the real Deno.serve callback is captured without a socket.
import {
  offlineHandler,
  restoreOfflineModuleSetup,
} from "./model-no-search-integration-fixture.ts";
import "./index.ts";

const fakeSupabase = "https://fixture.supabase.invalid";
const fakeCatalog = "https://fixture.catalog.invalid/api";
const catalogLeaf = "Электрические удлинители";
const baseProducts = [
  { id: 101, pagetitle: "Электрический удлинитель Alpha 3 м", price: 2100 },
  { id: 102, pagetitle: "Электрический удлинитель Beta 5 м", price: 2900 },
  { id: 103, pagetitle: "Электрический удлинитель Gamma 10 м", price: 3900 },
].map((product) => ({
  ...product,
  url: `https://220volt.kz/catalog/electric/udliniteli/${product.id}/`,
  category: catalogLeaf,
  warehouses: [{ city: "Караганда", amount: 3 }],
  options: [{ key: "brend__brend", caption_ru: "Бренд", value_ru: "Fixture" }],
}));

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function eventObjects(streamText: string): Array<Record<string, unknown>> {
  return streamText.split("\n\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

interface FixtureResult {
  events: Array<Record<string, unknown>>;
  steps: Array<{ step: string; meta?: Record<string, unknown> }>;
  requests: string[];
  modelCalls: number;
}

async function runOfflineTurn(message: string): Promise<FixtureResult> {
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  const requests: string[] = [];
  let steps: FixtureResult["steps"] = [];
  let modelCalls = 0;

  try {
    globalThis.setInterval = ((
      callback: Parameters<typeof setInterval>[0],
      delay?: number,
      ...args: unknown[]
    ) => {
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

      if (url.origin === fakeSupabase) {
        if (
          url.pathname === "/rest/v1/chat_request_logs" &&
          request.method === "POST"
        ) {
          return json({ id: "offline-log-id" }, 201);
        }
        if (
          url.pathname === "/rest/v1/chat_request_logs" &&
          request.method === "PATCH"
        ) {
          const body = await request.json() as {
            steps?: FixtureResult["steps"];
          };
          steps = body.steps ?? [];
          return new Response(null, { status: 204 });
        }
        if (
          url.pathname === "/rest/v1/app_settings" &&
          request.method === "GET"
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
        if (request.method === "GET" && url.pathname.startsWith("/rest/v1/")) {
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
              category: { id: 1, pagetitle: catalogLeaf, total_products: 3 },
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
          if (!message.includes("аналоги")) {
            assertEquals(url.searchParams.get("category"), catalogLeaf);
          }
          return json({
            data: {
              results: baseProducts,
              pagination: { total: baseProducts.length },
            },
          });
        }
      }

      if (url.toString() === "https://openrouter.ai/api/v1/chat/completions") {
        modelCalls += 1;
        const body = await request.json() as {
          tool_choice?: { function?: { name?: string } };
        };
        if (
          body.tool_choice?.function?.name !== "declare_selection_reasoning"
        ) {
          // A failed card proof may enter an ordinary terminal retry. It has
          // no catalog-grounded instruction in this fixture and cannot add a
          // card merely by naming one in untrusted model prose.
          return json({
            choices: [{
              finish_reason: "stop",
              message: {
                content: message.includes("аналоги")
                  ? "Эти модели полностью взаимозаменяемы и дешевле исходной."
                  : "",
                tool_calls: [],
              },
            }],
          });
        }
        return json({
          choices: [{
            finish_reason: "tool_calls",
            message: {
              content: message.includes("аналоги")
                ? "Эти модели полностью взаимозаменяемы и дешевле исходной."
                : null,
              tool_calls: [{
                id: "offline-reasoning",
                type: "function",
                function: {
                  name: "declare_selection_reasoning",
                  arguments: JSON.stringify({
                    reasoning: message.includes("аналоги")
                      ? "Ищу электрические удлинители из каталога. Эти модели полностью взаимозаменяемы и дешевле исходной."
                      : message.includes("для дома")
                      ? "Покажу несколько электрических удлинителей для дома."
                      : "Покажу несколько электрических удлинителей из каталога для выбора.",
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

      throw new Error(`Unexpected outbound request: ${request.method} ${url}`);
    };

    const request = new Request(
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
    );
    const response = await offlineHandler()(request);
    assertEquals(response.status, 200);
    const events = eventObjects(await response.text());
    assert(
      events.some((event) =>
        (event.v3_event as { type?: string } | undefined)?.type === "done"
      ) ||
        events.some((event) => Array.isArray(event.choices)),
      "handler must emit a protocol response",
    );
    return { events, steps, requests, modelCalls };
  } finally {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
  }
}

Deno.test({
  name:
    "model reasoning without search browses the verified leaf and renders grounded choices offline",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runOfflineTurn(
      "Предложи несколько электрических удлинителей на выбор",
    );
    const stepNames = result.steps.map(({ step }) => step);
    assert(
      stepNames.includes(
        "v3_unqualified_category_browse_after_model_no_search_queued",
      ),
    );
    assert(
      stepNames.includes(
        "v3_unqualified_category_browse_after_model_no_search",
      ),
    );
    const cards = result.events.filter((event) =>
      (event.v3_event as { type?: string } | undefined)?.type ===
        "products_block"
    );
    assertEquals(cards.length, 1);
    const cardBlock = cards[0].v3_event as {
      count: number;
      markdown: string;
    };
    assert(cardBlock.count >= 2);
    assert(
      baseProducts.filter((product) =>
        cardBlock.markdown.includes(product.pagetitle)
      ).length >= 2,
      "visible cards must come from fixture catalog records",
    );
    assertEquals(result.modelCalls, 1);
    assert(
      result.requests.some((request) =>
        request.startsWith(
          "GET https://fixture.catalog.invalid/api/products?",
        ) &&
        !new URL(request.slice(4)).searchParams.has("query")
      ),
    );
  },
});

Deno.test({
  name:
    "replacement drops unverified model prose without empty turn breaks and emits server proof",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runOfflineTurn(
      "Предложи аналоги электрического удлинителя Alpha 3 м",
    );
    const visibleText = result.events.flatMap((event) => {
      const content = (event.choices as Array<{ delta?: { content?: string } }> | undefined)
        ?.[0]?.delta?.content;
      return content ? [content] : [];
    }).join("\n");
    assert(!visibleText.includes("полностью взаимозаменяемы"));
    assert(!visibleText.includes("дешевле исходной"));
    assert(result.modelCalls > 0);
    assert(
      result.steps.some(({ step }) =>
        step === "v3_replacement_unproved_claim_removed"
      ),
      JSON.stringify(result.steps.map(({ step }) => step)),
    );
    assertEquals(
      result.steps.some(({ step }) =>
        step === "v3_selection_contract_caption"
      ),
      false,
      "replacement must use the live-card proof, not an unverified model contract",
    );
    const firstCardIndex = result.events.findIndex((event) =>
      (event.v3_event as { type?: string } | undefined)?.type ===
        "products_block"
    );
    assert(firstCardIndex >= 0, JSON.stringify({
      visibleText,
      steps: result.steps.map(({ step }) => step),
    }));
    const preCardText = result.events.slice(0, firstCardIndex).flatMap((event) => {
      const content = (event.choices as Array<{ delta?: { content?: string } }> | undefined)
        ?.[0]?.delta?.content;
      return content ? [content] : [];
    }).join("\n");
    assert(
      preCardText.includes("Показываю кандидатов для замены") &&
        preCardText.includes("взаимозаменяемость") &&
        preCardText.includes("не проверены"),
      `grounded replacement proof must explain candidate status before cards: ${preCardText}`,
    );
    const retainedReasoning = result.steps.findIndex(({ step, meta }) =>
      step === "v3_assistant_text" &&
      meta?.derived_selection === true &&
      Number(meta?.reasoning_chars ?? 0) > 0 &&
      !String(meta?.text ?? "").includes("полностью взаимозаменяемы")
    );
    const groundedBrowse = result.steps.findIndex(({ step }) =>
      step === "v3_terminal_visible_request_recovery"
    );
    assert(
      retainedReasoning >= 0 && groundedBrowse > retainedReasoning,
      "model reasoning must remain available internally before grounded recovery even when its prose is not shown",
    );
    assert(visibleText.includes("не подтверж"), JSON.stringify({
      visibleText,
      steps: result.steps.map(({ step }) => step),
    }));
    let visibleBubbleSeen = false;
    for (const [index, event] of result.events.entries()) {
      const content = (event.choices as Array<{ delta?: { content?: string } }> | undefined)
        ?.[0]?.delta?.content;
      if (content?.trim()) visibleBubbleSeen = true;
      const protocol = event.v3_event as { type?: string; count?: number } | undefined;
      if (protocol?.type === "products_block" && (protocol.count ?? 0) > 0) {
        visibleBubbleSeen = true;
      }
      if (protocol?.type === "assistant_turn_break") {
        assert(visibleBubbleSeen, "an empty assistant bubble must not be emitted");
        assert(
          result.events.slice(index + 1).some((next) => {
            const nextContent = (next.choices as Array<{ delta?: { content?: string } }> | undefined)
              ?.[0]?.delta?.content;
            const nextProtocol = next.v3_event as { type?: string; count?: number } | undefined;
            return Boolean(nextContent?.trim()) ||
              (nextProtocol?.type === "products_block" &&
                (nextProtocol.count ?? 0) > 0);
          }),
          "a suppressed model paragraph must not leave a trailing empty bubble",
        );
      }
    }
  },
});

Deno.test({
  name: "no-search browse does not promote cards lacking a customer qualifier",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const result = await runOfflineTurn(
        "Предложи несколько электрических удлинителей для дома",
      );
      const browse = result.steps.find(({ step }) =>
        step === "v3_unqualified_category_browse_after_model_no_search"
      );
      assert(
        browse,
        "the same fallback must run before the qualifier is checked",
      );
      assertEquals(browse.meta?.retrieved, 3);
      assertEquals(browse.meta?.qualifier_proven, 0);
      assertEquals(
        result.events.filter((event) =>
          (event.v3_event as { type?: string } | undefined)?.type ===
            "products_block"
        ).length,
        0,
      );
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});
