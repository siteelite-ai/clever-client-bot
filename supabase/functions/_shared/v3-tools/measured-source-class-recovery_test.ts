import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  admitMeasuredExplicitTargetDirectRoute,
  admitMeasuredSourceClassDirectRoute,
  parseMeasuredExplicitTargetClassRequest,
  parseMeasuredSourceClassRecoveryRequest,
  recoverMeasuredSourceClassSelection,
  verifiedMeasuredLedReplacementProducts,
} from "./measured-source-class-recovery.ts";
import { resetDiscoverCategoryCacheForTest } from "./discover-category.ts";
import type { ProductCache, ProductFull } from "./types.ts";

const request =
  "Хочу заменить люстру на светодиодное освещение в гостиной 25 м². Что подойдет?";
const explicitRequest =
  "Хочу заменить люстру на светодиодный светильник в гостиной 25 м². Что можете предложить?";

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

Deno.test("measured direct admission preserves plain source, LED, site and area requests", () => {
  for (
    const message of [
      request,
      "Хочу заменить старый торшер на светодиодное освещение в спальне 18 м²",
      "Нужно заменить старую люстру на светодиодный свет в спальне 18 м². Что подойдёт?",
      "Хочу поменять люстру на LED освещение для гостиной площадью 25 кв. м. Подберите варианты.",
    ]
  ) {
    assertEquals(admitMeasuredSourceClassDirectRoute(message), true, message);
  }
});

Deno.test("explicit LED target retains its own customer class and strict whole-request admission", () => {
  assertEquals(parseMeasuredSourceClassRecoveryRequest(explicitRequest), null);
  assertEquals(parseMeasuredExplicitTargetClassRequest(explicitRequest), {
    source_class: "люстру",
    destination: "светодиодный светильник",
    place: "гостиной",
    minimum_area_m2: 25,
    target_class: "светильник",
  });
  assertEquals(admitMeasuredExplicitTargetDirectRoute(explicitRequest), true);
  assertEquals(admitMeasuredSourceClassDirectRoute(explicitRequest), false);
  for (const extra of [
    "до 20 000 ₸",
    "белого цвета",
    "на натяжной потолок",
    "но не люстру",
    "только 2 варианта",
  ]) {
    assertEquals(admitMeasuredExplicitTargetDirectRoute(
      `Хочу заменить люстру на светодиодный светильник в гостиной 25 м² ${extra}.`,
    ), false, extra);
  }
});

Deno.test("measured direct admission delegates every uncovered customer obligation", () => {
  const cases = [
    [
      "budget",
      "Хочу заменить люстру на светодиодное освещение в гостиной 25 м² до 50 000 ₸. Что подойдет?",
    ],
    [
      "count",
      "Хочу заменить люстру на светодиодное освещение в гостиной 25 м². Покажите 2 варианта.",
    ],
    [
      "colour",
      "Хочу заменить люстру на светодиодное освещение в гостиной 25 м² белого цвета.",
    ],
    [
      "symbol-only colour",
      "Хочу заменить люстру на светодиодное освещение в гостиной 25 м² ⚪️",
    ],
    [
      "sensor",
      "Хочу заменить люстру на светодиодное освещение с датчиком движения в гостиной 25 м².",
    ],
    [
      "city-specific stock",
      "Хочу заменить люстру на светодиодное освещение в гостиной 25 м², в наличии в Астане.",
    ],
    [
      "exclusion",
      "Хочу заменить люстру на светодиодное освещение в гостиной 25 м², но не китайского производства.",
    ],
    [
      "mounting",
      "Хочу заменить люстру на светодиодное освещение в гостиной 25 м² с креплением на натяжной потолок.",
    ],
    [
      "power",
      "Хочу заменить люстру на светодиодное освещение в гостиной 25 м² мощностью от 50 Вт.",
    ],
    [
      "unlisted product feature",
      "Хочу заменить люстру на светодиодное освещение в гостиной 25 м² без мерцания.",
    ],
    [
      "target modifier",
      "Хочу заменить люстру на светодиодное освещение теплого света в гостиной 25 м².",
    ],
    [
      "source property",
      "Хочу заменить потолочную люстру на светодиодное освещение в гостиной 25 м².",
    ],
    [
      "site-adjacent condition",
      "Хочу заменить люстру на светодиодное освещение в гостиной с детьми 25 м².",
    ],
    [
      "site-absorbed colour",
      "Хочу заменить люстру на светодиодное освещение в гостиной белое 25 м².",
    ],
    [
      "ambiguous multiword site",
      "Хочу заменить люстру на светодиодное освещение в детской комнате 18 м².",
    ],
  ] as const;
  for (const [reason, message] of cases) {
    assertEquals(
      parseMeasuredSourceClassRecoveryRequest(message)?.source_class,
      "люстру",
      `${reason} should remain parseable for the expert route`,
    );
    assertEquals(admitMeasuredSourceClassDirectRoute(message), false, reason);
  }
});

