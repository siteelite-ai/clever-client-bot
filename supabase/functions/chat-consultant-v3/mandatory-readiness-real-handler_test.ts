import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  enableMandatoryReadinessInOfflineFixture,
  offlineHandler,
  restoreOfflineModuleSetup,
} from "./model-no-search-integration-fixture.ts";
import { resetDiscoverCategoryCacheForTest } from "../_shared/v3-tools/discover-category.ts";
enableMandatoryReadinessInOfflineFixture();
const offlineGet = Deno.env.get;
await import("./index.ts");
restoreOfflineModuleSetup();

type Event = Record<string, unknown>;
type Step = { step: string; meta?: Record<string, unknown> };
type Log = {
  id: string;
  session_id: string;
  user_query: string;
  error: string | null;
  created_at: string;
  response_events: Event[];
  steps: Step[];
};
const leaf = "Монтажные крепления";
const initial = "Подбери монтажные крепления для стены";
const question = "Из какого материала сделана стена?";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const protocol = (events: Event[]) =>
  events.map((event) => event.v3_event as Event).filter(Boolean);
const pending = (events: Event[]) => {
  const slot = [...protocol(events)].reverse().find((event) =>
    event.type === "slot_update" &&
    (event.slots as Event)?.pending_clarification
  );
  return (slot?.slots as Event)?.pending_clarification as Event | undefined;
};
const products = [1, 2, 3].map((id) => ({
  id,
  pagetitle: `Монтажное крепление для стены Бетон Fixture ${id}`,
  url: `https://220volt.kz/catalog/mounting/fixings/fixture-${id}/`,
  category: leaf,
  price: 100 + id,
  warehouses: [{ city: "Караганда", amount: 3 }],
  options: [{
    key: "base_material",
    caption_ru: "Материал основания",
    value_ru: "Бетон",
  }],
}));

