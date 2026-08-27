import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildGroundedAxisSectionHeading,
  buildGroundedAxisSplitCaption,
  classifyGroundedJargonEvidence,
  executeJargonRecoverCatalog,
  productSupportsGroundedAxis,
  selectGroundedJargonCacheFallback,
  splitSemanticJargonModifiers,
  titleSupportsGroundedAxis,
  titleSupportsLiveCategoryLabel,
  titleSupportsGroundedJargonQuery,
} from "./jargon-recover-catalog.ts";
import type { ProductCache, ProductRef } from "./types.ts";

Deno.test("translated title evidence is exact unless a separate modifier is unresolved", () => {
  assertEquals(classifyGroundedJargonEvidence(true, "CORN", 17, []), "exact");
  assertEquals(classifyGroundedJargonEvidence(true, "CORN", 17, ["E27"]), "axis_split");
  assertEquals(classifyGroundedJargonEvidence(false, "", 17, []), "empty");
});

Deno.test("jargon recovery applies discovered category to the actual catalog query", async () => {
  const requestedUrls: string[] = [];
  let helperPrompt = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes("openrouter.ai")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: string }> };
      helperPrompt = body.messages?.at(-1)?.content ?? "";
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
    const results = category === "Светодиодные лампы" && query === "CORN"
      ? [{
        id: 24780,
        pagetitle: "Лампа LED CORN капсула 5Вт 230В 4000К G4 ИЭК",
        price: 476,
        url: "https://220volt.kz/catalog/svetotexnika/lampyi/lampa-led-corn-g4-iek/",
        category: { pagetitle: "Лампы" },
        options: [],
      }]
      : !category && query === "LABEL OFF"
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
    category_in: ["Светодиодные лампы"],
    per_page: 5,
  }, {
    baseUrl: "https://catalog.test/api",
    apiToken: "catalog-token",
    openrouterApiKey: "router-token",
    // An old disabled rollout flag must not remove live taxonomy context.
    categoryContextEnabled: false,
    fetchImpl,
  }, cache);

  assertEquals(result.ok, true);
  assertEquals(result.ok ? result.total : 0, 1);
  assertEquals(result.ok ? result.results[0]?.pagetitle : null, "Лампа LED CORN капсула 5Вт 230В 4000К G4 ИЭК");
  const catalogUrls = requestedUrls.filter((url) => url.includes("catalog.test"));
  assertEquals(catalogUrls.map((url) => new URL(url).searchParams.get("category")), [
    "Светодиодные лампы",
    null,
    "Светодиодные лампы",
    "Светодиодные лампы",
    null,
  ]);
  assertEquals(helperPrompt.includes("Категория каталога: «Лампы»"), true);
  assertEquals(helperPrompt.includes("только граница безопасности"), true);
  assertEquals(helperPrompt.includes("Не повторяй категорию"), true);
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

Deno.test("live category title proof tolerates inflection but rejects sibling classes", () => {
  assertEquals(titleSupportsLiveCategoryLabel("Лампа LED CORN 5Вт G4", "Лампы"), true);
  assertEquals(titleSupportsLiveCategoryLabel("Лампа светодиодная CORN", "Светодиодные лампы"), true);
  assertEquals(titleSupportsLiveCategoryLabel("Средство для удаления наклеек LABEL OFF", "Лампы"), false);
});

Deno.test("jargon recovery decomposes an ungrounded translated phrase into a title-proven token", async () => {
  const catalogQueries: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("openrouter.ai")) {
      return new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ candidates: ["LED corn lamp"] }) } }] } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const query = new URL(url).searchParams.get("query") ?? "";
    catalogQueries.push(query);
    const results = query === "LED corn lamp" || query.toLowerCase() === "corn"
      ? [{
        id: 24780,
        pagetitle: "Лампа LED CORN капсула 5Вт",
        price: 476,
        url: "https://220volt.kz/catalog/svetotexnika/lampyi/24780/",
        category: { pagetitle: "Лампы" },
        options: [],
      }]
      : [];
    return new Response(JSON.stringify({ data: { results, pagination: { total: results.length } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

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
  }, new Map());

  assertEquals(result.ok ? result.matched_query : null, "corn");
  assertEquals(catalogQueries[0], "LED corn lamp");
  assertEquals(catalogQueries.includes("кукуруза"), true);
  assertEquals(catalogQueries.includes("corn"), true);
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
  assertEquals(result.ok ? result.semantic_bridge_matched : false, true);
  assertEquals(helperQueries.length, 2);
  assertEquals(helperQueries[1].includes("кабель медный негорючий"), true);
  assertEquals(catalogQueries.includes("кабель ВВГнг"), true);
});

