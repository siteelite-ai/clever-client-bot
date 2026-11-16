// Production HTTP/SSE handler with a synthetic database and catalog.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resetDiscoverCategoryCacheForTest } from "../_shared/v3-tools/discover-category.ts";
import {
  offlineHandler,
  restoreOfflineModuleSetup,
} from "./model-no-search-integration-fixture.ts";
import "./index.ts";

const offlineEnvGet = Deno.env.get;
const category = "Автоматические выключатели";
const schema = [
  ["current", "Номинальный ток, А", "32", "25", "25–32"],
  ["poles", "Количество полюсов", "2", "1"],
  ["curve", "Характеристика срабатывания", "C", "B"],
  ["breaking", "Номинальная откл способность, кА", "6", "4.5"],
  ["voltage", "Номинальное рабочее напряжение, В", "230", "400"],
];
type Event = Record<string, unknown>;
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.test({
  name:
    "apartment load: start with supply and line, then search and strictly verify cards",
  permissions: { env: false, net: false, read: true },
  async fn() {
    resetDiscoverCategoryCacheForTest();
    Deno.env.get = offlineEnvGet;
    const fetch = globalThis.fetch;
    const sessionId = crypto.randomUUID();
    let turn = 0;
    let productsCalls = 0;
    let unexpectedCalls = 0;
    let filters: URLSearchParams | null = null;
    let stored: { response_events?: Event[]; steps?: Event[] }[] = [];
    try {
      const card = (id: string, key?: string, value?: string) => ({
        id,
        pagetitle: `Автомат C32 2P ${id}`,
        url: `https://220volt.kz/catalog/electric/breakers/${id}/`,
        category,
        price: 1500,
        warehouses: [{ city: "Караганда", amount: 2 }],
        options: schema.filter(([field]) =>
          field !== key || value !== undefined
        )
          .map(([field, caption_ru, first]) => ({
            key: field,
            caption_ru,
            value_ru: field === key ? value : first,
          })),
      });
      globalThis.fetch = async (input, init) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const url = new URL(req.url);
        if (url.origin === "https://fixture.supabase.invalid") {
          if (url.pathname === "/rest/v1/chat_request_logs") {
            if (req.method === "POST") {
              return json({ id: `circuit-${turn}` }, 201);
            }
            if (req.method === "PATCH") {
              stored[turn] = { ...stored[turn], ...await req.json() };
              return new Response(null, { status: 204 });
            }
            if (req.method === "GET") {
              return json(
                turn > 0 && stored[turn - 1]?.response_events
                  ? {
                    session_id: sessionId,
                    error: null,
                    response_events: stored[turn - 1].response_events,
                  }
                  : null,
              );
            }
          }
          if (url.pathname === "/rest/v1/app_settings") {
            return json({
              openrouter_api_key: "offline-model",
              volt220_api_token: "offline-catalog",
              classifier_model: "offline",
            });
          }
          if (url.pathname.startsWith("/rest/v1/")) {
            return json(req.method === "GET" ? [] : {});
          }
        }
        if (url.origin === "https://fixture.catalog.invalid") {
          if (url.pathname === "/api/categories") {
            return json({
              data: {
                results: [{ id: 10, pagetitle: category, children: [] }],
                pagination: { total: 1, pages: 1, page: 1, per_page: 200 },
              },
            });
          }
          if (url.pathname === "/api/categories/options") {
            return json({
              data: {
                category: { id: 10, pagetitle: category, total_products: 5 },
                options: schema.map(([key, caption_ru, ...values]) => ({
                  key,
                  caption_ru,
                  type: "string",
                  values: values.map((value_ru) => ({
                    value_ru,
                    products_count: 1,
                  })),
                })),
              },
            });
          }
          if (url.pathname === "/api/products") {
            productsCalls++;
            filters = url.searchParams;
            // Intentionally ignore the filters so only local per-card proofs
            // can stop missing/incorrect/ranged attributes from rendering.
            const results = [
              card("compatible"),
              card("wrong-current", "current", "25"),
              card("current-range", "current", "25–32"),
              card("no-voltage", "voltage"),
              card("low-capacity", "breaking", "4.5"),
              { ...card("wrong-class"), category: "Аксессуары для автоматов" },
              { ...card("stock-not-proven"), warehouses: [] },
            ];
            return json({
              data: { results, pagination: { total: results.length } },
            });
          }
        }
        unexpectedCalls++;
        throw new Error(
          `Outbound call forbidden: ${url.origin}${url.pathname}`,
        );
      };
      const invoke = async (
        message: string,
        slots: Record<string, unknown>,
      ) => {
        const res = await offlineHandler()(
          new Request(
            "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                sessionId,
                messageId: crypto.randomUUID(),
                message,
                slots,
                history: [],
              }),
            },
          ),
        );
        assertEquals(res.status, 200);
        const body = await res.text();
        assert(body.includes("data: [DONE]"), body);
        const events = body.split("\n\n").filter((part) =>
          part.startsWith("data: {")
        )
          .map((part) =>
            JSON.parse(part.slice(6)).v3_event as Event | undefined
          )
          .filter((event): event is Event => !!event);
        assert(
          events.some((event) =>
            event.type === "diagnostic" && event.phase === "complete" &&
            event.error === null
          ),
          body,
        );
        return { events, body };
      };
      const takeSlot = (events: Event[], facet: string) => {
        const update = events.filter(({ type }) => type === "slot_update").at(
          -1,
        );
        const slot = update?.slots as {
          pending_clarification: { facet_key: string };
        } | undefined;
        assertEquals(slot?.pending_clarification.facet_key, facet);
        return slot!;
      };
      // Changing a claimed scope on the client must not authorize a search.
      let slots = takeSlot(
        (await invoke("Какой автомат для квартиры на 7 кВт?", {})).events,
        "circuit_supply",
      );
      const forged = structuredClone(slots);
      (forged.pending_clarification as unknown as { scope: { token: string } })
        .scope.token += " ";
      turn++;
      const rejected = await invoke("230 В, 1 фаза", forged);
      assert(rejected.body.includes("больше не связано"));
      assertEquals(productsCalls, 0);
      stored = [];
      turn = 0;
      slots = takeSlot(
        (await invoke("Какой автомат для квартиры на 7 кВт?", {})).events,
        "circuit_supply",
      );
      turn++;
      slots = takeSlot(
        (await invoke("230 В, 1 фаза", slots)).events,
        "circuit_line",
      );
      turn++;
      slots = takeSlot(
        (await invoke("Отдельная линия, медь 6 мм², в трубе", slots)).events,
        "circuit_project",
      );
      assertEquals(productsCalls, 0);
      turn++;
      const result = await invoke("По проекту C32, 2P, 6 кА", slots);
      const products = result.events.filter(({ type }) =>
        type === "products_block"
      );
      assertEquals(
        products.length,
        1,
        JSON.stringify({ body: result.body, steps: stored[turn].steps }),
      );
      assertEquals(products[0].count, 1);
      assert(String(products[0].markdown).includes("/compatible/"));
      assertEquals(productsCalls, 1);
      const sentFilters = filters as URLSearchParams | null;
      assert(sentFilters);
      for (const [key, , value] of schema) {
        assertEquals(sentFilters.getAll(`options[${key}][]`), [value]);
      }
      assertEquals(
        stored[turn].steps?.find(({ step }) =>
          step === "v3_circuit_protection_cards_verified"
        )?.meta,
        { filter_count: 5, candidates: 7, verified: 1, rendered: 1 },
      );
      assertEquals(unexpectedCalls, 0);
    } finally {
      globalThis.fetch = fetch;
      restoreOfflineModuleSetup();
    }
  },
});