async function scenario(
  mode:
    | "roundtrip"
    | "forged"
    | "new_topic"
    | "progress"
    | "missing"
    | "unowned"
    | "specified"
    | "mislabelled_ready"
    | "browse"
    | "replacement"
    | "subject"
    | "subject_single"
    | "subject_other"
    | "subject_literal",
) {
  const subjectMode = mode.startsWith("subject");
  const subjectPhrase = mode === "subject_other" ? "фиксатор" : "сверло",
    subjectClass = mode === "subject_other"
      ? "распорный анкер"
      : "бур по бетону",
    siblingClass = mode === "subject_other" ? "заклёпка" : "сверло по металлу";
  const subjectChoices = mode === "subject_literal" ? [] : [
    { value_ru: subjectClass, products_count: 1 },
    ...(mode === "subject_single"
      ? []
      : [{ value_ru: siblingClass, products_count: 1 }]),
  ];
  const scenarioLeaf = subjectMode
    ? mode === "subject_other"
      ? "Материалы для фиксации"
      : "Материалы для сверления"
    : leaf;
  const scenarioProducts = subjectMode
    ? products.map((p, i) => ({
      ...p,
      category: scenarioLeaf,
      pagetitle: mode === "subject_literal"
        ? "Сверло для стены Бетон Fixture " + p.id
        : (i === 1 ? siblingClass : subjectClass) + " Fixture " + p.id,
      options: [...p.options, {
        key: "item_kind",
        caption_ru: "Вид изделия",
        value_ru: i === 1 ? siblingClass : subjectClass,
      }, {
        key: "diameter",
        caption_ru: "Диаметр, мм",
        value_ru: i === 2 ? "10" : "8",
      }],
    }))
    : products;
  const previousFetch = globalThis.fetch,
    previousEnv = Deno.env.get,
    previousInterval = globalThis.setInterval;
  const intervals = new Set<number>(),
    logs: Log[] = [],
    requests: string[][] = [[], []],
    modelCalls = [0, 0];
  const result: Event[][] = [];
  let turn = 0;
  resetDiscoverCategoryCacheForTest();
  Deno.env.get = offlineGet;
  try {
    globalThis.setInterval = ((callback, delay, ...args) => {
      const id = previousInterval(callback, delay, ...args);
      intervals.add(id);
      return id;
    }) as typeof setInterval;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request
          ? input
          : new Request(input, init),
        url = new URL(request.url);
      if (url.origin === "https://fixture.supabase.invalid") {
        if (url.pathname === "/rest/v1/chat_request_logs") {
          if (request.method === "POST") {
            const body = await request.json();
            const id = `readiness-log-${logs.length}`;
            logs.push({
              id,
              session_id: body.session_id,
              user_query: body.user_query,
              error: "in_progress",
              created_at: new Date(Date.now() + logs.length * 1000)
                .toISOString(),
              response_events: [],
              steps: [],
            });
            return json({ id }, 201);
          }
          if (request.method === "PATCH") {
            const log = logs.find((row) =>
              row.id === url.searchParams.get("id")?.replace(/^eq\./u, "")
            );
            assert(log);
            Object.assign(log, await request.json());
            return new Response(null, { status: 204 });
          }
          if (url.searchParams.has("response_events")) return json(null);
          const wanted = url.searchParams.get("session_id")?.replace(
            /^eq\./u,
            "",
          );
          const excluded = url.searchParams.get("id")?.replace(/^neq\./u, "");
          return json(
            logs.filter((row) =>
              row.id !== excluded && row.error !== "in_progress" &&
              (!wanted || row.session_id === wanted)
            ).slice().reverse().slice(
              0,
              Number(url.searchParams.get("limit") ?? 8),
            ),
          );
        }
        if (url.pathname === "/rest/v1/app_settings") {
          return json({
            openrouter_api_key: "offline-openrouter",
            volt220_api_token: "offline-catalog",
            classifier_model: "offline-model",
            v3_criteria_gate_enabled: true,
            v3_anchor_filter_enabled: true,
            v3_relaxation_hints_enabled: true,
          });
        }
        if (request.method === "GET" && url.pathname.startsWith("/rest/v1/")) {
          return json([]);
        }
      }
      if (url.origin === "https://fixture.catalog.invalid") {
        requests[turn].push(url.toString());
        if (url.pathname === "/api/categories") {
          return json({
            data: {
              results: [{ id: 1, pagetitle: scenarioLeaf, children: [] }],
              pagination: { page: 1, per_page: 200, pages: 1, total: 1 },
            },
          });
        }
        if (url.pathname === "/api/categories/options") {
          return json({
            data: {
              category: { id: 1, pagetitle: scenarioLeaf, total_products: 3 },
              options: [
                {
                  key: "base_material",
                  caption_ru: "Материал основания",
                  type: "string",
                  values: [{ value_ru: "Бетон", products_count: 3 }],
                },
                ...(subjectMode && subjectChoices.length
                  ? [{
                    key: "item_kind",
                    caption_ru: "Вид изделия",
                    type: "string",
                    values: subjectChoices,
                  }]
                  : []),
                ...(subjectMode
                  ? [{
                    key: "diameter",
                    caption_ru: "Диаметр, мм",
                    type: "number",
                    unit: "мм",
                    values: [{ value_ru: "8", products_count: 2 }, {
                      value_ru: "10",
                      products_count: 1,
                    }],
                  }]
                  : []),
              ],
            },
          });
        }
        if (url.pathname === "/api/products") {
          return json({
            data: {
              results: scenarioProducts,
              pagination: { page: 1, pages: 1, total: 3 },
            },
          });
        }
      }
      if (url.toString() === "https://openrouter.ai/api/v1/chat/completions") {
        modelCalls[turn]++;
        const body = await request.json();
        if (
          subjectMode &&
          request.headers.get("X-Title") === "220volt-v3-category-resolver"
        ) {
          return json({
            choices: [{
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  candidates: [{ pagetitle: scenarioLeaf, confidence: 0.99 }],
                }),
                tool_calls: [],
              },
            }],
          });
        }
        if (
          body.tool_choice?.function?.name !== "declare_selection_reasoning"
        ) {
          const content = !body.tools?.length
            ? JSON.stringify({
              mode: "continuation",
              confidence: 1,
              reason: "reply to issued question",
            })
            : "";
          return json({
            choices: [{
              finish_reason: "stop",
              message: { content, tool_calls: [] },
            }],
          });
        }
        const schema = body.tools?.[0]?.function?.parameters;
        assertEquals(
          schema.required.includes("selection_readiness"),
          mode !== "replacement",
          "source replacement retains its own proof protocol",
        );
        const known = turn === 1 || mode === "specified" ||
          mode === "unowned" || mode === "browse" || subjectMode;
        const empty = (turn === 1 && mode === "new_topic") || mode === "browse";
        const args = {
          ...(schema.required.includes("selection_subject")
            ? {
              selection_subject: {
                customer_phrase: subjectMode
                  ? subjectPhrase
                  : "монтажные крепления",
                catalog_classification_id:
                  subjectMode && mode !== "subject_literal" ? "f1v0" : "",
              },
            }
            : {}),
          ...(mode !== "missing" && mode !== "replacement"
            ? {
              selection_readiness: {
                decision: known || mode === "mislabelled_ready"
                  ? "ready"
                  : "needs_input",
                critical_inputs: empty ? [] : [{
                  parameter: "Материал основания",
                  customer_quote: known ? "Бетон" : "",
                  question: known ? "" : question,
                  impact:
                    "От материала основания зависит физическая совместимость крепления.",
                }],
              },
            }
            : {}),
          reasoning: empty || mode === "replacement"
            ? "Покажу монтажные крепления из каталога для выбора."
            : known
            ? subjectMode
              ? `Подбираю ${
                turn === 1 && mode !== "subject_literal"
                  ? subjectClass
                  : subjectPhrase
              } для стены; Материал основания: Бетон указан клиентом. Диаметр изделия — 8 мм.`
              : "Подбираю монтажные крепления для стены; Материал основания: Бетон указан клиентом."
            : "",
          retrieval_query: known || mode === "replacement"
            ? subjectMode
              ? turn === 1 && mode !== "subject_literal"
                ? subjectClass
                : subjectPhrase
              : "монтажные крепления"
            : "",
          measurement_scope: subjectMode ? "per_product" : "not_applicable",
          compatible_classifications: subjectMode && mode !== "subject_literal"
            ? ["f1v0"]
            : [],
          excluded_classifications: [],
          required_facet_values: known && !empty
            ? (schema.properties.required_facet_values.items.enum ?? [])
            : [],
          explicit_customer_classifications: [],
        };
        return json({
          choices: [{
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [{
                id: `reasoning-${turn}`,
                type: "function",
                function: {
                  name: "declare_selection_reasoning",
                  arguments: JSON.stringify(args),
                },
              }],
            },
          }],
        });
      }
      throw Error(`Unexpected offline request ${request.method} ${url}`);
    };
    const messages = [
      mode === "replacement"
        ? "Предложи аналоги монтажного крепления Alpha 3 м"
        : mode === "browse"
        ? "Покажи монтажные крепления"
        : subjectMode
        ? `Подбери ${subjectPhrase} для стены. Бетон, диаметр ${subjectPhrase} 8 мм`
        : mode === "specified"
        ? `${initial}. Бетон`
        : initial,
    ];
    if (
      [
        "roundtrip",
        "forged",
        "new_topic",
        "progress",
        "subject",
        "subject_single",
      ].includes(mode)
    ) {
      messages.push(
        mode === "new_topic"
          ? "Новая тема. Покажи монтажные крепления"
          : mode === "progress"
          ? "покажи"
          : subjectMode
          ? subjectClass
          : "Бетон",
      );
    }
    let slots: Event = {};
    const sessionId = "77777777-7777-4777-8777-777777777777";
    for (turn = 0; turn < messages.length; turn++) {
      if (turn === 1) {
        const issued = pending(result[0]);
        assert(
          issued,
          "first turn must issue a real pending question: " +
            JSON.stringify(logs[0]?.steps),
        );
        const echoed = structuredClone(issued);
        if (mode === "forged") echoed.slot_id = "forged-slot";
        slots = { pending_clarification: echoed };
      }
      const response = await offlineHandler()(
        new Request(
          "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: messages[turn],
              messageId: crypto.randomUUID(),
              sessionId,
              slots,
              history: turn
                ? [{ role: "user", content: messages[0] }, {
                  role: "assistant",
                  content: "Подменённая история: ищи другой товар",
                }]
                : [],
            }),
          },
        ),
      );
      const stream = await response.text();
      assertEquals(response.status, 200, stream);
      result.push(
        stream.split("\n\n").filter((line) =>
          line.startsWith("data: ") && line !== "data: [DONE]"
        ).map((line) => JSON.parse(line.slice(6))),
      );
    }
    return { turns: result, logs, requests, modelCalls };
  } finally {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = previousInterval;
    globalThis.fetch = previousFetch;
    Deno.env.get = previousEnv;
  }
}

