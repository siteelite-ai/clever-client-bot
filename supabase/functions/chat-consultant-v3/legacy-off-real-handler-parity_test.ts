// Contract-level OFF regression: every request enters the real HTTP handler,
// while all Supabase, catalog and model traffic is intercepted. This is not
// evidence of live catalog coverage or three direct DN027B analogs.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  offlineHandler,
  restoreOfflineModuleSetup,
} from "./model-no-search-integration-fixture.ts";
await import("./index.ts");

const sourceTitle =
  "Светильник DN027B G2 LED6/NW 7W 220-240V D90 R; 929002070102";
const category = "Светильники";
const traits = [
  ["kind", "Вид светильника", "даунлайт"],
  ["mount", "Способ монтажа", "встраиваемый"],
  ["cutout", "Монтажное отверстие", "90 мм"],
  ["diameter", "Диаметр, см", "9"],
  ["power", "Мощность ламп, Вт", "7"],
  ["flux", "Световой поток, Лм", "600"],
  ["voltage", "Напряжение, В", "220"],
] as const;

function product(id: number, eligible = true) {
  return {
    id,
    pagetitle: id === 1
      ? sourceTitle
      : eligible
      ? `Светильник встраиваемый LED 7W альтернатива ${id}`
      : `Линейный светильник ${id}`,
    article: id === 1 ? "929002070102" : `OTHER-${id}`,
    url: `https://220volt.kz/catalog/svetotexnika/svetilniki/item-${id}/`,
    category,
    price: 1000 + id,
    warehouses: [{ city: "Караганда", amount: 5 }],
    options: [
      ...traits.map(([key, caption, value]) => ({
        key,
        caption_ru: caption,
        value_ru: !eligible && key === "kind" ? "линейный" : value,
      })),
      { key: "technology", caption_ru: "Тип лампы", value_ru: "LED" },
      { key: "socket", caption_ru: "Тип цоколя", value_ru: "нет" },
    ],
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Step = { step?: string; meta?: Record<string, unknown> };
type Block = { type?: string; count?: number; markdown?: string };
type Run = {
  events: Array<Record<string, unknown>>;
  steps: Step[];
  requests: string[];
  catalogPages: number[];
};

function eventsFromSse(stream: string): Run["events"] {
  return stream.split("\n\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) =>
      line === "data: [DONE]"
        ? { v3_event: { type: "done" } }
        : JSON.parse(line.slice(6)) as Record<string, unknown>
    );
}

function blocks(run: Run): Block[] {
  return run.events.flatMap((event) => {
    const block = event.v3_event as Block | undefined;
    return block?.type === "products_block" ? [block] : [];
  });
}

async function runReplacementWithOff(): Promise<Run> {
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  const requests: string[] = [];
  const catalogPages: number[] = [];
  let steps: Step[] = [];
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
      requests.push(`${request.method} ${url}`);
      if (url.origin === "https://fixture.supabase.invalid") {
        if (url.pathname === "/rest/v1/verified_product_facts") {
          throw new Error("OFF path must not read private manufacturer facts");
        }
        if (url.pathname === "/rest/v1/chat_request_logs") {
          if (request.method === "POST") {
            return json({ id: "off-parity-log" }, 201);
          }
          if (request.method === "PATCH") {
            steps = ((await request.json()) as { steps?: Step[] }).steps ?? [];
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
        if (url.pathname === "/api/categories") {
          return json({
            data: {
              results: [
                { id: 10, pagetitle: category, children: [] },
                { id: 12, pagetitle: "Прожекторы", children: [] },
              ],
              pagination: { page: 1, per_page: 200, pages: 1, total: 2 },
            },
          });
        }
        if (url.pathname === "/api/categories/options") {
          return json({
            data: {
              category: { id: 10, pagetitle: category, total_products: 100 },
              options: traits.map(([key, caption, value]) => ({
                key,
                caption_ru: caption,
                type: "string",
                values: [{ value_ru: value, products_count: 100 }],
              })),
            },
          });
        }
        if (url.pathname === "/api/products") {
          if (
            url.searchParams.has("article") ||
            url.searchParams.has("pagetitle") ||
            url.searchParams.has("query")
          ) {
            return json({
              data: { results: [product(1)], pagination: { total: 1 } },
            });
          }
          assertEquals(url.searchParams.get("category"), category);
          const page = Number(url.searchParams.get("page") ?? "1");
          catalogPages.push(page);
          const results = page === 1
            ? [
              product(2),
              ...Array.from({ length: 49 }, (_, i) => product(i + 100, false)),
            ]
            : page === 2
            ? [product(3), product(4), product(5)]
            : [];
          return json({ data: { results, pagination: { total: 100 } } });
        }
      }
      if (url.toString() === "https://openrouter.ai/api/v1/chat/completions") {
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
                  candidates: [{ pagetitle: category, confidence: 0.99 }],
                }),
              },
            }],
          });
        }
        throw new Error("OFF replacement unexpectedly delegated to the model");
      }
      throw new Error(`Unexpected outbound request: ${request.method} ${url}`);
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
    return {
      events: eventsFromSse(await response.text()),
      steps,
      requests,
      catalogPages,
    };
  } finally {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
  }
}

