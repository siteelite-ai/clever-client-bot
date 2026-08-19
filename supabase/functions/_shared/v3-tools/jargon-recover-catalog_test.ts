import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  executeJargonRecoverCatalog,
  selectGroundedJargonCacheFallback,
  splitSemanticJargonModifiers,
  titleSupportsGroundedJargonQuery,
} from "./jargon-recover-catalog.ts";
import type { ProductCache, ProductRef } from "./types.ts";

Deno.test("jargon recovery applies discovered category to the actual catalog query", async () => {
  const requestedUrls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes("openrouter.ai")) {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            tool_calls: [{ function: { arguments: JSON.stringify({ candidates: ["LABEL OFF", "CORN"] }) } }],
          },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    const parsed = new URL(url);
    const category = parsed.searchParams.get("category");
    const query = parsed.searchParams.get("query");
    const results = category === "Лампы" && query === "CORN"
      ? [{
        id: 24780,
        pagetitle: "Лампа LED CORN капсула 5Вт 230В 4000К G4 ИЭК",
        price: 476,
        url: "https://220volt.kz/catalog/svetotexnika/lampyi/lampa-led-corn-g4-iek/",
        category: { pagetitle: "Лампы" },
        options: [],
      }]
      : category !== "Лампы" && query === "LABEL OFF"
        ? [{
          id: 999,
          pagetitle: "Средство для удаления наклеек LABEL OFF, аэрозоль REXANT",
          price: 1464,
          url: "https://220volt.kz/catalog/avtotovary/himiya/label-off-rexant/",
          category: { pagetitle: "Средства для удаления наклеек" },
          options: [],
        }]
        : [];
    return new Response(JSON.stringify({
      data: { results, pagination: { total: results.length } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const cache: ProductCache = new Map();
  const result = await executeJargonRecoverCatalog({
    query: "кукуруза",
    category: "Лампы",
    per_page: 5,
  }, {
    baseUrl: "https://catalog.test/api",
    apiToken: "catalog-token",
    openrouterApiKey: "router-token",
    categoryContextEnabled: true,
    fetchImpl,
  }, cache);

  assertEquals(result.ok, true);
  assertEquals(result.ok ? result.total : 0, 1);
  assertEquals(result.ok ? result.results[0]?.pagetitle : null, "Лампа LED CORN капсула 5Вт 230В 4000К G4 ИЭК");
  const catalogUrls = requestedUrls.filter((url) => url.includes("catalog.test"));
  assertEquals(catalogUrls.map((url) => new URL(url).searchParams.get("category")), ["Лампы", "Лампы"]);
});

Deno.test("grounded jargon title evidence accepts compact codes without a product dictionary", () => {
  assertEquals(titleSupportsGroundedJargonQuery("Кабель ВВГ нг 2*1,5", "кабель ВВГнг"), true);
  assertEquals(titleSupportsGroundedJargonQuery("Кабель ВВГнг 2*1,5", "ВВГнг"), true);
  assertEquals(titleSupportsGroundedJargonQuery("Кабель ВВГ 2*1,5", "ВВГ"), true);
  assertEquals(titleSupportsGroundedJargonQuery("Лампа LED CORN капсула 5Вт", "лампа CORN"), true);
});

Deno.test("grounded jargon title evidence rejects unrelated and overly broad matches", () => {
  assertEquals(
    titleSupportsGroundedJargonQuery("Средство для удаления наклеек LABEL OFF", "лампа CORN"),
    false,
  );
  assertEquals(titleSupportsGroundedJargonQuery("Лампа LED стандартная", "лампа"), false);
  assertEquals(titleSupportsGroundedJargonQuery("ЛАМПА LED стандартная", "ЛАМПА"), false);
});

Deno.test("cached jargon fallback keeps only candidate and caller-proven title evidence", () => {
  const products: ProductRef[] = [
    { id: "exact", pagetitle: "Кабель ВВГнг 2*1,5", vendor: null, price: 300, stock: "in_stock", short_traits: [] },
    { id: "wrong-size", pagetitle: "Кабель ВВГнг 4*1,5", vendor: null, price: 200, stock: "in_stock", short_traits: [] },
    { id: "unrelated", pagetitle: "Средство LABEL OFF 2*1,5", vendor: null, price: 100, stock: "in_stock", short_traits: [] },
  ];

  const selected = selectGroundedJargonCacheFallback(
    products,
    ["лампа", "ВВГнг"],
    (product) => product.pagetitle.includes("2*1,5"),
  );

  assertEquals(selected?.matchedQuery, "ВВГнг");
  assertEquals(selected?.results.map((product) => product.id), ["exact"]);
});

Deno.test("jargon modifier bridge separates descriptive reasoning from structural constraints", () => {
  assertEquals(splitSemanticJargonModifiers([
    "негорючий",
    "для сухих помещений",
    "2*1.5",
    "IP65",
    "E27",
  ]), {
    semantic: ["негорючий", "для сухих помещений"],
    structural: ["2*1.5", "IP65", "E27"],
  });
});

Deno.test("empty literal intersection retries the model's semantic modifier as one lexical phrase", async () => {
  const helperQueries: string[] = [];
  const catalogQueries: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("openrouter.ai")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: string }> };
      const helperQuery = body.messages?.at(-1)?.content ?? "";
      helperQueries.push(helperQuery);
      const candidates = helperQuery.includes("кабель медный негорючий") ? ["кабель ВВГнг"] : ["медный провод"];
      return new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ candidates }) } }] } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    const query = new URL(url).searchParams.get("query") ?? "";
    catalogQueries.push(query);
    const results = query === "кабель ВВГнг"
      ? [{
        id: 101,
        pagetitle: "Кабель силовой ВВГнг 2*1,5",
        price: 300,
        url: "https://220volt.kz/catalog/cables/vvg/101/",
        category: { pagetitle: "Кабель" },
        options: [],
      }]
      : query === "кабель медный" || query === "медный провод"
        ? [{
          id: 102,
          pagetitle: "Кабель медный 4*2,5",
          price: 250,
          url: "https://220volt.kz/catalog/cables/vvg/102/",
          category: { pagetitle: "Кабель" },
          options: [],
        }]
        : [];
    return new Response(JSON.stringify({
      data: { results, pagination: { total: results.length } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const cache: ProductCache = new Map();
  const result = await executeJargonRecoverCatalog({
    query: "кабель медный",
    modifiers: ["негорючий", "2*1.5"],
    per_page: 5,
  }, {
    baseUrl: "https://catalog.test/api",
    apiToken: "catalog-token",
    openrouterApiKey: "router-token",
    fetchImpl,
  }, cache);

  assertEquals(result.ok ? result.matched_query : null, "кабель ВВГнг");
  assertEquals(result.ok ? result.results.map((product) => product.id) : [], ["101"]);
  assertEquals(helperQueries.length, 2);
  assertEquals(helperQueries[1].includes("кабель медный негорючий"), true);
  assertEquals(catalogQueries.includes("кабель ВВГнг"), true);
});
