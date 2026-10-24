// Four actual consecutive HTTP/SSE turns through the production handler.
// PostgREST persists the handler's own terminal response_events between turns;
// the catalog and provider are deterministic fixtures, with no external I/O.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  offlineHandler,
  restoreOfflineModuleSetup,
} from "./model-no-search-integration-fixture.ts";
import { latestRenderedSelectionRequest } from "../_shared/v3-tools/recent-product-evidence.ts";
import { resolveServerRenderedSelectionProof } from "../_shared/v3-tools/server-rendered-continuation.ts";
import "./index.ts";

const offlineEnvGet = Deno.env.get;
const sessionId = "77777777-7777-4777-8777-777777777777";
const category = "Люстры";
const messages = [
  "хочу поменять дома люстру в зале 30 квадратов. Что предложишь из современного?",
  "Они точно подходят для освещения 30 квадратных метров?",
  "Почему варианты отличаются по цене? Сравни подтверждённые характеристики.",
  "А есть другие варианты?",
];
const changedAreaFollowUp =
  "А есть другие люстры с площадью освещения не менее 50 м²?";

type Event = Record<string, unknown>;
type Step = { step?: string; meta?: Record<string, unknown> };
type Log = {
  id: string;
  session_id: string;
  user_query: string;
  error: string | null;
  created_at: string;
  final_products_count: number;
  response_events: Event[];
  steps: Step[];
};
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
  shape: string,
  destination = "для гостиной",
  area = 35,
): Product {
  return {
    id,
    pagetitle: destination === "для офиса"
      ? `Люстра светодиодная офисная Модель ${id}`
      : `Люстра светодиодная для гостиной Модель ${id}`,
    url: `https://220volt.kz/catalog/svetotexnika/lyustryi/fixture-${id}/`,
    category,
    price: 4_000 + 100 * id,
    warehouses: [{ city: "Караганда", amount: 3 }],
    options: [
      { key: "destination", caption_ru: "Назначение", value_ru: destination },
      // The unit is in the live facet caption; card values are numeric.
      {
        key: "lighting_area",
        caption_ru: "Максимальная площадь освещения, м2",
        value_ru: String(area),
      },
      { key: "shape", caption_ru: "Форма люстры", value_ru: shape },
    ],
  };
}

