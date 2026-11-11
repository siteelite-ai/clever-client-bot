import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  offlineHandler,
  restoreOfflineModuleSetup,
} from "./model-no-search-integration-fixture.ts";

const offlineGet = Deno.env.get;
await import("./index.ts");
restoreOfflineModuleSetup();

type Row = {
  id: number;
  pagetitle: string;
  url: string;
  price: number;
  category: { id: number; pagetitle: string };
  warehouses: Array<{ city: string; amount: number }>;
  options: Array<{ key: string; caption_ru: string; value_ru: string }>;
  content?: string;
};
type Event = Record<string, unknown>;
type Step = { step: string; meta?: Event };
const raw = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "./fixtures/semantic-compound-catalog-20261109.json",
      import.meta.url,
    ),
  ),
) as Row[];
const rows = raw.map((p) => ({
  ...p,
  content: "С медными токопроводящими жилами.",
}));
const material =
  rows[0].options.find((o) => o.caption_ru === "Материал проводника")!.key;
const flame = rows[0].options.find((o) => o.caption_ru === "Негорючесть")!.key;
const allowed = rows.filter((p) =>
  p.options.some((o) => o.key === flame && o.value_ru === "Да")
);
const decoy = (id: number, overrides: Partial<Row> = {}): Row => ({
  ...rows[0],
  id,
  url: `https://220volt.kz/catalog/fixture/not-a-match-${id}/`,
  ...overrides,
});
const decoys = [
  decoy(91, {
    options: rows[0].options.map((o) =>
      o.key === material ? { ...o, value_ru: "алюминий" } : o
    ),
  }),
  decoy(92, { pagetitle: "Кабель ВВГ нг 3*1,5" }),
  decoy(93, { options: rows[0].options.filter((o) => o.key !== flame) }),
  decoy(94, {
    options: [...rows[0].options, {
      ...rows[0].options.find((o) => o.key === flame)!,
      value_ru: "Нет",
    }],
  }),
  decoy(95, { warehouses: [{ city: "Астана", amount: 0 }] }),
  decoy(96, { category: { id: 91, pagetitle: "Удлинители" } }),
  decoy(97, {
    options: [...rows[0].options, {
      key: "ogranichennyy_prosmotr",
      caption_ru: "Ограниченный просмотр",
      value_ru: "Да",
    }],
  }),
];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function scenario(
  wide: boolean,
  onlyOne = false,
  seedWithoutProof = false,
) {
  const originalFetch = globalThis.fetch, originalGet = Deno.env.get;
  const originalInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  const requests: URL[] = [];
  let steps: Step[] = [], modelCalls = 0;
  const products = onlyOne
    ? [rows[0], ...rows.filter((p) => !allowed.includes(p)), ...decoys]
    : [...rows, ...decoys];
  Deno.env.get = offlineGet;
  try {
    globalThis.setInterval = ((callback, delay, ...args) => {
      const timer = originalInterval(callback, delay, ...args);
      intervals.add(timer);
      return timer;
    }) as typeof setInterval;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request
        ? input
        : new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === "https://fixture.supabase.invalid") {
        if (url.pathname === "/rest/v1/app_settings") {
          return json({
            openrouter_api_key: "offline-openrouter",
            volt220_api_token: "offline-catalog",
            v3_criteria_gate_enabled: true,
          });
        }
        if (url.pathname === "/rest/v1/chat_request_logs") {
          if (request.method === "POST") {
            return json({ id: "offline-log" }, 201);
          }
          if (request.method === "PATCH") {
            steps = (await request.json()).steps;
            return new Response(null, { status: 204 });
          }
        }
        return json(
          request.headers.get("Accept")?.includes("vnd.pgrst.object")
            ? null
            : [],
        );
      }
      if (
        url.origin === "https://fixture.catalog.invalid" &&
        url.pathname === "/api/products"
      ) {
        requests.push(url);
        const query = url.searchParams.get("query") ?? "";
        const markingOnly = /^2\s*[xх×*]\s*1[.,]5$/iu.test(query);
        // The exact marking seeds the leaf. The legacy title-translation
        // query returns just the base spelling, not the variants with suffixes.
        const structured =
          url.searchParams.get(`options[${material}][]`) === "медь" &&
          url.searchParams.get(`options[${flame}][]`) === "Да";
        const result = structured || (wide && markingOnly)
          ? products
          : markingOnly
          ? [rows[seedWithoutProof ? 1 : 0]]
          : /ввг\s*нг/iu.test(query)
          ? [rows[0]]
          : [];
        return json({
          data: { results: result, pagination: { total: result.length } },
        });
      }
      if (url.origin === "https://openrouter.ai") {
        modelCalls++;
        return json({
          choices: [{
            finish_reason: "tool_calls",
            message: {
              tool_calls: [{
                function: {
                  arguments: JSON.stringify({ candidates: ["Кабель ВВГнг"] }),
                },
              }],
            },
          }],
        });
      }
      throw Error(
        `Unexpected offline request: ${request.method} ${url.pathname}`,
      );
    };
    const response = await offlineHandler()(
      new Request(
        "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "нужен медный кабель негорючий 2*1,5",
            messageId: crypto.randomUUID(),
            sessionId: crypto.randomUUID(),
            history: [],
            stream: true,
          }),
        },
      ),
    );
    const stream = await response.text();
    assertEquals(response.status, 200, stream);
    const events = stream.split("\n\n").filter((s) => s.startsWith("data: {"))
      .flatMap((s) => {
        const row = JSON.parse(s.slice(6));
        return row.v3_event ? [row.v3_event as Event] : [];
      });
    return { events, steps, requests, modelCalls, stream };
  } finally {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalInterval;
    globalThis.fetch = originalFetch;
    Deno.env.get = originalGet;
  }
}

