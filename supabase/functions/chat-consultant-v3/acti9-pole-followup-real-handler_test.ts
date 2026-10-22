// A deterministic, two-turn HTTP/SSE regression for a compact replacement
// source. This exercises the production handler, not a standalone parser.
// Every database, catalog and model request is intercepted; no paid or live
// service can be reached by this test.
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
const sessionId = "15151515-1515-4151-8151-151515151515";
const category = "Автоматические выключатели";
const original = "Есть ли аналог автомату Schneider Electric Acti9 C16?";
const answer = "1 полюс, подбери их в каталоге";

type Event = Record<string, unknown>;
type Step = { step?: string; meta?: Record<string, unknown> };
type Product = {
  id: number;
  pagetitle: string;
  url: string;
  category: string;
  price: number;
  warehouses: Array<{ city: string; amount: number }>;
  options: Array<{ key: string; caption_ru: string; value_ru: string }>;
};

function product(
  id: number,
  title: string,
  series: string,
  poles: string,
  curve = "C",
): Product {
  return {
    id,
    pagetitle: title,
    url: `https://220volt.kz/catalog/electric/breakers/fixture-${id}/`,
    category,
    price: 1000 + id,
    warehouses: [{ city: "Караганда", amount: 5 }],
    options: [
      {
        key: "curve",
        caption_ru: "Характеристика срабатывания",
        value_ru: curve,
      },
      { key: "current", caption_ru: "Номинальный ток", value_ru: "16" },
      { key: "poles", caption_ru: "Количество полюсов", value_ru: poles },
      { key: "collection", caption_ru: "Коллекция", value_ru: series },
    ],
  };
}

