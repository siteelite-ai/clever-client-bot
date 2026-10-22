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
    source_url: `https://internal.manufacturer.example/spec/fixture-${id}.pdf?secret=PRIVATE_SENTINEL`,
    public_source_url: `https://navigator-light.ru/products/fixture-${id}`,
    document_version: "Rev 2026-10",
    document_page: 2,
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
  | "mixed"
  | "mixed_five"
  | "late_shortlist_proof"
  | "source_incomplete"
  | "source_missing_public"
  | "revoked"
  | "changed"
  | "changed_public_url"
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
  let hydrationReads = 0;
  let catalogSearches = 0;
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
          // The bounded shortlist hint is not the final read. The final read
          // includes exactly the source and the cards displayed this turn.
          if (url.searchParams.has("cutout_min_mm")) {
            if (mode === "late_shortlist_proof") {
              return json(Array.from({ length: 8 }, (_, index) =>
                approvedRow(index + 2)));
            }
            return json(["mixed", "mixed_five", "source_incomplete", "source_missing_public"].includes(mode)
              ? []
              : [2, 3, 4].map((id) => approvedRow(id)));
          }
          const ids = url.searchParams.get("product_id") ?? "";
          const approvedIds = mode === "late_shortlist_proof"
            ? [1, 7, 8, 9]
            : mode === "mixed_five"
            ? [1, 2, 3, 4, 8, 9]
            : [1, 2, 3, 4];
          const factRow = (id: number) =>
            mode === "late_shortlist_proof" && id >= 2 && id <= 6
              ? approvedRow(id, { luminous_flux_lm: null })
              : id === 1 && mode === "source_incomplete"
              ? approvedRow(id, { luminous_flux_lm: null })
              : id === 1 && mode === "source_missing_public"
              ? approvedRow(id, { public_source_url: null })
              : approvedRow(id);
          if (approvedIds.every((id) => ids.includes(String(id)))) {
            finalReads++;
            if (mode === "db_failure") {
              return json({ message: "fixture DB unavailable" }, 500);
            }
            if (mode === "timeout") {
              return await new Promise<Response>(() => {});
            }
            const rows = approvedIds.map(factRow);
            if (mode === "revoked") rows.pop();
            if (mode === "changed") rows[3] = approvedRow(4, {
              luminous_flux_lm: 650,
            });
            if (mode === "changed_public_url") rows[3] = approvedRow(4, {
              public_source_url: "https://navigator-light.ru/products/fixture-4-revised",
            });
            if (mode === "duplicate") rows.push(approvedRow(4));
            return json(rows);
          }
          hydrationReads++;
          const hydrationIds = mode === "late_shortlist_proof"
            ? Array.from({ length: 9 }, (_, index) => index + 1)
            : approvedIds;
          return json(hydrationIds.filter((id) => ids.includes(String(id)))
            .map(factRow));
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
              category: { id: 10, pagetitle: leaf, total_products: 9 },
              options: options.map(([key, caption, value]) => ({
                key, caption_ru: caption, type: "string",
                values: [{ value_ru: value, products_count: 4 }],
              })),
            },
          });
        }
        if (url.pathname === "/api/products") {
          const article = url.searchParams.get("article");
          let result: ReturnType<typeof product>[];
          if (article) {
            const ids = mode === "late_shortlist_proof"
              ? Array.from({ length: 9 }, (_, index) => index + 1)
              : [1, 2, 3, 4];
            result = ids.filter((id) =>
              product(id).article === article
            ).map(product);
          } else if (
            url.searchParams.has("query") || url.searchParams.has("pagetitle")
          ) {
            result = [product(1)];
          } else {
            catalogSearches++;
            if (mode === "late_shortlist_proof") {
              // Generic search cannot supply three complete proofs; the
              // exact-article hints must reach their late approved rows.
              result = [2, 5, 3, 6, 7].map(product);
            } else if (mode === "source_incomplete" || mode === "source_missing_public") {
              result = [2, 3, 4, 5, 6].map(product);
            } else if (mode === "mixed" || mode === "mixed_five") {
              const ids = [2, 5, 3, 6, 7];
              if (catalogSearches >= 2) ids.push(4);
              if (mode === "mixed_five" && catalogSearches >= 3) {
                ids.push(8, 9);
              }
              result = ids.map(product);
            } else {
              result = [2, 3, 4].map(product);
            }
          }
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
    return {
      events: events(await response.text()),
      steps,
      outbound,
      finalReads,
      hydrationReads,
      catalogSearches,
    };
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
    assert(JSON.stringify(result.events).includes("Кандидаты на замену: 3 шт."));
    assert(JSON.stringify(result.events).includes("Прошли проверку по восьми критериям"));
    assert(JSON.stringify(result.events).includes("Совместимость по габаритам, глубине, подключению и условиям установки не подтверждена"));
    assert(!JSON.stringify(result.events).includes("Подборка прямых аналогов"));
    assert(result.steps.some(({ step }) => step === "v3_replacement_final_fact_gate_passed"));
    assert(!JSON.stringify(result.events).includes("private-technical-reviewer"));
    assert(!JSON.stringify(result.events).includes("PRIVATE_SENTINEL"));
    assert(JSON.stringify(blocks).includes("https://navigator-light.ru/products/fixture-2"));
  },
});