async function runProtectionWithOff(message: string): Promise<Run> {
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  const requests: string[] = [];
  const catalogPages: number[] = [];
  let steps: Step[] = [];
  const leaf = "Прожекторы";
  const ipValues = ["IP20", "IP44", "IP54", "IP65"];
  const lamps = ipValues.map((ip, i) => ({
    id: i + 20,
    pagetitle: `Прожектор ${ip} ${i + 20}`,
    article: `IP-${i + 20}`,
    url: `https://220volt.kz/catalog/svetotexnika/prozhektoryi/item-${i + 20}/`,
    category: leaf,
    price: 2000 + i,
    warehouses: [{ city: "Караганда", amount: 4 }],
    options: [{ key: "ip", caption_ru: "Степень защиты", value_ru: ip }],
  }));
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
      requests.push(`${request.method} ${url}`);
      if (url.origin === "https://fixture.supabase.invalid") {
        if (url.pathname === "/rest/v1/verified_product_facts") {
          throw new Error("OFF path must not read private manufacturer facts");
        }
        if (url.pathname === "/rest/v1/chat_request_logs") {
          if (request.method === "POST") return json({ id: "off-ip-log" }, 201);
          if (request.method === "PATCH") {
            steps = ((await request.json()) as { steps?: Step[] }).steps ?? [];
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
        if (url.pathname === "/api/categories") {
          return json({
            data: {
              results: [
                { id: 10, pagetitle: category, children: [] },
                { id: 12, pagetitle: leaf, children: [] },
              ],
              pagination: { page: 1, per_page: 200, pages: 1, total: 2 },
            },
          });
        }
        if (url.pathname === "/api/categories/options") {
          return json({
            data: {
              category: { id: 12, pagetitle: leaf, total_products: 4 },
              options: [{
                key: "ip",
                caption_ru: "Степень защиты",
                type: "string",
                values: ipValues.map((value_ru) => ({
                  value_ru,
                  products_count: 1,
                })),
              }],
            },
          });
        }
        if (url.pathname === "/api/products") {
          catalogPages.push(Number(url.searchParams.get("page") ?? "1"));
          return json({ data: { results: lamps, pagination: { total: 4 } } });
        }
      }
      if (url.toString() === "https://openrouter.ai/api/v1/chat/completions") {
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
          const requestedIp = message.includes("IP65") ? "IP65" : null;
          return json({
            choices: [{
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [{
                  id: "off-ip-reasoning",
                  type: "function",
                  function: {
                    name: "declare_selection_reasoning",
                    arguments: JSON.stringify({
                      reasoning: requestedIp
                        ? "Покажу прожекторы со степенью защиты IP65 по живому фасету."
                        : message.includes("улицы")
                        ? "Для улицы нужна защита от дождя, поэтому проверяю степень защиты каждого прожектора."
                        : "Покажу разные прожекторы из каталога.",
                      measurement_scope: "not_applicable",
                      compatible_classifications: [],
                      excluded_classifications: [],
                      required_facet_values: requestedIp
                        ? [{ key: "Степень защиты", value: requestedIp }]
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
          body.tools?.some(({ function: schema }) =>
            schema?.name === "discover_category"
          )
        ) {
          return json({
            choices: [{
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [{
                  id: "off-ip-discover",
                  type: "function",
                  function: {
                    name: "discover_category",
                    arguments: JSON.stringify({ noun: leaf }),
                  },
                }],
              },
            }],
          });
        }
        if (
          body.tools?.some(({ function: schema }) =>
            schema?.name === "search_catalog"
          )
        ) {
          // Deliberately broad model query: the server must own the explicit
          // customer IP and the live exposure range at final card proof.
          return json({
            choices: [{
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [{
                  id: "off-ip-search",
                  type: "function",
                  function: {
                    name: "search_catalog",
                    arguments: JSON.stringify({
                      mode: "by_filter",
                      category: leaf,
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
      throw new Error(`Unexpected outbound request: ${request.method} ${url}`);
    };
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
    return {
      events: eventsFromSse(await response.text()),
      steps,
      requests,
      catalogPages,
    };
  } finally {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
  }
}

Deno.test({
  name:
    "OFF replacement retains the actual legacy HTTP route and never reads preview facts",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runReplacementWithOff();
    const cards = blocks(result);
    assertEquals(cards.length, 1, JSON.stringify(result.steps));
    assertEquals(cards[0].count, 4);
    assertEquals(result.catalogPages, [1, 2]);
    for (const id of [2, 3, 4, 5]) {
      assert(cards[0].markdown?.includes(`альтернатива ${id}`));
    }
    assert(!cards[0].markdown?.includes(sourceTitle));
    assertEquals(
      result.requests.some((request) =>
        request.includes("verified_product_facts")
      ),
      false,
    );
    assertEquals(
      result.steps.some(({ step }) => step === "v3_replacement_guarded_window"),
      false,
    );
    assert(
      result.events.some((event) =>
        (event.v3_event as Block | undefined)?.type === "done"
      ),
    );
  },
});

Deno.test({
  name:
    "OFF neutral request does not inject an IP filter before catalog retrieval",
  permissions: { read: true, env: false, net: false },
  async fn() {
    // The minimal offline model does not finish an unqualified assortment
    // browse. This assertion only covers presearch non-injection, not cards.
    const neutral = await runProtectionWithOff("Покажи прожекторы");
    assert(
      neutral.requests.some((request) => request.includes("/api/products?")),
    );
    assertEquals(
      neutral.requests.some((request) => request.includes("options%5Bip%5D")),
      false,
    );
    assertEquals(
      neutral.steps.some(({ step }) =>
        step === "v3_environmental_protection_range_enumerated"
      ),
      false,
    );
  },
});

Deno.test({
  name: "OFF HTTP IP requests preserve the live rain range and explicit IP65",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const outdoor = await runProtectionWithOff(
        "Покажи прожекторы с защитой от дождя",
      );
      const explicit = await runProtectionWithOff("Покажи прожекторы IP65");
      assertEquals(blocks(outdoor).length, 1, JSON.stringify(outdoor.steps));
      assertEquals(blocks(outdoor)[0].count, 3);
      assert(!blocks(outdoor)[0].markdown?.includes("Прожектор IP20"));
      for (const ip of ["IP44", "IP54", "IP65"]) {
        assert(blocks(outdoor)[0].markdown?.includes(`Прожектор ${ip}`));
      }
      const outdoorFilters = outdoor.requests
        .filter((request) => request.includes("/api/products?"))
        .map((request) =>
          new URL(request.slice(4)).searchParams.getAll("options[ip][]")
        )
        .flat();
      assertEquals(outdoorFilters.sort(), ["IP44", "IP54", "IP65"]);
      assert(
        outdoor.steps.some(({ step }) =>
          step === "v3_environmental_protection_range_search_enforced"
        ),
      );
      assertEquals(blocks(explicit).length, 1, JSON.stringify(explicit.steps));
      assertEquals(blocks(explicit)[0].count, 1);
      assert(blocks(explicit)[0].markdown?.includes("Прожектор IP65"));
      assert(!blocks(explicit)[0].markdown?.includes("Прожектор IP44"));
      const explicitFilters = explicit.requests
        .filter((request) => request.includes("/api/products?"))
        .map((request) =>
          new URL(request.slice(4)).searchParams.getAll("options[ip][]")
        )
        .flat();
      assertEquals(explicitFilters, ["IP65"]);
      for (const protectedRun of [outdoor, explicit]) {
        assertEquals(
          protectedRun.requests.some((request) =>
            request.includes("verified_product_facts")
          ),
          false,
        );
        assert(
          protectedRun.events.some((event) =>
            (event.v3_event as Block | undefined)?.type === "done"
          ),
        );
      }
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});
