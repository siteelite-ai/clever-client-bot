import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resetDiscoverCategoryCacheForTest } from "../_shared/v3-tools/discover-category.ts";
import {
  offlineHandler,
  restoreOfflineModuleSetup,
} from "./model-no-search-integration-fixture.ts";
import "./index.ts";

const offlineEnvGet = Deno.env.get;
const category = "Светильники";
const residentialLeaf = "Накладные светильники";
const customer =
  "Мне нужен бытовой светильник с датчиком движения с ценой не более 4000тенге. Дай несколько подходящих вариантов.";
type Event = Record<string, unknown>;
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function card(id: string, additional: Record<string, unknown> = {}) {
  return {
    id,
    article: `fixture-${id}`,
    pagetitle: `Светильник для дома ${id}`,
    price: 3300,
    url: `https://220volt.kz/catalog/svetotexnika/svetilniki/fixture-${id}/`,
    category,
    warehouses: [{ city: "Караганда", amount: 2 }],
    options: [
      {
        key: "type",
        caption_ru: "Вид светильника",
        value_ru: "Бытовые светильники накладные",
      },
      { key: "motion", caption_ru: "С датчиком движения", value_ru: "да" },
    ],
    ...additional,
  };
}
const gauss = card("37237", {
  article: "193411220-S",
  pagetitle: "Светильник Gauss HALL круглый с микроволновым сенсором",
  price: 3878,
  options: [
    {
      key: "type",
      caption_ru: "Вид светильника",
      value_ru: "Бытовые светильники накладные",
    },
    { key: "brend__brend", caption_ru: "Бренд", value_ru: "Gauss" },
  ],
});
const commonArea = {
  content: "Встроенный датчик движения. Назначение и область применения:<br>- Освещение подъездов и лестничных площадок<br>- Подсветка технических зон<br>Основные преимущества: надёжный корпус.",
  options: [{
    key: "type", caption_ru: "Вид светильника", value_ru: "Светильники для ЖКХ",
  }],
};