Deno.test("uncovered obligation never starts measured direct catalog work", async () => {
  let fetched = false;
  const message =
    "Хочу заменить люстру на светодиодное освещение в гостиной 25 м², но только белое. Что подойдет?";
  assertEquals(
    parseMeasuredSourceClassRecoveryRequest(message)?.source_class,
    "люстру",
  );
  const result = await recoverMeasuredSourceClassSelection(message, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    cache: new Map(),
    fetchImpl: () => {
      fetched = true;
      throw new Error("unexpected fetch");
    },
  });
  assertEquals(result, null);
  assertEquals(fetched, false);
});

Deno.test("fallback cards need independent LED, site, area and warehouse proof", () => {
  const cards = [
    product("good", "Люстра светодиодная 96W", "кухня; гостиная", "30"),
    {
      ...product("no-warehouse-rows", "Люстра светодиодная 60W", "гостиная", "30", 0),
      warehouse_evidence: "missing" as const,
    },
    product("office", "Офисная панель светодиодная 48W", "офис", "30"),
    product("bulb", "Люстра E14 под светодиодные лампы", "гостиная", "30"),
    product("small", "Люстра светодиодная 20W", "гостиная", "12"),
    product("no-area", "Люстра светодиодная 40W", "гостиная", ""),
    { ...product("explicit-out", "Люстра светодиодная 40W", "гостиная", "30", 0), stock: "out" as const },
    {
      ...product("explicit-zero", "Люстра светодиодная 40W", "гостиная", "30", 0),
      warehouse_evidence: "explicit_zero" as const,
    },
    {
      ...product("unknown-rows", "Люстра светодиодная 40W", "гостиная", "30", 0),
      warehouse_evidence: "unverified" as const,
    },
  ];
  assertEquals(
    verifiedMeasuredLedReplacementProducts(request, cards).map(({ id }) => id),
    ["good", "no-warehouse-rows"],
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
    product("no-warehouse-rows", "Люстра светодиодная 60W", "гостиная", "30", 0),
    product("explicit-zero", "Люстра светодиодная 55W", "гостиная", "30", 0),
    product("office", "Офисная панель светодиодная 48W", "офис", "30"),
    product("old", "Люстра E14 под лампы", "гостиная", "30"),
  ];
  const catalogRows = source.map((entry) => ({
    id: entry.id,
    pagetitle: entry.pagetitle,
    price: entry.price,
    url: entry.url,
    category: { pagetitle: entry.leaf_category },
    ...(entry.id === "no-warehouse-rows"
      ? {}
      : entry.id === "explicit-zero"
      ? { warehouses: [{ city: "Алматы", amount: 0 }] }
      : { warehouses: [{ city: "Алматы", amount: 3 }] }),
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
          pagination: { page: 1, per_page: 200, pages: 1, total: 2 },
        },
      };
    } else if (url.pathname.endsWith("/categories/options")) {
      data = {
        data: {
          category: { id: 1, pagetitle: "Люстры", total_products: 7 },
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
    return Promise.resolve(
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
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
  assertEquals(recovered?.products.map(({ id }) => id), [
    "good1",
    "good2",
    "good3",
    "no-warehouse-rows",
  ]);
  assertEquals(calls.filter((call) => call.includes("/products?")).length, 2);
  assertEquals(
    calls.some((call) =>
      call.includes("category=%D0%9B%D1%8E%D1%81%D1%82%D1%80%D1%8B")
    ),
    true,
  );

  targetTimeout = true;
  const timedOut = await recoverMeasuredSourceClassSelection(request, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    cache: new Map(),
    fetchImpl,
  });
  assertEquals(timedOut?.target_status, "catalog_timeout");
  assertEquals(timedOut?.origin, "source_class_fallback");
  assertEquals(timedOut?.products.map(({ id }) => id), [
    "good1",
    "good2",
    "good3",
    "no-warehouse-rows",
  ]);

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
  assertEquals(targetMatched?.products.map(({ id }) => id), [
    "good1",
    "good2",
    "good3",
    "no-warehouse-rows",
  ]);
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

Deno.test("explicit class first checks live target leaf, then labels only verified source alternatives", async () => {
  resetDiscoverCategoryCacheForTest();
  const calls: string[] = [];
  let targetResolutionFailed = false;
  let targetEnough = false;
  const cards: ProductFull[] = [
    { ...product("target", "Светильник светодиодный 60W", "гостиная", "25"), leaf_category: "Светильники" },
    { ...product("target-b", "Светильник светодиодный 65W", "гостиная", "30"), leaf_category: "Светильники" },
    { ...product("target-c", "Светильник светодиодный 70W", "гостиная", "32"), leaf_category: "Светильники" },
    product("source-a", "Люстра светодиодная 96W", "гостиная", "30"),
    product("source-b", "Люстра светодиодная 75W", "гостиная", "28"),
    product("source-c", "Люстра светодиодная 70W", "гостиная", "25"),
    product("source-missing-stock", "Люстра светодиодная 65W", "гостиная", "30", 0),
    product("office", "Люстра светодиодная офисная 48W", "офис", "30"),
    product("small", "Люстра светодиодная 24W", "гостиная", "12"),
    product("bulb-only", "Люстра под светодиодные лампы", "гостиная", "30"),
    { ...product("other-leaf", "Люстра светодиодная 72W", "гостиная", "30"), leaf_category: "Декоративное освещение" },
  ];
  const rows = cards.map((card) => ({
    id: card.id,
    pagetitle: card.pagetitle,
    price: card.price,
    url: card.url,
    category: { pagetitle: card.leaf_category },
    ...(card.id === "source-missing-stock"
      ? {}
      : { warehouses: [{ city: "Алматы", amount: 3 }] }),
    options: card.short_traits.map((trait, index) => {
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
    if (url.pathname.endsWith("/categories")) {
      data = {
        data: {
          results: [
            { id: 1, pagetitle: "Светильники", children: [] },
            { id: 2, pagetitle: "Люстры", children: [] },
            { id: 3, pagetitle: "Декоративное освещение", children: [] },
          ],
          pagination: { page: 1, per_page: 200, pages: 1, total: 3 },
        },
      };
    } else if (url.pathname.endsWith("/categories/options")) {
      const title = url.searchParams.get("pagetitle") ?? "";
      if (title === "Светильники" && targetResolutionFailed) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      data = {
        data: {
          category: { id: title === "Люстры" ? 2 : 1, pagetitle: title, total_products: 8 },
          options: [{
            key: "purpose",
            caption_ru: "Назначение",
            type: "string",
            values: [{ value_ru: "гостиная", products_count: 4 }],
          }],
        },
      };
    } else if (url.pathname.endsWith("/products")) {
      const category = url.searchParams.get("category");
      const results = category === "Светильники"
        ? rows.filter((row) => row.category.pagetitle === "Светильники")
          .slice(0, targetEnough ? 3 : 1)
        : category === "Люстры"
        ? rows.filter((row) => row.category.pagetitle !== "Светильники")
        : [];
      data = { data: { results, pagination: { total: results.length } } };
    } else {
      throw new Error(`Unexpected URL: ${url}`);
    }
    return Promise.resolve(new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  };
  const recovered = await recoverMeasuredSourceClassSelection(explicitRequest, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    cache: new Map(),
    fetchImpl,
  });
  assertEquals(recovered?.origin, "explicit_target_with_source_alternatives");
  assertEquals(recovered?.target_category, "Светильники");
  assertEquals(recovered?.source_category, "Люстры");
  assertEquals(recovered?.target_verified, 1);
  assertEquals(recovered?.source_verified, 3);
  assertEquals(recovered?.products.map(({ id }) => id), [
    "target",
    "source-a",
    "source-b",
    "source-c",
  ]);
  assertEquals(calls.filter((call) => call.includes("/products?")), [
    "/products?category=%D0%A1%D0%B2%D0%B5%D1%82%D0%B8%D0%BB%D1%8C%D0%BD%D0%B8%D0%BA%D0%B8&min_price=1&per_page=50",
    "/products?category=%D0%9B%D1%8E%D1%81%D1%82%D1%80%D1%8B&min_price=1&per_page=50",
  ]);

  targetEnough = true;
  calls.length = 0;
  const exactOnly = await recoverMeasuredSourceClassSelection(explicitRequest, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    cache: new Map(),
    fetchImpl,
  });
  assertEquals(exactOnly?.origin, "explicit_target_class");
  assertEquals(exactOnly?.source_status, "not_needed");
  assertEquals(exactOnly?.products.map(({ id }) => id), [
    "target",
    "target-b",
    "target-c",
  ]);
  assertEquals(calls.some((call) => call.includes("/products?category=%D0%9B")), false);

  targetResolutionFailed = true;
  calls.length = 0;
  const sourceOnly = await recoverMeasuredSourceClassSelection(explicitRequest, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    cache: new Map(),
    fetchImpl,
  });
  assertEquals(sourceOnly?.origin, "explicit_target_with_source_alternatives");
  assertEquals(sourceOnly?.target_category, null);
  assertEquals(sourceOnly?.target_status, "category_not_found");
  assertEquals(sourceOnly?.products.map(({ id }) => id), [
    "source-a",
    "source-b",
    "source-c",
  ]);
  assertEquals(calls.filter((call) => call.includes("/products?")), [
    "/products?category=%D0%9B%D1%8E%D1%81%D1%82%D1%80%D1%8B&min_price=1&per_page=50",
  ]);
  resetDiscoverCategoryCacheForTest();
});
