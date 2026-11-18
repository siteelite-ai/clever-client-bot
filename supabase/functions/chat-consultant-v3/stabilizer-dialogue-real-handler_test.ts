import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  enableMandatoryReadinessInOfflineFixture,
  offlineHandler,
  restoreOfflineModuleSetup,
} from "./model-no-search-integration-fixture.ts";
enableMandatoryReadinessInOfflineFixture();
await import("./index.ts");

const offlineEnvGet = Deno.env.get;
type Event = Record<string, unknown>;
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.test({
  name:
    "stabilizer SSE: carries only verified clarification into exact SKU search, withholds wrong-phase and unstocked cards",
  permissions: { env: false, net: false, read: true },
  async fn() {
    Deno.env.get = offlineEnvGet;
    const originalFetch = globalThis.fetch;
    const sessionId = crypto.randomUUID();
    const stored: { response_events?: Event[]; steps?: Event[] }[] = [];
    const catalogRequests: string[] = [];
    const unexpected: string[] = [];
    let turn = 0;
    try {
      globalThis.fetch = async (input, init) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const url = new URL(req.url);
        if (url.origin === "https://fixture.supabase.invalid") {
          if (url.pathname === "/rest/v1/chat_request_logs") {
            if (req.method === "POST") {
              return json({ id: `stabilizer-${turn}` }, 201);
            }
            if (req.method === "PATCH") {
              stored[turn] = { ...stored[turn], ...await req.json() };
              return new Response(null, { status: 204 });
            }
            if (req.method === "GET") {
              const last = stored[turn - 1]?.response_events;
              return json(
                last
                  ? {
                    session_id: sessionId,
                    error: null,
                    response_events: last,
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
        if (
          url.origin === "https://fixture.catalog.invalid" &&
          url.pathname === "/api/products"
        ) {
          const article = url.searchParams.get("article") ?? "";
          catalogRequests.push(article);
          const part = article.split("-")[2];
          const proof = ["002", "003", "005"].includes(part);
          const card = {
            id: part,
            article,
            pagetitle: `Стабилизатор напряжения HUB ${Number(part)}кВА IEK`,
            url:
              `https://220volt.kz/catalog/nizkovoltnoe-oborudovanie/stabilizatoryi/hub-${part}/`,
            vendor: "IEK",
            category: "Стабилизаторы",
            price: 10000,
            warehouses: part === "005"
              ? []
              : [{ city: "Караганда", amount: 2 }],
            options: [
              { key: "brend__brend", caption_ru: "Бренд", value_ru: "IEK" },
              {
                key: "phase",
                caption_ru: "Количество фаз",
                value_ru: part === "003" ? "3" : "1",
              },
              {
                key: "nominal_va",
                caption_ru: "Номинальная мощность, кВА",
                value_ru: String(Number(part)),
              },
            ],
          };
          return json({
            data: {
              results: proof ? [card] : [],
              pagination: { total: proof ? 1 : 0 },
            },
          });
        }
        unexpected.push(url.origin + url.pathname);
        throw new Error("Unexpected outbound dependency");
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
            event.type === "diagnostic" &&
            event.phase === "complete" && event.error === null
          ),
          body,
        );
        return { events, body };
      };
      const getSlot = (events: Event[]) => {
        const updated = events.filter(({ type }) => type === "slot_update").at(
          -1,
        )?.slots as
          | { pending_clarification?: { scope: { token: string } } }
          | undefined;
        assert(updated?.pending_clarification, JSON.stringify(events));
        return updated;
      };
      const ask =
        "Нужен стабилизатор для дома, напряжение часто падает до 170 В. Что посоветуете?";
      const first = await invoke(ask, {});
      assert(first.body.includes("Минимум 170 В учёл"), first.body);
      const slot = getSlot(first.events);
      const edited = structuredClone(slot);
      edited.pending_clarification!.scope.token += " ";
      turn++;
      const rejected = await invoke(
        "1 фаза, нагрузка 1 кВА, без пусковых токов",
        edited,
      );
      assert(rejected.body.includes("больше не связано"));
      assertEquals(catalogRequests, []);
      turn++;
      const reopened = getSlot((await invoke(ask, {})).events);
      turn++;
      const incomplete = await invoke("1 фаза, нагрузка 1 кВА", reopened);
      assert(incomplete.body.includes("пусковым скачком"), incomplete.body);
      assertEquals(catalogRequests, []);
      turn++;
      const result = await invoke(
        "Без пусковых токов",
        getSlot(incomplete.events),
      );
      const cards = result.events.filter(({ type }) =>
        type === "products_block"
      );
      assertEquals(
        cards.length,
        1,
        JSON.stringify({ body: result.body, steps: stored[turn]?.steps }),
      );
      assertEquals(cards[0].count, 1);
      assert(String(cards[0].markdown).includes("/hub-002/"));
      assert(!result.body.includes("/hub-003/"));
      assert(!result.body.includes("/hub-005/"));
      const evidence = stored[turn]?.steps?.find(({ step }) =>
        step === "v3_stabilizer_passport_search"
      )?.meta;
      assertEquals(evidence, {
        input_v: 170,
        phases: 1,
        load_va: 1000,
        peak_va: 1000,
        load_kind: "steady",
        passport_candidates: 6,
        catalog_failures: 0,
        catalog_rejected: 5,
        verified_count: 1,
        approved: [{
          id: "002",
          revision: "IEK-HUB-ed3-fig2",
          page: 3,
          limit_va: 1100,
        }],
      });
      assertEquals(catalogRequests.length, 6);
      // The displayed cards do not erase the server's measured application.
      // A correction after completion must use 150 V, not the old 170 V.
      turn++;
      const afterCards = await invoke(
        "Поправка: 150 В; нагрузка 1,05 кВА",
        getSlot(result.events),
      );
      const afterCardsProof = stored[turn]?.steps?.find(({ step }) =>
        step === "v3_stabilizer_passport_search"
      )?.meta as Record<string, unknown> | undefined;
      assertEquals(afterCardsProof?.input_v, 150);
      assertEquals(afterCardsProof?.phases, 1);
      assertEquals(afterCardsProof?.load_va, 1050);
      assertEquals(afterCardsProof?.load_kind, "steady");
      assertEquals(afterCardsProof?.verified_count, 0);
      assert(!afterCards.events.some(({ type }) => type === "products_block"));
      turn++;
      const lostTrust = structuredClone(getSlot(afterCards.events));
      lostTrust.pending_clarification!.scope.token += " ";
      const callsBeforeForgedCorrection = catalogRequests.length;
      const forgedCorrection = await invoke("Поправка: 170 В", lostTrust);
      assert(forgedCorrection.body.includes("больше не связано"));
      assertEquals(catalogRequests.length, callsBeforeForgedCorrection);
      turn++;
      const correctedStart = getSlot((await invoke(ask, {})).events);
      turn++;
      const corrected = await invoke(
        "Поправка: 150 В; одна фаза, нагрузка 1,05 кВА, без пусковых токов",
        correctedStart,
      );
      const correctedSearch = stored[turn]?.steps?.find(({ step }) =>
        step === "v3_stabilizer_passport_search"
      )?.meta as Record<string, unknown> | undefined;
      assertEquals(correctedSearch?.input_v, 150);
      assertEquals(correctedSearch?.load_va, 1050);
      assertEquals(correctedSearch?.verified_count, 0);
      assert(
        !corrected.events.some(({ type }) => type === "products_block"),
        corrected.body,
      );
      assert(!corrected.body.includes("/hub-002/"), corrected.body);
      assertEquals(unexpected, []);
    } finally {
      globalThis.fetch = originalFetch;
      restoreOfflineModuleSetup();
    }
  },
});
