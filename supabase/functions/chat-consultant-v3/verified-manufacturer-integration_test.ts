// Offline handler regression: manually approved private facts can establish a
// mounting cut-out only for the exact live product. An approved candidate can
// be recalled by its exact article even after the four-page leaf window. No real catalog, DB, or
// paid model is contacted. The flag is enabled only in this test module.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  enableVerifiedFactsInOfflineFixture,
  offlineHandler,
  restoreOfflineModuleSetup,
} from "./model-no-search-integration-fixture.ts";

enableVerifiedFactsInOfflineFixture();
await import("./index.ts");

const leaf = "Светильники";
const sourceTitle =
  "Светильник DN027B G2 LED6/NW 7W 220-240V D90 R; 929002070102";
const traits = [
  ["kind", "Вид светильника", "даунлайт"],
  ["mount", "Способ монтажа", "встраиваемый"],
  ["diameter", "Диаметр, см", "9"],
  ["power", "Мощность ламп, Вт", "7"],
  ["flux", "Световой поток, Лм", "600"],
  ["voltage", "Напряжение, В", "220"],
] as const;

function catalogProduct(id: number) {
  const isSource = id === 1;
  return {
    id,
    pagetitle: isSource
      ? sourceTitle
      : "Светильник встраиваемый LED 7W, другая модель",
    article: isSource ? "929002070102" : "OTHER-7W",
    url: `https://220volt.kz/catalog/svetotexnika/svetilniki/item-${id}/`,
    category: leaf,
    price: 1300 + id,
    warehouses: [{ city: "Караганда", amount: 5 }],
    options: [
      ...traits.map(([key, caption, value]) => ({
        key,
        caption_ru: caption,
        value_ru: !isSource && key === "diameter" ? "11.3" : value,
      })),
      { key: "technology", caption_ru: "Тип лампы", value_ru: "LED" },
      { key: "socket", caption_ru: "Тип цоколя", value_ru: "нет" },
    ],
  };
}

