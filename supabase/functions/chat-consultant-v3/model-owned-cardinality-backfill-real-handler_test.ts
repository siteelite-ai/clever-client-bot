// Offline HTTP/SSE proof for the model-owned search -> terminal render route.
// The model requests one catalog row, the handler safely enlarges that window,
// and the remote-step cap prevents a second model call. The handler must render
// the FIRST proven search pool without widening the category or card gates.
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
const category = "Электрические удлинители";
const leafCategory = "Удлинители сетевые";
const products = [101, 102, 103, 104, 105].map((id) => ({
  id,
  pagetitle: `Электрический удлинитель Серия ${id}`,
  url: `https://220volt.kz/catalog/electric/extension-cords/item-${id}/`,
  category: leafCategory,
  price: 1800 + id,
  warehouses: [{ city: "Караганда", amount: 5 }],
  options: [{ key: "brand", caption_ru: "Бренд", value_ru: "Тест" }],
}));
type Product = (typeof products)[number];
type HistoryMessage = { role: "user" | "assistant"; content: string };

type Event = Record<string, unknown>;
type Step = { step?: string; meta?: Record<string, unknown> };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function modelTool(
  name: string,
  args: Record<string, unknown>,
  content: string | null = null,
): Response {
  return json({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content,
        tool_calls: [{
          id: `offline-${name}-${crypto.randomUUID()}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
    }],
  });
}

function protocolEvents(body: string): Event[] {
  return body.split("\n\n")
    .filter((part) => part.startsWith("data: ") && part !== "data: [DONE]")
    .map((part) => JSON.parse(part.slice(6)) as Event)
    .flatMap((event) => event.v3_event ? [event.v3_event as Event] : []);
}

function publicStreamText(body: string): string {
  return body.split("\n\n")
    .filter((part) => part.startsWith("data: ") && part !== "data: [DONE]")
    .map((part) =>
      JSON.parse(part.slice(6)) as {
        choices?: Array<{ delta?: { content?: string } }>;
      }
    )
    .flatMap((event) =>
      event.choices?.map(({ delta }) => delta?.content ?? "") ?? []
    ).join("\n");
}

async function runCase(
  fixtureProducts: Product[],
  options: {
    message?: string;
    history?: HistoryMessage[];
    /** Simulate an incomplete full-text index inside one verified leaf. */
    queryCount?: number;
    /** Simulate repeated upstream rows sharing one catalog identity. */
    queryDuplicates?: number;
  } = {},
) {
  Deno.env.get = offlineEnvGet;
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  const modelCalls: string[] = [];
  const catalogQueries: string[] = [];
  const activeLeaf = options.queryCount === undefined
    ? leafCategory
    : "Удлинители";
  const activeCategory = options.queryCount === undefined
    ? category
    : "Удлинители";
  const activeProducts = options.queryCount === undefined
    ? fixtureProducts
    : fixtureProducts.map((product) => ({
      ...product,
      category: activeLeaf,
    }));
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
            return json({ id: "offline-model-cardinality" }, 201);
          }
          if (request.method === "PATCH") {
            steps = ((await request.json()) as { steps?: Step[] }).steps ??
              [];
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
        if (
          request.method === "GET" && url.pathname.startsWith("/rest/v1/")
        ) {
          return json([]);
        }
        if (
          request.method === "POST" && url.pathname.startsWith("/rest/v1/")
        ) {
          return json({}, 201);
        }
      }
      if (url.origin === "https://fixture.catalog.invalid") {
        if (url.pathname === "/api/categories") {
          return json({
            data: {
              results: [{
                id: 1,
                pagetitle: category,
                children: [{
                  id: 2,
                  pagetitle: leafCategory,
                  children: [],
                }],
              }, {
                id: 3,
                pagetitle: "Удлинители",
                children: [],
              }],
              pagination: { page: 1, per_page: 200, pages: 1, total: 2 },
            },
          });
        }
        if (url.pathname === "/api/categories/options") {
          return json({
            data: {
              category: {
                id: options.queryCount === undefined ? 1 : 3,
                pagetitle: activeCategory,
                total_products: activeProducts.length,
              },
              options: [{
                key: "brand",
                caption_ru: "Бренд",
                type: "string",
                values: [{
                  value_ru: "Тест",
                  products_count: activeProducts.length,
                }],
              }],
            },
          });
        }
        if (url.pathname === "/api/products") {
          catalogQueries.push(url.toString());
          const perPage = Number(url.searchParams.get("per_page")) || 1;
          const categoryFilter = [
            ...url.searchParams.getAll("category"),
            ...url.searchParams.getAll("category_in").flatMap((value) =>
              value.split(",")
            ),
          ].filter(Boolean);
          const matching = categoryFilter.length > 0
            ? activeProducts.filter((product) =>
              categoryFilter.includes(product.category)
            )
            : activeProducts;
          const maxPrice = Number(url.searchParams.get("max_price"));
          const budgetSafe = maxPrice > 0
            ? matching.filter((product) => product.price <= maxPrice)
            : matching;
          const queried = options.queryCount !== undefined &&
              url.searchParams.has("query")
            ? options.queryDuplicates && budgetSafe[0]
              ? Array.from({ length: options.queryDuplicates }, () =>
                budgetSafe[0])
              : budgetSafe.slice(0, options.queryCount)
            : budgetSafe;
          return json({
            data: {
              results: queried.slice(0, perPage),
              pagination: { total: queried.length },
            },
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
          modelCalls.push("category_matcher");
          return json({
            choices: [{
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  candidates: [{ pagetitle: activeCategory, confidence: 0.99 }],
                }),
              },
            }],
          });
        }
        const forced = body.tool_choice?.function?.name;
        if (forced === "declare_selection_reasoning") {
          modelCalls.push("reasoning");
          return modelTool(forced, {
            reasoning:
              "Ищу несколько электрических удлинителей и проверяю товары по карточкам каталога.",
            retrieval_query: "",
            measurement_scope: "not_applicable",
            compatible_classifications: [],
            excluded_classifications: [],
            required_facet_values: [],
            explicit_customer_classifications: [],
          });
        }
        if (
          body.tools?.some(({ function: schema }) =>
            schema?.name === "search_catalog"
          )
        ) {
          modelCalls.push("search_catalog");
          return modelTool("search_catalog", options.queryCount === undefined
            ? {
              mode: "by_filter",
              category: activeLeaf,
              per_page: 1,
            }
            : {
              mode: "by_query",
              query: "удлинители",
              category_in: [activeLeaf],
              per_page: 1,
            }, `Ищу товары в подтверждённой категории «${activeLeaf}».`);
        }
        if (
          body.tools?.some(({ function: schema }) =>
            schema?.name === "discover_category"
          )
        ) {
          modelCalls.push("discover_category");
          return modelTool("discover_category", { noun: category });
        }
        if (
          body.tools?.some(({ function: schema }) =>
            schema?.name === "render_products"
          )
        ) {
          modelCalls.push("render_products");
          return modelTool("render_products", {
            product_ids: ["101"],
            total_available: fixtureProducts.length,
            selection_target: {
              product_class: "электрический удлинитель",
              application_context: [],
            },
            criteria: [],
            compatibility_relations: [],
          });
        }
        modelCalls.push(`stop:${forced ?? "none"}`);
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

    const response = await offlineHandler()(
      new Request(
        "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: options.message ?? "Удлинители: покажи несколько товаров",
            messageId: crypto.randomUUID(),
            sessionId: crypto.randomUUID(),
            history: options.history ?? [],
          }),
        },
      ),
    );
    assertEquals(response.status, 200);
    const wireBody = await response.text();
    const protocol = protocolEvents(wireBody);
    const publicText = publicStreamText(wireBody);
    const trace = JSON.stringify({
      modelCalls,
      catalogQueries,
      steps,
      protocol,
      publicText,
    });
    return { modelCalls, catalogQueries, steps, protocol, publicText, trace };
  } finally {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
    restoreOfflineModuleSetup();
  }
}

function renderedIds(protocol: Event[]): number[] {
  return protocol.filter((event) => event.type === "products_block")
    .flatMap((event) =>
      [
        ...String(event.markdown ?? "").matchAll(
          /https:\/\/220volt\.kz\/catalog\/electric\/extension-cords\/item-(\d+)\//gu,
        ),
      ].map((match) => Number(match[1]))
    );
}

Deno.test({
  name:
    "real model-owned category search terminal-renders five proven extension cords without a second model call",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runCase(products);
    assert(result.modelCalls.includes("search_catalog"), result.trace);
    assert(!result.modelCalls.includes("render_products"), result.trace);
    assert(
      result.steps.some(({ step, meta }) =>
        step === "v3_tool_call" && meta?.tool === "search_catalog" &&
        meta?.ok === true
      ),
      result.trace,
    );
    assert(
      result.steps.some(({ step, meta }) =>
        step === "v3_model_owned_filtered_pool_preserved" &&
        meta?.eligible === 5
      ),
      result.trace,
    );
    assert(
      result.steps.some(({ step, meta }) =>
        step === "v3_model_owned_filtered_terminal_render" &&
        meta?.rendered === 5
      ),
      result.trace,
    );
    assert(result.catalogQueries.length > 0, result.trace);
    assert(
      result.catalogQueries.some((raw) =>
        Number(new URL(raw).searchParams.get("per_page")) >= 15
      ),
      result.trace,
    );
    const blocks = result.protocol.filter((event) =>
      event.type === "products_block"
    );
    assertEquals(blocks.length, 1, result.trace);
    assertEquals(
      renderedIds(result.protocol),
      [101, 102, 103, 104, 105],
      result.trace,
    );
    assertEquals(Number(blocks[0].count), 5, result.trace);
    assertEquals(
      (blocks[0].selection_contract as { result_cardinality?: unknown })
        ?.result_cardinality,
      { target: 5, minimum: 3, mode: "alternatives", explicit: true },
    );
    assert(
      !result.steps.some(({ step }) =>
        step === "v3_result_cardinality_shortfall"
      ),
      result.trace,
    );
  },
});

for (const queryCount of [1, 2]) {
  Deno.test({
    name:
      `real full-text shortfall of ${queryCount} choice(s) browses only the same verified leaf`,
    permissions: { read: true, env: false, net: false },
    async fn() {
      const result = await runCase(products, {
        message: "Предложи несколько удлинителей на выбор",
        queryCount,
      });
      const browse = result.steps.filter(({ step, meta }) =>
        step === "v3_source_proven_cardinality_recovery" &&
        meta?.kind === "verify_unqualified_browse_in_grounded_category"
      );
      assertEquals(browse.length, 1, result.trace);
      assertEquals(browse[0].meta?.eligible, 5, result.trace);
      assertEquals(renderedIds(result.protocol), [101, 102, 103, 104, 105], result.trace);
      assertEquals(new Set(renderedIds(result.protocol)).size, 5, result.trace);
      assert(
        result.catalogQueries.some((raw) => {
          const params = new URL(raw).searchParams;
          return !params.has("query") &&
            (params.get("category_in") === "Удлинители" ||
              params.get("category") === "Удлинители") &&
            Number(params.get("per_page")) === 50;
        }),
        result.trace,
      );
      assert(!result.steps.some(({ step }) =>
        step === "v3_result_cardinality_shortfall"
      ), result.trace);
    },
  });
}

Deno.test({
  name: "three duplicate upstream rows count as one choice and trigger one same-leaf browse",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runCase(products, {
      message: "Предложи несколько удлинителей на выбор",
      queryCount: 3,
      queryDuplicates: 3,
    });
    const browse = result.steps.filter(({ step, meta }) =>
      step === "v3_source_proven_cardinality_recovery" &&
      meta?.kind === "verify_unqualified_browse_in_grounded_category"
    );
    assertEquals(browse.length, 1, result.trace);
    assertEquals(browse[0].meta?.eligible, 5, result.trace);
    assertEquals(renderedIds(result.protocol), [101, 102, 103, 104, 105], result.trace);
    assertEquals(new Set(renderedIds(result.protocol)).size, 5, result.trace);
  },
});

Deno.test({
  name: "real sparse leaf reports two proven choices without inventing a third",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runCase(products.slice(0, 2), {
      message: "Предложи несколько удлинителей на выбор",
      queryCount: 1,
    });
    assertEquals(renderedIds(result.protocol), [101, 102], result.trace);
    assert(
      result.steps.some(({ step, meta }) =>
        step === "v3_source_proven_cardinality_recovery" &&
        meta?.kind === "verify_unqualified_browse_in_grounded_category" &&
        meta?.eligible === 2
      ),
      result.trace,
    );
    assert(
      result.steps.some(({ step, meta }) =>
        step === "v3_result_cardinality_shortfall" && meta?.actual === 2
      ),
      result.trace,
    );
    assert(/подтвердить 2 варианта/iu.test(result.publicText), result.trace);
  },
});

Deno.test({
  name: "real full-text shortfall cannot erase a numeric customer requirement",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runCase(products, {
      message: "Предложи несколько удлинителей 16 А на выбор",
      queryCount: 1,
    });
    assert(
      !result.steps.some(({ step, meta }) =>
        step === "v3_source_proven_cardinality_recovery" &&
        meta?.kind === "verify_unqualified_browse_in_grounded_category"
      ),
      result.trace,
    );
    assert(
      !result.catalogQueries.some((raw) => {
        const params = new URL(raw).searchParams;
        return !params.has("query") &&
          (params.get("category_in") === "Удлинители" ||
            params.get("category") === "Удлинители");
      }),
      result.trace,
    );
  },
});

const priorCableHistory: HistoryMessage[] = [
  { role: "user", content: "Покажи кабели ВВГ" },
  {
    role: "assistant",
    content:
      "Нашёл кабель ВВГ: https://220volt.kz/catalog/electric/extension-cords/item-900/",
  },
];

Deno.test({
  name: "continuation renders only current-turn proven category cards",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runCase(products, {
      history: priorCableHistory,
    });
    assert(result.modelCalls.includes("search_catalog"), result.trace);
    assert(!result.modelCalls.includes("render_products"), result.trace);
    assertEquals(
      renderedIds(result.protocol),
      [101, 102, 103, 104, 105],
      result.trace,
    );
    assert(
      result.steps.some(({ step }) =>
        step === "v3_model_owned_filtered_terminal_render"
      ),
      result.trace,
    );
  },
});

Deno.test({
  name:
    "one proven model-owned card is rendered with an honest explicit multi-choice shortfall",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runCase([
      products[0],
      { ...products[1], pagetitle: "Колодка штепсельная без кабеля" },
    ], {
      history: priorCableHistory,
    });
    assert(result.modelCalls.includes("search_catalog"), result.trace);
    assert(!result.modelCalls.includes("render_products"), result.trace);
    assertEquals(renderedIds(result.protocol), [101], result.trace);
    const blocks = result.protocol.filter((event) =>
      event.type === "products_block"
    );
    assertEquals(blocks.length, 1, result.trace);
    assertEquals(Number(blocks[0].count), 1, result.trace);
    assertEquals(
      (blocks[0].selection_contract as { result_cardinality?: unknown })
        ?.result_cardinality,
      { target: 5, minimum: 3, mode: "alternatives", explicit: true },
      result.trace,
    );
    assert(
      result.steps.some(({ step, meta }) =>
        step === "v3_result_cardinality_shortfall" && meta?.actual === 1 &&
        meta?.source === "model_owned_filtered_terminal"
      ),
      result.trace,
    );
    assert(/подтвердить 1 вариант/iu.test(result.publicText), result.trace);
    assert(
      /ослабить условия|какое условие можно изменить/iu.test(result.publicText),
      result.trace,
    );
    assert(
      /с вашего согласия|без вашего согласия/iu.test(result.publicText),
      result.trace,
    );
    assert(!result.trace.includes("item-900/"), result.trace);
  },
});

Deno.test({
  name: "continuation cannot reuse old cards when current search is empty",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runCase([], {
      history: priorCableHistory,
    });
    assertEquals(renderedIds(result.protocol), [], result.trace);
    assert(
      !result.steps.some(({ step }) =>
        step === "v3_model_owned_filtered_pool_preserved" ||
        step === "v3_model_owned_filtered_terminal_render"
      ),
      result.trace,
    );
  },
});

Deno.test({
  name: "model-owned filtered render exposes a customer price criterion",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runCase(
      products.map((product) =>
        product.id === 105 ? { ...product, price: 2600 } : product
      ),
      {
        message: "Удлинители: покажи несколько до 2000 тенге",
      },
    );
    assertEquals(
      renderedIds(result.protocol),
      [101, 102, 103, 104],
      result.trace,
    );
    const block = result.protocol.find((event) =>
      event.type === "products_block"
    );
    assert(block, result.trace);
    const mandatory = (block.selection_contract as {
      mandatory_criteria?: Array<{ key: string; op: string; value: number }>;
    }).mandatory_criteria ?? [];
    assert(
      mandatory.some(({ key, op, value }) =>
        key === "Цена" && op === "max" && value === 2000
      ),
      result.trace,
    );
  },
});

Deno.test({
  name: "model-owned cardinality cannot render foreign-category catalog rows",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const foreign = products.map((product) => ({
      ...product,
      category: "Автоматические выключатели",
    }));
    const result = await runCase(foreign);
    assert(result.modelCalls.includes("search_catalog"), result.trace);
    assert(
      result.steps.some(({ step, meta }) =>
        step === "v3_tool_call" && meta?.tool === "search_catalog" &&
        meta?.ok === true
      ),
      result.trace,
    );
    assert(
      !result.steps.some(({ step }) =>
        step === "v3_model_owned_filtered_pool_preserved" ||
        step === "v3_model_owned_filtered_terminal_render"
      ),
      result.trace,
    );
    assertEquals(renderedIds(result.protocol), [], result.trace);
    assertEquals(
      result.protocol.filter((event) => event.type === "products_block").length,
      0,
      result.trace,
    );
  },
});

Deno.test({
  name:
    "model-owned cardinality skips an off-target first row and backfills from eligible rows",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const mixed = [
      {
        ...products[0],
        pagetitle: "Колодка штепсельная без кабеля",
        category: leafCategory,
      },
      ...products.slice(1),
    ];
    const result = await runCase(mixed);
    assert(result.modelCalls.includes("search_catalog"), result.trace);
    assert(result.catalogQueries.length > 0, result.trace);
    assertEquals(
      renderedIds(result.protocol),
      [102, 103, 104, 105],
      result.trace,
    );
    assertEquals(
      result.protocol.filter((event) => event.type === "products_block").length,
      1,
      result.trace,
    );
    assert(
      !result.steps.some(({ step }) =>
        step === "v3_result_cardinality_shortfall"
      ),
      result.trace,
    );
  },
});
