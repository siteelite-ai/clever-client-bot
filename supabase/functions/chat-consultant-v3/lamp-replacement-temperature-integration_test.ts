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

const leaf = "Лампы";
const sourceTitle =
  "Лампа светодиодная ECO T75 таблетка 6Вт 230В 6500К GX53 IEK";
const traits = [
  ["base", "Тип цоколя", "GX53"],
  ["technology", "Вид лампы (принцип работы)", "светодиодная"],
  ["supply", "Тип напряжения", "АС"],
  ["voltage", "Напряжение, В", "170-264"],
  ["shape", "Форма колбы", "таблетка"],
  ["diameter", "Диаметр, мм", "74"],
  ["power", "Мощность, Вт", "6"],
  ["length", "Длина, мм", "29"],
  ["temperature", "Цветовая температура, К", "6500"],
  ["flux", "Световой поток, Лм", "600"],
] as const;

function lamp(id: number, title: string, temperature: string | null) {
  return {
    id,
    pagetitle: title,
    article: String(900000000000 + id),
    url: `https://220volt.kz/catalog/svetotexnika/lampyi/item-${id}/`,
    category: leaf,
    price: id === 2 ? 2000 : 100 + id,
    warehouses: [{ city: "Караганда", amount: 5 }],
    options: traits.flatMap(([key, caption_ru, value]) => {
      const value_ru = key === "temperature" ? temperature : value;
      return value_ru === null ? [] : [{ key, caption_ru, value_ru }];
    }),
  };
}

const wrongTemperatures = ["2700", "3000", "4000"];
const wrongCards = Array.from({ length: 48 }, (_, index) => {
  const k = wrongTemperatures[index % wrongTemperatures.length];
  return lamp(10 + index, `Лампа GX53 6Вт 230В ${k}К, вариант ${index}`, k);
});
const firstPage = [
  ...wrongCards,
  lamp(90, "Лампа GX53 6Вт 230В 2,7K", "6500"),
  lamp(91, "Лампа GX53 6Вт 230В 6500К без заполненного поля", null),
];
const matching = lamp(
  2,
  "Лампа NLL-GX53-6-230-6,5K 61 247 Navigator",
  "6500 К",
);

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Step = { step: string; meta?: Record<string, unknown> };
type Frame = {
  choices?: Array<{ delta?: { content?: string } }>;
  v3_event?: {
    type: string;
    count?: number;
    markdown?: string;
    selection_contract?: {
      mandatory_criteria: Array<
        { key: string; value: string | number; unit?: string }
      >;
    };
  };
};

async function runTurn({
  hasMatch = true,
  sourceTemperature = "6500",
}: { hasMatch?: boolean; sourceTemperature?: string | null } = {}) {
  const source = lamp(1, sourceTitle, sourceTemperature);
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  const pages: number[] = [];
  let steps: Step[] = [];
  try {
    globalThis.setInterval = ((callback, delay, ...args) => {
      const id = originalSetInterval(callback, delay, ...args);
      intervals.add(id);
      return id;
    }) as typeof setInterval;
    globalThis.fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      if (url.origin === "https://fixture.supabase.invalid") {
        if (url.pathname === "/rest/v1/chat_request_logs") {
          if (req.method === "POST") {
            return json({ id: "offline-lamp-log" }, 201);
          }
          if (req.method === "PATCH") {
            steps = (await req.json()).steps ?? [];
            return new Response(null, { status: 204 });
          }
        }
        if (url.pathname === "/rest/v1/app_settings") {
          return json({
            openrouter_api_key: "offline-openrouter",
            volt220_api_token: "offline-catalog",
            classifier_model: "offline-model",
            v3_criteria_gate_enabled: true,
          });
        }
        if (req.method === "GET" && url.pathname.startsWith("/rest/v1/")) {
          return json([]);
        }
        if (url.pathname.startsWith("/rest/v1/") && req.method === "POST") {
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
              category: { id: 10, pagetitle: leaf, total_products: 51 },
              options: traits.map(([key, caption_ru, value_ru]) => ({
                key,
                caption_ru,
                type: "string",
                values: [{ value_ru, products_count: 50 }],
              })),
            },
          });
        }
        if (url.pathname === "/api/products") {
          if (url.searchParams.get("options[base][]") === "GX53") {
            const page = Number(url.searchParams.get("page") ?? 1);
            pages.push(page);
            assert(page === 1 || page === 2);
            assertEquals(url.searchParams.get("category"), leaf);
            return json({
              data: {
                results: page === 1
                  ? firstPage
                  : [hasMatch ? matching : wrongCards[0]],
                pagination: { total: 51 },
              },
            });
          }
          return json({
            data: { results: [source], pagination: { total: 1 } },
          });
        }
      }
      if (url.toString() === "https://openrouter.ai/api/v1/chat/completions") {
        const body = await req.json() as {
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
      }
      throw new Error(`Unexpected outbound request: ${req.method} ${url}`);
    };
    const response = await offlineHandler()(
      new Request(
        "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: `Подбери аналог для этой лампы: ${sourceTitle}`,
            messageId: crypto.randomUUID(),
            sessionId: crypto.randomUUID(),
            history: [],
          }),
        },
      ),
    );
    assertEquals(response.status, 200);
    const frames: Frame[] = (await response.text()).split("\n\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));
    return {
      pages,
      steps,
      blocks: frames.flatMap(({ v3_event }) =>
        v3_event?.type === "products_block" ? [v3_event] : []
      ),
      text: frames.flatMap(({ choices }) =>
        choices?.map(({ delta }) => delta?.content ?? "") ?? []
      ).join(""),
    };
  } finally {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
  }
}

Deno.test({
  name:
    "LED lamp analog keeps exact Kelvin through paginated search and final SSE",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const positive = await runTurn();
      assertEquals(positive.pages, [1, 2], JSON.stringify(positive.steps));
      assertEquals(
        positive.blocks.map(({ count }) => count),
        [1],
        positive.text,
      );
      const block = positive.blocks[0];
      assertStringIncludes(block.markdown ?? "", matching.url);
      assert(
        block.selection_contract?.mandatory_criteria.some((criterion) =>
          criterion.key === "Цветовая температура, К" &&
          criterion.value === 6500 &&
          criterion.unit === "К"
        ),
      );
      assertStringIncludes(positive.text, "6500 К");
      assertStringIncludes(
        positive.text,
        "Полная взаимозаменяемость не подтверждена",
      );
      assert(
        !positive.text.includes("2700") && !positive.text.includes("3000"),
      );

      const noMatch = await runTurn({ hasMatch: false });
      assertEquals(noMatch.pages, [1, 2]);
      assertEquals(noMatch.blocks, []);
      assertStringIncludes(
        noMatch.text,
        "не нашёл подходящей лампы с цветовой температурой 6500 К",
      );
      assertStringIncludes(
        noMatch.text,
        "Если подходит другая температура",
      );

      const conflict = await runTurn({ sourceTemperature: "3000" });
      assertEquals(conflict.pages, []);
      assertEquals(conflict.blocks, []);
      assertStringIncludes(
        conflict.text,
        "не удалось подтвердить цветовую температуру",
      );
      assert(
        conflict.steps.some(({ step }) =>
          step === "v3_led_lamp_source_temperature_unverified"
        ),
      );
    } finally {
      restoreOfflineModuleSetup();
    }
  },
});
