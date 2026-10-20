// Real production handler, synthetic catalog and private fact store. No live
// catalog, database, or paid model requests leave this test process.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  enableDirectAnalogProofInOfflineFixture,
  offlineHandler,
  restoreOfflineModuleSetup,
} from "./model-no-search-integration-fixture.ts";

enableDirectAnalogProofInOfflineFixture();
await import("./index.ts");

const leaf = "Светильники";
const sourceTitle =
  "Светильник DN027B G2 LED6/NW 7W 220-240V D90 R; 929002070102";
const productRoot = "https://220volt.kz/catalog/svetotexnika/svetilniki/";
const options = [
  ["kind", "Вид светильника", "даунлайт"],
  ["mount", "Способ монтажа", "встраиваемый"],
  ["diameter", "Диаметр, см", "11.5"],
  ["power", "Мощность ламп, Вт", "7"],
  ["flux", "Световой поток, Лм", "600"],
  ["voltage", "Напряжение, В", "220"],
] as const;

function product(id: number) {
  return {
    id,
    pagetitle: id === 1 ? sourceTitle : `Встраиваемый светильник ${id}`,
    article: id === 1 ? "929002070102" : `SKU-${id}`,
    url: `${productRoot}fixture-${id}/`,
    category: leaf,
    price: 1800 + id,
    warehouses: [{ city: "Караганда", amount: 5 }],
    options: [
      ...options.map(([key, caption_ru, value_ru]) => ({
        key,
        caption_ru,
        value_ru,
      })),
      {
        key: "cutout",
        caption_ru: "Монтажное отверстие, мм",
        value_ru: "90",
      },
      {
        key: "seller_group_only",
        caption_ru: "Продается только в групповой упаковке",
        value_ru: "Нет",
      },
      { key: "pack_qty", caption_ru: "Количество в упаковке, шт", value_ru: "50" },
      { key: "technology", caption_ru: "Тип лампы", value_ru: "LED" },
      { key: "socket", caption_ru: "Тип цоколя", value_ru: "нет" },
    ],
  };
}

function approvedRow(id: number, overrides: Record<string, unknown> = {}) {
  const item = product(id);
  return {
    product_id: String(id),
    article: item.article,
    catalog_url: item.url,
    catalog_leaf_category: leaf,
    source_url: `https://navigator-light.ru/products/fixture-${id}`,
    document_version: "Rev 2026-10",
    document_page: null,
    verified_at: "2026-10-01T08:00:00Z",
    valid_until: "2026-12-01T08:00:00Z",
    revoked_at: null,
    approval_status: "approved",
    approved_at: "2026-10-02T08:00:00Z",
    approved_by: "private-technical-reviewer",
    fixture_form: "downlight",
    mounting_method: "recessed",
    luminous_flux_lm: 600,
    cutout_shape: "round",
    cutout_kind: "exact",
    cutout_min_mm: 90,
    cutout_max_mm: 90,
    outer_diameter_mm: 115,
    color_temperature_k: 4000,
    integrated_led: true,
    socket_kind: "none",
    socket_code: null,
    driver_included: true,
    driver_type: "external constant current",
    supply_min_v: 220,
    supply_max_v: 240,
    ...overrides,
  };
}

type FinalReadMode =
  | "pass"
  | "revoked"
  | "changed"
  | "duplicate"
  | "db_failure"
  | "timeout";

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

