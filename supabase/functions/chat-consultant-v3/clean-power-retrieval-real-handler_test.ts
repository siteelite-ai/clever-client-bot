// Actual HTTP handler + catalogue normalizer, with all fetches stubbed.
// No sockets, credentials, AI requests, live catalogue or production writes.
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  offlineHandler,
  restoreOfflineModuleSetup,
} from "./model-no-search-integration-fixture.ts";
await import("./index.ts");

type Step = { step: string; meta?: Record<string, unknown> };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const message = "Какой ИБП подойдет для газового котла мощностью 250 ватт?";
function card(id: number, title: string, traits = true) {
  return {
    id,
    pagetitle: title,
    category: "Источники бесперебойного питания",
    price: 15000,
    url: `https://220volt.kz/catalog/elektropitanie/ibp/fixture-${id}/`,
    warehouses: [{ city: "Караганда", amount: 3 }],
    options: traits
      ? [
        {
          key: "forma_vykhodnogo_signala",
          caption_ru: "Форма выходного сигнала",
          value_ru: "Чистая синусоида",
        },
        {
          key: "aktivnaya_vykhodnaya_moshchnost_vt",
          caption_ru: "Активная выходная мощность, Вт",
          value_ru: "600",
        },
      ]
      : [],
  };
}
async function scenario(mode: "verified" | "wrong_class" | "unproved") {
  const originalFetch = globalThis.fetch;
  const originalInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  const queries: string[] = [];
  let steps: Step[] = [];
  let aiCalls = 0;
  globalThis.setInterval = ((callback, delay, ...args) => {
    const id = originalInterval(callback, delay, ...args);
    intervals.add(id);
    return id;
  }) as typeof setInterval;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === "https://fixture.supabase.invalid") {
      if (url.pathname === "/rest/v1/app_settings") {
        return json({
          openrouter_api_key: "offline-openrouter",
          volt220_api_token: "offline-catalog",
          classifier_model: "offline-model",
        });
      }
      if (
        url.pathname === "/rest/v1/chat_request_logs" &&
        request.method === "PATCH"
      ) {
        steps = ((await request.json()) as { steps: Step[] }).steps ?? [];
        return new Response(null, { status: 204 });
      }
      if (
        url.pathname === "/rest/v1/chat_request_logs" &&
        request.method === "POST"
      ) return json({ id: `offline-ups-${mode}` }, 201);
      if (request.method === "GET" && url.pathname.startsWith("/rest/v1/")) {
        return json([]);
      }
      if (request.method === "POST" && url.pathname.startsWith("/rest/v1/")) {
        return json({}, 201);
      }
    }
    if (
      url.origin === "https://fixture.catalog.invalid" &&
      url.pathname === "/api/products"
    ) {
      const query = url.searchParams.get("query") ?? "";
      queries.push(query);
      const noise = card(1, "АВР для ИБП");
      const results = query === "UPS" && mode !== "wrong_class"
        ? [card(2, "UPS 1000 VA", mode !== "unproved")]
        : [noise];
      return json({
        data: {
          results,
          pagination: { total: results.length, page: 1, pages: 1 },
        },
      });
    }
    if (/openrouter|lovable/u.test(url.hostname)) aiCalls++;
    throw Error(
      `Unexpected offline route ${request.method} ${url.origin}${url.pathname}`,
    );
  };
  try {
    const response = await offlineHandler()(
      new Request(
        "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://220volt.testdevops.ru",
          },
          body: JSON.stringify({
            message,
            messageId: crypto.randomUUID(),
            sessionId: `offline-ups-${mode}`,
            history: [],
          }),
        },
      ),
    );
    const body = await response.text();
    const events = body.split("\n\n").filter((x) =>
      x.startsWith("data: ") && !x.startsWith("data: [DONE]")
    ).map((x) => JSON.parse(x.slice(6)));
    return {
      status: response.status,
      body,
      steps,
      queries,
      aiCalls,
      blocks: events.flatMap((x) =>
        x.v3_event?.type === "products_block" ? [x.v3_event] : []
      ),
    };
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalInterval;
    for (const id of intervals) clearInterval(id);
  }
}

Deno.test("real handler recovers a proven UPS via alias and retains strict rejection diagnostics", async () => {
  try {
    for (const mode of ["verified", "wrong_class", "unproved"] as const) {
      const result = await scenario(mode);
      assertEquals(result.status, 200);
      assertEquals(result.aiCalls, 0);
      assertEquals(result.queries, [
        "ИБП",
        "источник бесперебойного питания",
        "UPS",
      ]);
      const log = result.steps.find((x) =>
        x.step === "v3_safety_catalog_attempt"
      );
      assert(log, JSON.stringify(result.steps));
      assertEquals(log.meta?.class_diagnostics_version, 1);
      const queries = log.meta?.query_diagnostics as Array<
        {
          query: string;
          sampled: Array<{ verified: boolean; rejection: string | null }>;
        }
      >;
      assertEquals(queries.map((x) => x.query), result.queries);
      assertEquals(queries[2].sampled[0].verified, mode === "verified");
      assertEquals(
        queries[2].sampled[0].rejection,
        mode === "verified"
          ? null
          : mode === "wrong_class"
          ? "wrong_class"
          : "output_waveform_unproved",
      );
      assertEquals(log.meta?.class_rejections, [{
        product_id: "1",
        reason: "excluded_power_class",
        title_has_ups_identity: true,
        category_has_ups_identity: true,
        excluded_source: "title",
      }]);
      assertEquals(result.blocks.length, mode === "verified" ? 1 : 0);
      if (mode === "verified") {
        assertEquals(result.blocks[0].count, 1);
        assertStringIncludes(result.blocks[0].markdown, "fixture-2");
        assertEquals(result.blocks[0].markdown.includes("fixture-1"), false);
      } else if (mode === "wrong_class") {
        assertStringIncludes(
          result.body,
          "не удалось подтвердить именно как ИБП",
        );
      } else {
        assertEquals(
          (log.meta?.rejection_counts as Record<string, number>)
            .output_waveform_unproved,
          1,
        );
      }
      assertEquals(result.body.includes("class_rejections"), false);
      assertEquals(result.body.includes("query_diagnostics"), false);
      assertEquals(result.body.includes("offline-catalog"), false);
    }
  } finally {
    restoreOfflineModuleSetup();
  }
});
