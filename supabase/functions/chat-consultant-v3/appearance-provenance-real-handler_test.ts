// A no-network HTTP/SSE proof that a model-owned appearance query cannot
// bypass the live facet guard after category discovery. The production handler
// and its actual search I/O boundary run; all external services are fixtures.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { guardSearchFilters } from "../_shared/v3-tools/search-filter-guard.ts";
import {
  executeDiscoverCategory,
  resetDiscoverCategoryCacheForTest,
} from "../_shared/v3-tools/discover-category.ts";
import {
  offlineHandler,
  restoreOfflineModuleSetup,
} from "./model-no-search-integration-fixture.ts";
import {
  customerOwnsExactCatalogArticle,
  exactCustomerIdentitySearchDuringTaxonomyOutage,
  shouldDeferAppearanceProseBeforeDiscovery,
} from "./index.ts";

const offlineEnvGet = Deno.env.get;
const sessionId = "11111111-1111-4111-8111-111111111111";
const category = "Люстры";
const baseRequest = "Нужна люстра для гостиной. Покажи варианты.";
const round = {
  id: 1,
  pagetitle: "Люстра для гостиной круглая",
  url: "https://220volt.kz/catalog/lighting/chandeliers/round/",
  category,
  price: 4500,
  warehouses: [{ city: "Караганда", amount: 2 }],
  options: [
    { key: "shape", caption_ru: "Форма люстры", value_ru: "круг" },
    { key: "protection", caption_ru: "Степень защиты", value_ru: "IP65" },
    {
      key: "temperature",
      caption_ru: "Цветовая температура",
      value_ru: "4000 K",
    },
  ],
};
const oval = {
  ...round,
  id: 2,
  pagetitle: "Люстра для гостиной овальная",
  url: "https://220volt.kz/catalog/lighting/chandeliers/oval/",
  options: [
    { key: "shape", caption_ru: "Форма люстры", value_ru: "овал" },
    { key: "protection", caption_ru: "Степень защиты", value_ru: "IP44" },
    {
      key: "temperature",
      caption_ru: "Цветовая температура",
      value_ru: "3000 K",
    },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface CaseResult {
  catalogProductUrls: string[];
  catalogProductReadsAfterOptions: boolean[];
  directModelSearchCalls: number;
  modelDiscoveryCalls: number;
  jargonModelCalls: number;
  steps: Array<{ step?: string; meta?: Record<string, unknown> }>;
  publicEvents: Array<Record<string, unknown>>;
}

interface CaseOptions {
  /** Keep the declaration visible but make the next catalog call model-owned. */
  directModelSearch?: boolean;
  /** Avoid a prior rendered card that makes this a selection continuation. */
  freshSession?: boolean;
  /** The model may narrow by a live but unrequested category rather than text. */
  modelCategory?: string;
  modelPage?: number;
  modelMode?: "by_query" | "by_pagetitle" | "by_filter" | "by_article";
  modelOptions?: Record<string, string[]>;
  modelAnchorLeafCategory?: string;
  modelArticle?: string;
  liveAppearanceCategory?: boolean;
  appearanceOnlyFacets?: boolean;
  includeAreaFacet?: boolean;
  modelMinPrice?: number;
  taxonomyUnavailable?: boolean;
  jargonCandidates?: string[];
  categoryName?: string;
  fixtureProducts?: Array<Record<string, unknown>>;
  fixtureLeaves?: string[];
  catalogOnlyQueryToken?: string;
  forceFreshTaxonomy?: boolean;
  /** The first unresolved options lookup reaches model-owned rediscovery. */
  transientOptionsUnavailable?: boolean;
}

async function runCase(
  userMessage: string,
  modelQuery: string,
  modelPublicText: string | null = null,
  options: CaseOptions = {},
): Promise<CaseResult> {
  Deno.env.get = offlineEnvGet;
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  const catalogProductUrls: string[] = [];
  const catalogProductReadsAfterOptions: boolean[] = [];
  let optionsDiscovered = false;
  let steps: CaseResult["steps"] = [];
  let modelCalls = 0;
  let directModelSearchCalls = 0;
  let modelDiscoveryCalls = 0;
  let jargonModelCalls = 0;
  const categoryName = options.categoryName ?? category;
  const leaves = options.fixtureLeaves ?? [
    options.liveAppearanceCategory ? "Круглые люстры" : "Люстры потолочные",
    "Люстры подвесные",
  ];
  const priorLog = {
    id: "offline-appearance-prior",
    session_id: sessionId,
    user_query: baseRequest,
    error: null,
    final_products_count: 1,
    created_at: new Date(Date.now() - 2_000).toISOString(),
    response_events: [
      {
        type: "products_block",
        count: 1,
        markdown: `- **[${round.pagetitle}](${round.url})**\n  Цена: 4 500 ₸`,
      },
      {
        type: "diagnostic",
        phase: "complete",
        log_id: "offline-appearance-prior",
        error: null,
        products_count: 1,
      },
      { type: "done" },
    ],
  };
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
            return json({ id: "offline-now" }, 201);
          }
          if (request.method === "PATCH") {
            steps = ((await request.json()) as { steps?: CaseResult["steps"] })
              .steps ?? [];
            return new Response(null, { status: 204 });
          }
          if (request.method === "GET") {
            if (url.searchParams.has("response_events")) return json(null);
            return json(options.freshSession ? [] : [priorLog]);
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
          return json(null);
        }
        if (request.method === "POST" && url.pathname.startsWith("/rest/v1/")) {
          return json({}, 201);
        }
      }
      if (url.origin === "https://fixture.catalog.invalid") {
        if (url.pathname === "/api/categories") {
          if (options.taxonomyUnavailable) {
            return json({ error: "offline" }, 503);
          }
          return json({
            data: {
              results: [{
                id: 1,
                pagetitle: categoryName,
                children: options.directModelSearch
                  ? leaves.map((pagetitle, index) => ({
                    id: index + 2,
                    pagetitle,
                    children: [],
                  }))
                  : [],
              }],
              pagination: { page: 1, per_page: 200, pages: 1, total: 1 },
            },
          });
        }
        if (url.pathname === "/api/categories/options") {
          if (
            options.transientOptionsUnavailable && modelDiscoveryCalls === 0
          ) {
            return json({ error: "temporarily missing category" }, 404);
          }
          if (options.taxonomyUnavailable) {
            return json({ error: "offline" }, 503);
          }
          optionsDiscovered = true;
          return json({
            data: {
              category: { id: 1, pagetitle: categoryName, total_products: 2 },
              options: [
                {
                  key: "shape",
                  caption_ru: "Форма люстры",
                  type: "string",
                  values: ["круг", "овал"].map((value_ru) => ({
                    value_ru,
                    products_count: 1,
                  })),
                },
                ...(!options.appearanceOnlyFacets
                  ? [
                    {
                      key: "protection",
                      caption_ru: "Степень защиты",
                      type: "string",
                      values: ["IP65", "IP44"].map((value_ru) => ({
                        value_ru,
                        products_count: 1,
                      })),
                    },
                    {
                      key: "temperature",
                      caption_ru: "Цветовая температура",
                      type: "string",
                      values: ["4000 K", "3000 K"].map((value_ru) => ({
                        value_ru,
                        products_count: 1,
                      })),
                    },
                  ]
                  : []),
                ...(options.includeAreaFacet
                  ? [{
                    key: "lighting_area",
                    caption_ru: "Максимальная площадь освещения, м2",
                    type: "number",
                    unit: "м²",
                    values: [{ value_ru: "35 м²", products_count: 2 }],
                  }]
                  : []),
              ],
            },
          });
        }
        if (url.pathname === "/api/products") {
          catalogProductUrls.push(url.toString());
          catalogProductReadsAfterOptions.push(optionsDiscovered);
          const matchedProducts = options.catalogOnlyQueryToken &&
              !(url.searchParams.get("query") ?? "").toLocaleLowerCase("ru-RU")
                .includes(
                  options.catalogOnlyQueryToken.toLocaleLowerCase("ru-RU"),
                )
            ? []
            : options.fixtureProducts ?? [round, oval];
          return json({
            data: {
              results: matchedProducts,
              pagination: { total: matchedProducts.length },
            },
          });
        }
      }
      if (url.toString() === "https://openrouter.ai/api/v1/chat/completions") {
        modelCalls++;
        const body = await request.json() as {
          tool_choice?: { function?: { name?: string } };
          tools?: Array<{ function?: { name?: string } }>;
          messages?: Array<{ content?: string }>;
        };
        if (
          options.jargonCandidates &&
          body.tool_choice?.function?.name === "propose_candidates"
        ) {
          jargonModelCalls++;
          return json({
            choices: [{
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [{
                  id: `appearance-jargon-${modelCalls}`,
                  type: "function",
                  function: {
                    name: "propose_candidates",
                    arguments: JSON.stringify({
                      candidates: options.jargonCandidates,
                    }),
                  },
                }],
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
                content: modelPublicText,
                tool_calls: [{
                  id: `appearance-declaration-${modelCalls}`,
                  type: "function",
                  function: {
                    name: "declare_selection_reasoning",
                    arguments: JSON.stringify({
                      reasoning: options.includeAreaFacet
                        ? "Для гостиной 30 м² проверяю максимальную площадь освещения каждого светильника: не менее 30 м². Ищу люстры по каталогу."
                        : options.directModelSearch
                        ? "Подбираю люстры по запросу клиента и проверяю наличие."
                        : `Подбираю ${modelQuery} для гостиной.`,
                      retrieval_query: options.directModelSearch
                        ? ""
                        : modelQuery,
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
        if (body.tool_choice?.function?.name === "discover_category") {
          modelDiscoveryCalls++;
          return json({
            choices: [{
              finish_reason: "tool_calls",
              message: {
                content: modelPublicText,
                tool_calls: [{
                  id: `appearance-rediscovery-${modelCalls}`,
                  type: "function",
                  function: {
                    name: "discover_category",
                    arguments: JSON.stringify({
                      noun: categoryName,
                      semantic_query: userMessage,
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
                  candidates: [{ pagetitle: categoryName, confidence: 0.99 }],
                }),
              },
            }],
          });
        }
        if (
          body.tools?.some(({ function: schema }) =>
            schema?.name === "search_catalog"
          )
        ) {
          directModelSearchCalls++;
          return json({
            choices: [{
              finish_reason: "tool_calls",
              message: {
                content: modelPublicText,
                tool_calls: [{
                  id: `appearance-search-${modelCalls}`,
                  type: "function",
                  function: {
                    name: "search_catalog",
                    arguments: JSON.stringify({
                      mode: options.modelMode ?? "by_query",
                      ...(options.modelMode === "by_pagetitle"
                        ? { pagetitle: modelQuery }
                        : options.modelMode === "by_article"
                        ? { article: options.modelArticle ?? modelQuery }
                        : options.modelMode === "by_filter"
                        ? {}
                        : { query: modelQuery }),
                      category: options.modelCategory ?? categoryName,
                      ...(options.modelAnchorLeafCategory
                        ? {
                          anchor_leaf_category: options.modelAnchorLeafCategory,
                        }
                        : {}),
                      ...(options.modelOptions
                        ? { options: options.modelOptions }
                        : {}),
                      ...(options.modelPage ? { page: options.modelPage } : {}),
                      ...(options.modelMinPrice !== undefined
                        ? { min_price: options.modelMinPrice }
                        : {}),
                      per_page: 50,
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
      throw new Error(`Unexpected outbound request: ${request.method} ${url}`);
    };
    if (options.transientOptionsUnavailable) {
      resetDiscoverCategoryCacheForTest();
    }
    if (options.forceFreshTaxonomy) {
      const seeded = await executeDiscoverCategory(
        { noun: categoryName },
        {
          baseUrl: "https://fixture.catalog.invalid/api",
          apiToken: "offline-catalog",
          openrouterApiKey: "offline-openrouter",
          forceFreshTaxonomy: true,
        },
      );
      assert(seeded.ok, JSON.stringify(seeded));
    }
    const response = await offlineHandler()(
      new Request(
        "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: userMessage,
            messageId: crypto.randomUUID(),
            sessionId,
            slots: {},
            history: options.freshSession ? [] : [
              { role: "user", content: baseRequest },
              {
                role: "assistant",
                content:
                  `- **[${round.pagetitle}](${round.url})**\n  Цена: 4 500 ₸`,
              },
            ],
          }),
        },
      ),
    );
    assertEquals(response.status, 200);
    const publicEvents = (await response.text()).split("\n\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
    return {
      catalogProductUrls,
      catalogProductReadsAfterOptions,
      directModelSearchCalls,
      modelDiscoveryCalls,
      jargonModelCalls,
      steps,
      publicEvents,
    };
  } finally {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
  }
}

Deno.test({
  name: "model-owned round chandelier query cannot narrow a round room request",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      for (
        const request of [
          "Форма зала круглая, нужна люстра для гостиной. Подбери варианты.",
          "Зал круглый. Нужна люстра.",
          "Не хочу люстру круглую. Покажи другие варианты.",
        ]
      ) {
        const result = await runCase(request, "круглую люстру");
        if (!request.startsWith("Не хочу")) {
          assert(
            result.catalogProductUrls.length > 0,
            JSON.stringify(result.steps),
          );
        }
        for (const rawUrl of result.catalogProductUrls) {
          const url = new URL(rawUrl);
          assert(
            !/кругл/iu.test(url.searchParams.get("query") ?? ""),
            JSON.stringify({
              rawUrl,
              afterOptions: result.catalogProductReadsAfterOptions,
              allProducts: result.catalogProductUrls,
              searches: result.steps.filter(({ step }) =>
                step === "v3_tool_call" ||
                /appearance|search_queued/iu.test(step ?? "")
              ),
            }),
          );
          assert(
            ![...url.searchParams.entries()].some(([key, value]) =>
              /shape/iu.test(key) && /круг/iu.test(value)
            ),
            rawUrl,
          );
        }
        assert(
          result.steps.some(({ step }) =>
            step === "v3_unowned_appearance_query_broadened" ||
            step === "v3_unowned_appearance_query_broadened_at_io" ||
            step === "v3_unowned_appearance_jargon_query_rejected_at_io"
          ),
          JSON.stringify(result.steps),
        );
        const blocks = result.publicEvents.flatMap((event) => {
          const block = event.v3_event as {
            type?: string;
            selection_contract?: {
              mandatory_criteria?: Array<{ key: string; value: string }>;
            };
          } | undefined;
          return block?.type === "products_block" ? [block] : [];
        });
        for (const block of blocks) {
          assert(
            !block.selection_contract?.mandatory_criteria?.some(({ key }) =>
              key === "shape" || key === "Форма люстры"
            ),
            JSON.stringify(block),
          );
        }
        assert(
          result.publicEvents.every((event) =>
            !/Подбираю\s+круглую\s+люстру/iu.test(JSON.stringify(event))
          ),
          JSON.stringify(result.publicEvents),
        );
      }
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});

Deno.test({
  name:
    "customer-owned appearance remains searchable; technical and jargon queries are unchanged",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const facet = {
        key: "shape",
        caption: "Форма люстры",
        values: [{ value: "круг" }, { value: "овал" }],
      };
      const explicit = await runCase(
        "Нужна круглая люстра для гостиной. Подбери варианты.",
        "круглую люстру",
      );
      assert(
        explicit.catalogProductUrls.length > 0,
        JSON.stringify(explicit.steps),
      );
      assert(
        !explicit.steps.some(({ step }) =>
          step === "v3_unowned_appearance_query_broadened" ||
          step === "v3_unowned_appearance_query_broadened_at_io"
        ),
        JSON.stringify(explicit.steps),
      );
      for (const query of ["кукуруза Korn", "кабель ВВГ 3×1,5", "IP65"]) {
        const guarded = guardSearchFilters(
          { mode: "by_query", query, category },
          [facet],
          "",
          "Нужна люстра",
          "",
          [],
          {
            currentUserMessage: "Нужна люстра",
            trustedActiveProductTarget: category,
          },
        );
        assertEquals(guarded.requiresBroadBrowse, false, query);
        assertEquals(guarded.args.query, query);
      }
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});

Deno.test({
  name: "model declaration with visible text cannot leak unowned round shape",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const result = await runCase(
        "Нужна люстра",
        "круглую люстру",
        "Подбираю круглую люстру. Проверяю наличие в каталоге.",
      );
      assert(
        result.steps.some(({ step }) =>
          step === "v3_derived_selection_reasoning_requested"
        ),
        JSON.stringify(result.steps),
      );
      assert(
        result.catalogProductUrls.length > 0,
        JSON.stringify(result.steps),
      );
      assert(
        result.catalogProductUrls.every((rawUrl) =>
          !/кругл/iu.test(new URL(rawUrl).searchParams.get("query") ?? "")
        ),
        JSON.stringify(result.catalogProductUrls),
      );
      assert(
        result.publicEvents.every((event) =>
          !/кругл(?:ую|ая|ой)\s+люстр/iu.test(JSON.stringify(event))
        ),
        JSON.stringify(result.publicEvents),
      );
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});

Deno.test({
  name:
    "unowned appearance does not erase customer IP65 at the live catalog boundary",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const result = await runCase(
        "Форма зала круглая, нужна люстра IP65 для гостиной.",
        "круглая люстра IP65",
      );
      assert(
        result.catalogProductUrls.length > 0,
        JSON.stringify(result.steps),
      );
      assert(
        result.catalogProductUrls.every((rawUrl) =>
          !/кругл/iu.test(new URL(rawUrl).searchParams.get("query") ?? "")
        ),
        JSON.stringify(result.catalogProductUrls),
      );
      assert(
        result.catalogProductUrls.some((rawUrl) =>
          new URL(rawUrl).searchParams.get("options[protection][]") === "IP65"
        ),
        JSON.stringify({
          urls: result.catalogProductUrls,
          steps: result.steps,
        }),
      );
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});

Deno.test({
  name:
    "direct model search tool-call with free prose is guarded at catalog I/O on page 2",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const result = await runCase(
        "Есть ли люстры?",
        "круглую люстру",
        "Подбираю круглую люстру для вашей комнаты. Проверяю наличие.",
        {
          directModelSearch: true,
          freshSession: true,
          modelPage: 2,
          modelMinPrice: 1000,
        },
      );
      assert(
        result.directModelSearchCalls > 0,
        JSON.stringify(result.steps),
      );
      assert(
        result.steps.some(({ step, meta }) =>
          step === "v3_unowned_appearance_query_broadened" &&
          meta?.source === "model_tool_call"
        ),
        JSON.stringify(result.steps),
      );
      assert(
        result.catalogProductUrls.length > 0 &&
          result.catalogProductReadsAfterOptions.every(Boolean),
        JSON.stringify(result),
      );
      for (const rawUrl of result.catalogProductUrls) {
        const url = new URL(rawUrl);
        assert(!/кругл/iu.test(url.searchParams.get("query") ?? ""), rawUrl);
        assert(
          ![...url.searchParams.entries()].some(([key, value]) =>
            /shape/iu.test(key) && /круг/iu.test(value)
          ),
          rawUrl,
        );
      }
      assert(
        result.catalogProductUrls.some((rawUrl) =>
          new URL(rawUrl).searchParams.get("page") === "2"
        ),
        JSON.stringify({
          urls: result.catalogProductUrls,
          steps: result.steps,
        }),
      );
      assert(
        result.catalogProductUrls.filter((rawUrl) =>
          new URL(rawUrl).searchParams.get("page") === "2"
        ).every((rawUrl) =>
          new URL(rawUrl).searchParams.get("min_price") !== "1000"
        ),
        JSON.stringify(result.catalogProductUrls),
      );
      assert(
        result.publicEvents.every((event) =>
          !/Подбираю круглую люстру/iu.test(JSON.stringify(event))
        ),
        JSON.stringify(result.publicEvents),
      );
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});

Deno.test({
  name: "appearance recovery keeps customer color temperature and budget",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const result = await runCase(
        "Форма зала круглая, нужна люстра 4000 K до 5000 тенге.",
        "круглая люстра 4000 K",
      );
      assert(
        result.catalogProductUrls.length > 0,
        JSON.stringify(result.steps),
      );
      assert(
        result.catalogProductUrls.some((rawUrl) => {
          const params = new URL(rawUrl).searchParams;
          return params.get("options[temperature][]") === "4000 K" &&
            params.get("max_price") === "5000";
        }),
        JSON.stringify({
          urls: result.catalogProductUrls,
          steps: result.steps,
        }),
      );
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});

Deno.test({
  name:
    "direct model category-only appearance is absent from catalog I/O and SSE",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const result = await runCase(
        "Есть ли люстры?",
        "люстра",
        "Показываю круглые люстры. Проверяю наличие.",
        {
          directModelSearch: true,
          freshSession: true,
          liveAppearanceCategory: true,
          modelCategory: "Круглые люстры",
        },
      );
      assert(result.directModelSearchCalls > 0, JSON.stringify(result.steps));
      assert(result.catalogProductUrls.length > 0, JSON.stringify(result));
      assert(
        result.catalogProductUrls.every((rawUrl) =>
          !/кругл/iu.test(new URL(rawUrl).searchParams.get("category") ?? "")
        ),
        JSON.stringify(result.catalogProductUrls),
      );
      assert(
        result.publicEvents.every((event) =>
          !/Показываю круглые люстры/iu.test(JSON.stringify(event))
        ),
        JSON.stringify(result.publicEvents),
      );
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});

Deno.test({
  name:
    "direct model pagetitle cannot turn an unrequested shape into exact SKU lookup",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const result = await runCase(
        "Есть ли люстры?",
        "Круглая люстра",
        "Проверяю круглую люстру по названию.",
        {
          directModelSearch: true,
          freshSession: true,
          modelMode: "by_pagetitle",
        },
      );
      assert(result.directModelSearchCalls > 0, JSON.stringify(result.steps));
      assert(
        result.steps.some(({ step, meta }) =>
          step === "v3_unowned_appearance_query_broadened_at_io" &&
          meta?.unowned_pagetitle === true
        ),
        JSON.stringify(result.steps),
      );
      assert(result.catalogProductUrls.length > 0, JSON.stringify(result));
      assert(
        result.catalogProductUrls.every((rawUrl) =>
          !/кругл/iu.test(new URL(rawUrl).searchParams.get("pagetitle") ?? "")
        ),
        JSON.stringify(result.catalogProductUrls),
      );
      assert(
        result.publicEvents.every((event) =>
          !/Проверяю круглую люстру/iu.test(JSON.stringify(event))
        ),
        JSON.stringify(result.publicEvents),
      );
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});

Deno.test({
  name: "direct by_query strips unowned shape option before catalog I/O",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const result = await runCase(
        "Есть ли люстры?",
        "люстра",
        "Ищу люстры. Проверяю наличие.",
        {
          directModelSearch: true,
          freshSession: true,
          modelOptions: { shape: ["круг"] },
        },
      );
      assert(result.directModelSearchCalls > 0, JSON.stringify(result.steps));
      assert(result.catalogProductUrls.length > 0, JSON.stringify(result));
      assert(
        result.catalogProductUrls.every((rawUrl) =>
          new URL(rawUrl).searchParams.get("options[shape][]") !== "круг"
        ),
        JSON.stringify(result.catalogProductUrls),
      );
      assert(
        result.steps.some(({ step }) =>
          step === "v3_unowned_appearance_options_removed_at_io"
        ),
        JSON.stringify(result.steps),
      );
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});

Deno.test({
  name:
    "direct model broadening preserves customer IP65, floor and page without a technical facet",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const result = await runCase(
        "Есть ли люстры IP65 от 1000 тенге?",
        "круглая люстра IP65",
        "Проверяю круглую люстру IP65.",
        {
          directModelSearch: true,
          freshSession: true,
          appearanceOnlyFacets: true,
          modelPage: 2,
          modelMinPrice: 1000,
        },
      );
      assert(result.directModelSearchCalls > 0, JSON.stringify(result.steps));
      assert(
        result.catalogProductUrls.some((rawUrl) => {
          const params = new URL(rawUrl).searchParams;
          return /IP65/iu.test(params.get("query") ?? "") &&
            !/кругл/iu.test(params.get("query") ?? "") &&
            params.get("page") === "2" &&
            params.get("min_price") === "1000";
        }),
        JSON.stringify({
          urls: result.catalogProductUrls,
          steps: result.steps,
        }),
      );
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});

Deno.test({
  name:
    "failed taxonomy never lets an unverified free search reach catalog I/O",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const result = await runCase(
        "Есть ли люстры?",
        "круглая люстра",
        "Проверяю круглую люстру.",
        {
          directModelSearch: true,
          freshSession: true,
          taxonomyUnavailable: true,
        },
      );
      assertEquals(result.catalogProductUrls, []);
      assert(
        result.publicEvents.every((event) =>
          !/Проверяю круглую люстру/iu.test(JSON.stringify(event))
        ),
        JSON.stringify(result.publicEvents),
      );
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});

Deno.test({
  name:
    "jargon helper's model-only appearance candidate never reaches products",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const result = await runCase(
        "Есть ли люстры?",
        "люстра",
        null,
        {
          directModelSearch: true,
          freshSession: true,
          jargonCandidates: ["круглая люстра"],
          catalogOnlyQueryToken: "круглая",
        },
      );
      assert(result.jargonModelCalls > 0, JSON.stringify(result.steps));
      assert(
        result.catalogProductUrls.every((rawUrl) =>
          !/кругл/iu.test(new URL(rawUrl).searchParams.get("query") ?? "")
        ),
        JSON.stringify({
          urls: result.catalogProductUrls,
          steps: result.steps,
        }),
      );
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});

Deno.test({
  name: "customer jargon кукуруза still reaches literal CORN title proof",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const product = {
        id: 3,
        pagetitle: "Лампа светодиодная CORN E27 20W",
        url: "https://220volt.kz/catalog/svetotexnika/lampy/corn-e27/",
        category: "Лампы светодиодные",
        leaf_category: "Лампы светодиодные",
        price: 3500,
        warehouses: [{ city: "Караганда", amount: 2 }],
        options: [],
      };
      const result = await runCase(
        "Есть ли лампы кукуруза?",
        "лампа кукуруза",
        null,
        {
          directModelSearch: true,
          freshSession: true,
          categoryName: "Лампы",
          fixtureLeaves: ["Лампы светодиодные", "Лампы накаливания"],
          fixtureProducts: [product],
          catalogOnlyQueryToken: "CORN",
          jargonCandidates: ["CORN"],
          forceFreshTaxonomy: true,
        },
      );
      assert(result.jargonModelCalls > 0, JSON.stringify(result.steps));
      assert(
        result.catalogProductUrls.some((rawUrl) =>
          /CORN/iu.test(new URL(rawUrl).searchParams.get("query") ?? "")
        ),
        JSON.stringify({
          urls: result.catalogProductUrls,
          steps: result.steps,
        }),
      );
      const productBlocks = result.publicEvents.flatMap((event) => {
        const block = event.v3_event as {
          type?: string;
          markdown?: string;
        } | undefined;
        return block?.type === "products_block" ? [block] : [];
      });
      assert(
        productBlocks.some((block) => /CORN/iu.test(block.markdown ?? "")),
        JSON.stringify(result.publicEvents),
      );
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});

Deno.test({
  name:
    "model-owned anchor leaf cannot silently inject an unrequested shape category",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const result = await runCase(
        "Есть ли люстры?",
        "люстра",
        "Проверяю люстры в каталоге.",
        {
          directModelSearch: true,
          freshSession: true,
          modelMode: "by_filter",
          modelCategory: "Люстры подвесные",
          modelAnchorLeafCategory: "Круглые люстры",
          liveAppearanceCategory: true,
          forceFreshTaxonomy: true,
        },
      );
      assert(result.directModelSearchCalls > 0, JSON.stringify(result.steps));
      assert(result.catalogProductUrls.length > 0, JSON.stringify(result));
      assert(
        result.catalogProductUrls.every((rawUrl) =>
          !/кругл/iu.test(new URL(rawUrl).searchParams.get("category") ?? "")
        ),
        JSON.stringify(result.catalogProductUrls),
      );
      assert(
        result.steps.some(({ step, meta }) =>
          step === "v3_unowned_appearance_query_broadened_at_io" &&
          meta?.unowned_category === true
        ),
        JSON.stringify(result.steps),
      );
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});

Deno.test({
  name: "appearance prose waits for live schema on first discovery",
  permissions: { read: true, env: false, net: false },
  fn() {
    assertEquals(
      shouldDeferAppearanceProseBeforeDiscovery("select", false, false),
      true,
    );
    assertEquals(
      shouldDeferAppearanceProseBeforeDiscovery("inquire", false, true),
      true,
    );
    assertEquals(
      shouldDeferAppearanceProseBeforeDiscovery("inquire", false, false),
      false,
    );
    assertEquals(
      shouldDeferAppearanceProseBeforeDiscovery("select", true, false),
      false,
    );
  },
});

Deno.test({
  name:
    "temporary discovery miss keeps model-owned room-area shape prose out of pre-discovery SSE",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const result = await runCase(
        "Нужна люстра для гостиной 30 квадратов. Покажи варианты.",
        "люстра",
        "Для гостиной 30 квадратов подбираю квадратную люстру. Проверяю каталог.",
        {
          directModelSearch: true,
          freshSession: true,
          transientOptionsUnavailable: true,
          includeAreaFacet: true,
          fixtureProducts: [round, oval].map((product) => ({
            ...product,
            options: [
              ...product.options,
              {
                key: "lighting_area",
                caption_ru: "Максимальная площадь освещения, м2",
                value_ru: "35 м²",
              },
            ],
          })),
        },
      );
      assertEquals(result.modelDiscoveryCalls, 1, JSON.stringify(result.steps));
      assert(
        result.steps.some(({ step, meta }) =>
          step === "v3_unverified_appearance_public_text_deferred" &&
          meta?.source === "taxonomy_pending"
        ),
        JSON.stringify(result.steps),
      );
      assert(
        result.steps.some(({ step, meta }) =>
          step === "v3_agent_phase_transition" &&
          meta?.from === "rediscover_after_failed_discovery" &&
          meta?.to === "search_after_discovery"
        ),
        JSON.stringify(result.steps),
      );
      assert(
        result.catalogProductUrls.length > 0 &&
          result.catalogProductReadsAfterOptions.every(Boolean),
        JSON.stringify(result),
      );
      assert(
        result.catalogProductUrls.every((rawUrl) =>
          !/квадрат/iu.test(new URL(rawUrl).searchParams.toString())
        ),
        JSON.stringify(result.catalogProductUrls),
      );
      assert(
        result.publicEvents.every((event) =>
          !/квадратн[а-я]*\s+люстр|форма\s+люстры\s*:\s*квадрат/iu.test(
            JSON.stringify(event),
          )
        ),
        JSON.stringify(result.publicEvents),
      );
    } finally {
      restoreOfflineModuleSetup();
      resetDiscoverCategoryCacheForTest();
    }
  },
});

Deno.test({
  name:
    "taxonomy outage accepts only exact customer articles, never model-only codes",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const invented = await runCase(
        "Есть ли люстры?",
        "ROUND-1",
        "Проверяю артикул ROUND-1.",
        {
          directModelSearch: true,
          freshSession: true,
          modelMode: "by_article",
          modelArticle: "ROUND-1",
          taxonomyUnavailable: true,
        },
      );
      assertEquals(invented.catalogProductUrls, []);
      assertEquals(
        customerOwnsExactCatalogArticle(
          "ROUND-1",
          "Есть ли люстра с артикулом ROUND-1?",
        ),
        true,
      );
      assertEquals(
        customerOwnsExactCatalogArticle("ROUND-1", "Есть ли люстры?"),
        false,
      );
      assertEquals(
        customerOwnsExactCatalogArticle(
          "ROUND-1",
          "Есть ли люстры?",
          "Хочу люстру ROUND-1",
        ),
        true,
      );
      assertEquals(
        customerOwnsExactCatalogArticle(
          "ROUND-1",
          "Есть ли люстра ROUND-123?",
        ),
        false,
      );
      assertEquals(
        exactCustomerIdentitySearchDuringTaxonomyOutage({
          mode: "by_article",
          article: "ROUND-1",
          category: "Круглые люстры",
          anchor_leaf_category: "Круглые люстры",
          options: { shape: ["круг"] },
          max_price: 100,
          page: 2,
        }, "Есть ли люстра с артикулом ROUND-1?"),
        { mode: "by_article", article: "ROUND-1" },
      );
      assertEquals(
        exactCustomerIdentitySearchDuringTaxonomyOutage({
          mode: "by_article",
          article: "ROUND-1",
          category: "Круглые люстры",
        }, "Есть ли люстры?"),
        null,
      );
      assertEquals(
        exactCustomerIdentitySearchDuringTaxonomyOutage({
          mode: "by_pagetitle",
          pagetitle: "Люстра модель ROUND-1",
          category_in: ["Круглые люстры"],
          options: { shape: ["круг"] },
        }, "Есть ли люстра модель ROUND-1?"),
        { mode: "by_pagetitle", pagetitle: "Люстра модель ROUND-1" },
      );
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});
