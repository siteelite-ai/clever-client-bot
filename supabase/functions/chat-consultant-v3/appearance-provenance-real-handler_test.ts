// A no-network HTTP/SSE proof that a model-owned appearance query cannot
// bypass the live facet guard after category discovery. The production handler
// and its actual search I/O boundary run; all external services are fixtures.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { guardSearchFilters } from "../_shared/v3-tools/search-filter-guard.ts";
import type { Criterion } from "../_shared/v3-tools/criteria-gate.ts";
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
  modelRequests: number;
  catalogProductUrls: string[];
  catalogProductReadsAfterOptions: boolean[];
  directModelSearchCalls: number;
  modelDiscoveryCalls: number;
  jargonModelCalls: number;
  steps: Array<{ step?: string; meta?: Record<string, unknown> }>;
  publicEvents: Array<Record<string, unknown>>;
}

interface CaseOptions {
  declarationReasoning?: string;
  /** Old SKU refresh must not gate a new search with changed conditions. */
  oldCardLookup?: "empty" | "unavailable" | "ambiguous";
  serverHistoryMissing?: boolean;
  priorRequest?: string;
  priorCriteria?: Criterion[];
  priorCard?: {pagetitle:string;url:string};
  serverRefinement?: {query:string;card:{pagetitle:string;url:string};criteria:Criterion[]};
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
  fixtureFacets?: Array<Record<string, unknown>>;
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
  const priorCard = options.priorCard ?? round;
  const leaves = options.fixtureLeaves ?? [
    options.liveAppearanceCategory ? "Круглые люстры" : "Люстры потолочные",
    "Люстры подвесные",
  ];
  const priorLog = {
    id: "offline-appearance-prior",
    session_id: sessionId,
    user_query: options.priorRequest ?? baseRequest,
    error: null,
    final_products_count: 1,
    created_at: new Date(Date.now() - 2_000).toISOString(),
    response_events: [
      {
        type: "products_block",
        count: 1,
        markdown: `- **[${priorCard.pagetitle}](${priorCard.url})**\n  Цена: 4 500 ₸`,
        ...(options.priorCriteria ? {
          selection_contract: { mandatory_criteria: options.priorCriteria },
        } : {}),
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
  const serverLogs=options.serverRefinement ? [{
    ...priorLog,id:"offline-appearance-refined",user_query:options.serverRefinement.query,
    created_at:new Date(Date.now()-1_000).toISOString(),
    response_events:[
      {type:"products_block",count:1,
        markdown:`- **[${options.serverRefinement.card.pagetitle}](${options.serverRefinement.card.url})**\n  Цена: 5 500 ₸`,
        selection_contract:{mandatory_criteria:options.serverRefinement.criteria}},
      {type:"diagnostic",phase:"complete",log_id:"offline-appearance-refined",error:null,products_count:1},
      {type:"done"},
    ],
    steps:[
      {step:"v3_conversation_boundary",meta:{mode:"continuation"}},
      {step:"v3_rendered_refinement_fresh_search_context",meta:{source:"completed_server_selection_conditions",
        base_log_id:priorLog.id,latest_card_log_id:priorLog.id,old_cards_rehydrated:false}},
    ],
  },priorLog] : [priorLog];
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
            return json(options.freshSession || options.serverHistoryMissing ? [] :
              url.searchParams.get("limit")==="1" ? serverLogs.slice(0,1) : serverLogs);
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
              options: options.fixtureFacets ?? [
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
          if (url.searchParams.has("pagetitle") && options.oldCardLookup) {
            if (options.oldCardLookup === "unavailable") return json({error:"unavailable"},503);
            const results = options.oldCardLookup === "empty" ? [] : [round,round];
            return json({data:{results,pagination:{total:results.length}}});
          }
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
                      reasoning: options.declarationReasoning ?? (options.includeAreaFacet
                        ? "Для гостиной 30 м² проверяю максимальную площадь освещения каждого светильника: не менее 30 м². Ищу люстры по каталогу."
                        : options.directModelSearch
                        ? "Подбираю люстры по запросу клиента и проверяю наличие."
                        : `Подбираю ${modelQuery} для гостиной.`),
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
              { role: "user", content: options.priorRequest ?? baseRequest },
              {
                role: "assistant",
                content:
                  `- **[${priorCard.pagetitle}](${priorCard.url})**\n  Цена: 4 500 ₸`,
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
      modelRequests: modelCalls,
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
  name: "changed conditions search fresh cards even when old SKU lookup is empty, unavailable or ambiguous",
  permissions: {read:true,env:false,net:false},
  async fn() {
    try {
      const candidate={...oval,id:3,price:5500,
        pagetitle:"Люстра для гостиной овальная белая IP65",
        url:"https://220volt.kz/catalog/lighting/chandeliers/fresh-oval/",
        options:[
          ...oval.options.map(option=>option.key==="protection" ? {...option,value_ru:"IP65"}:option),
          {key:"color",caption_ru:"Цвет корпуса",value_ru:"белый"},
        ]};
      const expensive={...candidate,id:4,price:6500,url:candidate.url+"expensive/"};
      const wrongIP={...candidate,id:5,url:candidate.url+"ip44/",
        options:candidate.options.map(o=>o.key==="protection"?{...o,value_ru:"IP44"}:o)};
      const wrongColor={...candidate,id:6,url:candidate.url+"black/",
        options:candidate.options.map(o=>o.key==="color"?{...o,value_ru:"черный"}:o)};
      const noStock={...candidate,id:7,url:candidate.url+"no-stock/",warehouses:[{city:"Караганда",amount:0}]};
      const restricted={...candidate,id:8,url:candidate.url+"restricted/",options:[...candidate.options,
        {key:"ogranichennyy_prosmotr",caption_ru:"Ограниченный просмотр",value_ru:"Да"}]};
      for(const mode of ["empty","unavailable","ambiguous"] as const) {
        const result=await runCase("А есть овальные? Бюджет до 6000 тенге","круглую люстру",null,{
          oldCardLookup:mode,
          priorRequest:"Нужна круглая белая люстра для гостиной IP65 в наличии, бюджет до 5000 тенге.",
          priorCriteria:[
            {key:"Форма люстры",op:"eq",value:"круг",level:"A",evidence:"user_explicit"},
            {key:"Степень защиты",op:"eq",value:"IP65",level:"A",evidence:"user_explicit"},
            {key:"Цвет корпуса",op:"eq",value:"белый",level:"A",evidence:"user_explicit"},
          ],
          fixtureFacets:[
            {key:"shape",caption_ru:"Форма люстры",type:"string",values:[{value_ru:"круг"},{value_ru:"овал"}]},
            {key:"protection",caption_ru:"Степень защиты",type:"string",values:[{value_ru:"IP65"},{value_ru:"IP44"}]},
            {key:"color",caption_ru:"Цвет корпуса",type:"string",values:[{value_ru:"белый"},{value_ru:"черный"}]},
          ],
          fixtureProducts:[round,candidate,expensive,wrongIP,wrongColor,noStock,restricted],
        });
        const trace=JSON.stringify({mode,steps:result.steps,events:result.publicEvents});
        assert(result.steps.some(({step})=>step==="v3_rendered_refinement_fresh_search_context"),trace);
        assert(!result.steps.some(({step})=>step==="v3_verified_rendered_scope_continuation"||step==="v3_recent_product_evidence_recovered"),trace);
        assert(result.catalogProductUrls.length>0,trace);
        assert(result.catalogProductUrls.every(u=>!new URL(u).searchParams.has("pagetitle")),trace);
        const state=result.steps.find(({step})=>step==="v3_dialogue_selection_state_compiled")?.meta?.active_criteria as Criterion[];
        for(const value of ["овал","IP65","белый",6000]) assert(state?.some(c=>c.value===value),trace);
        assert(!state.some(c=>c.value==="круг"||c.value===5000),trace);
        const blocks=result.publicEvents.map(e=>e.v3_event as Record<string,unknown>).filter(e=>e?.type==="products_block");
        const rendered=blocks.map(b=>b.markdown).join("\n");
        assert(rendered.includes(candidate.url),trace);
        for(const p of [round,expensive,wrongIP,wrongColor,noStock,restricted]) assert(!rendered.includes(`](${p.url})`),trace);
      }
    } finally {restoreOfflineModuleSetup();}
  },
});

Deno.test({
  name: "without a catalog shape axis the current text axis replaces old geometry and verifies every fresh card",
  permissions: {read:true,env:false,net:false},
  async fn() {
    try {
      resetDiscoverCategoryCacheForTest();
      const fresh={...round,id:3,category:"Светильники",price:5500,
        pagetitle:"Светильник овальный белый IP65",
        url:"https://220volt.kz/catalog/lighting/luminaires/new-oval/",
        options:[
          {key:"protection",caption_ru:"Степень защиты",value_ru:"IP65"},
          {key:"color",caption_ru:"Цвет корпуса",value_ru:"белый"},
        ]};
      const oldShape={...fresh,id:4,pagetitle:"Светильник круглый белый IP65",url:fresh.url+"round/"};
      const overBudget={...fresh,id:5,price:6500,url:fresh.url+"expensive/"};
      const missingShape={...fresh,id:6,pagetitle:"Светильник ABC белый IP65",url:fresh.url+"unknown/"};
      const conflictingShape={...fresh,id:7,url:fresh.url+"conflict/",options:[...fresh.options,
        {key:"body_shape",caption_ru:"Форма корпуса",value_ru:"круглая"}]};
      const wrongIP={...fresh,id:8,url:fresh.url+"ip44/",options:fresh.options.map(o=>o.key==="protection"?{...o,value_ru:"IP44"}:o)};
      const wrongColor={...fresh,id:9,url:fresh.url+"black/",options:fresh.options.map(o=>o.key==="color"?{...o,value_ru:"черный"}:o)};
      const noStock={...fresh,id:10,url:fresh.url+"no-stock/",warehouses:[{city:"Караганда",amount:0}]};
      const restricted={...fresh,id:11,url:fresh.url+"restricted/",options:[...fresh.options,
        {key:"ogranichennyy_prosmotr",caption_ru:"Ограниченный просмотр",value_ru:"Да"}]};
      const result=await runCase("А есть овальные? Бюджет до 6000 тенге","круглые светильники",null,{
        categoryName:"Светильники",oldCardLookup:"unavailable",forceFreshTaxonomy:true,
        priorRequest:"Покажи круглые белые светильники с защитой IP65 в наличии, бюджет до 5000 тенге.",
        priorCard:{pagetitle:"Светильник IP65  D140*48 круглый",url:"https://220volt.kz/catalog/lighting/luminaires/old/"},
        priorCriteria:[
          {key:"Цвет корпуса",op:"eq",value:"белый",level:"A",evidence:"user_explicit"},
          {key:"Степень защиты",op:"eq",value:"IP65",level:"A",evidence:"user_explicit"},
        ],
        fixtureFacets:[
          {key:"color",caption_ru:"Цвет корпуса",type:"string",values:[{value_ru:"белый"}]},
          {key:"protection",caption_ru:"Степень защиты",type:"string",values:[{value_ru:"IP65"}]},
        ],
        fixtureProducts:[oldShape,missingShape,conflictingShape,overBudget,wrongIP,wrongColor,noStock,restricted,fresh],
      });
      const trace=JSON.stringify(result);
      assert(result.steps.some(({step})=>step==="v3_rendered_refinement_fresh_search_context"),trace);
      assert(result.catalogProductUrls.length>0,trace);
      assert(result.catalogProductUrls.every(u=>!new URL(u).searchParams.has("pagetitle")),trace);
      const blocks=result.publicEvents.map(e=>e.v3_event as Record<string,unknown>).filter(e=>e?.type==="products_block");
      const rendered=blocks.map(b=>b.markdown).join("\n");
      assert(rendered.includes(`](${fresh.url})`),trace);
      for(const p of [oldShape,missingShape,conflictingShape,overBudget,wrongIP,wrongColor,noStock,restricted])
        assert(!rendered.includes(`](${p.url})`),trace);
      const shape=result.steps.find(({step})=>step==="v3_textual_selection_contract_compiled")?.meta;
      assertEquals(shape?.allowed,["oval"],trace);
      assertEquals(shape?.catalog_filter,false,trace);
      assert(result.catalogProductUrls.every(raw=>![...new URL(raw).searchParams.keys()].some(k=>/shape|форма/iu.test(k))),trace);
      const contract=blocks[0]?.selection_contract as Record<string,unknown>;
      const visible=contract?.visible_requirements as Array<Record<string,unknown>>;
      assert(visible?.some(r=>r.kind==="textual_characteristic"&&r.value==="oval"),trace);
      assert(!visible?.some(r=>r.kind==="literal_modifier"&&/круг/iu.test(String(r.label))),trace);
    } finally {
      resetDiscoverCategoryCacheForTest();
      restoreOfflineModuleSetup();
    }
  },
});

Deno.test({
  name: "a third color turn keeps the certified text shape and budget without reloading either old SKU",
  permissions: {read:true,env:false,net:false},
  async fn() {
    try {
      resetDiscoverCategoryCacheForTest();
      const product={...round,id:3,category:"Светильники",price:5500,
        pagetitle:"Светильник овальный черный IP65",url:"https://220volt.kz/catalog/lighting/luminaires/oval-black/",
        options:[{key:"color",caption_ru:"Цвет корпуса",value_ru:"черный"},
          {key:"protection",caption_ru:"Степень защиты",value_ru:"IP65"}]};
      const oldShape={...product,id:4,pagetitle:"Светильник круглый черный IP65",url:product.url+"round/"};
      const oldColor={...product,id:5,pagetitle:"Светильник овальный белый IP65",url:product.url+"white/",
        options:product.options.map(o=>o.key==="color"?{...o,value_ru:"белый"}:o)};
      const result=await runCase("А есть черные?","круглые светильники",null,{
        categoryName:"Светильники",oldCardLookup:"unavailable",forceFreshTaxonomy:true,
        priorRequest:"Покажи круглые белые светильники IP65 в наличии, бюджет до 5000 тенге.",
        serverRefinement:{query:"А есть овальные? Бюджет до 6000 тенге",card:oldColor,
          criteria:[{key:"Цвет корпуса",op:"eq",value:"белый",level:"A",evidence:"user_explicit"},
            {key:"Степень защиты",op:"eq",value:"IP65",level:"A",evidence:"user_explicit"}]},
        fixtureFacets:[{key:"color",caption_ru:"Цвет корпуса",type:"string",values:[{value_ru:"белый"},{value_ru:"черный"}]},
          {key:"protection",caption_ru:"Степень защиты",type:"string",values:[{value_ru:"IP65"}]}],
        fixtureProducts:[oldShape,oldColor,product],
      });
      const trace=JSON.stringify(result);
      const state=result.steps.find(({step})=>step==="v3_dialogue_selection_state_compiled")?.meta?.active_criteria as Criterion[];
      assert(state?.some(c=>c.value===6000),trace);
      assert(state.some(c=>c.value==="черный"),trace);
      assert(!state.some(c=>c.value==="белый"||c.value===5000),trace);
      assert(result.catalogProductUrls.every(u=>!new URL(u).searchParams.has("pagetitle")),trace);
      const rendered=result.publicEvents.map(e=>e.v3_event as Record<string,unknown>).filter(e=>e?.type==="products_block").map(b=>b.markdown).join("\n");
      assert(rendered.includes(`](${product.url})`),trace);
      assert(!rendered.includes(`](${oldShape.url})`)&&!rendered.includes(`](${oldColor.url})`),trace);
    } finally {resetDiscoverCategoryCacheForTest();restoreOfflineModuleSetup();}
  },
});

Deno.test({
  name: "a text-only shape with no proven candidate never disappears at the final card gate",
  permissions: {read:true,env:false,net:false},
  async fn() {
    try {
      resetDiscoverCategoryCacheForTest();
      const result=await runCase("А есть овальные? Бюджет до 6000 тенге","светильники",null,{
        categoryName:"Светильники",forceFreshTaxonomy:true,oldCardLookup:"empty",
        priorRequest:"Покажи круглые белые светильники IP65 в наличии, до 5000 тенге.",
        priorCriteria:[{key:"Цвет корпуса",op:"eq",value:"белый",level:"A",evidence:"user_explicit"},
          {key:"Степень защиты",op:"eq",value:"IP65",level:"A",evidence:"user_explicit"}],
        fixtureFacets:[{key:"color",caption_ru:"Цвет корпуса",type:"string",values:[{value_ru:"белый"}]},
          {key:"protection",caption_ru:"Степень защиты",type:"string",values:[{value_ru:"IP65"}]}],
        fixtureProducts:[{...round,pagetitle:"Светильник ABC белый IP65",category:"Светильники",
          options:[{key:"color",caption_ru:"Цвет корпуса",value_ru:"белый"},
            {key:"protection",caption_ru:"Степень защиты",value_ru:"IP65"}]}],
      });
      const trace=JSON.stringify(result);
      assert(result.catalogProductUrls.length>0,trace);
      assert(result.steps.some(({step,meta})=>step==="v3_textual_selection_contract_compiled"&&JSON.stringify(meta?.allowed)==='["oval"]'),trace);
      assert(!result.publicEvents.some(e=>(e.v3_event as Record<string,unknown>)?.type==="products_block"),trace);
    } finally {resetDiscoverCategoryCacheForTest();restoreOfflineModuleSetup();}
  },
});

Deno.test({
  name: "questions about old cards still fail closed when the old SKU cannot be refreshed",
  permissions: {read:true,env:false,net:false},
  async fn() {
    try {
      for(const message of ["Покажи их","Какая из них самая дешёвая?","Какие остатки у этих товаров?"]) {
        const result=await runCase(message,"люстры",null,{oldCardLookup:"empty"});
        const trace=JSON.stringify(result);
        assertEquals(result.modelRequests,0,trace);
        assert(result.steps.some(({step})=>step==="v3_recent_product_evidence_unavailable"),trace);
        assert(!result.steps.some(({step})=>step==="v3_rendered_refinement_fresh_search_context"),trace);
        assert(!result.publicEvents.some(e=>(e.v3_event as Record<string,unknown>)?.type==="products_block"),trace);
      }
    } finally {restoreOfflineModuleSetup();}
  },
});

Deno.test({
  name: "compound refinement preserves verified context, replaces shape/budget and applies independent new fields",
  permissions: {read:true,env:false,net:false},
  async fn() {
    try {
      const candidate={...oval,id:3,price:5500,
        pagetitle:"Люстра для гостиной овальная IP65 4000K",
        url:"https://220volt.kz/catalog/lighting/chandeliers/oval-ip65-4000/",
        options:oval.options.map(option=> option.key==="protection" ? {...option,value_ru:"IP65"} :
          option.key==="temperature" ? {...option,value_ru:"4000 K"} : option)};
      const expensive={...candidate,id:4,price:6500,url:"https://220volt.kz/catalog/lighting/chandeliers/expensive-oval/"};
      const wrongTemperature={...candidate,id:5,pagetitle:"Люстра для гостиной овальная IP65 3000K",
        url:"https://220volt.kz/catalog/lighting/chandeliers/oval-warm/",
        options:candidate.options.map(option=>option.key==="temperature" ? {...option,value_ru:"3000 K"}:option)};
      for(const withTemperature of [false,true]) {
      const result=await runCase(withTemperature
        ? "А есть овальные? Цветовая температура: 4000 K; Бюджет до 6000 тенге."
        : "А есть овальные? Бюджет до 6000 тенге.","круглую люстру",null,{
        priorRequest:"Нужна круглая люстра для гостиной со степенью защиты IP65 до 5000 тенге.",
        priorCriteria:[
          {key:"Форма люстры",op:"eq",value:"круг",level:"A",evidence:"user_explicit"},
          {key:"Степень защиты",op:"eq",value:"IP65",level:"A",evidence:"user_explicit"},
          {key:"Цена",op:"max",value:5000,level:"A",evidence:"user_explicit"},
        ],
        fixtureProducts:[round,oval,candidate,expensive,wrongTemperature],
      });
      const diagnostic=JSON.stringify({steps:result.steps,events:result.publicEvents});
      assert(result.steps.some(({step})=>step==="v3_compound_selection_refinement_bound"),diagnostic);
      const state=result.steps.find(({step})=>step==="v3_dialogue_selection_state_compiled")?.meta?.active_criteria as Criterion[];
      assert(state?.some(c=>c.value==="овал"),diagnostic);
      assert(state.some(c=>c.value==="IP65"),diagnostic);
      if(withTemperature) assert(state.some(c=>/температур/iu.test(c.key)&&Number.parseFloat(String(c.value))===4000),diagnostic);
      assert(state.some(c=>c.key==="Цена"&&c.value===6000),diagnostic);
      assert(!state.some(c=>c.value==="круг"||c.value===5000),diagnostic);
      const blocks=result.publicEvents.map(event=>event.v3_event as Record<string,unknown>)
        .filter(event=>event?.type==="products_block");
      assert(blocks.length>0,diagnostic);
      const rendered=blocks.map(block=>block.markdown).join("\n");
      assert(rendered.includes(candidate.url),diagnostic);
      for(const decoy of [round,oval,expensive,...(withTemperature ? [wrongTemperature]:[])]) assert(!rendered.includes(decoy.url),diagnostic);
      }
    } finally {restoreOfflineModuleSetup();}
  },
});

Deno.test({
  name:"compound refinement cannot inherit a fabricated or absent browser selection",
  permissions:{read:true,env:false,net:false},
  async fn() {
    try {
      for(const options of [{freshSession:true},{serverHistoryMissing:true}]) {
        const result=await runCase("А есть овальные? Бюджет до 6000 тенге.","люстры",null,options);
        assertEquals(result.modelRequests,0,JSON.stringify(result.steps));
        assertEquals(result.catalogProductUrls,[],JSON.stringify(result.steps));
        assert(result.steps.some(({step})=>step==="v3_compound_selection_context_unproven"),JSON.stringify(result.steps));
        assert(!result.publicEvents.some(event=>(event.v3_event as Record<string,unknown>)?.type==="products_block"));
      }
    } finally {restoreOfflineModuleSetup();}
  },
});

Deno.test({
  name:"compound refinement does not carry old conditions into a second independent task",
  permissions:{read:true,env:false,net:false},
  async fn() {
    try {
      for(const message of ["А есть овальные? Ещё нужен кабель.","Покажи такие же, но белые. Ещё нужен кабель."]) {
        const result=await runCase(message,"кабель",null,{
          priorRequest:"Нужна круглая люстра для гостиной IP65 до 4000 тенге.",
          priorCriteria:[{key:"Степень защиты",op:"eq",value:"IP65",level:"A",evidence:"user_explicit"}],
        });
        const trace=JSON.stringify(result.steps);
        assert(result.steps.some(({step,meta})=>step==="v3_conversation_boundary"&&meta?.mode==="new_task"),trace);
        assert(!result.steps.some(({step})=>step==="v3_compound_selection_refinement_bound"),trace);
        assert(!result.steps.some(({step})=>step==="v3_verified_rendered_scope_continuation"),trace);
        for(const {meta} of result.steps.filter(({step})=>step==="v3_dialogue_selection_state_compiled")) {
          assertEquals(meta?.prior_turns,0,trace);
          assertEquals(meta?.restored_contract_criteria,0,trace);
          assert(!(meta?.active_criteria as Criterion[]).some(c=>c.value==="IP65"||c.value===4000),trace);
        }
      }
    } finally {restoreOfflineModuleSetup();}
  },
});

Deno.test({
  name: "dialogue replacement reaches search and card gate without reviving the old axis",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const newOval = {
        ...oval, id: 3,
        pagetitle: "Люстра для гостиной овальная IP65",
        url: "https://220volt.kz/catalog/lighting/chandeliers/oval-ip65/",
        options: oval.options.map(option => option.key === "protection"
          ? { ...option, value_ru: "IP65" } : option),
      };
      const result = await runCase("А есть овальные?", "круглую люстру", null, {
        priorRequest: "Нужна круглая люстра для гостиной со степенью защиты IP65.",
        priorCriteria: [
          { key: "Форма люстры", op: "eq", value: "круг", level: "A", evidence: "user_explicit" },
          { key: "Степень защиты", op: "eq", value: "IP65", level: "A", evidence: "user_explicit" },
        ],
        fixtureProducts: [round, oval, newOval],
      });
      const state = result.steps.find(({step}) => step === "v3_dialogue_selection_state_compiled");
      assert(state, JSON.stringify(result.steps));
      assertEquals((state.meta?.active_criteria as Criterion[]).some(c => c.value === "круг"), false, JSON.stringify(state));
      assert((state.meta?.active_criteria as Criterion[]).some(c => c.value === "овал"));
      assert((state.meta?.active_criteria as Criterion[]).some(c => c.value === "IP65"));
      assert(result.catalogProductUrls.length > 0, JSON.stringify(result.steps));
      for (const raw of result.catalogProductUrls) {
        const url = new URL(raw);
        assert(![...url.searchParams.entries()].some(([key,value]) => /shape/.test(key) && /круг/.test(value)), raw);
      }
      const blocks = result.publicEvents.map(event => event.v3_event as Record<string,unknown>)
        .filter(event => event?.type === "products_block");
      assert(blocks.length > 0, JSON.stringify({events:result.publicEvents,steps:result.steps}));
      const rendered = blocks.map(block => block.markdown).join("\n");
      assert(rendered.includes(newOval.url), rendered);
      assert(!rendered.includes(round.url), rendered);
      assert(!rendered.includes(oval.url), rendered);
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});

Deno.test({
  name: "more options preserves prior server constraints even when model omits them",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const nextRound = {...round, id: 3,
        pagetitle:"Люстра для гостиной круглая IP65 новая",
        url:"https://220volt.kz/catalog/lighting/chandeliers/round-new/"};
      const result = await runCase("А есть другие варианты?", "люстры", null, {
        priorRequest:"Нужна круглая люстра для гостиной IP65",
        priorCriteria:[
          {key:"Форма люстры",op:"eq",value:"круг",level:"A",evidence:"user_explicit"},
          {key:"Степень защиты",op:"eq",value:"IP65",level:"A",evidence:"user_explicit"},
        ],
        fixtureProducts:[round,oval,nextRound],
      });
      const state=result.steps.find(({step})=>step==="v3_dialogue_selection_state_compiled");
      assert(state,JSON.stringify(result.steps));
      assertEquals((state.meta?.active_criteria as Criterion[]).map(c=>c.value).sort(),["IP65","круг"]);
      const blocks=result.publicEvents.map(event=>event.v3_event as Record<string,unknown>)
        .filter(event=>event?.type==="products_block");
      assert(blocks.length>0,JSON.stringify({events:result.publicEvents,steps:result.steps}));
      const rendered=blocks.map(block=>block.markdown).join("\n");
      assert(rendered.includes(nextRound.url),rendered);
      assert(!rendered.includes(oval.url),rendered);
      assert(!rendered.includes(round.url),rendered);
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});

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
  name: "exact silver refinement preserves mains socket purpose, mount and color through catalog I/O and final cards",
  permissions: {read:true,env:false,net:false},
  async fn() {
    try {
      resetDiscoverCategoryCacheForTest();
      const make = (id:number,color:string,mount="скрытый") => ({
        id,category:"Розетки",pagetitle:`Розетка ${id}`,price:1000,
        url:`https://220volt.kz/catalog/electrics/sockets/exact-enum-${id}/`,
        warehouses:[{city:"Караганда",amount:2}],
        options:[{key:"color",caption_ru:"Цвет",value_ru:color},
          {key:"mount",caption_ru:"Тип монтажа",value_ru:mount}],
      });
      const good=make(101,"серебристый");
      const decoys=[make(102,"серый"),make(103,"черный с серебром"),make(104,"черный"),make(105,"серебристый","открытый"),
        {...make(106,"серебристый"),pagetitle:"Розетка Ethernet RJ-45 /W1181006 (серебряный)"},
        {...make(107,"серебристый"),pagetitle:"Розетка TV серебристая"},
        {...make(108,"серебристый"),options:[...make(108,"серебристый").options,{key:"type",caption_ru:"Тип",value_ru:"компьютерная"}]}];
      const result=await runCase("А есть серебристые?","розетки",null,{
        categoryName:"Розетки",forceFreshTaxonomy:true,directModelSearch:true,
        declarationReasoning:"Ищу розетки скрытого монтажа серебристого цвета.",
        priorRequest:"Есть ли у вас розетки скрытого монтажа черного цвета?",
        priorCard:{pagetitle:"Розетка черная",url:"https://220volt.kz/catalog/electrics/sockets/black/"},
        priorCriteria:[{key:"Цвет",op:"eq",value:"черный",level:"A",evidence:"user_explicit"},
          {key:"Тип монтажа",op:"eq",value:"скрытый",level:"A",evidence:"user_explicit"}],
        fixtureLeaves:["Розетки электрические"],
        fixtureFacets:[{key:"color",caption_ru:"Цвет",type:"string",
          values:["серый","серебристый","серебряный рифленый","черный с серебром","черный"].map(value_ru=>({value_ru}))},
          {key:"mount",caption_ru:"Тип монтажа",type:"string",values:[{value_ru:"скрытый"},{value_ru:"открытый"}]}],
        // Deliberately ignore API filters: final card checks must reject decoys independently.
        fixtureProducts:[...decoys,good],
      });
      const trace=JSON.stringify(result);
      assert(result.catalogProductUrls.length>0,trace);
      for(const url of result.catalogProductUrls) {
        const colors=[...new URL(url).searchParams].filter(([key])=>key.includes("[color]")).map(([,value])=>value);
        assertEquals(colors,["серебристый"],trace);
      }
      const blocks=result.publicEvents.map(e=>e.v3_event as Record<string,unknown>).filter(e=>e?.type==="products_block");
      const rendered=blocks.map(b=>b.markdown).join("\n");
      assert(rendered.includes(good.url),trace);
      for(const p of decoys) assert(!rendered.includes(`](${p.url})`),trace);
      for(const block of blocks) {
        const contract=block.selection_contract as {mandatory_criteria:Criterion[]};
        assertEquals(contract.mandatory_criteria.filter(c=>c.key==="Цвет").map(c=>c.value),["серебристый"],trace);
      }
    } finally {resetDiscoverCategoryCacheForTest();restoreOfflineModuleSetup();}
  },
});

Deno.test({
  name: "socket function is customer-owned: fresh mains and explicit RJ45 requests do not share final cards",
  permissions: {read:true,env:false,net:false},
  async fn() {
    try {
      const make=(id:number,pagetitle:string)=>({id,pagetitle,category:"Розетки",price:1000,
        url:`https://220volt.kz/catalog/electrics/sockets/function-${id}/`,
        warehouses:[{city:"Караганда",amount:2}],options:[{key:"color",caption_ru:"Цвет",value_ru:"серебристый"}]});
      const mains=make(301,"Розетка с заземлением");
      const data=make(302,"Розетка RJ45");
      const tv=make(303,"Розетка TV");
      for (const scenario of [
        {query:"Покажи серебристые розетки",reasoning:"Подбираю серебристые розетки по каталогу.",good:mains,bad:[data,tv]},
        {query:"Покажи серебристые розетки RJ45",reasoning:"Подбираю серебристые розетки RJ45 по каталогу.",good:data,bad:[mains,tv]},
      ]) {
        resetDiscoverCategoryCacheForTest();
        const result=await runCase(scenario.query,"розетки",null,{
          freshSession:true,categoryName:"Розетки",forceFreshTaxonomy:true,directModelSearch:true,
          declarationReasoning:scenario.reasoning,fixtureLeaves:["Розетки электрические","Розетки информационные"],
          fixtureFacets:[{key:"color",caption_ru:"Цвет",type:"string",values:[{value_ru:"серебристый"}]}],
          fixtureProducts:[mains,data,tv],
        });
        const trace=JSON.stringify(result);
        assert(result.catalogProductUrls.length>0,trace);
        const blocks=result.publicEvents.map(e=>e.v3_event as Record<string,unknown>).filter(e=>e?.type==="products_block");
        const rendered=blocks.map(b=>b.markdown).join("\n");
        assert(rendered.includes(scenario.good.url),trace);
        for(const p of scenario.bad) assert(!rendered.includes(`](${p.url})`),trace);
        assert(result.steps.some(({step,meta})=>step==="v3_socket_function_contract_compiled" &&
          (meta?.functions as string[])?.includes(scenario.good===mains ? "mains" : "data")),trace);
      }
    } finally {resetDiscoverCategoryCacheForTest();restoreOfflineModuleSetup();}
  },
});

Deno.test({
  name: "multiword color refinement restores the completed Gallant double selection through search and rendering",
  permissions: {read:true,env:false,net:false},
  async fn() {
    try {
      resetDiscoverCategoryCacheForTest();
      const make=(id:number,series:string,count:string,color:string)=>({
        id,category:"Розетки",pagetitle:`Розетка ${count==="2"?"двойная":"одинарная"} ${series} ${id}`,
        price:1000,url:`https://220volt.kz/catalog/electrics/sockets/ivory-${id}/`,warehouses:[{city:"Караганда",amount:2}],
        options:[{key:"series",caption_ru:"Коллекция",value_ru:series},
          {key:"count",caption_ru:"Количество разъемов",value_ru:count},
          {key:"color",caption_ru:"Цвет",value_ru:color}],
      });
      const good=make(201,"Gallant","2","слоновая кость");
      const decoys=[make(202,"Gallant","1","слоновая кость"),make(203,"Другой","2","слоновая кость"),
        make(204,"Gallant","2","белый")];
      const series:Criterion={key:"Коллекция",op:"eq",value:"Gallant",level:"A",evidence:"user_explicit"};
      const result=await runCase("Мне нужен цвет слоновой кости","розетки",null,{
        categoryName:"Розетки",forceFreshTaxonomy:true,directModelSearch:true,
        declarationReasoning:"Подбираю двойные розетки Gallant цвета слоновой кости.",
        priorRequest:"Покажи розетки Gallant",
        priorCard:{pagetitle:"Розетка Gallant",url:"https://220volt.kz/catalog/electrics/sockets/gallant/"},priorCriteria:[series],
        serverRefinement:{query:"Нужны двойные",criteria:[series],card:{
          pagetitle:"Розетка двойная Gallant",url:"https://220volt.kz/catalog/electrics/sockets/gallant-double/"}},
        fixtureLeaves:["Розетки электрические"],
        fixtureFacets:[{key:"series",caption_ru:"Коллекция",type:"string",values:[{value_ru:"Gallant"},{value_ru:"Другой"}]},
          {key:"count",caption_ru:"Количество разъемов",type:"string",values:[{value_ru:"1"},{value_ru:"2"}]},
          {key:"color",caption_ru:"Цвет",type:"string",values:[{value_ru:"белый"},{value_ru:"слоновая кость"}]}],
        fixtureProducts:[...decoys,good],
      });
      const trace=JSON.stringify(result);
      assert(!result.publicEvents.some(e=>(e.v3_event as Record<string,unknown>)?.type==="conversation_boundary"),trace);
      assert(result.steps.some(({step})=>step==="v3_rendered_refinement_fresh_search_context"),trace);
      const state=result.steps.find(({step})=>step==="v3_dialogue_selection_state_compiled")?.meta?.active_criteria as Criterion[];
      for(const value of ["Gallant","слоновая кость"]) assert(state?.some(c=>c.value===value),trace);
      assert(result.catalogProductUrls.length>0,trace);
      for(const raw of result.catalogProductUrls) {
        const params=new URL(raw).searchParams;
        assertEquals(params.getAll("options[series][]"),["Gallant"],trace);
        assertEquals(params.getAll("options[color][]"),["слоновая кость"],trace);
      }
      const rendered=result.publicEvents.map(e=>e.v3_event as Record<string,unknown>)
        .filter(e=>e?.type==="products_block").map(e=>e.markdown).join("\n");
      assert(rendered.includes(good.url),trace);
      for(const p of decoys) assert(!rendered.includes(`](${p.url})`),trace);
      const contract=(result.publicEvents.map(e=>e.v3_event as Record<string,unknown>)
        .find(e=>e?.type==="products_block")?.selection_contract) as {visible_requirements:Array<{kind:string;value:unknown}>};
      assert(contract.visible_requirements.some(r=>r.kind==="count" && r.value===2),trace);
    } finally {resetDiscoverCategoryCacheForTest();restoreOfflineModuleSetup();}
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