const firstBatch = [
  product(1, "круг"),
  product(2, "квадрат"),
  product(3, "овал"),
];
const freshBatch = [
  product(4, "овал"),
  product(5, "круг"),
  product(6, "квадрат"),
];
const capacityFreshBatch = [
  product(9, "овал", "для гостиной", 50),
  product(10, "круг", "для гостиной", 75),
];
const distractors = [
  product(7, "квадрат", "для офиса"),
  product(8, "квадрат", "для гостиной", 12),
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
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

function sseEvents(text: string): Event[] {
  return text.split("\n\n")
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

function cardUrls(events: Event[]): string[] {
  return v3Events(events)
    .filter(({ type }) => type === "products_block")
    .flatMap(({ markdown }) =>
      [
        ...String(markdown ?? "").matchAll(
          /https:\/\/220volt\.kz\/catalog\/[^)\s]+/gu,
        ),
      ]
        .map(([url]) => url)
    );
}

async function runFourTurnScenario(input: {
  newCapacity: boolean;
  handler: (request: Request) => Promise<Response>;
  envGet: typeof Deno.env.get;
  preview?: boolean;
  fourthMessage?: string;
}): Promise<void> {
  Deno.env.get = input.envGet;
  const scenarioMessages = [...messages];
  if (input.fourthMessage) scenarioMessages[3] = input.fourthMessage;
  const allProducts = [
    ...firstBatch,
    ...freshBatch,
    ...(input.newCapacity ? capacityFreshBatch : []),
    ...distractors,
  ];
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  const logs: Log[] = [];
  const catalogReads: string[][] = [[], [], [], []];
  const turns: Event[][] = [];
  const modelTools: string[][] = [[], [], [], []];
  const historyBases: Array<string | null> = [];
  let fourthTurnDeclarationRequests = 0;
  let fourthTurnCorrectionRequests = 0;
  let turn = 0;
  try {
    globalThis.setInterval = ((callback, delay, ...args) => {
      const id = originalSetInterval(callback, delay, ...args);
      intervals.add(id);
      return id;
    }) as typeof setInterval;
    globalThis.fetch = async (fetchInput, init) => {
      const request = fetchInput instanceof Request
        ? fetchInput
        : new Request(fetchInput, init);
      const url = new URL(request.url);
      if (url.origin === "https://fixture.supabase.invalid") {
        if (url.pathname === "/rest/v1/chat_request_logs") {
          if (request.method === "POST") {
            const body = await request.json() as { user_query: string };
            const id = `offline-chandelier-${turn}`;
            logs.push({
              id,
              session_id: sessionId,
              user_query: body.user_query,
              error: "in_progress",
              created_at: new Date(Date.now() - (4 - turn) * 1_000)
                .toISOString(),
              final_products_count: 0,
              response_events: [],
              steps: [],
            });
            return json({ id }, 201);
          }
          if (request.method === "PATCH") {
            const id = url.searchParams.get("id")?.replace(/^eq\./u, "");
            const log = logs.find((row) => row.id === id);
            assert(log, `Unknown log update: ${url}`);
            const body = await request.json() as Partial<Log>;
            Object.assign(log, body);
            return new Response(null, { status: 204 });
          }
          if (request.method === "GET") {
            // JSONB boundary lookup (there is no "new task" in this session).
            if (url.searchParams.has("response_events")) return json(null);
            const limit = Number(url.searchParams.get("limit") ?? 8);
            const rows = logs.filter(({ error }) => error !== "in_progress")
              .slice().sort((a, b) => b.created_at.localeCompare(a.created_at))
              .slice(0, Number.isFinite(limit) ? limit : 8);
            const select = url.searchParams.get("select") ?? "";
            return json(rows.map((row) => {
              const data = { ...row } as Record<string, unknown>;
              if (!select.includes("steps")) delete data.steps;
              if (!select.includes("final_products_count")) {
                delete data.final_products_count;
              }
              if (!select.includes("response_events")) {
                delete data.response_events;
              }
              return data;
            }));
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
        ) return json(null);
        if (
          request.method === "POST" && url.pathname.startsWith("/rest/v1/")
        ) return json({}, 201);
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
              category: {
                id: 1,
                pagetitle: category,
                total_products: allProducts.length,
              },
              options: [
                {
                  key: "destination",
                  caption_ru: "Назначение",
                  type: "string",
                  values: [
                    {
                      value_ru: "для гостиной",
                      products_count: input.newCapacity ? 9 : 7,
                    },
                    { value_ru: "для офиса", products_count: 1 },
                  ],
                },
                {
                  key: "lighting_area",
                  caption_ru: "Максимальная площадь освещения, м2",
                  type: "number",
                  unit: "м²",
                  values: [
                    { value_ru: "12", products_count: 1 },
                    { value_ru: "35", products_count: 7 },
                    ...(input.newCapacity
                      ? [
                        { value_ru: "50", products_count: 1 },
                        { value_ru: "75", products_count: 1 },
                      ]
                      : []),
                  ],
                },
                {
                  key: "shape",
                  caption_ru: "Форма люстры",
                  type: "string",
                  values: [
                    { value_ru: "квадрат", products_count: 4 },
                    {
                      value_ru: "круг",
                      products_count: input.newCapacity ? 3 : 2,
                    },
                    {
                      value_ru: "овал",
                      products_count: input.newCapacity ? 3 : 2,
                    },
                  ],
                },
              ],
            },
          });
        }
        if (url.pathname === "/api/products") {
          catalogReads[turn].push(url.toString());
          const title = url.searchParams.get("pagetitle");
          // More stock becomes available for the last turn; the first batch
          // is still present to verify its exclusion by the handler. The
          // fixture honors category/facet parameters, but does not assume
          // that a plural category query ("Люстры") matches singular product
          // titles ("Люстра"). A verified category browse must still work.
          const available = turn === 0
            ? [...firstBatch, ...distractors]
            : allProducts;
          const categoryFilter = url.searchParams.get("category");
          const categoryIn = url.searchParams.getAll("category_in[]");
          const query =
            url.searchParams.get("query")?.trim().toLocaleLowerCase("ru") ??
              "";
          const facetFilters = [...url.searchParams.entries()]
            .flatMap(([key, value]) => {
              const match = key.match(/^options\[([^\]]+)\]\[\]$/u);
              return match ? [{ key: match[1], value }] : [];
            });
          const matching = available.filter((item) =>
            (!title || item.pagetitle === title) &&
            (!categoryFilter || item.category === categoryFilter) &&
            (categoryIn.length === 0 || categoryIn.includes(item.category)) &&
            (!query ||
              item.pagetitle.toLocaleLowerCase("ru").includes(query)) &&
            facetFilters.every(({ key, value }) =>
              item.options.some((option) =>
                option.key === key && option.value_ru === value
              )
            )
          );
          return json({
            data: {
              results: matching,
              pagination: { total: matching.length },
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
          response_format?: { type?: string };
        };
        if (body.tool_choice?.function?.name) {
          modelTools[turn].push(body.tool_choice.function.name);
        }
        if (body.response_format?.type === "json_object") {
          return json({
            choices: [{
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  mode: "continuation",
                  confidence: 0.98,
                  reason: "references_prior_cards",
                }),
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
          body.tool_choice?.function?.name === "declare_selection_reasoning"
        ) {
          if (turn === 3) fourthTurnDeclarationRequests++;
          const correction = turn === 3 && fourthTurnDeclarationRequests > 1;
          if (turn === 3 && correction) fourthTurnCorrectionRequests++;
          return modelTool("declare_selection_reasoning", {
            // Deliberately wrong shape inference: the customer specified
            // square metres, never a square-shaped chandelier.
            reasoning: turn === 3 && input.newCapacity
              ? "Для зала 30 м² рекомендую новые люстры с максимальной площадью освещения ровно 50 м². Проверяю назначение и характеристики по каталогу."
              : turn === 0
              ? "Для зала 30 квадратов проверяю площадь освещения каждого товара по карточке. Форма люстры: квадрат."
              : "Для зала 30 квадратов проверяю назначение и площадь освещения каждого нового товара по каталогу.",
            retrieval_query: turn === 0
              ? "квадратная люстра для гостиной"
              : "люстра для гостиной",
            measurement_scope: "per_product",
            compatible_classifications: [],
            excluded_classifications: [],
            required_facet_values: turn === 0 ? ["f2v0"] : [],
            explicit_customer_classifications: [],
          });
        }
        if (body.tool_choice?.function?.name === "discover_category") {
          return modelTool("discover_category", { noun: "люстра" });
        }
        if (body.tool_choice?.function?.name === "propose_candidates") {
          return modelTool("propose_candidates", { candidates: ["люстра"] });
        }
        if (
          body.tools?.some(({ function: tool }) =>
            tool?.name === "search_catalog"
          )
        ) {
          return modelTool("search_catalog", {
            mode: "by_filter",
            category,
            per_page: 50,
            ...(turn === 0 ? { options: { shape: ["квадрат"] } } : {}),
          });
        }
        return json({
          choices: [{
            finish_reason: "stop",
            message: {
              content: turn === 1
                ? "Проверяю заявленную площадь освещения каждого показанного светильника по карточке."
                : turn === 2
                ? "Сравниваю подтверждённые характеристики и цены ранее показанных вариантов."
                : "",
              tool_calls: [],
            },
          }],
        });
      }
      throw new Error(
        `Unexpected outbound request: ${request.method} ${url}`,
      );
    };

    for (turn = 0; turn < scenarioMessages.length; turn++) {
      const history = turns.flatMap((events, index) => [
        { role: "user" as const, content: scenarioMessages[index] },
        {
          role: "assistant" as const,
          content: publicText(events) + v3Events(events)
            .filter(({ type }) => type === "products_block")
            .map(({ markdown }) => String(markdown ?? ""))
            .join("\n"),
        },
      ]);
      historyBases.push(latestRenderedSelectionRequest(history));
      const response = await input.handler(
        new Request(
          input.preview
            ? "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3-preview"
            : "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(input.preview
                ? {
                  "x-volt-preview-secret":
                    "offline-preview-secret-000000000000000001",
                }
                : {}),
            },
            body: JSON.stringify({
              message: scenarioMessages[turn],
              messageId: crypto.randomUUID(),
              sessionId,
              history,
            }),
          },
        ),
      );
      assertEquals(response.status, 200, `turn ${turn + 1}`);
      const events = sseEvents(await response.text());
      turns.push(events);
      assert(
        logs[turn]?.response_events.some(({ type }) => type === "done"),
        `turn ${turn + 1} did not persist its own terminal SSE events`,
      );
    }

    const first = cardUrls(turns[0]);
    assert(
      first.length >= 3,
      JSON.stringify({ first, steps: logs[0].steps.map(({ step }) => step) }),
    );
    assert(
      first.every((url) => firstBatch.some((product) => product.url === url)),
      JSON.stringify(first),
    );
    assert(
      logs[0].steps.some(({ step }) => step === "v3_user_constraints_frozen"),
      JSON.stringify(logs[0].steps),
    );
    for (const index of [0, 3]) {
      const blocks = v3Events(turns[index]).filter(({ type }) =>
        type === "products_block"
      );
      for (const block of blocks) {
        const mandatory = (block.selection_contract as {
          mandatory_criteria?: Array<{ key: string }>;
        } | undefined)?.mandatory_criteria ?? [];
        assert(
          !mandatory.some(({ key }) => /форма|shape/iu.test(key)),
          JSON.stringify(block),
        );
      }
      for (const rawUrl of catalogReads[index]) {
        const params = new URL(rawUrl).searchParams;
        assert(
          ![...params.entries()].some(([key, value]) =>
            /shape/iu.test(key) ||
            ((key === "query" || key === "q") && /квадратн/iu.test(value))
          ),
          rawUrl,
        );
      }
    }
    assert(
      /30\s*(?:м²|м2|квадрат)/iu.test(publicText(turns[1])),
      publicText(turns[1]),
    );
    assert(
      /3 из 3 вариантов имеют значение не ниже запроса/iu.test(
        publicText(turns[1]),
      ),
      publicText(turns[1]),
    );
    assertEquals(historyBases[2], messages[0]);
    assertEquals(historyBases[3], messages[0]);
    assert(
      modelTools[0].includes("declare_selection_reasoning"),
      JSON.stringify(modelTools),
    );
    if (!input.newCapacity) {
      assert(
        modelTools[3].includes("declare_selection_reasoning"),
        JSON.stringify(modelTools),
      );
    }
    assertEquals(
      fourthTurnCorrectionRequests,
      0,
      "a customer-owned capacity must be frozen before paid correction",
    );
    assertEquals(
      logs[3].steps.filter(({ step }) =>
        step === "v3_product_measurement_correction_http_retry" ||
        step === "v3_product_measurement_correction_failed"
      ).length,
      0,
    );
    if (input.newCapacity) {
      assert(
        logs[3].steps.some(({ step, meta }) =>
          step === "v3_user_constraints_frozen" &&
          (meta?.added as Array<{ op?: string; value?: number }> | undefined)
            ?.some(({ op, value }) => op === "min" && value === 50)
        ),
        JSON.stringify(logs[3].steps),
      );
    }

    const other = cardUrls(turns[3]);
    assert(catalogReads[3].length > 0, JSON.stringify(logs[3].steps));
    if (!input.newCapacity) {
      assert(
        logs[3].steps.some(({ step, meta }) =>
          step === "v3_server_rendered_selection_base_checked" &&
          meta?.matched === true
        ),
        JSON.stringify(logs[3].steps),
      );
      assert(
        logs[3].steps.some(({ step, meta }) =>
          step === "v3_elliptical_selection_context_resolved" &&
          meta?.excluded_urls === first.length
        ),
        JSON.stringify(logs[3].steps),
      );
      assert(
        logs[3].steps.some(({ step, meta }) =>
          step === "v3_destination_area_card_proof_covers_measurement" &&
          meta?.minimum_area_m2 === 30
        ),
        JSON.stringify(logs[3].steps),
      );
      assert(
        logs[3].steps.some(({ step, meta }) =>
          step === "v3_grounded_category_search_recovery" &&
          meta?.source === "server_verified_additional_selection"
        ),
        JSON.stringify(logs[3].steps),
      );
    } else {
      assert(
        logs[3].steps.some(({ step, meta }) =>
          step === "v3_visible_reasoning_guided_render" &&
          Number(meta?.rendered) >= 2
        ),
        JSON.stringify(logs[3].steps),
      );
    }
    assert(
      catalogReads[3].some((raw) => {
        const params = new URL(raw).searchParams;
        return !params.has("query") &&
          (params.get("category") === category ||
            params.getAll("category_in[]").includes(category));
      }),
      JSON.stringify(catalogReads[3]),
    );
    const failures: string[] = [];
    if (
      resolveServerRenderedSelectionProof(
        logs.slice(0, 2),
        sessionId,
        messages[0],
        messages[2],
      ) === null
    ) {
      failures.push(
        "turn 3: a completed, certified area-question bridge did not preserve the rendered selection proof for the price comparison",
      );
    }
    if (!/(?:цен|характеристик|сравн)/iu.test(publicText(turns[2]))) {
      failures.push(
        "turn 3: price comparison rejected as unverified instead of using the certified cards",
      );
    }
    if (other.length < 2) {
      failures.push(
        "turn 4: several fresh catalog candidates existed, but fewer than two source-proven product cards were rendered",
      );
    }
    if (input.newCapacity) {
      assert(
        capacityFreshBatch.every((product) => other.includes(product.url)),
        JSON.stringify(other),
      );
      assert(
        other.every((url) =>
          capacityFreshBatch.some((product) => product.url === url)
        ),
        JSON.stringify(other),
      );
    } else {
      assert(
        other.every((url) => freshBatch.some((product) => product.url === url)),
        JSON.stringify(other),
      );
    }
    assert(
      other.every((url) => !first.includes(url)),
      JSON.stringify({ first, other }),
    );
    assertEquals(
      failures,
      [],
      JSON.stringify({
        turn3Steps: logs[2].steps.map(({ step }) => step),
        turn4Steps: logs[3].steps,
        freshCatalogReads: catalogReads[3],
        turn4Text: publicText(turns[3]),
        turn4ToolEvents: v3Events(turns[3]).filter(({ type }) =>
          type === "tool_event"
        ),
        modelTools: modelTools[3],
        rendered: other,
      }),
    );
  } finally {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
    restoreOfflineModuleSetup();
  }
}