Deno.test({
  name:
    "strict HTTP: question and server-owned reply restore the original product before catalog search",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const r = await scenario("roundtrip");
    assertEquals(pending(r.turns[0])?.question, question);
    assertEquals(
      r.modelCalls[0],
      1,
      "readiness reuses existing reasoning call",
    );
    assert(
      !r.logs[0].steps.some((s) =>
        s.step === "v3_tool_call" && s.meta?.tool === "search_catalog"
      ),
    );
    const boundary = r.logs[1].steps.find((s) =>
      s.step === "v3_conversation_boundary"
    );
    assertEquals(boundary?.meta?.verified_selection_readiness_slot, true);
    const discovery = r.logs[1].steps.find((s) =>
      s.step === "v3_tool_call" && s.meta?.tool === "discover_category"
    );
    assert(
      JSON.stringify(discovery?.meta?.args).includes("крепления"),
      JSON.stringify(r.logs[1].steps),
    );
    assert(JSON.stringify(discovery?.meta?.args).includes("Бетон"));
    assert(
      !r.logs[1].steps.some((s) =>
        s.step === "v3_tool_call" && s.meta?.error_code === "category_not_found"
      ),
    );
    assert(
      protocol(r.turns[1]).some((e) => e.type === "products_block"),
      JSON.stringify(r.logs[1].steps),
    );
  },
});

