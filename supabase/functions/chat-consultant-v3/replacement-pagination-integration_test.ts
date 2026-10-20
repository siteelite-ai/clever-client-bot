// Offline production-handler regression for structural replacement pagination.
// A nonempty first page is not a complete plural answer. All outbound calls
// are intercepted; this test uses neither the live catalog nor a paid model.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  offlineHandler,
  restoreOfflineModuleSetup,
} from "./model-no-search-integration-fixture.ts";
import "./index.ts";

const leaf = "Светильники";
const sourceTitle =
  "Светильник DN027B G2 LED6/NW 7W 220-240V D90 R; 929002070102";
const sourceArticle = "929002070102";
const message = `предложи аналоги на ${sourceTitle}`;

const traits = [
  ["kind", "Вид светильника", "даунлайт"],
  ["mount", "Способ монтажа", "встраиваемый"],
  ["diameter", "Диаметр, см", "9"],
  ["power", "Мощность ламп, Вт", "7"],
  ["flux", "Световой поток, Лм", "600"],
  ["voltage", "Напряжение, В", "220"],
] as const;

function product(id: number, eligible = true) {
  return {
    id,
    pagetitle: id === 1
      ? sourceTitle
      : eligible
      ? `Светильник встраиваемый альтернативный ${id}`
      : `Светильник линейный неподходящий ${id}`,
    article: id === 1 ? sourceArticle : String(900000000000 + id),
    url: `https://220volt.kz/catalog/svetotexnika/svetilniki/item-${id}/`,
    category: leaf,
    price: 1200 + id,
    warehouses: [{ city: "Караганда", amount: 5 }],
    options: [
      ...traits.map(([key, caption, value]) => ({
        key,
        caption_ru: caption,
        value_ru: !eligible && key === "kind" ? "линейный" : value,
      })),
      // Synthetic proof for the guarded route. The real DN027B card lacks a
      // verified cutout, so the live handler must still ask the customer.
      { key: "cutout", caption_ru: "Монтажное отверстие, мм", value_ru: "90" },
      { key: "lamp_technology", caption_ru: "Тип лампы", value_ru: "LED" },
      { key: "lamp_socket", caption_ru: "Цоколь", value_ru: "нет" },
    ],
  };
}

const source = product(1);
const firstEligible = product(2);
const firstPage = [
  firstEligible,
  firstEligible,
  ...Array.from({ length: 48 }, (_, i) => product(100 + i, false)),
];
const completeFirstPage = [
  firstEligible,
  ...Array.from({ length: 49 }, (_, i) => product(100 + i, false)),
];

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseEvents(stream: string): Array<Record<string, unknown>> {
  return stream.split("\n\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

type Run = {
  events: Array<Record<string, unknown>>;
  steps: Array<{ step?: string; meta?: Record<string, unknown> }>;
  catalogPages: number[];
  outbound: string[];
};

async function runTurn(
  secondPageEligibleIds: number[],
  { completeWindow = false, sourceHasCutout = true }: {
    completeWindow?: boolean;
    sourceHasCutout?: boolean;
  } = {},
): Promise<Run> {
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  const outbound: string[] = [];
  const catalogPages: number[] = [];
  let steps: Run["steps"] = [];

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
      outbound.push(`${request.method} ${url}`);

      if (url.origin === "https://fixture.supabase.invalid") {
        if (
          url.pathname === "/rest/v1/chat_request_logs" &&
          request.method === "POST"
        ) {
          return json({ id: "offline-replacement-log" }, 201);
        }
        if (
          url.pathname === "/rest/v1/chat_request_logs" &&
          request.method === "PATCH"
        ) {
          const body = await request.json() as { steps?: Run["steps"] };
          steps = body.steps ?? [];
          return new Response(null, { status: 204 });
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
        if (url.pathname.startsWith("/rest/v1/") && request.method === "POST") {
          return json({}, 201);
        }
      }

      if (url.origin === "https://fixture.catalog.invalid") {
        if (url.pathname === "/api/categories") {
          return json({
            data: {
              results: [{ id: 10, pagetitle: leaf, children: [] }],
              pagination: { page: 1, per_page: 200, pages: 1, total: 1 },
            },
          });
        }
        if (url.pathname === "/api/categories/options") {
          return json({
            data: {
              category: { id: 10, pagetitle: leaf, total_products: 100 },
              options: traits.map(([key, caption, value]) => ({
                key,
                caption_ru: caption,
                type: "string",
                values: [
                  { value_ru: value, products_count: 50 },
                  ...key === "kind"
                    ? [{ value_ru: "линейный", products_count: 50 }]
                    : [],
                ],
              })),
            },
          });
        }
        if (url.pathname === "/api/products") {
          if (
            url.searchParams.has("article") || url.searchParams.has("pagetitle")
          ) {
            return json({
              data: {
                results: [sourceHasCutout ? source : {
                  ...source,
                  options: source.options.filter(({ key }) => key !== "cutout"),
                }],
                pagination: { total: 1 },
              },
            });
          }
          if (url.searchParams.has("query")) {
            return json({
              data: {
                results: [sourceHasCutout ? source : {
                  ...source,
                  options: source.options.filter(({ key }) => key !== "cutout"),
                }],
                pagination: { total: 1 },
              },
            });
          }
          assertEquals(url.searchParams.get("category"), leaf);
          const page = Number(url.searchParams.get("page") ?? "1");
          catalogPages.push(page);
          if (page === 1) {
            return json({
              data: {
                results: completeWindow ? completeFirstPage : firstPage,
                pagination: { total: completeWindow ? 50 : 100 },
              },
            });
          }
          if (page === 2) {
            // The upstream can repeat a product within and across pages. A
            // duplicate ID must not consume a slot or appear twice in cards.
            const second = [
              firstEligible,
              ...secondPageEligibleIds.map((id) => product(id)),
            ];
            second.push(
              ...Array.from(
                { length: 50 - second.length },
                (_, i) => product(200 + i, false),
              ),
            );
            return json({
              data: { results: second, pagination: { total: 100 } },
            });
          }
          throw new Error(`Unexpected catalog page ${page}`);
        }
      }

      if (url.toString() === "https://openrouter.ai/api/v1/chat/completions") {
        const body = await request.json() as {
          messages?: Array<{ content?: string }>;
        };
        if (
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
        // If this fixture ever leaves the deterministic direct route, fail
        // visibly instead of making an arbitrary model-authored answer pass.
        throw new Error("Replacement unexpectedly delegated to the model");
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
            message,
            messageId: crypto.randomUUID(),
            sessionId: crypto.randomUUID(),
            history: [],
          }),
        },
      ),
    );
    assertEquals(response.status, 200);
    return {
      events: sseEvents(await response.text()),
      steps,
      catalogPages,
      outbound,
    };
  } finally {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
  }
}

