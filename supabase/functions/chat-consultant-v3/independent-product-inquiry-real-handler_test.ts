// Real HTTP/SSE handler, synthetic settings/catalog/logs only. Net and env
// permissions are denied: no customer data, live catalog or paid model calls.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  offlineHandler,
  restoreOfflineModuleSetup,
} from "./model-no-search-integration-fixture.ts";
import "./index.ts";

addEventListener("unload", restoreOfflineModuleSetup);

const question =
  "Элемент питания NBT-CR2025-BP5 94 764 Navigator - цена на сайте указана за штуку или за упаковку?";
const oldQuery = "Найди кабель для насоса";
const oldTitle = "Кабель OLD-123";
const oldUrl = "https://220volt.kz/catalog/cables/pump/old-123/";
const oldMarkdown = `- **[${oldTitle}](${oldUrl})**\n  Цена: 9 000 ₸/м`;
const sessionId = "11111111-1111-4111-8111-111111111111";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Options = {
  history?: boolean;
  oldLog?: "complete" | "failed" | "unavailable";
  pending?: "readiness" | "catalog" | "cutout";
  unit?: string | null;
  candidates?: "sibling" | "ambiguous";
  message?: string;
};

async function runCase(options: Options = {}) {
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  const catalogUrls: string[] = [];
  const logReads: string[] = [];
  let modelCalls = 0;
  let steps: Array<{ step: string; meta?: Record<string, unknown> }> = [];
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
            return json({ id: "new-inquiry-log" }, 201);
          }
          if (request.method === "PATCH") {
            const body = await request.json();
            if (body.steps) steps = body.steps;
            return new Response(null, { status: 204 });
          }
          if (request.method === "GET") {
            logReads.push(url.search);
            if (options.oldLog === "unavailable") {
              return json({ error: "offline old log unavailable" }, 503);
            }
            if (options.oldLog) {
              return json([{
                id: "prior-log",
                session_id: sessionId,
                user_query: oldQuery,
                error: options.oldLog === "failed" ? "timeout" : null,
                final_products_count: options.oldLog === "failed" ? 0 : 1,
                created_at: new Date(Date.now() - 1_000).toISOString(),
                response_events: options.oldLog === "failed" ? [] : [
                  { type: "products_block", count: 1, markdown: oldMarkdown },
                  {
                    type: "diagnostic",
                    phase: "complete",
                    log_id: "prior-log",
                    error: null,
                    products_count: 1,
                  },
                  { type: "done" },
                ],
              }]);
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
            v3_criteria_gate_enabled: true,
          });
        }
        if (request.method === "GET" && url.pathname.startsWith("/rest/v1/")) {
          return json([]);
        }
        if (request.method === "POST" && url.pathname.startsWith("/rest/v1/")) {
          return json({}, 201);
        }
      }
      if (url.origin === "https://fixture.catalog.invalid") {
        catalogUrls.push(`${url.pathname}${url.search}`);
        if (url.pathname === "/api/products") {
          const unit = options.unit === undefined ? "шт" : options.unit;
          const current = {
            id: 31088,
            pagetitle: `Элемент питания NBT-CR2025-BP${
              options.candidates === "sibling" ? "50" : "5"
            } Navigator`,
            article: "94764",
            url: "https://220volt.kz/catalog/power/batteries/nbt-cr2025-bp5/",
            category: "Элементы питания",
            price: 225, // synthetic fixture, never a claim about today's price
            warehouses: [{ city: "Караганда", amount: 10 }],
            options: unit
              ? [{
                key: "unit",
                caption_ru: "Единица измерения",
                value_ru: unit,
              }]
              : [],
          };
          const results = options.candidates === "ambiguous"
            ? [current, {
              ...current,
              id: 31089,
              article: "94765",
              url: "https://220volt.kz/catalog/power/batteries/other/",
            }]
            : [current];
          return json({
            data: { results, pagination: { total: results.length } },
          });
        }
        if (url.pathname === "/api/categories") {
          return json({ data: { results: [], pagination: { total: 0 } } });
        }
      }
      if (url.origin === "https://openrouter.ai") {
        modelCalls++;
        return json({
          choices: [{
            finish_reason: "stop",
            message: { content: "", tool_calls: [] },
          }],
        });
      }
      throw new Error(`Unexpected offline request: ${request.method} ${url}`);
    };
    const pending = options.pending === "catalog"
      ? {
        facet_key: "catalog_section",
        options: ["Розетки"],
        scope: { kind: "broad_assortment", token: oldQuery },
      }
      : options.pending
      ? {
        facet_key: "current",
        question: "Укажите ток",
        options: [],
        scope: {
          kind: options.pending === "cutout"
            ? "replacement_mounting_cutout"
            : "selection_readiness",
          token: oldQuery,
        },
      }
      : undefined;
    const response = await offlineHandler()(
      new Request(
        "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: options.message ?? question,
            messageId: crypto.randomUUID(),
            sessionId,
            history: options.history
              ? [
                { role: "user", content: oldQuery },
                { role: "assistant", content: oldMarkdown },
              ]
              : [],
            slots: {
              pending_clarification: pending,
              price_max: 100,
              unit: "м",
            },
          }),
        },
      ),
    );
    assertEquals(response.status, 200);
    const wire = await response.text();
    const events = wire.split("\n\n")
      .filter((part) => part.startsWith("data: ") && part !== "data: [DONE]")
      .map((part) => {
        const frame = JSON.parse(part.slice(6));
        return (frame.v3_event ??
          (frame.choices?.[0]?.delta?.content
            ? { type: "delta", content: frame.choices[0].delta.content }
            : null)) as Record<string, unknown> | null;
      })
      .filter((event): event is Record<string, unknown> => event !== null);
    assert(wire.includes("data: [DONE]"));
    return { events, steps, catalogUrls, logReads, modelCalls };
  } finally {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
  }
}