Deno.test({
  name: "mixed structural window falls back to three approved analogs when five are unavailable",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runTurn("mixed");
    const blocks = productBlocks(result);
    assert(result.catalogSearches >= 2, JSON.stringify(result.steps));
    assertEquals(result.finalReads, 1, JSON.stringify(result.steps));
    assertEquals(blocks.length, 1, JSON.stringify(result.steps));
    assertEquals(blocks[0].count, 3);
    assertEquals(blocks[0].selection_contract?.direct_analog_proof?.status,
      "confirmed_direct");
    assertEquals(blocks[0].selection_contract?.direct_analog_proof?.candidates?.length, 3);
    assert(!JSON.stringify(blocks).includes("fixture-5/"));
    assert(result.steps.some(({ step }) => step === "v3_replacement_final_fact_gate_passed"));
  },
});

Deno.test({
  name: "mixed structural window continues until five approved analogs are found",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runTurn("mixed_five");
    const blocks = productBlocks(result);
    assert(result.catalogSearches >= 3, JSON.stringify(result.steps));
    assertEquals(result.finalReads, 1, JSON.stringify(result.steps));
    assertEquals(blocks.length, 1, JSON.stringify(result.steps));
    assertEquals(blocks[0].count, 5);
    assertEquals(blocks[0].selection_contract?.direct_analog_proof?.status,
      "confirmed_direct");
    assertEquals(blocks[0].selection_contract?.direct_analog_proof?.candidates?.length, 5);
    for (const id of [2, 3, 4, 8, 9]) {
      assert(JSON.stringify(blocks).includes(`fixture-${id}/`));
    }
    for (const id of [5, 6, 7]) {
      assert(!JSON.stringify(blocks).includes(`fixture-${id}/`));
    }
    assert(result.steps.some(({ step }) =>
      step === "v3_replacement_final_fact_gate_passed"
    ));
  },
});

Deno.test({
  name: "eight cutout hints reach late three fully proved cards after five incomplete facts",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runTurn("late_shortlist_proof");
    const blocks = productBlocks(result);
    const window = result.steps.find(({ step }) =>
      step === "v3_replacement_guarded_window"
    );
    const shortlist = window?.meta?.verified_shortlist as
      | { attempted?: number; accepted?: number; rejected?: number }
      | undefined;
    assertEquals(shortlist?.attempted, 8, JSON.stringify(result.steps));
    assertEquals(shortlist?.accepted, 3, JSON.stringify(result.steps));
    assertEquals(shortlist?.rejected, 5, JSON.stringify(result.steps));
    assertEquals(result.finalReads, 1, JSON.stringify(result.steps));
    assertEquals(blocks.length, 1, JSON.stringify(result.steps));
    assertEquals(blocks[0].count, 3);
    assertEquals(blocks[0].selection_contract?.direct_analog_proof?.status,
      "confirmed_direct");
    assertEquals(blocks[0].selection_contract?.direct_analog_proof?.candidates?.length, 3);
    for (const id of [7, 8, 9]) {
      assert(JSON.stringify(blocks).includes(`fixture-${id}/`));
    }
    for (const id of [2, 3, 4, 5, 6]) {
      assert(!JSON.stringify(blocks).includes(`fixture-${id}/`));
    }
    assert(!JSON.stringify(result.events).includes("PRIVATE_SENTINEL"));
  },
});

Deno.test({
  name: "incomplete source facts do not expand the bounded structural search",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runTurn("source_incomplete");
    const blocks = productBlocks(result);
    assertEquals(result.catalogSearches, 1, JSON.stringify(result.steps));
    assert(result.hydrationReads <= 2, JSON.stringify(result.steps));
    assertEquals(blocks.length, 1, JSON.stringify(result.steps));
    assertEquals(blocks[0].count, 5);
    assertEquals(blocks[0].selection_contract?.direct_analog_proof, undefined);
    assert(!JSON.stringify(result.events).includes("Кандидаты на замену:"));
  },
});

Deno.test({
  name: "legacy source facts without a separately approved public URL cannot trigger direct proof",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runTurn("source_missing_public");
    const blocks = productBlocks(result);
    assertEquals(result.catalogSearches, 1, JSON.stringify(result.steps));
    assertEquals(blocks.length, 1, JSON.stringify(result.steps));
    assertEquals(blocks[0].selection_contract?.direct_analog_proof, undefined);
    assert(!JSON.stringify(result.events).includes("PRIVATE_SENTINEL"));
  },
});

for (const mode of ["revoked", "changed", "changed_public_url", "duplicate", "db_failure", "timeout"] as const) {
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