Deno.test({
  name:
    "strict HTTP: lexical category gap asks a live class and a verified choice reaches cards without a sibling or conflicting diameter",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const s = await scenario("subject");
    const issued = pending(s.turns[0]);
    assert(issued);
    assertEquals((issued.options as Event[]).map((o) => o.value), [
      "бур по бетону",
      "сверло по металлу",
    ]);
    assert(
      !s.requests[0].some((u) => new URL(u).pathname === "/api/products"),
      "unconfirmed class must not search products",
    );
    const cards = protocol(s.turns[1]).filter((e) =>
      e.type === "products_block"
    );
    assert(cards.length > 0, JSON.stringify(s.logs[1].steps));
    assertEquals(
      cards.reduce((n, e) => n + Number(e.count), 0),
      1,
      JSON.stringify({
        cards,
        steps: s.logs[1].steps.filter((x) =>
          /criteria|facet|subject|render/.test(x.step)
        ),
      }),
    );
    assert(
      s.logs[1].steps.some((s) =>
        s.step === "v3_selection_subject_decision" && s.meta?.status === "ready"
      ),
    );
    assert(s.requests[1].some((u) => new URL(u).pathname === "/api/products"));
  },
});
Deno.test({
  name:
    "strict HTTP: a subject declaration cannot override the earlier rejected category guard",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const s = await scenario("subject_other");
    assert(
      s.logs[0].steps.some((s) =>
        s.step === "v3_discovery_result_target_mismatch"
      ),
    );
    assert(
      !s.logs[0].steps.some((s) => s.step === "v3_selection_subject_decision"),
    );
    assert(!protocol(s.turns[0]).some((e) => e.type === "products_block"));
    assert(!s.requests[0].some((u) => new URL(u).pathname === "/api/products"));
  },
});
Deno.test({
  name:
    "strict HTTP: singleton live class uses one real chip and completes the same verified subject roundtrip",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const s = await scenario("subject_single");
    const issued = pending(s.turns[0]);
    assert(issued, JSON.stringify(s.logs[0].steps));
    assertEquals((issued.options as Event[]).length, 1);
    assert(
      protocol(s.turns[1]).some((e) => e.type === "products_block"),
      JSON.stringify(s.logs[1].steps),
    );
  },
});
Deno.test({
  name:
    "strict HTTP: a literal customer class survives an unrelated category label without an alias or another question",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const s = await scenario("subject_literal");
    assertEquals(pending(s.turns[0]), undefined);
    assert(
      protocol(s.turns[0]).some((e) => e.type === "products_block"),
      JSON.stringify(s.logs[0].steps),
    );
  },
});

