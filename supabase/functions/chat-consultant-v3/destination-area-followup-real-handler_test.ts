// A real HTTP/SSE continuation from a completed, server-owned prior turn.
// The first turn is represented by its durable log and browser-visible card;
// the follow-up executes the production handler. Every outbound dependency is
// intercepted, so this spends no model tokens and cannot reach the network.
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
type Event = Record<string, unknown>;
type ServerLog = {
  id: string;
  session_id: string;
  user_query: string;
  error: string | null;
  final_products_count: number;
  response_events: Event[];
  created_at: string;
};

const sessionId = "11111111-1111-4111-8111-111111111111";
const leaf = "Светильники";
const base =
  "Хочу заменить люстру на светодиодный светильник в гостиной 30 м². Что подойдет?";
const followup = "А есть другие варианты?";
const areaOnlyReasoning =
  "Светодиодный светильник для гостиной 30 м² проверяю по назначению и подтверждённой площади освещения каждой карточки.";
const rawPreviewReasoning =
  "Для гостиной площадью 30 м² при базовой норме 150–200 лк требуется световой поток 4500–6000 лм. Живая схема содержит характеристику „Максимальная площадь освещения, м2“ со значением 30, что соответствует помещению. Назначение „гостиная“ совпадает с запросом. Проверяю другие варианты по этим двум проверяемым характеристикам.";
const adversarialPerCardReasoning =
  "Светодиодный светильник для гостиной 30 м² обязан иметь не менее 5500 лм каждый. Каждую карточку проверяю по назначению и площади освещения.";
const adversarialConditionalPerCardReasoning =
  "Для гостиной площадью 30 м² при условии, что каждый светильник имеет не менее 5500 лм, требуется подбор. Живая схема содержит характеристику „Максимальная площадь освещения, м2“ со значением 30. Проверяю другие варианты по каталогу.";
const adversarialPrefixPerCardReasoning =
  "Каждый светильник для гостиной площадью 30 м² при норме 150 лк должен выдавать не менее 5000 лм. Живая схема содержит характеристику „Максимальная площадь освещения, м2“ со значением 30. Проверяю другие варианты по каталогу.";
const priorUrl = "https://220volt.kz/catalog/lighting/luminaires/fixture-one/";
const nextUrl = "https://220volt.kz/catalog/lighting/luminaires/fixture-two/";
const previousCard =
  `- **[Светодиодный светильник для гостиной Первый](${priorUrl})**\n  Цена: 2500 ₸`;

function item(
  id: number,
  slug: string,
  title: string,
  destination: string,
  area: number,
) {
  return {
    id,
    pagetitle: title,
    url: `https://220volt.kz/catalog/lighting/luminaires/${slug}/`,
    category: leaf,
    price: 2000 + id,
    warehouses: [{ city: "Караганда", amount: 5 }],
    options: [
      {
        key: "destination",
        caption_ru: "Назначение",
        value_ru: destination,
      },
      {
        key: "lighting_area",
        caption_ru: "Максимальная площадь освещения, м2",
        value_ru: `${area} м²`,
      },
    ],
  };
}