function approvedRow(id: number) {
  const item = catalogProduct(id);
  return {
    product_id: String(id),
    article: item.article,
    catalog_url: item.url,
    catalog_leaf_category: leaf,
    source_url: "https://manufacturer.example/specification.pdf",
    document_version: "rev-1",
    document_page: 2,
    verified_at: "2026-10-18T12:00:00.000Z",
    valid_until: "2026-11-18T12:00:00.000Z",
    revoked_at: null,
    approval_status: "approved",
    approved_at: "2026-10-19T12:00:00.000Z",
    approved_by: "fixture-reviewer",
    cutout_shape: "round",
    cutout_kind: id === 1 ? "exact" : "range",
    cutout_min_mm: 90,
    cutout_max_mm: id === 1 ? 90 : 110,
    outer_diameter_mm: id === 1 ? 105 : 113,
    color_temperature_k: null,
    integrated_led: null,
    socket_kind: null,
    socket_code: null,
    driver_included: null,
    driver_type: null,
    supply_min_v: null,
    supply_max_v: null,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function events(stream: string): Array<Record<string, unknown>> {
  return stream.split("\n\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

Deno.test({
  name:
    "private manufacturer cut-out hydrates an exact source and range candidate without leaking provenance",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const originalFetch = globalThis.fetch;
    const originalSetInterval = globalThis.setInterval;
    const intervals = new Set<number>();
    const outbound: string[] = [];
    let steps: Array<{ step?: string; meta?: Record<string, unknown> }> = [];
    let failCandidateHydration = false;
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
            return json({ id: "offline-verified-facts-log" }, 201);
          }
          if (
            url.pathname === "/rest/v1/chat_request_logs" &&
            request.method === "PATCH"
          ) {
            steps = (await request.json() as { steps?: typeof steps }).steps ??
              [];
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
          if (url.pathname === "/rest/v1/verified_product_facts") {
            const ids = url.searchParams.get("product_id") ?? "";
            if (failCandidateHydration && ids.includes("2")) {
              return json({ message: "fixture DB unavailable" }, 500);
            }
            return json(
              ids
                ? [1, 2].filter((id) => ids.includes(String(id))).map(
                  approvedRow,
                )
                : [approvedRow(2)],
            );
          }
          if (
            request.method === "GET" && url.pathname.startsWith("/rest/v1/")
          ) return json([]);
          if (
            request.method === "POST" && url.pathname.startsWith("/rest/v1/")
          ) return json({}, 201);
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
                category: { id: 10, pagetitle: leaf, total_products: 2 },
                options: traits.map(([key, caption, value]) => ({
                  key,
                  caption_ru: caption,
                  type: "string",
                  values: [
                    { value_ru: value, products_count: 2 },
                    ...key === "diameter"
                      ? [{ value_ru: "11.3", products_count: 1 }]
                      : [],
                  ],
                })),
              },
            });
          }
          if (url.pathname === "/api/products") {
            const article = url.searchParams.get("article");
            const results = article === "OTHER-7W"
              ? [catalogProduct(2)]
              : [catalogProduct(1)];
            return json({
              data: {
                results,
                pagination: { total: article ? results.length : 1_314 },
              },
            });
          }
        }
        if (
          url.toString() === "https://openrouter.ai/api/v1/chat/completions"
        ) {
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
          throw new Error(
            "Guarded replacement unexpectedly delegated to the model",
          );
        }
        throw new Error(
          `Unexpected outbound request: ${request.method} ${url}`,
        );
      };

      const response = await offlineHandler()(
        new Request(
          "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: `предложи аналоги на ${sourceTitle}`,
              messageId: crypto.randomUUID(),
              sessionId: crypto.randomUUID(),
              history: [],
            }),
          },
        ),
      );
      assertEquals(response.status, 200);
      const stream = await response.text();
      const blocks = events(stream).flatMap((event) => {
        const item = event.v3_event as
          | { type?: string; count?: number }
          | undefined;
        return item?.type === "products_block" ? [item] : [];
      });
      assertEquals(blocks.length, 1, JSON.stringify(steps));
      assertEquals(blocks[0].count, 1);
      assert(!stream.includes("manufacturer.example"));
      assert(!stream.includes("Какой диаметр монтажного отверстия"));
      assert(
        outbound.some((line) =>
          line.includes("/rest/v1/verified_product_facts")
        ),
      );
      assert(
        steps.some(({ step, meta }) =>
          step === "v3_replacement_guarded_window" &&
          ((meta?.manufacturer_facts as { attached?: number } | undefined)
              ?.attached ?? 0) >= 2
        ),
        JSON.stringify(steps),
      );
      assert(
        steps.some(({ step, meta }) =>
          step === "v3_replacement_guarded_window" &&
          ((meta?.verified_shortlist as { accepted?: number } | undefined)
              ?.accepted ?? 0) === 1 &&
          (meta?.catalog_requests as number) <= 20
        ),
        JSON.stringify(steps),
      );
      assert(
        !steps.some(({ step }) =>
          step === "v3_replacement_guarded_contract_unverified"
        ),
        JSON.stringify(steps),
      );

      failCandidateHydration = true;
      const failedResponse = await offlineHandler()(
        new Request(
          "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: `предложи аналоги на ${sourceTitle}`,
              messageId: crypto.randomUUID(),
              sessionId: crypto.randomUUID(),
              history: [],
            }),
          },
        ),
      );
      assertEquals(failedResponse.status, 200);
      const failedStream = await failedResponse.text();
      assert(failedStream.includes("Проверка каталога не завершилась"));
      assert(!failedStream.includes("не подтвердилось ни одного кандидата"));
      assert(
        steps.some(({ step, meta }) =>
          step === "v3_replacement_guarded_window" &&
          ((meta?.manufacturer_facts as { failed?: number } | undefined)
              ?.failed ?? 0) > 0
        ),
        JSON.stringify(steps),
      );
    } finally {
      for (const id of intervals) clearInterval(id);
      globalThis.setInterval = originalSetInterval;
      globalThis.fetch = originalFetch;
      restoreOfflineModuleSetup();
    }
  },
});