for (
  const [name, options] of [
    ["fresh dialogue", {}],
    ["completed previous selection", { history: true, oldLog: "complete" }],
    ["failed previous selection", { history: true, oldLog: "failed" }],
    ["unavailable old context", { history: true, oldLog: "unavailable" }],
    ["pending readiness", { pending: "readiness", oldLog: "unavailable" }],
    ["pending section choice", { pending: "catalog", oldLog: "unavailable" }],
    ["pending replacement measurement", {
      pending: "cutout",
      oldLog: "unavailable",
    }],
  ] as Array<[string, Options]>
) {
  Deno.test({
    name: `exact item price-unit inquiry is isolated from ${name}`,
    permissions: { read: true, env: false, net: false },
    async fn() {
      const result = await runCase(options);
      assertEquals(
        result.modelCalls,
        0,
        `deterministic catalog unit, not a model guess: ${
          JSON.stringify(result)
        }`,
      );
      assertEquals(
        result.logReads.length,
        0,
        "old logs must not gate this independent question",
      );
      assert(
        result.catalogUrls.some((path) => path.includes("/products?")),
        "fresh lookup required",
      );
      assert(
        result.catalogUrls.every((path) =>
          !decodeURIComponent(path).includes("OLD-123")
        ),
      );
      const boundary = result.steps.find(({ step }) =>
        step === "v3_conversation_boundary"
      );
      assertEquals(boundary?.meta?.mode, "new_task");
      assertEquals(
        boundary?.meta?.reason,
        "local_independent_exact_product_inquiry",
      );
      const answered = result.steps.find(({ step }) =>
        step === "v3_exact_product_inquiry_answered"
      );
      assertEquals(answered?.meta?.product_id, "31088");
      assertEquals(answered?.meta?.deterministic_price_unit, true);
      const evidence = result.events.filter(({ type }) =>
        type === "price_unit_evidence"
      );
      assertEquals(evidence.length, 1);
      assertEquals(evidence[0].basis, "piece");
      assertEquals(evidence[0].unit, "шт");
      const blocks = result.events.filter(({ type }) =>
        type === "products_block"
      );
      assertEquals(blocks.length, 1);
      assert(String(blocks[0].markdown).includes("NBT-CR2025-BP5"));
      assert(!JSON.stringify(result.events).includes(oldTitle));
      const text = result.events.filter(({ type }) => type === "delta").map((
        { content },
      ) => content).join(" ");
      assert(text.includes("за одну штуку"));
      assert(
        !/5\s*(?:штук|элемент)|пять/iu.test(text),
        "BP5 is not packaging evidence",
      );
    },
  });
}

for (const [unit, basis] of [["уп.", "package"], [null, "unknown"]] as const) {
  Deno.test({
    name: `independent inquiry respects actual catalog unit ${unit}`,
    permissions: { read: true, env: false, net: false },
    async fn() {
      const result = await runCase({ history: true, oldLog: "complete", unit });
      assertEquals(result.modelCalls, 0);
      assertEquals(
        result.events.find(({ type }) => type === "price_unit_evidence")?.basis,
        basis,
      );
    },
  });
}

for (const candidates of ["sibling", "ambiguous"] as const) {
  Deno.test({
    name: `independence does not authorise a ${candidates} exact card`,
    permissions: { read: true, env: false, net: false },
    async fn() {
      const result = await runCase({
        candidates,
        history: true,
        oldLog: "complete",
      });
      assert(
        result.steps.some(({ step }) =>
          step === "v3_exact_product_inquiry_fallback"
        ),
      );
      assertEquals(
        result.events.filter(({ type }) => type === "price_unit_evidence")
          .length,
        0,
      );
      assertEquals(
        result.events.filter(({ type }) => type === "products_block").length,
        0,
      );
    },
  });
}

Deno.test({
  name: "a dependent unit question still requires verified previous cards",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runCase({
      message: "У этого NBT-CR2025-BP5 цена за штуку или за упаковку?",
      history: true,
    });
    assert(
      result.steps.some(({ step }) =>
        step === "v3_unverified_rendered_selection_context_rejected"
      ),
    );
    assertEquals(result.catalogUrls.length, 0);
    assertEquals(result.modelCalls, 0);
    assertEquals(
      result.events.filter(({ type }) => type === "products_block").length,
      0,
    );
  },
});
