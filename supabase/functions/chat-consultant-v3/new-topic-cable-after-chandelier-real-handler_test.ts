// Six consecutive HTTP/SSE requests through the real V3 handler. Every
// dependency is intercepted: this proves the new-topic transport boundary and
// the next turn's server-owned continuation without spending model tokens.
import {
  assert,
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  offlineHandler,
  restoreOfflineModuleSetup,
} from "./model-no-search-integration-fixture.ts";
import { CUSTOMER_TURN_BOUNDARY } from "../_shared/v3-tools/criteria-consistency.ts";
import "./index.ts";

const offlineEnvGet = Deno.env.get;
const initialSession = "77777777-7777-4777-8777-777777777777";
const chandelierCategory = "Люстры";
const cableCategory = "Кабель ВВГ";
const messages = [
  "хочу поменять дома люстру в зале 30\nквадратов. Что предложишь из современного?",
  "Они точно подходят для освещения 30 квадратных метров?",
  "Почему варианты отличаются по цене? Сравни подтверждённые характеристики.",
  "А есть другие варианты?",
  "Новая тема. Найди кабель ВВГ 3×1,5",
  "А есть другие варианты?",
];

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

function chandelier(id: number, shape: string): Product {
  return {
    id,
    pagetitle: `Люстра светодиодная для гостиной Модель ${id}`,
    url: `https://220volt.kz/catalog/svetotexnika/lyustryi/fixture-${id}/`,
    category: chandelierCategory,
    price: 4_000 + 100 * id,
    warehouses: [{ city: "Караганда", amount: 3 }],
    options: [
      {
        key: "destination",
        caption_ru: "Назначение",
        value_ru: "для гостиной",
      },
      {
        key: "lighting_area",
        caption_ru: "Максимальная площадь освещения, м2",
        value_ru: "35",
      },
      { key: "shape", caption_ru: "Форма люстры", value_ru: shape },
    ],
  };
}

function cable(id: number): Product {
  return {
    id,
    pagetitle: `Кабель ВВГ 3*1,5 ГОСТ Модель ${id}`,
    url: `https://220volt.kz/catalog/kabeli-provoda/kabel-vvg/item-${id}/`,
    category: cableCategory,
    price: 100 + id,
    warehouses: [{ city: "Караганда", amount: 10 }],
    options: [
      { key: "tip_kabelya", caption_ru: "Тип кабеля", value_ru: "ВВГ" },
      { key: "sechenie", caption_ru: "Сечение", value_ru: "3*1,5" },
      {
        key: "edinica_izmereniya",
        caption_ru: "Единица измерения",
        value_ru: "м",
      },
    ],
  };
}

const firstChandeliers = [
  chandelier(1, "круг"),
  chandelier(2, "квадрат"),
  chandelier(3, "овал"),
];
const laterChandeliers = [
  chandelier(4, "овал"),
  chandelier(5, "круг"),
  chandelier(6, "квадрат"),
];
const firstCables = [cable(101), cable(102), cable(103)];
const laterCables = [cable(104), cable(105), cable(106)];

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
  }).join("\n") + "\n" + v3Events(events)
    .filter(({ type }) => type === "delta")
    .map(({ content }) => String(content ?? ""))
    .join("\n");
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

function normalized(value: string): string {
  return value.toLocaleLowerCase("ru").replace(/[×xх*]/gu, "*").replace(
    /ё/gu,
    "е",
  );
}

