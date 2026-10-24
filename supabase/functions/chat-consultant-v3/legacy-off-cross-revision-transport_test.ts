// Portable, deterministic transport probe for default-OFF regression review.
// A temporary import map can redirect only ./index.ts to a clean archived
// revision for a literal main/PR119/PR120 comparison. No handler is copied.
// All Supabase, catalog and model calls are intercepted; unknown calls fail.
// The normalized JSON (cards, contracts, chips, safe search parameters) is
// compared to the pinned SHA-256; only the digest is printed by default.
// Baseline: published origin/main da6313ac578f65e587858b2212412cdee44e372c;
// also checked against PR119 base 0f3a0efa5a3af8b550488b4216e069fd314bb0f2.
// This does not establish live catalog quality or provider reliability.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  offlineHandler,
  restoreFixture,
} from "./legacy-off-cross-revision-fixture.ts";
import "./index.ts";

type Event = { v3_event?: Record<string, unknown>; choices?: unknown[] };
type Log = {
  id: string;
  session_id: string;
  user_query: string;
  error: string | null;
  created_at: string;
  response_events: Array<Record<string, unknown>>;
};
type Probe = {
  name: string;
  status: number;
  events: Event[];
  requests: string[];
};

const gallantCategory = "Розетки";
const gallantProducts = [
  [201, "Розетка двойная Gallant черный/хром", 6343],
  [202, "Розетка двойная Gallant графит", 6500],
  [203, "Розетка одноместная Gallant белая", 2800],
] as const;
const gallantSwitch = [204, "Выключатель Gallant графит", 2500] as const;
const cableCategory = "Кабель ВВГ";
const cableProducts = [
  [301, "Кабель ВВГ 2*1,5 ГОСТ А", 380],
  [302, "Кабель ВВГ 2*1,5 ГОСТ Б", 320],
  [303, "Кабель ВВГ 3*1,5 ГОСТ В", 100],
] as const;

function item(
  id: number,
  title: string,
  price: number,
  category: string,
) {
  return {
    id,
    pagetitle: title,
    article: `FIX-${id}`,
    url: `https://220volt.kz/catalog/fixture/${
      category === gallantCategory ? "rozetki" : "kabel"
    }/item-${id}/`,
    category,
    price,
    warehouses: [{ city: "Караганда", amount: 5 }],
    options: category !== cableCategory
      ? [
        { key: "kollektsiya", caption_ru: "Коллекция", value_ru: "Gallant" },
        {
          key: "tip",
          caption_ru: "Тип",
          value_ru: category === gallantCategory ? "Розетка" : "Выключатель",
        },
        {
          key: "kolichestvo_razyemov",
          caption_ru: "Количество разъемов",
          value_ru: title.includes("двойная") ? "2" : "1",
        },
        {
          key: "edinica_izmereniya",
          caption_ru: "Единица измерения",
          value_ru: "шт",
        },
      ]
      : [
        { key: "tip_kabelya", caption_ru: "Тип кабеля", value_ru: "ВВГ" },
        {
          key: "sechenie",
          caption_ru: "Сечение",
          value_ru: title.includes("3*1,5") ? "3*1,5" : "2*1,5",
        },
        {
          key: "edinica_izmereniya",
          caption_ru: "Единица измерения",
          value_ru: "м",
        },
      ],
  };
}

const products = [
  ...gallantProducts.map(([id, title, price]) =>
    item(id, title, price, gallantCategory)
  ),
  item(gallantSwitch[0], gallantSwitch[1], gallantSwitch[2], "Выключатели"),
  ...cableProducts.map(([id, title, price]) =>
    item(id, title, price, cableCategory)
  ),
];

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseEvents(source: string): Event[] {
  return source.split("\n\n")
    .filter((part) => part.startsWith("data: ") && part !== "data: [DONE]")
    .map((part) => JSON.parse(part.slice(6)) as Event);
}