function productBlocks(events: Run["events"]) {
  return events.flatMap((event) => {
    const block = event.v3_event as {
      type?: string;
      count?: number;
      markdown?: string;
      selection_contract?: {
        result_cardinality?: { minimum?: number; target?: number };
      };
    } | undefined;
    return block?.type === "products_block" ? [block] : [];
  });
}

function visibleText(events: Run["events"]): string {
  return events.flatMap((event) => {
    const choices = event.choices as
      | Array<{ delta?: { content?: string } }>
      | undefined;
    return choices?.map((choice) => choice.delta?.content ?? "") ?? [];
  }).join("");
}

Deno.test({
  name:
    "plural exact-source replacement paginates, dedupes IDs and reports partial shortfall",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const full = await runTurn([3, 4, 5, 6]);
      const fullBlocks = productBlocks(full.events);
      assertEquals(fullBlocks.length, 1, JSON.stringify(full.steps));
      assertEquals(fullBlocks[0].count, 5);
      assertEquals(
        fullBlocks[0].selection_contract?.result_cardinality?.minimum,
        3,
      );
      assertEquals(
        fullBlocks[0].selection_contract?.result_cardinality?.target,
        5,
      );
      // Guarded retrieval can probe several filter stages on page 1 before
      // widening to page 2; only the latter proves pagination completed.
      assert(full.catalogPages.includes(2), JSON.stringify(full.catalogPages));
      assert(full.catalogPages.every((page) => page === 1 || page === 2));
      for (const id of [2, 3, 4, 5, 6]) {
        assert(fullBlocks[0].markdown?.includes(`альтернативный ${id}`));
      }
      assertEquals(
        fullBlocks[0].markdown?.match(/альтернативный 2\b/gu)?.length,
        1,
        "the repeated upstream ID must appear only once",
      );
      assert(
        full.steps.some(({ step, meta }) =>
          step === "v3_replacement_guarded_window" &&
          meta?.selected === 5 &&
          Number(meta?.tool_pages) >= 2
        ),
        JSON.stringify(full.steps),
      );

      const short = await runTurn([3]);
      const shortBlocks = productBlocks(short.events);
      assertEquals(shortBlocks.length, 1, JSON.stringify(short.steps));
      assertEquals(shortBlocks[0].count, 2);
      assert(short.catalogPages.includes(2), JSON.stringify(short.catalogPages));
      assert(short.catalogPages.every((page) => page === 1 || page === 2));
      const disclosure = visibleText(short.events);
      assert(disclosure.includes("подтвердить 2 варианта"), disclosure);
      assert(
        disclosure.includes("Полноту поиска подтвердить не удалось"),
        disclosure,
      );
      assert(!disclosure.includes("аналогов нет"), disclosure);

      // A single structurally screened card can also be the complete *filtered query*
      // result. That is a catalog-evidence shortage, not a pagination defect:
      // do not manufacture extra cards or silently weaken structural gates.
      const complete = await runTurn([], { completeWindow: true });
      const completeBlocks = productBlocks(complete.events);
      assertEquals(completeBlocks.length, 1, JSON.stringify(complete.steps));
      assertEquals(completeBlocks[0].count, 1);
      assert(complete.catalogPages.length > 0);
      assert(complete.catalogPages.every((page) => page === 1));
      assert(
        visibleText(complete.events).includes(
          "Пока удалось подтвердить 1 вариант",
        ),
      );
      assert(
        complete.steps.some(({ step, meta }) =>
          step === "v3_replacement_guarded_window" &&
          meta?.selected === 1 && Number(meta?.tool_pages) >= 1
        ),
        JSON.stringify(complete.steps),
      );

      // The actual source card has no verified cut-out in catalog evidence.
      // It must ask before any shortlist or paid model call, rather than
      // treating the model code D90 or generic diameter as proof.
      const unknownCutout = await runTurn([], { sourceHasCutout: false });
      assertEquals(productBlocks(unknownCutout.events).length, 0);
      assertEquals(unknownCutout.catalogPages, []);
      assert(
        visibleText(unknownCutout.events).includes("диаметр монтажного отверстия"),
      );
      assert(
        unknownCutout.steps.some(({ step }) =>
          step === "v3_replacement_cutout_question_issued"
        ),
        JSON.stringify(unknownCutout.steps),
      );
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});
