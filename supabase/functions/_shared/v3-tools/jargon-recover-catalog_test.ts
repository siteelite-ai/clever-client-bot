import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { executeJargonRecoverCatalog } from "./jargon-recover-catalog.ts";
import type { ProductCache } from "./types.ts";

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