Deno.test({
  name:
    "four real chandelier turns preserve room area and price context, then verify fresh alternatives",
  permissions: { read: true, env: false, net: false },
  fn: () =>
    runFourTurnScenario({
      newCapacity: false,
      handler: offlineHandler(),
      envGet: offlineEnvGet,
    }),
});

Deno.test({
  name:
    "four real turns freeze a new product-capacity minimum before any correction call",
  permissions: { read: true, env: false, net: false },
  fn: () =>
    runFourTurnScenario({
      newCapacity: true,
      handler: offlineHandler(),
      envGet: offlineEnvGet,
      fourthMessage: changedAreaFollowUp,
    }),
});

async function runPreviewDirectMinimumScenario(): Promise<void> {
  const marker = globalThis as typeof globalThis & {
    __VOLT220_FUNCTION_VARIANT__?: "preview";
    __VOLT220_ADMISSION_SCOPE__?: "preview";
  };
  marker.__VOLT220_FUNCTION_VARIANT__ = "preview";
  marker.__VOLT220_ADMISSION_SCOPE__ = "preview";
  const previewGet = (name: string) =>
    name === "VOLT220_PRODUCT_MEASUREMENT_HTTP_RETRY_PREVIEW_ENABLED"
      ? "true"
      : name === "VOLT220_V3_PREVIEW_SECRET"
      ? "offline-preview-secret-000000000000000001"
      : offlineEnvGet(name);
  let handler: ((request: Request) => Promise<Response>) | null = null;
  try {
    Deno.env.get = previewGet;
    (Deno as unknown as { serve: typeof Deno.serve }).serve = ((
      callback: (
        request: Request,
      ) => Promise<Response>,
    ) => {
      handler = callback;
      return { shutdown() {}, finished: Promise.resolve() };
    }) as unknown as typeof Deno.serve;
    // A second module instance captures the preview-only server flag. No
    // browser-provided header can activate this flag in production.
    await import("./index.ts?chandelier-preview-direct-capacity-minimum");
    assert(handler, "preview handler did not register");
    await runFourTurnScenario({
      newCapacity: true,
      handler,
      envGet: previewGet,
      preview: true,
      fourthMessage: changedAreaFollowUp,
    });
  } finally {
    restoreOfflineModuleSetup();
    delete marker.__VOLT220_FUNCTION_VARIANT__;
    delete marker.__VOLT220_ADMISSION_SCOPE__;
  }
}

Deno.test({
  name:
    "preview direct capacity minimum renders fresh cards without consuming a correction retry",
  permissions: { read: true, env: false, net: false },
  fn: () => runPreviewDirectMinimumScenario(),
});
