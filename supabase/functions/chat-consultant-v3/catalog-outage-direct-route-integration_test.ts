// Fault injection through the unchanged production HTTP/SSE handler. Two
// independent direct catalog routes must not turn an upstream 502 into a
// customer-facing "no products" conclusion or a fabricated product card.
// Every outbound request is mocked; this test has no paid or live network.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  offlineHandler,
  restoreOfflineModuleSetup,
} from "./model-no-search-integration-fixture.ts";
import "./index.ts";

// A separate cleanup test is skipped by --filter; unload runs for both full
// and focused invocations and matches the other real-handler fixture.
addEventListener("unload", restoreOfflineModuleSetup);

type Route = "exact_vvg" | "named_series";
type Event = {
  v3_event?: { type?: string; content?: string; [key: string]: unknown };
  choices?: Array<{ delta?: { content?: string } }>;
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function eventsFromSse(body: string): Event[] {
  return body.split("\n\n")
    .filter((part) => part.startsWith("data: ") && part !== "data: [DONE]")
    .map((part) => JSON.parse(part.slice(6)) as Event);
}

async function turnDuringCatalogOutage(route: Route): Promise<{
  events: Event[];
  doneMarker: boolean;
  catalogRequests: string[];
  steps: Array<{ step: string; meta?: Record<string, unknown> }>;
}> {
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  const catalogRequests: string[] = [];
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
            return json({ id: `offline-catalog-outage-${route}` }, 201);
          }
          if (request.method === "PATCH") {
            steps =
              ((await request.json()) as { steps?: typeof steps }).steps ?? [];
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
        catalogRequests.push(`${request.method} ${url.pathname}`);
        if (route === "exact_vvg" && url.pathname === "/api/categories") {
          return json({ error: "upstream unavailable" }, 502);
        }
        if (route === "named_series" && url.pathname === "/api/products") {
          return json({ error: "upstream unavailable" }, 502);
        }
        throw new Error(
          `Unexpected catalog request: ${request.method} ${url.pathname}`,
        );
      }
      // Both routes should finish directly. An unexpected model call would
      // hide the catalog outage behind generated prose and fail this fixture.
      throw new Error(`Unexpected outbound request: ${request.method} ${url}`);
    };

    const message = route === "exact_vvg"
      ? "найди кабель ВВГ 2*1,5 самый дешевый"
      : "покажи ассортимент Gallant на сайте";
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
      events: eventsFromSse(body),
      doneMarker: body.includes("data: [DONE]"),
      catalogRequests,
      steps,
    };
  } finally {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
  }
}

for (
  const [route, failedEndpoint] of [
    ["exact_vvg", "/api/categories"],
    ["named_series", "/api/products"],
  ] as const
) {
  Deno.test({
    name:
      `${route}: upstream catalog 502 stays a technical uncertainty, not empty stock`,
    permissions: { read: true, env: false, net: false },
    async fn() {
      const result = await turnDuringCatalogOutage(route);
      assert(
        result.catalogRequests.some((request) =>
          request.endsWith(failedEndpoint)
        ),
        `the intended failing endpoint was not reached: ${
          JSON.stringify(result.catalogRequests)
        }`,
      );
      assert(
        result.doneMarker &&
          result.events.some(({ v3_event }) =>
            v3_event?.type === "diagnostic" && v3_event?.phase === "complete"
          ),
        "the SSE response must have a complete diagnostic and [DONE] marker",
      );
      assertEquals(
        result.events.filter(({ v3_event }) =>
          v3_event?.type === "products_block"
        ).length,
        0,
        "unverified catalog results must not create product cards",
      );
      const visible = result.events
        .flatMap(({ choices }) =>
          choices?.map(({ delta }) => delta?.content ?? "") ?? []
        )
        .join("\n");
      assert(
        result.steps.some(({ step }) =>
          step ===
            (route === "exact_vvg"
              ? "v3_exact_compound_complete_price_proof"
              : "v3_broad_assortment_preflight")
        ),
        `must exercise the intended direct route: ${
          JSON.stringify(result.steps.map(({ step }) => step))
        }`,
      );
      assert(
        /не удалось|ошибк|повторит|временно|не могу|не завершил/iu.test(
          visible,
        ),
        `the customer must see that catalog verification failed: ${visible}`,
      );
      assert(
        !/товаров нет|товары отсутствуют|не наш[её]л подходящие товары|нет доступных товаров/iu
          .test(visible),
        `upstream failure must not be described as proven empty stock: ${visible}`,
      );
      assert(
        !/ошибка соединения/iu.test(visible),
        `catalog upstream 502 must not be mislabeled as the user's connection error: ${visible}`,
      );
    },
  });
}