const products = [
  item(
    1,
    "fixture-one",
    "Светодиодный светильник для гостиной Первый",
    "для гостиной",
    35,
  ),
  item(
    2,
    "fixture-two",
    "Светодиодный светильник для гостиной Второй",
    "для гостиной",
    35,
  ),
  item(3, "office", "Светодиодный светильник офисный", "для офиса", 35),
  item(
    4,
    "small",
    "Светодиодный светильник для гостиной компактный",
    "для гостиной",
    12,
  ),
];

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function eventsFromSse(body: string): Event[] {
  return body.split("\n\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Event);
}

function priorLog(baseRequest = base): ServerLog {
  const id = "offline-completed-prior";
  return {
    id,
    session_id: sessionId,
    user_query: baseRequest,
    error: null,
    final_products_count: 1,
    created_at: new Date(Date.now() - 2_000).toISOString(),
    response_events: [
      { type: "products_block", count: 1, markdown: previousCard },
      {
        type: "diagnostic",
        phase: "complete",
        log_id: id,
        error: null,
        products_count: 1,
      },
      { type: "done" },
    ],
  };
}

interface Run {
  events: Event[];
  steps: Step[];
  catalogProductReads: number;
  primaryReasoningRequests: number;
  correctionRequests: number;
  modelRequests: number;
  priorLogReads: number;
}

async function runFollowup({
  baseRequest = base,
  failLogRead = false,
  rawReasoning = areaOnlyReasoning,
  interveningUserTurns = [],
}: {
  baseRequest?: string;
  failLogRead?: boolean;
  rawReasoning?: string;
  /** Completed dependent turns between the rendered batch and this request. */
  interveningUserTurns?: string[];
} = {}): Promise<Run> {
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  const prior = priorLog(baseRequest);
  const priorRows = [
    ...interveningUserTurns.map((query, index): ServerLog => ({
      id: `offline-dependent-${index}`,
      session_id: sessionId,
      user_query: query,
      error: null,
      final_products_count: 0,
      created_at: new Date(
        Date.now() - 1_500 + index * 100,
      ).toISOString(),
      response_events: [{ type: "done" }],
    })).reverse(),
    prior,
  ];
  let steps: Step[] = [];
  let catalogProductReads = 0;
  let primaryReasoningRequests = 0;
  let correctionRequests = 0;
  let modelRequests = 0;
  let priorLogReads = 0;
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
            return json({ id: "offline-current-log" }, 201);
          }
          if (request.method === "PATCH") {
            steps = ((await request.json()) as { steps?: Step[] }).steps ?? [];
            return new Response(null, { status: 204 });
          }
          if (request.method === "GET") {
            priorLogReads++;
            if (
              failLogRead &&
              (url.searchParams.get("select") ?? "").includes(
                "final_products_count",
              )
            ) return json({ message: "fixture unavailable" }, 503);
            // The JSONB boundary query is separate from ordinary session
            // history. This two-turn dialogue has no session rotation.
            if (url.searchParams.has("response_events")) return json(null);
            const limit = Number(url.searchParams.get("limit") ?? 8);
            return json(priorRows.slice(0, Number.isFinite(limit) ? limit : 8));
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
              category: { id: 1, pagetitle: leaf, total_products: 4 },
              options: [
                {
                  key: "destination",
                  caption_ru: "Назначение",
                  type: "string",
                  values: [{ value_ru: "для гостиной", products_count: 3 }],
                },
                {
                  key: "lighting_area",
                  caption_ru: "Максимальная площадь освещения, м2",
                  type: "number",
                  unit: "м²",
                  values: [12, 35].map((area) => ({
                    value_ru: `${area} м²`,
                    products_count: 1,
                  })),
                },
              ],
            },
          });
        }
        if (url.pathname === "/api/products") {
          catalogProductReads++;
          return json({
            data: { results: products, pagination: { total: 4 } },
          });
        }
      }
      if (url.toString() === "https://openrouter.ai/api/v1/chat/completions") {
        modelRequests++;
        const body = await request.json() as {
          tool_choice?: { function?: { name?: string } };
          tools?: Array<{ function?: { name?: string } }>;
          messages?: Array<{ content?: string }>;
        };
        if (
          body.tool_choice?.function?.name === "declare_selection_reasoning"
        ) {
          const correction = body.messages?.some(({ content }) =>
            content?.includes("<correction>")
          ) ?? false;
          if (correction) {
            correctionRequests++;
          } else primaryReasoningRequests++;
          return json({
            choices: [{
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [{
                  id: `offline-area-declaration-${modelRequests}`,
                  type: "function",
                  function: {
                    name: "declare_selection_reasoning",
                    arguments: JSON.stringify({
                      reasoning: rawReasoning,
                      retrieval_query: "светодиодный светильник",
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
                  candidates: [{ pagetitle: leaf, confidence: 0.99 }],
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
          return json({
            choices: [{
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [{
                  id: `offline-area-search-${modelRequests}`,
                  type: "function",
                  function: {
                    name: "search_catalog",
                    arguments: JSON.stringify({
                      mode: "by_filter",
                      category: leaf,
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

    const response = await offlineHandler()(
      new Request(
        "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: followup,
            messageId: crypto.randomUUID(),
            sessionId,
            history: [
              { role: "user", content: baseRequest },
              { role: "assistant", content: previousCard },
              ...interveningUserTurns.flatMap((query) => [
                { role: "user", content: query },
                {
                  role: "assistant",
                  content: "Проверяю ранее предложенные товары.",
                },
              ]),
            ],
          }),
        },
      ),
    );
    assertEquals(response.status, 200);
    return {
      events: eventsFromSse(await response.text()),
      steps,
      catalogProductReads,
      primaryReasoningRequests,
      correctionRequests,
      modelRequests,
      priorLogReads,
    };
  } finally {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
  }
}

function blocks(events: Event[]): Array<{ markdown?: string; count?: number }> {
  return events.flatMap((event) => {
    const block = event.v3_event as {
      type?: string;
      markdown?: string;
      count?: number;
    } | undefined;
    return block?.type === "products_block" ? [block] : [];
  });
}

function publicText(events: Event[]): string {
  return events.flatMap((event) => {
    const choices = event.choices as
      | Array<{ delta?: { content?: string } }>
      | undefined;
    return choices?.map((choice) => choice.delta?.content ?? "") ?? [];
  }).join("\n");
}

function hasEnforcedDestinationArea(
  steps: Step[],
  minimumAreaM2: number,
): boolean {
  // The area can be discharged either by the fresh per-card destination gate
  // or by a server-certified A-level catalog facet that is actually applied
  // to the search. A frozen criterion without the live filter is not proof.
  if (
    steps.some(({ step, meta }) =>
      step === "v3_destination_area_card_proof_covers_measurement" &&
      meta?.minimum_area_m2 === minimumAreaM2
    )
  ) return true;
  const frozen = steps.some(({ step, meta }) =>
    step === "v3_user_constraints_frozen" &&
    Array.isArray(meta?.added) &&
    meta.added.some((candidate: unknown) => {
      const criterion = candidate as Record<string, unknown>;
      return criterion.key === "Максимальная площадь освещения, м2" &&
        criterion.op === "min" &&
        criterion.value === String(minimumAreaM2) &&
        criterion.unit === "м²" &&
        criterion.level === "A" &&
        criterion.evidence === "user_explicit";
    })
  );
  const enforced = steps.some(({ step, meta }) =>
    step === "v3_selection_criteria_plan_enforced" &&
    Number(meta?.mandatory_count) >= 1 &&
    Array.isArray(meta?.option_keys) &&
    meta.option_keys.includes("lighting_area") &&
    Array.isArray(meta?.conflicting_keys) &&
    meta.conflicting_keys.length === 0
  );
  const filteredSearch = steps.some(({ step, meta }) => {
    if (
      step !== "v3_tool_call" || meta?.tool !== "search_catalog" ||
      meta.ok !== true
    ) return false;
    const args = meta.args as
      | { options?: { lighting_area?: unknown } }
      | undefined;
    const values = args?.options?.lighting_area;
    return Array.isArray(values) && values.length > 0 &&
      values.every((value: unknown) =>
        typeof value === "string" &&
        /^\d+(?:[.,]\d+)?\s*м²$/u.test(value) &&
        Number.parseFloat(value.replace(",", ".")) >= minimumAreaM2
      );
  });
  const gatedRecovery = steps.some(({ step, meta }) =>
    step === "v3_measured_reasoning_terminal_recovery" &&
    Number(meta?.rendered) > 0 &&
    Array.isArray(meta?.criteria) &&
    meta.criteria.some((candidate: unknown) => {
      const criterion = candidate as Record<string, unknown>;
      return criterion.key === "Максимальная площадь освещения, м2" &&
        criterion.op === "min" &&
        criterion.value === String(minimumAreaM2) &&
        criterion.unit === "м²" &&
        criterion.level === "A" &&
        criterion.evidence === "user_explicit";
    })
  );
  return frozen && ((enforced && filteredSearch) || gatedRecovery);
}

Deno.test({
  name:
    "room-area follow-up keeps primary reasoning and live card gates, with a fail-closed log read",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const result = await runFollowup();
      assertEquals(result.primaryReasoningRequests, 1, JSON.stringify(result));
      assertEquals(result.correctionRequests, 0, JSON.stringify(result));
      assert(result.priorLogReads >= 2, JSON.stringify(result));
      assert(result.catalogProductReads >= 1, JSON.stringify(result));
      assert(
        result.steps.some(({ step, meta }) =>
          step === "v3_tool_call" && meta?.tool === "search_catalog"
        ),
        JSON.stringify(result.steps),
      );
      assert(
        result.steps.some(({ step, meta }) =>
          step === "v3_server_rendered_selection_base_checked" &&
          meta?.matched === true
        ),
        JSON.stringify(result.steps),
      );
      assert(
        hasEnforcedDestinationArea(result.steps, 30),
        JSON.stringify(result.steps),
      );
      assert(
        result.steps.some(({ step, meta }) =>
          step === "v3_selection_criteria_plan_enforced" &&
          Array.isArray(meta?.option_keys) &&
          meta.option_keys.includes("lighting_area")
        ),
        JSON.stringify(result.steps),
      );
      const rendered = blocks(result.events);
      assertEquals(rendered.length, 1, JSON.stringify(result));
      assertEquals(rendered[0].count, 1, JSON.stringify(result));
      assert(rendered[0].markdown?.includes(nextUrl), JSON.stringify(result));
      assert(!rendered[0].markdown?.includes(priorUrl), JSON.stringify(result));
      assert(
        !rendered[0].markdown?.includes("офисный"),
        JSON.stringify(result),
      );
      assert(
        !rendered[0].markdown?.includes("компактный"),
        JSON.stringify(result),
      );

      // An additional physical requirement must not make a legitimate
      // server-rendered continuation fail provenance. Suitability itself
      // remains subject to the regular (stricter) catalog/card checks.
      const multiCriterion = await runFollowup({
        baseRequest:
          "Хочу заменить люстру на светодиодный светильник в гостиной 30 м², мощность от 20 Вт. Что подойдет?",
      });
      assertEquals(
        multiCriterion.primaryReasoningRequests,
        1,
        JSON.stringify(multiCriterion),
      );
      assert(
        !multiCriterion.steps.some(({ step }) =>
          step === "v3_unverified_rendered_selection_context_rejected"
        ),
        JSON.stringify(multiCriterion.steps),
      );

      // The actual preview wording contains model-inferred illuminance and
      // lumens. Preserve its customer-owned destination and area, drop the
      // unsupported numeric premise, then prove every fresh card separately.
      const preview = await runFollowup({
        rawReasoning: rawPreviewReasoning,
      });
      assertEquals(
        preview.primaryReasoningRequests,
        1,
        JSON.stringify(preview),
      );
      assertEquals(preview.correctionRequests, 0, JSON.stringify(preview));
      assert(preview.catalogProductReads >= 1, JSON.stringify(preview));
      assert(
        hasEnforcedDestinationArea(preview.steps, 30),
        JSON.stringify(preview.steps),
      );
      assert(
        preview.steps.some(({ step, meta }) =>
          step === "v3_measured_reasoning_terminal_recovery" &&
          Number(meta?.rendered) === 1
        ),
        JSON.stringify(preview.steps),
      );
      const previewBlocks = blocks(preview.events);
      assertEquals(previewBlocks.length, 1, JSON.stringify(preview));
      assertEquals(previewBlocks[0].count, 1, JSON.stringify(preview));
      assert(
        previewBlocks[0].markdown?.includes(nextUrl),
        JSON.stringify(preview),
      );
      assert(
        !previewBlocks[0].markdown?.includes(priorUrl),
        JSON.stringify(preview),
      );
      assert(
        !previewBlocks[0].markdown?.includes("офисный"),
        JSON.stringify(preview),
      );
      assert(
        !previewBlocks[0].markdown?.includes("компактный"),
        JSON.stringify(preview),
      );
      assert(
        !/(?:150|200|4500|6000)\s*(?:лк|лм)?/iu.test(
          publicText(preview.events),
        ),
        publicText(preview.events),
      );

      const fabricatedPerCardLumens = await runFollowup({
        rawReasoning: adversarialPerCardReasoning,
      });
      assertEquals(
        fabricatedPerCardLumens.primaryReasoningRequests,
        1,
        JSON.stringify(fabricatedPerCardLumens),
      );
      assert(
        fabricatedPerCardLumens.correctionRequests >= 1,
        JSON.stringify(fabricatedPerCardLumens),
      );
      assertEquals(
        blocks(fabricatedPerCardLumens.events).length,
        0,
        JSON.stringify(fabricatedPerCardLumens),
      );
      assert(
        !/5500\s*лм/iu.test(publicText(fabricatedPerCardLumens.events)),
        publicText(fabricatedPerCardLumens.events),
      );

      const conditionalPerCardLumens = await runFollowup({
        rawReasoning: adversarialConditionalPerCardReasoning,
      });
      assertEquals(
        conditionalPerCardLumens.primaryReasoningRequests,
        1,
        JSON.stringify(conditionalPerCardLumens),
      );
      assert(
        conditionalPerCardLumens.correctionRequests >= 1,
        JSON.stringify(conditionalPerCardLumens),
      );
      assertEquals(
        blocks(conditionalPerCardLumens.events).length,
        0,
        JSON.stringify(conditionalPerCardLumens),
      );
      assert(
        !/5500\s*лм/iu.test(publicText(conditionalPerCardLumens.events)),
        publicText(conditionalPerCardLumens.events),
      );

      const prefixPerCardLumens = await runFollowup({
        rawReasoning: adversarialPrefixPerCardReasoning,
      });
      assertEquals(
        prefixPerCardLumens.primaryReasoningRequests,
        1,
        JSON.stringify(prefixPerCardLumens),
      );
      assert(
        prefixPerCardLumens.correctionRequests >= 1,
        JSON.stringify(prefixPerCardLumens),
      );
      assertEquals(
        blocks(prefixPerCardLumens.events).length,
        0,
        JSON.stringify(prefixPerCardLumens),
      );
      assert(
        !/5000\s*лм/iu.test(publicText(prefixPerCardLumens.events)),
        publicText(prefixPerCardLumens.events),
      );

      const failedRead = await runFollowup({ failLogRead: true });
      assertEquals(
        failedRead.primaryReasoningRequests,
        0,
        JSON.stringify(failedRead),
      );
      assertEquals(
        failedRead.correctionRequests,
        0,
        JSON.stringify(failedRead),
      );
      assertEquals(
        failedRead.catalogProductReads,
        0,
        JSON.stringify(failedRead),
      );
      assertEquals(
        blocks(failedRead.events).length,
        0,
        JSON.stringify(failedRead),
      );
      assert(
        publicText(failedRead.events).includes("Повторите запрос"),
        JSON.stringify(failedRead),
      );
      assert(
        failedRead.steps.some(({ step, meta }) =>
          step === "v3_server_rendered_selection_base_checked" &&
          meta?.matched === false
        ),
        JSON.stringify(failedRead.steps),
      );
      assert(
        failedRead.steps.some(({ step }) =>
          step === "v3_unverified_rendered_selection_context_rejected"
        ),
        JSON.stringify(failedRead.steps),
      );

      const fourTurn = await runFollowup({
        interveningUserTurns: [
          "Они точно подходят для освещения 30 квадратных метров?",
          "Спасибо.",
        ],
      });
      assertEquals(
        fourTurn.primaryReasoningRequests,
        1,
        JSON.stringify(fourTurn),
      );
      assertEquals(fourTurn.correctionRequests, 0, JSON.stringify(fourTurn));
      assert(
        fourTurn.steps.some(({ step, meta }) =>
          step === "v3_server_rendered_selection_base_checked" &&
          meta?.matched === true
        ),
        JSON.stringify(fourTurn.steps),
      );
      assert(
        hasEnforcedDestinationArea(fourTurn.steps, 30),
        JSON.stringify(fourTurn.steps),
      );
      const fourTurnBlocks = blocks(fourTurn.events);
      assertEquals(fourTurnBlocks.length, 1, JSON.stringify(fourTurn));
      assert(
        fourTurnBlocks[0].markdown?.includes(nextUrl),
        JSON.stringify(fourTurn),
      );
      assert(
        !fourTurnBlocks[0].markdown?.includes(priorUrl),
        JSON.stringify(fourTurn),
      );
      assert(
        !fourTurnBlocks[0].markdown?.includes("офисный"),
        JSON.stringify(fourTurn),
      );
      assert(
        !fourTurnBlocks[0].markdown?.includes("компактный"),
        JSON.stringify(fourTurn),
      );

      for (
        const changedDestination of [
          "Они точно подходят для спальни 30 м²?",
          "Они точно подходят на кухню 30 м²?",
          "Они точно подходят для спальни?",
        ]
      ) {
        const changed = await runFollowup({
          interveningUserTurns: [changedDestination, "Спасибо."],
        });
        assertEquals(changed.primaryReasoningRequests, 0, changedDestination);
        assert(
          changed.steps.some(({ step, meta }) =>
            step === "v3_server_rendered_selection_base_checked" &&
            meta?.matched === true
          ),
          changedDestination,
        );
        assertEquals(changed.correctionRequests, 0, changedDestination);
        assertEquals(changed.catalogProductReads, 0, changedDestination);
        assertEquals(blocks(changed.events).length, 0, changedDestination);
        assert(
          changed.steps.some(({ step, meta }) =>
            step === "v3_unverified_rendered_selection_context_rejected" &&
            meta?.base_matched === true
          ),
          changedDestination,
        );
        assert(
          !changed.steps.some(({ step }) =>
            step === "v3_destination_area_card_proof_covers_measurement"
          ),
          changedDestination,
        );
      }

      const revisedArea = await runFollowup({
        interveningUserTurns: [
          "Они точно подходят для освещения 40 квадратных метров?",
          "Спасибо.",
        ],
      });
      assertEquals(
        revisedArea.primaryReasoningRequests,
        0,
        JSON.stringify(revisedArea),
      );
      assertEquals(
        revisedArea.correctionRequests,
        0,
        JSON.stringify(revisedArea),
      );
      assertEquals(
        revisedArea.catalogProductReads,
        0,
        JSON.stringify(revisedArea),
      );
      assertEquals(
        blocks(revisedArea.events).length,
        0,
        JSON.stringify(revisedArea),
      );
      assert(
        !revisedArea.steps.some(({ step }) =>
          step === "v3_destination_area_card_proof_covers_measurement"
        ),
        JSON.stringify(revisedArea.steps),
      );
      assert(
        revisedArea.steps.some(({ step, meta }) =>
          step === "v3_unverified_rendered_selection_context_rejected" &&
          meta?.base_matched === true
        ),
        JSON.stringify(revisedArea.steps),
      );

      const fourTurnInventedLumens = await runFollowup({
        interveningUserTurns: [
          "Они точно подходят для освещения 30 квадратных метров?",
          "Спасибо.",
        ],
        rawReasoning: adversarialPerCardReasoning,
      });
      assert(
        fourTurnInventedLumens.correctionRequests >= 1,
        JSON.stringify(fourTurnInventedLumens),
      );
      assertEquals(
        blocks(fourTurnInventedLumens.events).length,
        0,
        JSON.stringify(fourTurnInventedLumens),
      );
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});