Deno.test({
  name:
    "semantic compound HTTP uses the first translated example only to learn fields, not to cap the selection",
  permissions: { read: true, net: false, env: false },
  async fn() {
    const s = await scenario(false, false, true);
    const block = s.events.find((e) => e.type === "products_block");
    assertEquals(block?.count, 4, JSON.stringify(s.steps));
    assertEquals(
      allowed.filter((p) => String(block?.markdown).includes(p.url)).length,
      4,
    );
    assert(
      s.modelCalls > 0,
      "the offline legacy helper had to supply the first positive example",
    );
    assert(
      s.requests.some((u) =>
        u.searchParams.get(`options[${flame}][]`) === "Да"
      ),
    );
  },
});

for (const wide of [true, false]) {
  Deno.test({
    name:
      `semantic compound HTTP uses verified catalogue facets instead of one title spelling (${
        wide ? "broad seed" : "short seed"
      })`,
    permissions: { read: true, net: false, env: false },
    async fn() {
      const s = await scenario(wide);
      const block = s.events.find((e) => e.type === "products_block");
      const trace = JSON.stringify({
        blocks: s.events.filter((e) => e.type === "products_block"),
        steps: s.steps.filter((x) => /compound|turn_end/.test(x.step)),
        model: s.modelCalls,
      });
      assertEquals(block?.count, 4, trace);
      const markdown = String(block?.markdown);
      for (
        const p of [...rows.filter((p) => !allowed.includes(p)), ...decoys]
      ) assert(!markdown.includes(p.url), trace);
      assertEquals(
        allowed.filter((p) => markdown.includes(p.url)).length,
        4,
        trace,
      );
      assertEquals(s.modelCalls, 0, trace);
      const evidence = s.steps.find((s) =>
        s.step === "v3_semantic_compound_facets_verified"
      )?.meta;
      assertEquals(evidence?.verified, 8, trace);
      assertEquals(evidence?.rendered, 4, trace);
      assertEquals(
        s.requests.some((u) =>
          u.searchParams.get(`options[${material}][]`) === "медь" &&
          u.searchParams.get(`options[${flame}][]`) === "Да"
        ),
        !wide,
        trace,
      );
    },
  });
}

Deno.test({
  name:
    "semantic compound HTTP reports one verified result without relaxing the condition or claiming the whole catalogue",
  permissions: { read: true, net: false, env: false },
  async fn() {
    const s = await scenario(false, true);
    assertEquals(s.events.find((e) => e.type === "products_block")?.count, 1);
    assert(
      s.stream.includes("подтвердить 1 вариант в проверенной части каталога"),
      s.stream,
    );
    assertEquals(s.modelCalls, 0);
  },
});