Deno.test("semantic jargon recovery appends structural axes when the exact card is beyond the base page", async () => {
  const catalogQueries: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("openrouter.ai")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: string }> };
      const prompt = body.messages?.at(-1)?.content ?? "";
      const candidates = prompt.includes("кабель медный негорючий") ? ["кабель ВВГнг"] : ["кабель"];
      return new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ candidates }) } }] } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    const query = new URL(url).searchParams.get("query") ?? "";
    catalogQueries.push(query);
    const products = query === "кабель ВВГнг"
      ? Array.from({ length: 20 }, (_value, index) => ({
        id: 200 + index,
        pagetitle: `Кабель ВВГнг 4*${index + 1}`,
        price: 300 + index,
        url: `https://220volt.kz/catalog/cables/vvg/${200 + index}/`,
        category: { pagetitle: "Кабели силовые" },
        options: [],
      }))
      : query === "кабель ВВГнг 2*1,5"
        ? [{
          id: 299,
          pagetitle: "Кабель силовой ВВГнг 2*1,5",
          price: 350,
          url: "https://220volt.kz/catalog/cables/vvg/299/",
          category: { pagetitle: "Кабели силовые" },
          options: [],
        }]
        : [];
    return new Response(JSON.stringify({
      data: { results: products, pagination: { total: products.length } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const result = await executeJargonRecoverCatalog({
    query: "кабель",
    modifiers: ["медный", "негорючий", "2*1.5"],
    require_semantic_bridge: true,
    per_page: 20,
  }, {
    baseUrl: "https://catalog.test/api",
    apiToken: "catalog-token",
    openrouterApiKey: "router-token",
    fetchImpl,
  }, new Map());

  assertEquals(result.ok ? result.matched_query : null, "кабель ВВГнг");
  assertEquals(result.ok ? result.results.map((product) => product.id) : [], ["299"]);
  assertEquals(result.ok ? result.semantic_bridge_matched : false, true);
  assertEquals(catalogQueries.includes("кабель ВВГнг 2*1,5"), true);
});

Deno.test("grounded axis proof is structural and vocabulary-free", () => {
  const product: ProductRef = {
    id: "lamp",
    pagetitle: "Лампа LED A60 12Вт E27",
    vendor: "Test",
    price: 1000,
    stock: "in_stock",
    short_traits: ["Степень защиты IP65"],
  };
  assertEquals(productSupportsGroundedAxis(product, "E27"), true);
  assertEquals(productSupportsGroundedAxis(product, "IP 65"), true);
  assertEquals(productSupportsGroundedAxis(product, "E14"), false);
  assertEquals(productSupportsGroundedAxis(product, "кукуруза"), false);
  assertEquals(titleSupportsGroundedAxis(product.pagetitle, "IP65"), false);
  assertEquals(titleSupportsGroundedAxis(product.pagetitle, "E27"), true);
});

Deno.test("axis split copy states that independently proven sections are not one match", () => {
  const caption = buildGroundedAxisSplitCaption("CORN", ["E27"]);
  assertEquals(caption.includes("одновременно"), true);
  assertEquals(caption.includes("не нашлось"), true);
  assertEquals(caption.includes("отдельно"), true);
  assertEquals(caption.includes("нельзя считать одним полным совпадением"), true);
  assertEquals(buildGroundedAxisSectionHeading("E27"), "**Отдельно подтверждено «E27»:**");
});

Deno.test("empty jargon and modifier intersection always returns explicit partial evidence", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("openrouter.ai")) {
      return new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ candidates: ["CORN"] }) } }] } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const query = new URL(url).searchParams.get("query");
    const results = query === "CORN"
      ? [{
        id: 24780,
        pagetitle: "Лампа LED CORN 5Вт G4",
        price: 476,
        url: "https://220volt.kz/catalog/light/lamps/24780/",
        category: { pagetitle: "Лампы" },
        options: [],
      }]
      : [];
    return new Response(JSON.stringify({ data: { results, pagination: { total: results.length } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await executeJargonRecoverCatalog({
    query: "кукуруза",
    modifiers: ["E27"],
    per_page: 5,
  }, {
    baseUrl: "https://catalog.test/api",
    apiToken: "catalog-token",
    openrouterApiKey: "router-token",
    // An old disabled feature flag must no longer erase truthful base evidence.
    axialModifiersEnabled: false,
    fetchImpl,
  }, new Map());

  assertEquals(result.ok, true);
  assertEquals(result.ok ? result.total : 0, 1);
  assertEquals(result.ok ? result.partial_match : false, true);
  assertEquals(result.ok ? result.unmatched_tokens.includes("e27") : false, true);
  assertEquals(result.ok ? result.results[0]?.pagetitle : null, "Лампа LED CORN 5Вт G4");
});

Deno.test("literal translation strategy is the primary jargon recovery mode", async () => {
  let helperCalls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("openrouter.ai")) {
      helperCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: string }> };
      const system = body.messages?.[0]?.content ?? "";
      const candidates = system.includes("буквальный переводчик") ? ["CORN"] : ["светодиодная лампа"];
      return new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ candidates }) } }] } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const query = new URL(url).searchParams.get("query");
    const results = query === "CORN"
      ? [{
        id: 24780,
        pagetitle: "Лампа LED CORN 5Вт G4",
        price: 476,
        url: "https://220volt.kz/catalog/light/lamps/24780/",
        category: { pagetitle: "Лампы" },
        options: [],
      }]
      : [];
    return new Response(JSON.stringify({ data: { results, pagination: { total: results.length } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await executeJargonRecoverCatalog({
    query: "кукуруза",
    modifiers: ["E27"],
    category: "Лампы",
    per_page: 5,
  }, {
    baseUrl: "https://catalog.test/api",
    apiToken: "catalog-token",
    openrouterApiKey: "router-token",
    fetchImpl,
  }, new Map());

  assertEquals(helperCalls, 1);
  assertEquals(result.ok ? result.matched_query : null, "CORN");
  assertEquals(result.ok ? result.partial_match : false, true);
  assertEquals(result.ok ? result.results.length : 0, 1);
});

Deno.test("a generic modifier match cannot hide a stronger literal class axis", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("openrouter.ai")) {
      return new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ candidates: ["LED", "CORN"] }) } }] } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const query = new URL(url).searchParams.get("query");
    const results = query === "LED"
      ? [{
        id: 1,
        pagetitle: "Лампа LED A60 10Вт E27",
        price: 900,
        url: "https://220volt.kz/catalog/light/lamps/1/",
        category: { pagetitle: "Светодиодные лампы" },
        options: [],
      }]
      : query === "CORN"
      ? [{
        id: 2,
        pagetitle: "Лампа LED CORN 5Вт G4",
        price: 476,
        url: "https://220volt.kz/catalog/light/lamps/2/",
        category: { pagetitle: "Светодиодные лампы" },
        options: [],
      }]
      : [];
    return new Response(JSON.stringify({ data: { results, pagination: { total: results.length } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await executeJargonRecoverCatalog({
    query: "кукуруза",
    modifiers: ["E27"],
    category: "Лампы",
    category_in: ["Светодиодные лампы"],
  }, {
    baseUrl: "https://catalog.test/api",
    apiToken: "catalog-token",
    openrouterApiKey: "router-token",
    fetchImpl,
  }, new Map());

  assertEquals(result.ok ? result.matched_query : null, "CORN");
  assertEquals(result.ok ? result.results.map((product) => product.id) : [], ["2"]);
  assertEquals(result.ok ? result.partial_match : false, true);
  assertEquals(result.ok ? result.unmatched_tokens.includes("e27") : false, true);
});

Deno.test("an exact translated intersection outranks a different missing-modifier candidate", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("openrouter.ai")) {
      return new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ candidates: ["CORN", "MAIZE"] }) } }] } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const query = new URL(url).searchParams.get("query");
    const results = query === "CORN"
      ? [{
        id: 3,
        pagetitle: "Лампа LED CORN 8Вт E27",
        price: 1200,
        url: "https://220volt.kz/catalog/light/lamps/3/",
        category: { pagetitle: "Светодиодные лампы" },
        options: [],
      }]
      : query === "MAIZE"
      ? [{
        id: 4,
        pagetitle: "Лампа LED MAIZE 5Вт G4",
        price: 500,
        url: "https://220volt.kz/catalog/light/lamps/4/",
        category: { pagetitle: "Светодиодные лампы" },
        options: [],
      }]
      : [];
    return new Response(JSON.stringify({ data: { results, pagination: { total: results.length } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await executeJargonRecoverCatalog({
    query: "кукуруза",
    modifiers: ["E27"],
    category: "Лампы",
    category_in: ["Светодиодные лампы"],
  }, {
    baseUrl: "https://catalog.test/api",
    apiToken: "catalog-token",
    openrouterApiKey: "router-token",
    fetchImpl,
  }, new Map());

  assertEquals(result.ok ? result.matched_query : null, "CORN");
  assertEquals(result.ok ? result.results.map((product) => product.id) : [], ["3"]);
  assertEquals(result.ok ? result.unmatched_tokens.includes("e27") : true, false);
});

Deno.test("taxonomy shape drift retries a distinctive candidate and keeps only the live umbrella category", async () => {
  const catalogCategories: Array<string | null> = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("openrouter.ai")) {
      return new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ candidates: ["LABEL OFF", "CORN"] }) } }] } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const parsed = new URL(url);
    const query = parsed.searchParams.get("query");
    const category = parsed.searchParams.get("category");
    catalogCategories.push(category);
    const results = category
      ? []
      : query === "LABEL OFF"
        ? [{
          id: 999,
          pagetitle: "Средство для удаления наклеек LABEL OFF",
          price: 1000,
          url: "https://220volt.kz/catalog/auto/chemistry/999/",
          category: { pagetitle: "Автохимия" },
          options: [],
        }]
        : query === "CORN"
          ? [{
            id: 24780,
            pagetitle: "Лампа LED CORN 5Вт G4",
            price: 476,
            url: "https://220volt.kz/catalog/light/lamps/24780/",
            options: [],
          }]
          : [];
    return new Response(JSON.stringify({ data: { results, pagination: { total: results.length } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await executeJargonRecoverCatalog({
    query: "кукуруза",
    modifiers: ["E27"],
    category: "Лампы",
    category_in: ["Светодиодные лампы"],
  }, {
    baseUrl: "https://catalog.test/api",
    apiToken: "catalog-token",
    openrouterApiKey: "router-token",
    fetchImpl,
  }, new Map());

  assertEquals(result.ok ? result.matched_query : null, "CORN");
  assertEquals(result.ok ? result.results.map((product) => product.id) : [], ["24780"]);
  assertEquals(result.ok ? result.partial_match : false, true);
  assertEquals(catalogCategories.includes(null), true);
});

Deno.test("professional fallback cannot turn an associated product into an axial split", async () => {
  const helperSystems: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("openrouter.ai")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: string }> };
      const system = body.messages?.[0]?.content ?? "";
      helperSystems.push(system);
      const candidates = system.includes("буквальный переводчик") ? ["MAIZE"] : ["лампа для растений"];
      return new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ candidates }) } }] } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const query = new URL(url).searchParams.get("query");
    const results = query === "лампа для растений"
      ? [{
        id: 1,
        pagetitle: "Лампа для растений G4",
        price: 1000,
        url: "https://220volt.kz/catalog/light/lamps/1/",
        category: { pagetitle: "Лампы" },
        options: [],
      }]
      : [];
    return new Response(JSON.stringify({ data: { results, pagination: { total: results.length } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await executeJargonRecoverCatalog({
    query: "кукуруза",
    modifiers: ["E27"],
    category: "Лампы",
  }, {
    baseUrl: "https://catalog.test/api",
    apiToken: "catalog-token",
    openrouterApiKey: "router-token",
    fetchImpl,
  }, new Map());

  // The literal translation is absent. The weaker professional helper points
  // at an associated product, but because E27 is missing it must not create a
  // partial split that could later be rendered as if it were the source word.
  assertEquals(helperSystems.length, 2);
  assertEquals(result.ok ? result.matched_query : null, null);
  assertEquals(result.ok ? result.results : [], []);
  assertEquals(result.ok ? result.partial_match : true, false);
});
