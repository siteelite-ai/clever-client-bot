import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  parseMeasuredSourceClassRecoveryRequest,
  recoverMeasuredSourceClassSelection,
  verifiedMeasuredLedReplacementProducts,
} from "./measured-source-class-recovery.ts";
import type { ProductCache, ProductFull } from "./types.ts";

const request =
  "Хочу заменить люстру на светодиодное освещение в гостиной 25 м². Что подойдет?";

function product(
  id: string,
  title: string,
  purpose = "гостиная",
  area = "30",
  stock = 3,
): ProductFull {
  return {
    id,
    pagetitle: title,
    url: `https://220volt.kz/catalog/test/products/${id}/`,
    leaf_category: "Люстры",
    vendor: null,
    price: 1000,
    stock: "in_stock",
    warehouses: stock > 0 ? [{ city: "Алматы", qty: stock }] : [],
    short_traits: [
      `Назначение: ${purpose}`,
      `Максимальная площадь освещения, м2: ${area}`,
    ],
  };
}

Deno.test("measured source class comes only from an explicit replacement relation", () => {
  assertEquals(parseMeasuredSourceClassRecoveryRequest(request), {
    source_class: "люстру",
    destination: "светодиодное освещение",
    place: "гостиной",
    minimum_area_m2: 25,
  });
  assertEquals(
    parseMeasuredSourceClassRecoveryRequest(
      "Хочу заменить старую люстру на светодиодный светильник в гостиной 25 м²",
    ),
    null,
  );
  assertEquals(
    parseMeasuredSourceClassRecoveryRequest(
      "Хочу заменить старый торшер на светодиодное освещение в спальне 18 м²",
    )?.source_class,
    "торшер",
  );
  assertEquals(
    parseMeasuredSourceClassRecoveryRequest(
      "Нужен светодиодный светильник в гостиной 25 м²",
    ),
    null,
  );
  assertEquals(
    parseMeasuredSourceClassRecoveryRequest(
      "Хочу заменить люстру на обычный светильник в гостиной 25 м²",
    ),
    null,
  );
  assertEquals(
    parseMeasuredSourceClassRecoveryRequest(
      "Хочу заменить люстру на светодиодное освещение для гостиной",
    ),
    null,
  );
  assertEquals(
    parseMeasuredSourceClassRecoveryRequest(
      "Хочу заменить люстру на светодиодную ленту в гостиной 25 м²",
    ),
    null,
  );
  assertEquals(
    parseMeasuredSourceClassRecoveryRequest(
      "Хочу заменить люстру в зале на светодиодное освещение в гостиной 25 м²",
    ),
    null,
  );
});

Deno.test("fallback cards need independent LED, site, area and warehouse proof", () => {
  const cards = [
    product("good", "Люстра светодиодная 96W", "кухня; гостиная", "30"),
    product("office", "Офисная панель светодиодная 48W", "офис", "30"),
    product("bulb", "Люстра E14 под светодиодные лампы", "гостиная", "30"),
    product("small", "Люстра светодиодная 20W", "гостиная", "12"),
    product("no-area", "Люстра светодиодная 40W", "гостиная", ""),
    product("no-stock", "Люстра светодиодная 40W", "гостиная", "30", 0),
  ];
  assertEquals(
    verifiedMeasuredLedReplacementProducts(request, cards).map(({ id }) => id),
    ["good"],
  );
});

Deno.test("bounded live source-leaf fallback recovers only proved products after empty target", async () => {
  const calls: string[] = [];
  let targetTimeout = false;
  let targetSufficient = false;
  const source = [
    product("good1", "Люстра светодиодная 100W", "гостиная", "30"),
    product("good2", "Люстра светодиодная 96W", "кухня; гостиная", "30"),
    product("good3", "Люстра светодиодная 72W", "гостиная", "25"),
    product("office", "Офисная панель светодиодная 48W", "офис", "30"),
    product("old", "Люстра E14 под лампы", "гостиная", "30"),
  ];
  const catalogRows = source.map((entry) => ({
    id: entry.id,
    pagetitle: entry.pagetitle,
    price: entry.price,
    url: entry.url,
    category: { pagetitle: entry.leaf_category },
    warehouses: [{ city: "Алматы", amount: 3 }],
    options: entry.short_traits.map((trait, index) => {
      const [caption, ...value] = trait.split(":");
      return {
        key: `facet_${index}`,
        caption_ru: caption,
        value_ru: value.join(":").trim(),
      };
    }),
  }));
  const fetchImpl: typeof fetch = (input) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}?${url.searchParams.toString()}`);
    let data: unknown;
    if (url.pathname.endsWith("/products")) {
      if (!url.searchParams.has("category") && targetTimeout) {
        throw new DOMException("target deadline", "AbortError");
      }
      const results = url.searchParams.has("category") || targetSufficient
        ? catalogRows
        : [];
      data = { data: { results, pagination: { total: results.length } } };
    } else if (url.pathname.endsWith("/categories")) {
      data = {
        data: {
          results: [
            { id: 1, pagetitle: "Люстры", children: [] },
            { id: 2, pagetitle: "Офисные светильники", children: [] },
          ],
          pagination: { pages: 1 },
        },
      };
    } else if (url.pathname.endsWith("/categories/options")) {
      data = {
        data: {
          category: { id: 1, pagetitle: "Люстры", total_products: 5 },
          options: [{
            key: "purpose",
            caption_ru: "Назначение",
            type: "string",
            values: [{ value_ru: "гостиная", products_count: 3 }],
          }],
        },
      };
    } else {
      throw new Error(`Unexpected URL: ${url}`);
    }
    return Promise.resolve(new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  };
  const cache: ProductCache = new Map();
  const recovered = await recoverMeasuredSourceClassSelection(request, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    cache,
    fetchImpl,
  });
  assertEquals(recovered?.origin, "source_class_fallback");
  assertEquals(recovered?.source_category, "Люстры");
  assertEquals(recovered?.source_pages, 1);
  assertEquals(recovered?.products.map(({ id }) => id), ["good1", "good2", "good3"]);
  assertEquals(calls.filter((call) => call.includes("/products?")).length, 2);
  assertEquals(calls.some((call) => call.includes("category=%D0%9B%D1%8E%D1%81%D1%82%D1%80%D1%8B")), true);

  targetTimeout = true;
  const timedOut = await recoverMeasuredSourceClassSelection(request, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    cache: new Map(),
    fetchImpl,
  });
  assertEquals(timedOut?.target_status, "catalog_timeout");
  assertEquals(timedOut?.origin, "source_class_fallback");
  assertEquals(timedOut?.products.map(({ id }) => id), ["good1", "good2", "good3"]);

  targetTimeout = false;
  targetSufficient = true;
  const targetMatched = await recoverMeasuredSourceClassSelection(request, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    cache: new Map(),
    fetchImpl,
  });
  assertEquals(targetMatched?.origin, "target_query");
  assertEquals(targetMatched?.source_status, "not_needed");
  assertEquals(targetMatched?.products.map(({ id }) => id), ["good1", "good2", "good3"]);
});

Deno.test("destination-only request never opens source-class fallback", async () => {
  let fetched = false;
  const result = await recoverMeasuredSourceClassSelection(
    "Нужен светодиодный светильник в гостиной 25 м²",
    {
      baseUrl: "https://catalog.test",
      apiToken: "test",
      cache: new Map(),
      fetchImpl: () => {
        fetched = true;
        throw new Error("unexpected fetch");
      },
    },
  );
  assertEquals(result, null);
  assertEquals(fetched, false);
});