for (const mode of ["missing", "unowned"] as const) {
  Deno.test({
    name: `strict HTTP: ${mode} readiness cannot enter search or repair`,
    permissions: { read: true, env: false, net: false },
    async fn() {
      const r = await scenario(mode);
      assertEquals(r.modelCalls[0], 1);
      const decision = r.logs[0].steps.find((s) =>
        s.step === "v3_selection_readiness_decision"
      );
      assertEquals(decision?.meta?.status, "invalid");
      assert(
        !r.logs[0].steps.some((s) =>
          s.step === "v3_tool_call" &&
          ["search_catalog", "render_products"].includes(String(s.meta?.tool))
        ),
      );
    },
  });
}

Deno.test({
  name:
    "strict HTTP: forged pending cannot inherit the server task or render cards",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const r = await scenario("forged");
    const boundary = r.logs[1].steps.find((s) =>
      s.step === "v3_conversation_boundary"
    );
    assertEquals(boundary?.meta?.verified_selection_readiness_slot, false);
    assert(!protocol(r.turns[1]).some((e) => e.type === "products_block"));
  },
});

Deno.test({
  name: "strict HTTP: explicit new topic drops the old missing-input task",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const r = await scenario("new_topic");
    assertEquals(
      r.logs[1].steps.find((s) => s.step === "v3_conversation_boundary")?.meta
        ?.mode,
      "new_task",
    );
    const discovery = r.logs[1].steps.find((s) =>
      s.step === "v3_tool_call" && s.meta?.tool === "discover_category"
    );
    assert(!JSON.stringify(discovery?.meta?.args).includes("для стены"));
  },
});

Deno.test({
  name:
    "strict HTTP: bare progress reissues the proven question without model/catalog calls",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const r = await scenario("progress");
    assertEquals(pending(r.turns[1])?.question, question);
    assertEquals(r.modelCalls[1], 0);
    assertEquals(r.requests[1], []);
  },
});

Deno.test({
  name:
    "strict HTTP: plain assortment renders without a customer questionnaire",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const r = await scenario("browse");
    assert(!pending(r.turns[0]));
    assert(
      protocol(r.turns[0]).some((event) => event.type === "products_block"),
      JSON.stringify(r.logs[0].steps),
    );
  },
});

Deno.test({
  name: "strict HTTP: source replacement retains its own source-proof protocol",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const r = await scenario("replacement");
    assert(r.modelCalls[0] > 0);
    assert(
      !r.logs[0].steps.some((step) =>
        step.step === "v3_selection_readiness_decision"
      ),
    );
    assert(
      !protocol(r.turns[0]).some((event) => event.type === "products_block"),
      "an unproved replacement is still blocked by its established proof gate",
    );
  },
});

Deno.test({
  name: "strict HTTP: a supplied critical fact is not asked again",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const r = await scenario("specified");
    assert(!pending(r.turns[0]));
    assert(
      !r.logs[0].steps.some((s) =>
        s.step === "v3_selection_input_decision" &&
        s.meta?.decision === "clarify"
      ),
    );
    assert(
      protocol(r.turns[0]).some((e) => e.type === "products_block"),
      JSON.stringify(r.logs[0].steps),
    );
  },
});

Deno.test({
  name:
    "strict HTTP: a ready label cannot override the model's declared missing critical input",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const r = await scenario("mislabelled_ready");
    assertEquals(pending(r.turns[0])?.question, question);
    assertEquals(r.modelCalls[0], 1);
    assert(
      !r.logs[0].steps.some((s) =>
        s.step === "v3_tool_call" && s.meta?.tool === "search_catalog"
      ),
    );
  },
});