function normalized(probe: Probe) {
  return {
    name: probe.name,
    status: probe.status,
    products: probe.events.flatMap(({ v3_event }) =>
      v3_event?.type === "products_block"
        ? [{
          count: v3_event.count,
          markdown: v3_event.markdown,
          selection_contract: v3_event.selection_contract ?? null,
        }]
        : []
    ),
    choices: probe.events.flatMap(({ v3_event }) =>
      v3_event?.type === "quick_replies"
        ? [{
          replies: v3_event.replies,
          facet_key: v3_event.facet_key,
        }]
        : []
    ),
    scopes: probe.events.flatMap(({ v3_event }) =>
      v3_event?.type === "active_selection_scope"
        ? [{
          ...(v3_event.scope as Record<string, unknown>),
          source_slot_id: typeof (v3_event.scope as Record<string, unknown>)
                  ?.source_slot_id === "string" &&
              /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(
                String(
                  (v3_event.scope as Record<string, unknown>)
                    .source_slot_id,
                ),
              )
            ? "<server-issued>"
            : (v3_event.scope as Record<string, unknown>)?.source_slot_id,
        }]
        : []
    ),
    catalog_searches: probe.requests
      .filter((request) =>
        request.startsWith("GET https://fixture.catalog.invalid/api/products?")
      )
      .map((request) => {
        const url = new URL(request.slice(4));
        return [...url.searchParams.entries()].sort(([a], [b]) =>
          a.localeCompare(b)
        );
      }),
    private_fact_reads:
      probe.requests.filter((request) =>
        request.includes("/rest/v1/verified_product_facts")
      ).length,
  };
}