Deno.test({
  name:
    "residential light SSE: exact one, zero on more, explicit placement and permission, then three strict cards",
  permissions: { env: false, net: false, read: true },
  async fn() {
    Deno.env.get = offlineEnvGet;
    resetDiscoverCategoryCacheForTest();
    const fetch = globalThis.fetch;
    const sessionId = crypto.randomUUID();
    const stored: { response_events?: Event[]; steps?: Event[] }[] = [];
    const requests: URL[] = [];
    const browseRequests = () => requests.filter((url) => !url.searchParams.has("query"));
    let turn = 0;
    const unexpected: string[] = [];
    try {
      globalThis.fetch = async (input, init) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const url = new URL(req.url);
        if (url.origin === "https://fixture.supabase.invalid") {
          if (url.pathname === "/rest/v1/chat_request_logs") {
            if (req.method === "POST") {
              return json({ id: `household-${turn}` }, 201);
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
        if (url.origin === "https://fixture.catalog.invalid") {
          if (url.pathname === "/api/categories") {
            return json({
              data: {
                results: [{ id: 10, pagetitle: category, children: turn === 0 || turn >= 14
                  ? [{ id: 11, pagetitle: residentialLeaf, children: [] }]
                  : [] }],
                pagination: { total: 1, per_page: 200, page: 1, pages: 1 },
              },
            });
          }
          if (url.pathname === "/api/categories/options") {
            return json({
              data: {
                category: { id: 10, pagetitle: category, total_products: 53 },
                options: [{
                  key: "motion",
                  caption_ru: "С датчиком движения",
                  type: "string",
                  values: [{ value_ru: "да", products_count: 3 }],
                }],
              },
            });
          }
          if (url.pathname === "/api/products") {
            requests.push(url);
            const page = Number(url.searchParams.get("page") ?? 1);
            const query = url.searchParams.get("query");
            const pageData = (results: unknown[], total = results.length) =>
              json({ data: { results, pagination: {
                total, page, per_page: 50, pages: Math.ceil(total / 50),
              } } });
            if (query) {
              if (turn < 14) return pageData([]);
              assertEquals(url.searchParams.get("category"), category);
              assertEquals(page, 1);
              assertEquals(url.searchParams.get("max_price"), "4000");
              const onlight = card("42020", { ...commonArea, article: "90348", price: 2614 });
              if (query === "датчик") {
                return pageData([
                  onlight,
                  card("no-purpose", { ...commonArea, content: "Встроенный датчик движения. Для коридоров." }),
                  card("contradiction", { ...commonArea, content: "Встроенный датчик движения. Не предназначен для подъездов." }),
                  card("outside", { ...commonArea, category: "Датчики" }),
                  card("unknown-class", { ...commonArea, category: undefined }),
                  card("missing-stock", { ...commonArea, warehouses: [] }),
                  card("over-cap", { ...commonArea, price: 4010 }),
                  card("no-motion", { ...commonArea, content: "Предназначен для освещения подъездов." }),
                  card("already-checked", commonArea),
                ]);
              }
              assertEquals(query, "сенсор");
              return pageData([onlight, card("sensor-only", { ...commonArea, price: 2910 })]);
            }
            if (turn >= 14) {
              if (url.searchParams.get("category") === residentialLeaf) return pageData([]);
              return pageData(Array.from({ length: 50 }, (_, i) =>
                card(page === 1 && i === 0 ? "already-checked" : `browse-${page}-${i}`,
                  { options: [] })), 605);
            }
            // Intentionally ignore the cap and include non-matches. A
            // search response is not evidence that the filters worked.
            const good = turn === 8
              ? [card("a"), card("b"), card("c")]
              : [card("a", turn === 0 ? { category: residentialLeaf } : {})];
            const other = [
              gauss,
              card("too-expensive", { price: 5100 }),
              card("no-stock", { warehouses: [] }),
              card("wrong-class", { category: "Датчики" }),
              ...(turn === 0 ? [card("missing-class", { category: undefined })] : []),
              card("acoustic", { content: "Датчик реагирует только на звук." }),
              card("utility", {
                content: "Назначение и область применения:<br>- Освещение подъездов и лестничных площадок<br>- Подсветка технических зон<br>Основные преимущества:<br>- Освещение спальни в другой модели.",
                options: [{
                  key: "type",
                  caption_ru: "Вид светильника",
                  value_ru: "Светильники для ЖКХ",
                }, {
                  key: "motion",
                  caption_ru: "С датчиком движения",
                  value_ru: "да",
                }],
              }),
            ];
            const first = [
              ...other,
              ...Array.from(
                { length: 44 },
                (_, index) => card(`n${index}`, { options: [] }),
              ),
            ];
            if (turn === 0) {
              const results = url.searchParams.get("category") === residentialLeaf
                ? good : first.slice(0, 50);
              return json({ data: { results,
                pagination: { total: results.length, per_page: 50, pages: 1, page },
              } });
            }
            return json({
              data: {
                results: page === 1 ? first : good,
                ...(turn === 1 && page === 2 ? {} : {
                  pagination: {
                    total: first.length + good.length,
                    per_page: 50, pages: 2,
                    ...(turn === 10 ? {} : {
                      page: turn === 9 && page === 2 ? 1 : page,
                    }),
                  },
                }),
              },
            });
          }
        }
        unexpected.push(url.origin + url.pathname);
        throw new Error("Unexpected outbound dependency");
      };
      const invoke = async (
        message: string,
        slots: Record<string, unknown> = {},
      ) => {
        const response = await offlineHandler()(
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
        const body = await response.text();
        assertEquals(response.status, 200);
        assertStringIncludes(body, "data: [DONE]");
        const events = body.split("\n\n").filter((part) =>
          part.startsWith("data: {")
        )
          .map((part) =>
            JSON.parse(part.slice(6)).v3_event as Event | undefined
          ).filter((ev): ev is Event => !!ev);
        assert(
          events.some((event) =>
            event.type === "diagnostic" && event.phase === "complete" &&
            event.error === null
          ),
          body,
        );
        return {
          body,
          cards: events.find((event) => event.type === "products_block"),
          slots: events.filter((event) => event.type === "slot_update").at(-1)
            ?.slots as Record<string, unknown> | undefined,
          proof: stored[turn]?.steps?.find(({ step }) =>
            step === "v3_residential_fixture_proof"
          )?.meta,
        };
      };
      const first = await invoke(customer);
      assertEquals(
        first.cards?.count,
        1,
        JSON.stringify({ body: first.body, proof: first.proof }),
      );
      assertStringIncludes(first.body, "один вариант");
      assertStringIncludes(first.body, "можно указать новый бюджет");
      assertStringIncludes(first.body, "Где будет светильник");
      assertEquals(
        (first.proof as Record<string, unknown>)?.catalogue_window_complete,
        true,
      );
      assert(!first.body.includes("fixture-37237"));
      assert(!first.body.includes("fixture-wrong-class"));
      assert(!first.body.includes("fixture-missing-class"));
      assertEquals(requests.map((url) => [url.searchParams.get("category"), url.searchParams.get("page") ?? "1"]), [
        [category, "1"],
        [residentialLeaf, "1"],
      ]);
      resetDiscoverCategoryCacheForTest();
      assert(first.slots);
      turn++;
      const more = await invoke("Покажи ещё", first.slots);
      assertEquals(more.cards, undefined, more.body);
      assertStringIncludes(more.body, "новые варианты до 4000");
      assertEquals(
        (more.proof as Record<string, unknown>)?.catalogue_window_complete,
        false,
      );
      assert(more.slots);
      turn++;
      const place = await invoke("На крытый балкон", more.slots);
      assertEquals(place.cards, undefined, place.body);
      assertStringIncludes(place.body, "можно ЖКХ");
      assert(place.slots);
      turn++;
      const ack = await invoke("Да", place.slots);
      assertEquals(ack.cards, undefined, ack.body);
      assert(ack.slots);
      assertEquals(
        browseRequests().length,
        6,
        "bare yes cannot start a new catalogue scan",
      );
      turn++;
      const utility = await invoke("Можно ЖКХ", ack.slots);
      assertEquals(
        utility.cards?.count,
        1,
        JSON.stringify({ body: utility.body, proof: utility.proof }),
      );
      assertStringIncludes(String(utility.cards?.markdown), "fixture-37237");
      assertStringIncludes(utility.body, "по вашему согласию");
      assert(utility.slots);
      turn++;
      const forbidden = await invoke("Без ЖКХ", utility.slots);
      assertEquals(forbidden.cards, undefined);
      turn++;
      const renewed = await invoke(customer);
      assert(renewed.slots);
      turn++;
      const forged = structuredClone(renewed.slots);
      (forged.pending_clarification as { scope: { token: string } }).scope
        .token += " ";
      const refused = await invoke("Покажи ещё", forged);
      assertStringIncludes(refused.body, "Не удалось подтвердить условия");
      assertEquals(browseRequests().length, 12, "unverified context cannot scan");
      turn++;
      const several = await invoke(customer);
      assertEquals(several.cards?.count, 3, several.body);
      assert(!several.body.includes("Где будет светильник"));
      assertEquals(browseRequests().length, 14);
      for (const [nextTurn, expectedReason] of [
        [9, "page_mismatch"],
        [10, "page_missing"],
      ] as const) {
        turn = nextTurn;
        const uncertain = await invoke(customer);
        assertEquals(uncertain.cards?.count, 1, "verified cards survive uncertain coverage");
        assertStringIncludes(uncertain.body, "один вариант");
        const proof = uncertain.proof as Record<string, unknown>;
        assertEquals(proof?.catalogue_window_complete, false,
          `page evidence: ${expectedReason}`);
        assert((proof?.catalogue_page_evidence as Array<Record<string, unknown>>)
          ?.some(({ page, issue }) => page === 2 && issue === expectedReason));
      }
      assertEquals(browseRequests().length, 18);

      turn = 11;
      const beforeUseList = await invoke(customer);
      assert(beforeUseList.slots);
      assert(!beforeUseList.body.includes("fixture-utility/"));
      turn = 12;
      const entry = await invoke("Можно ЖКХ, для подъезда", beforeUseList.slots);
      assertEquals(entry.cards?.count, 2, entry.body);
      assertStringIncludes(String(entry.cards?.markdown), "fixture-utility/");
      assertStringIncludes(String(entry.cards?.markdown), "fixture-37237/");
      assert(entry.slots);
      turn = 13;
      const bedroom = await invoke("Для спальни", entry.slots);
      assertEquals(bedroom.cards, undefined, bedroom.body);
      assert(!bedroom.body.includes("fixture-utility/"));
      resetDiscoverCategoryCacheForTest();
      turn = 14;
      const beforeConsent = await invoke(customer);
      assert(beforeConsent.slots);
      assertEquals(beforeConsent.cards, undefined, beforeConsent.body);
      assert(!beforeConsent.body.includes("fixture-42020/"));

      const from = requests.length;
      turn = 15;
      const recovered = await invoke("Можно ЖКХ, для подъезда", beforeConsent.slots);
      assertEquals(recovered.cards?.count, 2, recovered.body);
      const markdown = String(recovered.cards?.markdown);
      assertStringIncludes(markdown, "fixture-42020/");
      assertStringIncludes(markdown, "fixture-sensor-only/");
      assertEquals(markdown.split("fixture-42020/").length, 2, "one card across queries");
      for (const id of ["no-purpose", "contradiction", "outside", "unknown-class",
        "missing-stock", "over-cap", "no-motion", "already-checked"]) {
        assert(!markdown.includes(`fixture-${id}/`), markdown);
      }
      const diagnostic = recovered.proof as Record<string, unknown>;
      assertEquals(diagnostic?.catalogue_window_complete, false, "text results don't prove coverage");
      assertEquals(diagnostic?.supplemental_candidate_search, [
        { query:"датчик", rows:9, verified:1, failed:false },
        { query:"сенсор", rows:2, verified:1, failed:false },
      ]);
      assertEquals(requests.slice(from).length, 7);
      assert(
        requests.every((url) => url.searchParams.get("max_price") === "4000"),
      );
      assertEquals(unexpected, []);
    } finally {
      globalThis.fetch = fetch;
      resetDiscoverCategoryCacheForTest();
      restoreOfflineModuleSetup();
    }
  },
});