async function runTurn(mode: FinalReadMode) {
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  const outbound: string[] = [];
  let steps: Array<{ step?: string; meta?: Record<string, unknown> }> = [];
  let finalReads = 0;
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
        if (url.pathname === "/rest/v1/chat_request_logs" && request.method === "POST") {
          return json({ id: "offline-direct-proof-log" }, 201);
        }
        if (url.pathname === "/rest/v1/chat_request_logs" && request.method === "PATCH") {
          steps = (await request.json() as { steps?: typeof steps }).steps ?? [];
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
          // The bounded shortlist hint is not the final read. Product IDs are
          // always the exact source and the three cards displayed this turn.
          if (url.searchParams.has("cutout_min_mm")) {
            return json([2, 3, 4].map((id) => approvedRow(id)));
          }
          const ids = url.searchParams.get("product_id") ?? "";
          if (["1", "2", "3", "4"].every((id) => ids.includes(id))) {
            finalReads++;
            if (mode === "db_failure") {
              return json({ message: "fixture DB unavailable" }, 500);
            }
            if (mode === "timeout") {
              return await new Promise<Response>(() => {});
            }
            const rows = [1, 2, 3, 4].map((id) => approvedRow(id));
            if (mode === "revoked") rows.pop();
            if (mode === "changed") rows[3] = approvedRow(4, {
              luminous_flux_lm: 650,
            });
            if (mode === "duplicate") rows.push(approvedRow(4));
            return json(rows);
          }
          return json([1, 2, 3, 4].filter((id) => ids.includes(String(id)))
            .map((id) => approvedRow(id)));
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
            data: { results: [{ id: 10, pagetitle: leaf, children: [] }],
              pagination: { page: 1, per_page: 200, pages: 1, total: 1 } },
          });
        }
        if (url.pathname === "/api/categories/options") {
          return json({
            data: {
              category: { id: 10, pagetitle: leaf, total_products: 4 },
              options: options.map(([key, caption, value]) => ({
                key, caption_ru: caption, type: "string",
                values: [{ value_ru: value, products_count: 4 }],
              })),
            },
          });
        }
        if (url.pathname === "/api/products") {
          const article = url.searchParams.get("article");
          const result = article
            ? [1, 2, 3, 4].filter((id) => product(id).article === article).map(product)
            : url.searchParams.has("query") || url.searchParams.has("pagetitle")
            ? [product(1)]
            : [product(2), product(3), product(4)];
          return json({
            data: { results: result, pagination: { total: result.length } },
          });
        }
      }
      if (url.toString() === "https://openrouter.ai/api/v1/chat/completions") {
        const body = await request.json() as {
          messages?: Array<{ content?: string }>;
        };
        if (body.messages?.some(({ content }) => content?.includes("CATEGORY MATCHER"))) {
          return json({
            choices: [{ finish_reason: "stop", message: {
              content: JSON.stringify({ candidates: [{ pagetitle: leaf, confidence: 0.99 }] }),
            } }],
          });
        }
        throw new Error("Direct proof unexpectedly delegated to the model");
      }
      throw new Error(`Unexpected outbound request: ${request.method} ${url}`);
    };

    const response = await offlineHandler()(new Request(
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
    ));
    assertEquals(response.status, 200);
    return { events: events(await response.text()), steps, outbound, finalReads };
  } finally {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
  }
}

function productBlocks(result: Awaited<ReturnType<typeof runTurn>>) {
  return result.events.flatMap(({ v3_event }) => {
    const event = v3_event as
      | { type?: string; count?: number; selection_contract?: {
        direct_analog_proof?: { status?: string; candidates?: unknown[] };
      } }
      | undefined;
    return event?.type === "products_block" ? [event] : [];
  });
}

Deno.test({
  name: "three direct analogs need one final live approval read before cards",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runTurn("pass");
    const blocks = productBlocks(result);
    assertEquals(result.finalReads, 1, JSON.stringify(result.steps));
    assertEquals(blocks.length, 1, JSON.stringify(result.steps));
    assertEquals(blocks[0].count, 3);
    assertEquals(blocks[0].selection_contract?.direct_analog_proof?.status,
      "confirmed_direct");
    assertEquals(blocks[0].selection_contract?.direct_analog_proof?.candidates?.length, 3);
    assert(result.steps.some(({ step }) => step === "v3_replacement_final_fact_gate_passed"));
    assert(!JSON.stringify(result.events).includes("private-technical-reviewer"));
  },
});

for (const mode of ["revoked", "changed", "duplicate", "db_failure", "timeout"] as const) {
  Deno.test({
    name: `final live approval ${mode} fails closed with no cards`,
    permissions: { read: true, env: false, net: false },
    async fn() {
      const result = await runTurn(mode);
      assertEquals(result.finalReads, 1, JSON.stringify(result.steps));
      assertEquals(productBlocks(result).length, 0, JSON.stringify(result.steps));
      assert(
        JSON.stringify(result.events).includes(
          "Не удалось повторно подтвердить данные производителей",
        ),
        JSON.stringify(result.events),
      );
      assert(result.steps.some(({ step }) =>
        step === "v3_replacement_final_fact_gate_rejected"
      ));
    },
  });
}

addEventListener("unload", restoreOfflineModuleSetup);