Deno.test({
  name: "portable OFF transport probe for published and draft revisions",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const realFetch = globalThis.fetch;
    const realSetInterval = globalThis.setInterval;
    const timers = new Set<number>();
    const logs: Log[] = [];
    const requests: string[] = [];
    let activeMessage = "";
    let modelCalls = 0;
    try {
      globalThis.setInterval = ((callback, delay, ...args) => {
        const id = realSetInterval(callback, delay, ...args);
        timers.add(id);
        return id;
      }) as typeof setInterval;
      globalThis.fetch = async (input, init) => {
        const request = input instanceof Request
          ? input
          : new Request(input, init);
        const url = new URL(request.url);
        requests.push(`${request.method} ${url}`);
        if (url.origin === "https://fixture.supabase.invalid") {
          if (url.pathname === "/rest/v1/verified_product_facts") {
            throw new Error("OFF handler must not read private facts");
          }
          if (url.pathname === "/rest/v1/chat_request_logs") {
            if (request.method === "POST") {
              const body = await request.json() as Record<string, unknown>;
              const id = `probe-log-${logs.length + 1}`;
              logs.push({
                id,
                session_id: String(body.session_id ?? ""),
                user_query: String(body.user_query ?? activeMessage),
                error: "in_progress",
                created_at: new Date(Date.now() - logs.length * 1000)
                  .toISOString(),
                response_events: [],
              });
              return json({ id }, 201);
            }
            if (request.method === "PATCH") {
              const body = await request.json() as Record<string, unknown>;
              const log = logs.at(-1);
              if (log) {
                log.error = typeof body.error === "string" ? body.error : null;
                log.response_events = Array.isArray(body.response_events)
                  ? body.response_events as Log["response_events"]
                  : [];
              }
              return new Response(null, { status: 204 });
            }
            if (request.method === "GET") {
              const prior = logs.at(-2);
              const selected = url.searchParams.get("select") ?? "";
              if (selected.includes("response_events") && prior) {
                return json(prior);
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
                results: [
                  { id: 10, pagetitle: gallantCategory, children: [] },
                  { id: 11, pagetitle: "Выключатели", children: [] },
                  { id: 12, pagetitle: cableCategory, children: [] },
                ],
                pagination: { page: 1, per_page: 200, pages: 1, total: 3 },
              },
            });
          }
          if (url.pathname === "/api/categories/options") {
            const category = url.searchParams.get("pagetitle") ??
              gallantCategory;
            return json({
              data: {
                category: {
                  id: category === cableCategory ? 12 : 10,
                  pagetitle: category,
                  total_products: 3,
                },
                options: category === cableCategory
                  ? [{
                    key: "sechenie",
                    caption_ru: "Сечение",
                    type: "string",
                    values: [{ value_ru: "2*1,5", products_count: 2 }],
                  }]
                  : [
                    {
                      key: "kollektsiya",
                      caption_ru: "Коллекция",
                      type: "string",
                      values: [{ value_ru: "Gallant", products_count: 3 }],
                    },
                    {
                      key: "kolichestvo_razyemov",
                      caption_ru: "Количество разъемов",
                      type: "number",
                      values: [{ value_ru: "1", products_count: 1 }, {
                        value_ru: "2",
                        products_count: 2,
                      }],
                    },
                  ],
              },
            });
          }
          if (url.pathname === "/api/products") {
            const category = url.searchParams.get("category");
            const query = (url.searchParams.get("query") ?? "").toLowerCase();
            // Deliberately return the broad live pool even for facet-filtered
            // requests. The handler's final per-card gate must enforce both
            // the selected series and the two-socket criterion.
            const relevant = category
              ? products.filter((item) => item.category === category)
              : query.includes("кабел")
              ? products.filter((item) => item.category === cableCategory)
              : products.filter((item) => item.category !== cableCategory);
            return json({
              data: {
                results: relevant,
                pagination: { total: relevant.length },
              },
            });
          }
        }
        if (
          url.toString() === "https://openrouter.ai/api/v1/chat/completions"
        ) {
          modelCalls++;
          const body = await request.json() as {
            messages?: Array<{ content?: string }>;
            tool_choice?: { function?: { name?: string } };
            tools?: Array<{ function?: { name?: string } }>;
          };
          if (
            body.messages?.some(({ content }) =>
              content?.includes("CATEGORY MATCHER")
            )
          ) {
            const leaf = activeMessage.toLowerCase().includes("кабел")
              ? cableCategory
              : gallantCategory;
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
            body.tool_choice?.function?.name === "declare_selection_reasoning"
          ) {
            return json({
              choices: [{
                finish_reason: "tool_calls",
                message: {
                  content: null,
                  tool_calls: [{
                    id: `probe-reasoning-${modelCalls}`,
                    type: "function",
                    function: {
                      name: "declare_selection_reasoning",
                      arguments: JSON.stringify({
                        reasoning: activeMessage.toLowerCase().includes("кабел")
                          ? "Ищу точную маркировку ВВГ 2×1,5 и минимальную цену за метр."
                          : "Проверяю двойные розетки серии Gallant с двумя разъёмами в каталоге.",
                        measurement_scope: "not_applicable",
                        compatible_classifications: [],
                        excluded_classifications: [],
                        required_facet_values: activeMessage.includes("двойные")
                          ? [{ key: "Количество разъемов", value: "2" }]
                          : [],
                        explicit_customer_classifications: [],
                      }),
                    },
                  }],
                },
              }],
            });
          }
          if (
            body.tools?.some(({ function: tool }) =>
              tool?.name === "search_catalog"
            )
          ) {
            return json({
              choices: [{
                finish_reason: "tool_calls",
                message: {
                  content: null,
                  tool_calls: [{
                    id: `probe-search-${modelCalls}`,
                    type: "function",
                    function: {
                      name: "search_catalog",
                      arguments: JSON.stringify({
                        mode: "by_filter",
                        category: activeMessage.toLowerCase().includes("кабел")
                          ? cableCategory
                          : gallantCategory,
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
        throw new Error(
          `Unexpected outbound request: ${request.method} ${url}`,
        );
      };

      async function turn(
        name: string,
        message: string,
        history: Array<{ role: "user" | "assistant"; content: string }>,
        slots: Record<string, unknown> = {},
        sessionId = "11111111-1111-4111-8111-111111111111",
      ): Promise<Probe> {
        activeMessage = message;
        const start = requests.length;
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
                history,
                slots,
              }),
            },
          ),
        );
        return {
          name,
          status: response.status,
          events: sseEvents(await response.text()),
          requests: requests.slice(start),
        };
      }

      const cable = await turn(
        "vvg-exact-cheapest",
        "найди кабель ВВГ 2*1,5 самый дешевый",
        [],
      );
      const gallant = await turn(
        "gallant-broad",
        "покажи ассортимент Gallant на сайте",
        [],
      );
      const pending = gallant.events.find(({ v3_event }) =>
        v3_event?.type === "slot_update"
      )
        ?.v3_event?.slots as
          | { pending_clarification?: Record<string, unknown> }
          | undefined;
      const boundary = gallant.events.find(({ v3_event }) =>
        v3_event?.type === "conversation_boundary"
      )
        ?.v3_event?.session_id;
      const gallantSection = await turn(
        "gallant-section",
        "Розетки",
        [
          { role: "user", content: "покажи ассортимент Gallant на сайте" },
          { role: "assistant", content: "Какой раздел Gallant показать?" },
        ],
        pending?.pending_clarification
          ? { pending_clarification: pending.pending_clarification }
          : {},
        typeof boundary === "string"
          ? boundary
          : "11111111-1111-4111-8111-111111111111",
      );
      const gallantDouble = await turn(
        "gallant-double-continuation",
        "двойные электрические розетки",
        [
          { role: "user", content: "покажи ассортимент Gallant на сайте" },
          { role: "assistant", content: "Какой раздел Gallant показать?" },
          { role: "user", content: "Розетки" },
          {
            role: "assistant",
            content: "Показываю товары Gallant в разделе Розетки.",
          },
        ],
        {},
        typeof boundary === "string"
          ? boundary
          : "11111111-1111-4111-8111-111111111111",
      );
      assertEquals(cable.status, 200);
      assertEquals(gallant.status, 200);
      assertEquals(gallantSection.status, 200);
      assertEquals(gallantDouble.status, 200);
      const snapshot = [
        normalized(cable),
        normalized(gallant),
        normalized(gallantSection),
        normalized(gallantDouble),
      ];
      for (const item of snapshot) assertEquals(item.private_fact_reads, 0);
      assertEquals(modelCalls, 1);
      assertEquals(snapshot.map((item) => item.products.length), [1, 0, 1, 1]);
      assertEquals(snapshot.map((item) => item.products[0]?.count ?? 0), [
        1,
        0,
        3,
        2,
      ]);
      assertEquals(snapshot[1].choices[0]?.facet_key, "catalog_section");
      assertEquals(
        snapshot[3].products[0]?.selection_contract &&
          (snapshot[3].products[0].selection_contract as {
            mandatory_criteria?: Array<{ key?: string; value?: unknown }>;
          }).mandatory_criteria?.map(({ key, value }) => [key, value]),
        [["Количество разъемов", "2"], ["Тип", "Розетка"], [
          "Коллекция",
          "Gallant",
        ]],
      );
      const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", bytes),
      );
      const digestHex = [...digest].map((byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
      assertEquals(
        digestHex,
        "5c457500fd3a9a65a5c917d71ec1ff9a970bc913d816a72944574eeb525dfbba",
        "OFF product cards, chips, catalog requests and selection contracts must match published main",
      );
      console.log(`OFF_TRANSPORT_SHA256=${digestHex}`);
    } finally {
      for (const id of timers) clearInterval(id);
      globalThis.setInterval = realSetInterval;
      globalThis.fetch = realFetch;
      restoreFixture();
    }
  },
});
