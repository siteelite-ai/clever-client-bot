// The opt-in manufacturer path must not read its private table when the
// production flag is absent, even for a structural replacement request.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  offlineHandler,
  restoreOfflineModuleSetup,
} from "./model-no-search-integration-fixture.ts";
await import("./index.ts");

const leaf = "Светильники";
const sourceTitle =
  "Светильник DN027B G2 LED6/NW 7W 220-240V D90 R; 929002070102";
const traits = [
  ["kind", "Вид светильника", "даунлайт"],
  ["mount", "Способ монтажа", "встраиваемый"],
  ["cutout", "Монтажное отверстие", "90 мм"],
  ["diameter", "Диаметр, см", "9"],
  ["power", "Мощность ламп, Вт", "7"],
  ["flux", "Световой поток, Лм", "600"],
  ["voltage", "Напряжение, В", "220"],
] as const;

let candidateVariant: "baseline" | "normalized_mount_other_outer" = "baseline";

function product(id: number) {
  return {
    id,
    pagetitle: id === 1 ? sourceTitle : "Светильник встраиваемый LED 7W",
    article: id === 1 ? "929002070102" : "OTHER-7W",
    url: `https://220volt.kz/catalog/svetotexnika/svetilniki/item-${id}/`,
    category: leaf,
    price: 1300 + id,
    warehouses: [{ city: "Караганда", amount: 5 }],
    options: [
      ...traits.map(([key, caption, value]) => ({
        key,
        caption_ru: caption,
        value_ru:
          id === 2 && candidateVariant === "normalized_mount_other_outer"
            ? key === "mount"
              ? "  ВСТРАИВАЕМЫЙ  "
              : key === "diameter"
              ? "11.3"
              : key === "cutout"
              ? "90,0 мм"
              : value
            : value,
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

function replacementBlocks(stream: string): Array<{
  count?: number;
  markdown?: string;
  selection_contract?: {
    visible_requirements?: Array<{
      kind?: string;
      label?: string;
      op?: string;
      value?: number;
      unit?: string;
    }>;
  };
}> {
  return stream.split("\n\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) =>
      JSON.parse(line.slice(6)) as {
        v3_event?: {
          type?: string;
          count?: number;
          markdown?: string;
          selection_contract?: {
            visible_requirements?: Array<{
              kind?: string;
              label?: string;
              op?: string;
              value?: number;
              unit?: string;
            }>;
          };
        };
      }
    )
    .flatMap(({ v3_event }) =>
      v3_event?.type === "products_block" ? [v3_event] : []
    );
}

Deno.test({
  name: "verified facts off performs no private shortlist or hydration read",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const originalFetch = globalThis.fetch;
    const originalSetInterval = globalThis.setInterval;
    const intervals = new Set<number>();
    const requests: string[] = [];
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
            throw new Error("private facts must not be read with flag off");
          }
          if (
            url.pathname === "/rest/v1/chat_request_logs" &&
            request.method === "POST"
          ) return json({ id: "offline-facts-off-log" }, 201);
          if (
            url.pathname === "/rest/v1/chat_request_logs" &&
            request.method === "PATCH"
          ) return new Response(null, { status: 204 });
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
          if (
            request.method === "GET" && url.pathname.startsWith("/rest/v1/")
          ) {
            return json([]);
          }
          if (
            request.method === "POST" && url.pathname.startsWith("/rest/v1/")
          ) {
            return json({}, 201);
          }
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
                  values: [{ value_ru: value, products_count: 2 }],
                })),
              },
            });
          }
          if (url.pathname === "/api/products") {
            const exact = url.searchParams.has("article") ||
              url.searchParams.has("pagetitle") ||
              url.searchParams.has("query");
            const results = exact ? [product(1)] : [product(1), product(2)];
            return json({
              data: { results, pagination: { total: results.length } },
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
          throw new Error("guarded replacement unexpectedly used the model");
        }
        throw new Error(`unexpected offline request: ${request.method} ${url}`);
      };
      const runTurn = async () => {
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
        return replacementBlocks(await response.text());
      };
      const baseline = await runTurn();
      assertEquals(baseline.length, 1);
      assertEquals(baseline[0].count, 1);
      assert(baseline[0].markdown?.includes("Светильник встраиваемый LED 7W"));

      // The generic diameter is the outer housing, not the mounting cut-out.
      // A case/whitespace-equivalent mount and a decimal-comma 90 mm cut-out
      // must preserve the default-OFF guarded shortlist. This is an offline
      // behavior guard, not proof of equality with a separately run PR #119.
      candidateVariant = "normalized_mount_other_outer";
      const normalized = await runTurn();
      assertEquals(normalized.length, 1);
      assertEquals(normalized[0].count, baseline[0].count);
      assert(
        normalized[0].markdown?.includes("Светильник встраиваемый LED 7W"),
      );
      assertEquals(
        normalized[0].selection_contract?.visible_requirements?.find(
          ({ kind }) => kind === "mounting_cutout",
        ),
        {
          kind: "mounting_cutout",
          label: "Диаметр монтажного отверстия",
          op: "eq",
          value: 90,
          unit: "мм",
        },
      );
      assert(requests.some((entry) => entry.includes("/api/products?")));
      assertEquals(
        requests.some((entry) => entry.includes("verified_product_facts")),
        false,
      );
    } finally {
      candidateVariant = "baseline";
      for (const id of intervals) clearInterval(id);
      globalThis.setInterval = originalSetInterval;
      globalThis.fetch = originalFetch;
      restoreOfflineModuleSetup();
    }
  },
});