const products = [
  product(1, "Автомат Schneider Electric Acti9 1P C16", "Acti9", "1"),
  product(2, "Автомат Schneider Electric Acti9 3P C16", "Acti9", "3"),
  product(3, "Автомат GENERICA 1P 16A характеристика C", "GENERICA", "1"),
  product(4, "Автомат CHINT 1P C16", "CHINT", "1"),
  product(5, "Автомат GENERICA 3P C16", "GENERICA", "3"),
  product(6, "Автомат CHINT 1P B16", "CHINT", "1", "B"),
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function eventsFromSse(body: string): Event[] {
  return body.split("\n\n")
    .filter((part) => part.startsWith("data: ") && part !== "data: [DONE]")
    .map((part) => JSON.parse(part.slice(6)) as Event);
}

function v3Events(events: Event[]): Event[] {
  return events.flatMap((event) =>
    event.v3_event ? [event.v3_event as Event] : []
  );
}

function publicText(events: Event[]): string {
  return events.flatMap((event) => {
    const choices = event.choices as
      | Array<{ delta?: { content?: string } }>
      | undefined;
    return choices?.map(({ delta }) => delta?.content ?? "") ?? [];
  }).join("\n");
}

Deno.test({
  name:
    "Acti9 C16 asks poles, then a server-verified 1-pole reply preserves C16 and rejects other poles",
  permissions: { read: true, env: false, net: false },
  async fn() {
    Deno.env.get = offlineEnvGet;
    const originalFetch = globalThis.fetch;
    const originalSetInterval = globalThis.setInterval;
    const intervals = new Set<number>();
    let turn = 0;
    let firstLog: Event[] = [];
    const steps: Step[][] = [[], []];
    const catalogQueries: URL[] = [];
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
              return json({ id: `offline-acti9-${turn}` }, 201);
            }
            if (request.method === "PATCH") {
              const body = await request.json() as {
                steps?: Step[];
                response_events?: Event[];
              };
              if (body.steps) steps[turn] = body.steps;
              if (turn === 0 && body.response_events) {
                firstLog = body.response_events;
              }
              return new Response(null, { status: 204 });
            }
            if (request.method === "GET") {
              if (
                turn === 1 &&
                (url.searchParams.get("select") ?? "").includes(
                  "response_events",
                )
              ) {
                return json({
                  session_id: sessionId,
                  user_query: original,
                  error: null,
                  response_events: firstLog,
                  final_products_count: 0,
                  created_at: new Date(Date.now() - 1000).toISOString(),
                });
              }
              return json([]);
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
          if (
            request.method === "GET" && url.pathname.startsWith("/rest/v1/")
          ) return json([]);
          if (
            request.method === "POST" && url.pathname.startsWith("/rest/v1/")
          ) return json({}, 201);
        }
        if (url.origin === "https://fixture.catalog.invalid") {
          if (url.pathname === "/api/categories") {
            return json({
              data: {
                results: [{ id: 10, pagetitle: category, children: [] }],
                pagination: { page: 1, per_page: 200, pages: 1, total: 1 },
              },
            });
          }
          if (url.pathname === "/api/categories/options") {
            return json({
              data: {
                category: {
                  id: 10,
                  pagetitle: category,
                  total_products: products.length,
                },
                options: [
                  {
                    key: "curve",
                    caption_ru: "Характеристика срабатывания",
                    type: "string",
                    values: ["B", "C"].map((value_ru) => ({
                      value_ru,
                      products_count: 3,
                    })),
                  },
                  {
                    key: "current",
                    caption_ru: "Номинальный ток",
                    type: "number",
                    unit: "А",
                    values: ["10", "16"].map((value_ru) => ({
                      value_ru,
                      products_count: 3,
                    })),
                  },
                  {
                    key: "poles",
                    caption_ru: "Количество полюсов",
                    type: "string",
                    values: ["1", "2", "3"].map((value_ru) => ({
                      value_ru,
                      products_count: 2,
                    })),
                  },
                  {
                    key: "collection",
                    caption_ru: "Коллекция",
                    type: "string",
                    values: ["Acti9", "GENERICA", "CHINT"].map((value_ru) => ({
                      value_ru,
                      products_count: 2,
                    })),
                  },
                ],
              },
            });
          }
          if (url.pathname === "/api/products") {
            catalogQueries.push(url);
            const title = url.searchParams.get("pagetitle");
            const query = url.searchParams.get("query") ??
              url.searchParams.get("q") ?? "";
            let found = products.filter((item) =>
              !title ||
              item.pagetitle.toLocaleLowerCase("ru-RU").includes(
                title.toLocaleLowerCase("ru-RU"),
              )
            );
            if (query && /\bC16\b/iu.test(query)) {
              found = found.filter((item) =>
                /\bC16\b|16A характеристика C/iu.test(item.pagetitle)
              );
            }
            return json({
              data: { results: found, pagination: { total: found.length } },
            });
          }
        }
        if (
          url.toString() === "https://openrouter.ai/api/v1/chat/completions"
        ) {
          const body = await request.json() as {
            tool_choice?: { function?: { name?: string } };
            tools?: Array<{ function?: { name?: string } }>;
            messages?: Array<{ content?: string }>;
          };
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
            body.tool_choice?.function?.name === "declare_selection_reasoning"
          ) {
            return json({
              choices: [{
                finish_reason: "tool_calls",
                message: {
                  content: null,
                  tool_calls: [{
                    id: "offline-acti9-reasoning",
                    type: "function",
                    function: {
                      name: "declare_selection_reasoning",
                      arguments: JSON.stringify({
                        reasoning:
                          "Ищу аналоги автомата Schneider Electric Acti9 C16 с характеристикой C, номиналом 16 А и уточнённой полюсностью 1.",
                        retrieval_query: "автоматический выключатель 1P 16A C",
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

      const invoke = async (
        message: string,
        slots: Record<string, unknown>,
        history: Array<{ role: string; content: string }>,
      ) => {
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
                slots,
                history,
              }),
            },
          ),
        );
        assertEquals(response.status, 200);
        return eventsFromSse(await response.text());
      };

      const first = await invoke(original, {}, []);
      const firstEvents = v3Events(first);
      const issued = firstEvents.find((event) => event.type === "slot_update")
        ?.slots as
          | { pending_clarification?: Record<string, unknown> }
          | undefined;
      const pending = issued?.pending_clarification;
      assert(pending, JSON.stringify({ firstEvents, steps: steps[0] }));
      assertEquals(
        (pending.scope as { kind?: string })?.kind,
        "selection_readiness",
      );
      assertEquals((pending.scope as { token?: string }).token, original);
      assert(/полюс/iu.test(publicText(first)), publicText(first));
      assertEquals(
        firstEvents.filter((event) => event.type === "products_block").length,
        0,
      );
      assert(
        firstLog.some((event) =>
          event.type === "diagnostic" && event.phase === "complete"
        ),
      );
      assert(firstLog.some((event) => event.type === "done"));

      turn = 1;
      const second = await invoke(answer, { pending_clarification: pending }, [
        { role: "user", content: original },
        { role: "assistant", content: publicText(first) },
      ]);
      const secondEvents = v3Events(second);
      assert(
        secondEvents.some((event) =>
          event.type === "diagnostic" && event.phase === "complete" &&
          event.error === null
        ),
        JSON.stringify(secondEvents),
      );
      const cards = secondEvents.filter((event) =>
        event.type === "products_block"
      );
      assertEquals(
        cards.length,
        1,
        JSON.stringify({
          secondEvents,
          steps: steps[1],
          catalogQueries: catalogQueries.map(String),
        }),
      );
      const markdown = String(cards[0].markdown ?? "");
      assert(markdown.includes(products[2].url), markdown);
      assert(markdown.includes(products[3].url), markdown);
      assert(!markdown.includes(products[0].url), markdown);
      assert(!markdown.includes(products[1].url), markdown);
      assert(!markdown.includes(products[4].url), markdown);
      assert(!markdown.includes(products[5].url), markdown);
      const criteria = (cards[0].selection_contract as {
        mandatory_criteria?: Array<{ key: string; value: unknown }>;
      } | undefined)?.mandatory_criteria ?? [];
      assert(
        criteria.some(({ key, value }) =>
          /полюс/iu.test(key) && String(value) === "1"
        ),
        JSON.stringify(criteria),
      );
      assert(
        criteria.some(({ key, value }) =>
          /ток/iu.test(key) && String(value) === "16"
        ),
        JSON.stringify(criteria),
      );
      assert(
        criteria.some(({ key, value }) =>
          /характеристик/iu.test(key) && String(value).toUpperCase() === "C"
        ),
        JSON.stringify(criteria),
      );
      assert(
        steps[1].some(({ step }) =>
          step === "v3_compact_replacement_continuation_rendered"
        ),
        JSON.stringify(steps[1]),
      );
      assert(catalogQueries.length > 0);
    } finally {
      for (const id of intervals) clearInterval(id);
      globalThis.setInterval = originalSetInterval;
      globalThis.fetch = originalFetch;
    }
  },
});

addEventListener("unload", restoreOfflineModuleSetup);
