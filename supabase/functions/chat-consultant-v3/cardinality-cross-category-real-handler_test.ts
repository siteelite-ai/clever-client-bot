// Category-neutral HTTP/SSE cardinality regression. The real V3 handler,
// catalog adapter and renderer execute unchanged; every outbound request is
// intercepted. These prompts currently take the server-compiled selection
// path, so the scripted model fallback cannot be mistaken for actual coverage.
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
type Case = {
  label: string;
  message: string;
  category: string;
  products: Product[];
  expectedIds: number[];
  strict?: boolean;
};

function item(
  id: number,
  category: string,
  pagetitle: string,
  price: number,
  options: Product["options"],
): Product {
  return {
    id,
    pagetitle,
    url: `https://220volt.kz/catalog/electric/fixtures/item-${id}/`,
    category,
    price,
    warehouses: [{ city: "Караганда", amount: 5 }],
    options,
  };
}

const socketOptions = (count: string, color: string): Product["options"] => [
  { key: "outlets", caption_ru: "Количество разъемов", value_ru: count },
  { key: "color", caption_ru: "Цвет", value_ru: color },
];
const breakerOptions = (poles: string, current: string): Product["options"] => [
  { key: "brand", caption_ru: "Бренд", value_ru: "Schneider Electric" },
  { key: "poles", caption_ru: "Количество полюсов", value_ru: poles },
  { key: "current", caption_ru: "Номинальный ток", value_ru: current },
];
const extensionOptions = (kind: string): Product["options"] => [
  { key: "kind", caption_ru: "Тип", value_ru: kind },
];