Deno.test({
  name:
    "four chandelier turns, explicit cable new topic, then cable-only continuation on rotated session",
  permissions: { read: true, env: false, net: false },
  async fn() {
    Deno.env.get = offlineEnvGet;
    const originalFetch = globalThis.fetch;
    const originalSetInterval = globalThis.setInterval;
    const intervals = new Set<number>();
    const logs: Log[] = [];
    const turns: Event[][] = [];
    const catalogReads: string[][] = messages.map(() => []);
    const modelRequests: string[][] = messages.map(() => []);
    const transportSessions: string[] = [];
    let activeTurn = 0;
    let sessionId = initialSession;
    let chandelierSession = initialSession;
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
              const body = await request.json() as Record<string, unknown>;
              const id = `offline-boundary-${activeTurn}`;
              logs.push({
                id,
                session_id: String(body.session_id ?? ""),
                user_query: String(body.user_query ?? ""),
                error: "in_progress",
                created_at: new Date(
                  Date.now() - (messages.length - activeTurn) * 1_000,
                ).toISOString(),
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
              Object.assign(log, await request.json());
              return new Response(null, { status: 204 });
            }
            if (request.method === "GET") {
              let rows = logs.filter(({ error }) => error !== "in_progress");
              const session = url.searchParams.get("session_id")?.replace(
                /^eq\./u,
                "",
              );
              const exclude = url.searchParams.get("id")?.replace(
                /^neq\./u,
                "",
              );
              if (session) {
                rows = rows.filter((row) => row.session_id === session);
              }
              if (exclude) rows = rows.filter((row) => row.id !== exclude);
              const boundary = url.searchParams.get("response_events");
              if (boundary) {
                assert(boundary.startsWith("cs."), boundary);
                const expected = JSON.parse(boundary.slice(3)) as Event[];
                rows = rows.filter((row) =>
                  expected.every((event) =>
                    row.response_events.some((candidate) =>
                      Object.entries(event).every(([key, value]) =>
                        candidate[key] === value
                      )
                    )
                  )
                );
              }
              rows = rows.slice().sort((a, b) =>
                b.created_at.localeCompare(a.created_at)
              );
              const limit = Number(url.searchParams.get("limit") ?? 8);
              rows = rows.slice(0, Number.isFinite(limit) ? limit : 8);
              const select = url.searchParams.get("select") ?? "";
              const selected = rows.map((row) => {
                const result = { ...row } as Record<string, unknown>;
                if (!select.includes("steps")) delete result.steps;
                if (!select.includes("final_products_count")) {
                  delete result.final_products_count;
                }
                if (!select.includes("response_events")) {
                  delete result.response_events;
                }
                return result;
              });
              return json(
                request.headers.get("Accept")?.includes(
                    "application/vnd.pgrst.object+json",
                  )
                  ? selected[0] ?? null
                  : selected,
              );
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
                results: [
                  { id: 1, pagetitle: chandelierCategory, children: [] },
                  { id: 2, pagetitle: cableCategory, children: [] },
                ],
                pagination: { page: 1, per_page: 200, pages: 1, total: 2 },
              },
            });
          }
          if (url.pathname === "/api/categories/options") {
            const isCable = url.searchParams.get("pagetitle") === cableCategory;
            return json({
              data: {
                category: {
                  id: isCable ? 2 : 1,
                  pagetitle: isCable ? cableCategory : chandelierCategory,
                  total_products: isCable ? 6 : 6,
                },
                options: isCable
                  ? [
                    {
                      key: "tip_kabelya",
                      caption_ru: "Тип кабеля",
                      type: "string",
                      values: [{ value_ru: "ВВГ", products_count: 6 }],
                    },
                    {
                      key: "sechenie",
                      caption_ru: "Сечение",
                      type: "string",
                      values: [{ value_ru: "3*1,5", products_count: 6 }],
                    },
                  ]
                  : [
                    {
                      key: "destination",
                      caption_ru: "Назначение",
                      type: "string",
                      values: [{ value_ru: "для гостиной", products_count: 6 }],
                    },
                    {
                      key: "lighting_area",
                      caption_ru: "Максимальная площадь освещения, м2",
                      type: "number",
                      unit: "м²",
                      values: [{ value_ru: "35", products_count: 6 }],
                    },
                    {
                      key: "shape",
                      caption_ru: "Форма люстры",
                      type: "string",
                      values: ["круг", "квадрат", "овал"].map((value_ru) => ({
                        value_ru,
                        products_count: 2,
                      })),
                    },
                  ],
              },
            });
          }
          if (url.pathname === "/api/products") {
            catalogReads[activeTurn].push(url.toString());
            const available = activeTurn <= 3
              ? activeTurn === 0
                ? firstChandeliers
                : [...firstChandeliers, ...laterChandeliers]
              : activeTurn === 4
              ? firstCables
              : [...firstCables, ...laterCables];
            const title = url.searchParams.get("pagetitle");
            const category = url.searchParams.get("category");
            const categoryIn = url.searchParams.getAll("category_in[]");
            const query = normalized(
              url.searchParams.get("query")?.trim() ?? "",
            );
            const facets = [...url.searchParams.entries()].flatMap(
              ([key, value]) => {
                const match = key.match(/^options\[([^\]]+)\]\[\]$/u);
                return match ? [{ key: match[1], value }] : [];
              },
            );
            const matching = available.filter((item) =>
              (!title || item.pagetitle === title) &&
              (!category || item.category === category) &&
              (categoryIn.length === 0 || categoryIn.includes(item.category)) &&
              (!query || normalized(item.pagetitle).includes(query)) &&
              facets.every(({ key, value }) =>
                item.options.some((option) =>
                  option.key === key &&
                  normalized(option.value_ru) === normalized(value)
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
          modelRequests[activeTurn].push(JSON.stringify(body));
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
                    candidates: [{
                      pagetitle: activeTurn >= 4
                        ? cableCategory
                        : chandelierCategory,
                      confidence: 0.99,
                    }],
                  }),
                },
              }],
            });
          }
          if (
            body.tool_choice?.function?.name === "declare_selection_reasoning"
          ) {
            const cableTurn = activeTurn >= 4;
            return modelTool("declare_selection_reasoning", {
              reasoning: cableTurn
                ? "Ищу в каталоге кабель ВВГ с точным сечением 3×1,5 по маркировке каждой карточки."
                : activeTurn === 0
                ? "Для зала 30 квадратов проверяю площадь освещения каждого товара по карточке. Форма люстры: квадрат."
                : "Для зала 30 квадратов проверяю назначение и площадь освещения каждого нового товара по каталогу.",
              retrieval_query: cableTurn
                ? "кабель ВВГ 3*1,5"
                : activeTurn === 0
                ? "квадратная люстра для гостиной"
                : "люстра для гостиной",
              // A compound cable marking is an exact identity, not a derived
              // physical-capacity calculation such as chandelier area.
              measurement_scope: cableTurn ? "not_applicable" : "per_product",
              compatible_classifications: [],
              excluded_classifications: [],
              required_facet_values: cableTurn
                ? []
                : activeTurn === 0
                ? ["f2v0"]
                : [],
              explicit_customer_classifications: [],
            });
          }
          if (body.tool_choice?.function?.name === "propose_candidates") {
            return modelTool("propose_candidates", {
              candidates: [activeTurn >= 4 ? "кабель ВВГ" : "люстра"],
            });
          }
          if (
            body.tools?.some(({ function: tool }) =>
              tool?.name === "search_catalog"
            )
          ) {
            return modelTool("search_catalog", {
              mode: "by_filter",
              category: activeTurn >= 4 ? cableCategory : chandelierCategory,
              per_page: 50,
              ...(activeTurn === 0 ? { options: { shape: ["квадрат"] } } : {}),
            });
          }
          return json({
            choices: [{
              finish_reason: "stop",
              message: {
                content: activeTurn === 1
                  ? "Проверяю заявленную площадь освещения каждого показанного светильника по карточке."
                  : activeTurn === 2
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

      for (activeTurn = 0; activeTurn < messages.length; activeTurn++) {
        const history = turns.flatMap((events, index) => [
          { role: "user" as const, content: messages[index] },
          {
            role: "assistant" as const,
            content: publicText(events) + v3Events(events)
              .filter(({ type }) => type === "products_block")
              .map(({ markdown }) => String(markdown ?? ""))
              .join("\n"),
          },
        ]);
        transportSessions.push(sessionId);
        const response = await offlineHandler()(
          new Request(
            "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                message: messages[activeTurn],
                messageId: crypto.randomUUID(),
                sessionId,
                history,
              }),
            },
          ),
        );
        assertEquals(response.status, 200, `turn ${activeTurn + 1}`);
        const events = eventsFromSse(await response.text());
        turns.push(events);
        assert(
          logs[activeTurn]?.response_events.some(({ type }) => type === "done"),
          `turn ${activeTurn + 1} did not persist terminal SSE events`,
        );
        const boundaries = v3Events(events).filter(({ type }) =>
          type === "conversation_boundary"
        );
        if (activeTurn === 0) {
          // The first complete request establishes its own session. Match the
          // public widget: use the server-emitted ID from the next turn on.
          assertEquals(boundaries.length, 1, JSON.stringify(events));
          sessionId = String(boundaries[0].session_id);
          chandelierSession = sessionId;
        } else if (activeTurn === 4) {
          assertEquals(boundaries.length, 1, JSON.stringify(events));
          assertEquals(boundaries[0].mode, "new_task");
          assertEquals(typeof boundaries[0].session_id, "string");
          assertNotEquals(boundaries[0].session_id, sessionId);
          sessionId = String(boundaries[0].session_id);
        } else {
          assertEquals(boundaries.length, 0, JSON.stringify(events));
        }
      }

      assertEquals(transportSessions[0], initialSession);
      assertEquals(transportSessions[4], chandelierSession);
      assertEquals(transportSessions[5], sessionId);
      assertNotEquals(chandelierSession, initialSession);
      assertNotEquals(sessionId, chandelierSession);
      assertEquals(
        turns.slice(4).flatMap(v3Events).filter(({ type }) =>
          type === "conversation_boundary"
        ).length,
        1,
        "the cable topic change must rotate exactly once",
      );
      assertEquals(logs[4].session_id, chandelierSession);
      assertEquals(logs[5].session_id, sessionId);
      assert(
        logs[4].response_events.some(({ type, session_id }) =>
          type === "conversation_boundary" && session_id === sessionId
        ),
      );
      assert(
        logs[4].steps.some(({ step, meta }) =>
          step === "v3_conversation_boundary" && meta?.mode === "new_task"
        ),
        JSON.stringify(logs[4].steps),
      );
      assert(
        logs[5].steps.some(({ step, meta }) =>
          step === "v3_conversation_boundary" && meta?.mode === "continuation"
        ),
        JSON.stringify(logs[5].steps),
      );

      const chandelierUrls = new Set(
        [...firstChandeliers, ...laterChandeliers].map(({ url }) => url),
      );
      const firstCableUrls = cardUrls(turns[4]);
      const nextCableUrls = cardUrls(turns[5]);
      assert(
        firstCableUrls.length >= 1,
        JSON.stringify({
          steps: logs[4].steps,
          text: publicText(turns[4]),
          reads: catalogReads[4],
        }),
      );
      assert(
        logs[5].steps.some(({ step, meta }) =>
          step === "v3_server_rendered_selection_base_checked" &&
          meta?.matched === true
        ),
        "the cable continuation must be tied to the completed server-rendered cable batch",
      );
      assert(
        logs[5].steps.some(({ step, meta }) =>
          step === "v3_elliptical_selection_context_resolved" &&
          meta?.excluded_urls === firstCableUrls.length
        ),
        "the cable continuation must exclude only the prior cable cards",
      );
      assert(
        !logs[5].steps.some(({ step }) =>
          step === "v3_product_measurement_unverified"
        ),
        "exact compound cable marking 3×1,5 must not become an unprojectable derived measurement on a verified follow-up",
      );
      assert(
        nextCableUrls.length >= 1,
        JSON.stringify({
          steps: logs[5].steps,
          text: publicText(turns[5]),
          reads: catalogReads[5],
        }),
      );
      assert(
        firstCableUrls.every((url) =>
          firstCables.some((item) => item.url === url)
        ),
        JSON.stringify(firstCableUrls),
      );
      assert(
        nextCableUrls.every((url) =>
          laterCables.some((item) => item.url === url)
        ),
        JSON.stringify(nextCableUrls),
      );
      assert(nextCableUrls.every((url) => !firstCableUrls.includes(url)));
      for (const index of [4, 5]) {
        const rendered = publicText(turns[index]) + v3Events(turns[index])
          .filter(({ type }) => type === "products_block")
          .map(({ markdown }) => String(markdown ?? "")).join("\n");
        assert(
          !rendered.includes(CUSTOMER_TURN_BOUNDARY),
          "internal customer-turn boundary must not reach customer-visible text",
        );
        assert(
          !/30\s*(?:м²|м2|квадрат)|гостин|люстр/iu.test(rendered),
          rendered,
        );
        assert(
          cardUrls(turns[index]).every((url) => !chandelierUrls.has(url)),
          rendered,
        );
        assert(
          catalogReads[index].every((raw) =>
            !/люстр|гостин|30\s*(?:м2|м²)/iu.test(decodeURIComponent(raw))
          ),
          JSON.stringify(catalogReads[index]),
        );
        const dialogModelInputs = modelRequests[index].flatMap((body) => {
          const parsed = JSON.parse(body) as {
            messages?: Array<{ role?: string; content?: string }>;
          };
          // Static system instructions can mention unrelated examples. Only
          // the caller's dialogue/input may carry stale session context.
          return parsed.messages?.filter(({ role }) => role !== "system")
            .map(({ content }) => String(content ?? "")) ?? [];
        });
        assert(
          dialogModelInputs.every((content) =>
            !/люстр|гостин|30\s*(?:м2|м²|квадрат)/iu.test(content)
          ),
          JSON.stringify(
            dialogModelInputs.filter((content) =>
              /люстр|гостин|30\s*(?:м2|м²|квадрат)/iu.test(content)
            ),
          ),
        );
      }
      assert(catalogReads[5].length > 0, JSON.stringify(logs[5].steps));
    } finally {
      for (const id of intervals) clearInterval(id);
      globalThis.setInterval = originalSetInterval;
      globalThis.fetch = originalFetch;
      restoreOfflineModuleSetup();
    }
  },
});
