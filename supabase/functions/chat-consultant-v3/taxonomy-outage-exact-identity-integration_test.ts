// The production handler may recover one customer-supplied SKU while taxonomy
// is unavailable. All HTTP calls are mocked; no live catalog or paid model.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  offlineHandler,
  restoreOfflineModuleSetup,
  setTaxonomyOutageExactLookupInOfflineFixture,
} from "./model-no-search-integration-fixture.ts";
import "./index.ts";

addEventListener("unload", restoreOfflineModuleSetup);

type Case =
  | "exact"
  | "sibling"
  | "hard_size"
  | "appearance"
  | "products_503"
  | "products_429"
  | "categories_429"
  | "categories_timeout"
  | "categories_401"
  | "categories_403"
  | "categories_404"
  | "category_not_found"
  | "flag_off";
type Event = {
  v3_event?: {
    type?: string;
    markdown?: string;
    content?: string;
    [key: string]: unknown;
  };
  choices?: Array<{ delta?: { content?: string } }>;
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function product(title: string) {
  return {
    id: 1,
    pagetitle: title,
    article: "CAT-1",
    url: "https://220volt.kz/catalog/svetotexnika/svetilniki/item-1/",
    category: "Светильники",
    price: 1354,
    warehouses: [{ city: "Караганда", amount: 2 }],
    options: [],
  };
}

async function runCase(which: Case): Promise<{
  events: Event[];
  paths: string[];
  steps: string[];
  done: boolean;
}> {
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  const paths: string[] = [];
  let steps: string[] = [];
  try {
    setTaxonomyOutageExactLookupInOfflineFixture(which !== "flag_off");
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
            return json({ id: `outage-${which}` }, 201);
          }
          if (request.method === "PATCH") {
            steps = ((await request.json()) as {
              steps?: Array<{ step: string }>;
            }).steps?.map(({ step }) => step) ?? [];
            return new Response(null, { status: 204 });
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
        if (request.method === "GET" && url.pathname.startsWith("/rest/v1/")) {
          return json([]);
        }
        if (request.method === "POST" && url.pathname.startsWith("/rest/v1/")) {
          return json({}, 201);
        }
      }
      if (url.origin === "https://fixture.catalog.invalid") {
        paths.push(`${request.method} ${url.pathname}${url.search}`);
        if (url.pathname === "/api/categories") {
          if (which === "category_not_found") {
            return json({
              data: {
                results: [{
                  id: 999,
                  pagetitle: "Другая категория",
                  children: [],
                }],
                pagination: { page: 1, per_page: 200, pages: 1, total: 1 },
              },
            });
          }
          if (which === "categories_timeout") {
            throw new DOMException("category fetch timed out", "AbortError");
          }
          if (which === "categories_429") {
            return json({ error: "catalog rate limited" }, 429);
          }
          if (which.startsWith("categories_40")) {
            return json(
              { error: "catalog permission/route failure" },
              Number(which.slice(-3)),
            );
          }
          if (which === "flag_off") {
            return json({ error: "taxonomy unavailable" }, 503);
          }
          return json({ error: "taxonomy unavailable" }, 503);
        }
        if (url.pathname === "/api/products") {
          if (which === "products_503") {
            return json({ error: "product search unavailable" }, 503);
          }
          if (which === "products_429") {
            return json({ error: "product search rate limited" }, 429);
          }
          return json({
            data: {
              results: [
                product(
                  which === "sibling"
                    ? "Розетка ABC-12345"
                    : "Светильник ABC-12345",
                ),
              ],
              pagination: { total: 1 },
            },
          });
        }
      }
      if (url.toString() === "https://openrouter.ai/api/v1/chat/completions") {
        return json({
          choices: [{
            finish_reason: "stop",
            message: { content: "", tool_calls: [] },
          }],
        });
      }
      throw new Error(`Unexpected outbound request: ${request.method} ${url}`);
    };
    const message = which === "hard_size"
      ? "найди светильник ABC-12345 диаметром 90 мм"
      : which === "appearance"
      ? "найди светильник ABC-12345 круглой формы"
      : "найди светильник ABC-12345";
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
    const body = await response.text();
    return {
      events: body.split("\n\n")
        .filter((part) => part.startsWith("data: ") && part !== "data: [DONE]")
        .map((part) => JSON.parse(part.slice(6)) as Event),
      paths,
      steps,
      done: body.includes("data: [DONE]"),
    };
  } finally {
    setTaxonomyOutageExactLookupInOfflineFixture(false);
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
  }
}

for (
  const which of [
    "exact",
    "sibling",
    "hard_size",
    "appearance",
    "products_503",
    "products_429",
    "categories_429",
    "categories_timeout",
    "categories_401",
    "categories_403",
    "categories_404",
    "flag_off",
    "category_not_found",
  ] as const
) {
  Deno.test({
    name:
      `taxonomy outage recovery ${which} remains bounded and evidence-gated`,
    permissions: { read: true, env: false, net: false },
    async fn() {
      const result = await runCase(which);
      const blocks = result.events.filter(({ v3_event }) =>
        v3_event?.type === "products_block"
      );
      const visible = result.events.flatMap(({ choices }) =>
        choices?.map(({ delta }) => delta?.content ?? "") ?? []
      ).join("\n");
      assert(result.done, "the SSE stream must finish");
      assert(
        result.paths.some((path) => path.startsWith("GET /api/categories")),
      );
      for (const tool of ["discover_category", "search_catalog"]) {
        const events = result.events.map(({ v3_event }) => v3_event).filter((
          event,
        ) => event?.type === "tool_event" && event.tool === tool);
        assertEquals(
          events.filter((event) => event?.phase === "start").length,
          events.filter((event) => event?.phase === "result").length,
          `${tool} must balance start/result SSE events`,
        );
      }
      if (which === "flag_off" || which === "category_not_found") {
        assertEquals(
          result.steps.some((step) => step.startsWith("v3_taxonomy_outage_")),
          false,
        );
        assertEquals(blocks.length, 0);
        return;
      }
      assertEquals(
        result.paths.filter((path) => path.startsWith("GET /api/products"))
          .length,
        ["exact", "sibling", "products_503", "products_429"].includes(which)
          ? 1
          : 0,
        `only one literal product lookup is allowed: ${
          JSON.stringify(result.paths)
        }`,
      );
      if (which === "exact") {
        assertEquals(blocks.length, 1);
        assert(blocks[0].v3_event?.markdown?.includes("Светильник ABC-12345"));
        assert(result.steps.includes("v3_taxonomy_outage_exact_lookup"));
      } else {
        assertEquals(blocks.length, 0, "unverified cards must not escape");
        assert(result.steps.includes("v3_taxonomy_outage_fail_closed"));
        assert(/временн|техническ|не удалось/iu.test(visible), visible);
        assert(
          !/не наш[её]л подходящие товары|подходящих товаров не найдено/iu
            .test(visible),
          visible,
        );
      }
    },
  });
}