const cases: Case[] = [
  {
    label: "двойные чёрные розетки",
    message: "Найди несколько двойных черных электрических розеток",
    category: "Электрические розетки",
    products: [
      ...[1, 2, 3, 4, 5].map((id) =>
        item(
          id,
          "Электрические розетки",
          `Розетка двойная черная Серия ${id}`,
          1200 + id,
          socketOptions("2", "Черный"),
        )
      ),
      item(
        6,
        "Электрические розетки",
        "Розетка одинарная белая",
        1100,
        socketOptions("1", "Белый"),
      ),
    ],
    expectedIds: [1, 2, 3, 4, 5],
  },
  {
    label: "автоматы Schneider 16 А, 3 полюса",
    message:
      "Покажи несколько автоматических выключателей Schneider на 16 ампер, на 3 полюса",
    category: "Автоматические выключатели",
    products: [
      ...[11, 12, 13, 14, 15].map((id) =>
        item(
          id,
          "Автоматические выключатели",
          `Автомат Schneider Electric 3P 16A Серия ${id}`,
          2200 + id,
          breakerOptions("3", "16"),
        )
      ),
      item(
        16,
        "Автоматические выключатели",
        "Автомат Schneider Electric 1P 10A",
        1500,
        breakerOptions("1", "10"),
      ),
    ],
    expectedIds: [11, 12, 13, 14, 15],
  },
  {
    label: "электрические удлинители",
    message: "Предложи несколько электрических удлинителей на выбор",
    category: "Электрические удлинители",
    products: [
      ...[21, 22, 23, 24, 25].map((id) =>
        item(
          id,
          "Электрические удлинители",
          `Электрический удлинитель Серия ${id}`,
          1800 + id,
          extensionOptions("Удлинитель"),
        )
      ),
      item(
        26,
        "Электрические удлинители",
        "Колодка штепсельная без кабеля",
        800,
        extensionOptions("Колодка"),
      ),
    ],
    expectedIds: [21, 22, 23, 24, 25],
  },
  {
    label: "строгий бюджет: подтверждена одна розетка",
    message:
      "Найди несколько двойных черных электрических розеток не дороже 1000 тенге",
    category: "Электрические розетки",
    products: [
      item(
        31,
        "Электрические розетки",
        "Розетка двойная черная Бюджет",
        900,
        socketOptions("2", "Черный"),
      ),
      ...[32, 33, 34, 35, 36].map((id) =>
        item(
          id,
          "Электрические розетки",
          `Розетка двойная черная Дорогая ${id}`,
          2000 + id,
          socketOptions("2", "Черный"),
        )
      ),
      item(
        37,
        "Электрические розетки",
        "Розетка одинарная белая",
        700,
        socketOptions("1", "Белый"),
      ),
    ],
    expectedIds: [31],
    strict: true,
  },
];
const catalogCategories = [...new Set(cases.map(({ category }) => category))];

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function modelTool(name: string, args: Record<string, unknown>): Response {
  return json({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: null,
        tool_calls: [{
          id: `offline-${name}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
    }],
  });
}

function sseEvents(body: string): Event[] {
  return body.split("\n\n")
    .filter((part) => part.startsWith("data: ") && part !== "data: [DONE]")
    .map((part) => JSON.parse(part.slice(6)) as Event);
}

async function runCase(scenario: Case) {
  Deno.env.get = offlineEnvGet;
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  const calls: string[] = [];
  const catalogQueries: string[] = [];
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
            return json({ id: "offline-cardinality" }, 201);
          }
          if (request.method === "PATCH") {
            steps = ((await request.json()) as { steps?: Step[] }).steps ?? [];
            return new Response(null, { status: 204 });
          }
          return json([]);
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
              results: catalogCategories.map((pagetitle, index) => ({
                id: index + 1,
                pagetitle,
                children: [],
              })),
              pagination: {
                page: 1,
                per_page: 200,
                pages: 1,
                total: catalogCategories.length,
              },
            },
          });
        }
        if (url.pathname === "/api/categories/options") {
          return json({
            data: {
              category: {
                id: catalogCategories.indexOf(scenario.category) + 1,
                pagetitle: scenario.category,
                total_products: scenario.products.length,
              },
              options: [
                ...new Map(
                  scenario.products.flatMap((product) => product.options).map((
                    option,
                  ) => [option.key, option]),
                ).values(),
              ].map((option) => ({
                key: option.key,
                caption_ru: option.caption_ru,
                type: "string",
                values: [
                  ...new Set(
                    scenario.products.flatMap((product) => product.options)
                      .filter((candidate) => candidate.key === option.key)
                      .map((candidate) => candidate.value_ru),
                  ),
                ]
                  .map((value_ru) => ({ value_ru, products_count: 3 })),
              })),
            },
          });
        }
        if (url.pathname === "/api/products") {
          catalogQueries.push(url.toString());
          // An imperfect upstream page deliberately includes a wrong-facet
          // row. The real handler must prove every rendered product itself.
          return json({
            data: {
              results: scenario.products,
              pagination: { total: scenario.products.length },
            },
          });
        }
      }
      if (url.toString() === "https://openrouter.ai/api/v1/chat/completions") {
        const body = await request.json() as {
          tool_choice?: { function?: { name?: string } };
          tools?: Array<{ function?: { name?: string } }>;
          messages?: Array<{ role?: string; name?: string; content?: string }>;
        };
        if (
          !body.tools?.length &&
          body.messages?.some(({ content }) =>
            content?.includes("CATEGORY MATCHER")
          )
        ) {
          calls.push("category_matcher");
          return json({
            choices: [{
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  candidates: [{
                    pagetitle: scenario.category,
                    confidence: 0.99,
                  }],
                }),
              },
            }],
          });
        }
        const forced = body.tool_choice?.function?.name;
        if (forced === "declare_selection_reasoning") {
          calls.push("reasoning");
          return modelTool(forced, {
            reasoning:
              `Ищу товары в разделе «${scenario.category}» по запросу клиента и проверяю каждую карточку по характеристикам.`,
            retrieval_query: scenario.category,
            measurement_scope: "not_applicable",
            compatible_classifications: [],
            excluded_classifications: [],
            required_facet_values: [],
            explicit_customer_classifications: [],
          });
        }
        calls.push("stop");
        return json({
          choices: [{
            finish_reason: "stop",
            message: { content: "", tool_calls: [] },
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
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: scenario.message,
            messageId: crypto.randomUUID(),
            sessionId: crypto.randomUUID(),
            history: [],
          }),
        },
      ),
    );
    assertEquals(response.status, 200);
    const events = sseEvents(await response.text());
    return { events, steps, calls, catalogQueries };
  } finally {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
  }
}

for (const scenario of cases) {
  Deno.test({
    name: `real HTTP/SSE cardinality: ${scenario.label}`,
    permissions: { read: true, env: false, net: false },
    async fn() {
      const result = await runCase(scenario);
      const protocol = result.events.flatMap((event) =>
        event.v3_event ? [event.v3_event as Event] : []
      );
      const blocks = protocol.filter((event) =>
        event.type === "products_block"
      );
      assertEquals(
        blocks.length,
        1,
        JSON.stringify({ calls: result.calls, steps: result.steps, protocol }),
      );
      const block = blocks[0];
      const markdown = String(block.markdown ?? "");
      const links = [
        ...markdown.matchAll(
          /https:\/\/220volt\.kz\/catalog\/electric\/fixtures\/item-(\d+)\//gu,
        ),
      ]
        .map((match) => Number(match[1]));
      assertEquals(new Set(links).size, links.length, markdown);
      assertEquals(links.length, Number(block.count));
      assertEquals(
        links.length,
        scenario.strict ? 1 : 5,
        JSON.stringify({ markdown, calls: result.calls, steps: result.steps }),
      );
      assert(links.every((id) => scenario.expectedIds.includes(id)), markdown);
      assert(
        result.steps.some(({ step }) =>
          step === "v3_visible_reasoning_guided_render" ||
          step === "v3_measured_reasoning_terminal_recovery"
        ),
        JSON.stringify({ calls: result.calls, steps: result.steps }),
      );
      assert(result.catalogQueries.length > 0);
      const cardinality = (block.selection_contract as {
        result_cardinality?: {
          target: number;
          minimum: number;
          mode: string;
          explicit: boolean;
        };
      } | undefined)?.result_cardinality;
      assertEquals(cardinality, {
        target: 5,
        minimum: 3,
        mode: "alternatives",
        explicit: true,
      });
      if (scenario.strict) {
        const publicText = result.events.flatMap((event) =>
          (event.choices as Array<{ delta?: { content?: string } }> | undefined)
            ?.map(({ delta }) => delta?.content ?? "") ?? []
        ).join("\n");
        assert(
          /подтвердить 1 вариант|подтвержден.*1 вариант/iu.test(publicText),
          publicText,
        );
        assert(
          /с вашего согласия|без вашего согласия/iu.test(publicText),
          publicText,
        );
        assert(
          result.steps.some(({ step }) =>
            step === "v3_result_cardinality_shortfall"
          ),
        );
      } else {
        assert(
          result.calls.every((call) =>
            ["category_matcher", "reasoning", "stop"].includes(call)
          ),
          JSON.stringify(result.calls),
        );
      }
    },
  });
}

addEventListener("unload", restoreOfflineModuleSetup);
