import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { CatalogClientDeps } from "./search-catalog.ts";
import type { ProductCache } from "./types.ts";
import { classifyExactCompoundMarkingRequest } from "./exact-compound-marking-policy.ts";
import {
  exactCompoundClassPhrase,
  selectCompleteCategoryPrice,
  type CompleteCategoryPriceInput,
} from "./complete-category-price.ts";

const request = {
  query: "кабель ВВГ 3*1,5",
  first: 3,
  second: 1.5,
  priceDirection: "cheapest" as const,
  exhaustive: false,
};
const input: CompleteCategoryPriceInput = {
  request,
  discovery: {
    ok: true,
    category: { id: 1, pagetitle: "Кабель ВВГ", total_products: 3 },
    facets: [],
    leaf_categories: [{ id: 2, pagetitle: "Лист 3x1.5" }],
    resolution_method: "exact",
  },
};

function raw(id: string, title: string, price: number, options: Array<Record<string, unknown>> = [],
  warehouses: unknown = [{ city: "Караганда", amount: 5 }]) {
  return {
    id, pagetitle: title, price,
    url: `https://220volt.kz/catalog/cables/vvg/product-${id}/`,
    options: [
      { key: "edinica_izmereniya", caption_ru: "Единица измерения", value_ru: "м" },
      ...options,
    ],
    warehouses,
  };
}

function page(rows: unknown[], total = rows.length, status = 200): Response {
  return new Response(JSON.stringify({ data: { results: rows, pagination: { total } } }), {
    status, headers: { "content-type": "application/json" },
  });
}

function deps(fetchImpl: typeof fetch): CatalogClientDeps {
  return { baseUrl: "https://catalog.test/api", apiToken: "test", fetchImpl };
}

Deno.test("class phrase is extracted from customer-owned compound, not guessed from taxonomy", () => {
  assertEquals(exactCompoundClassPhrase(request), "кабель ввг");
  assertEquals(exactCompoundClassPhrase({ ...request, query: "ВВГ без маркировки" }), null);
  const customerRequest = classifyExactCompoundMarkingRequest("найди кабель ввг 3*1,5 самый дешевый");
  assert(customerRequest);
  assertEquals(customerRequest.priceDirection, "cheapest");
  assertEquals(exactCompoundClassPhrase(customerRequest), "кабель ввг");
});

Deno.test("exact parent hierarchy prunes only wholly disjoint marking leaves", async () => {
  const discovery = { ...input.discovery, category: { id: 1, pagetitle: "Кабель ВВГ", total_products: 226 },
    leaf_categories: [
      { id: 2, pagetitle: "2x1.5" },
      { id: 3, pagetitle: "3x1.5" },
      { id: 4, pagetitle: "3x2.5" },
      { id: 5, pagetitle: "3x4" },
    ] };
  const seen: string[] = [];
  const result = await selectCompleteCategoryPrice({ ...input, discovery }, deps((url) => {
    const leaf = new URL(String(url)).searchParams.get("category") ?? "";
    seen.push(leaf);
    assertEquals(leaf, "3x1.5");
    return Promise.resolve(page([raw("301", "Кабель ВВГ 3*1,5 ГОСТ IK", 301)]));
  }), new Map());
  assert(result.ok);
  assertEquals(result.product.id, "301");
  assertEquals(result.evidence.taxonomy_leaf_count, 4);
  assertEquals(result.evidence.skipped_other_marking_leaves, 3);
  assertEquals(result.evidence.leaf_categories, ["3x1.5"]);
  assertEquals(seen, ["3x1.5"]);
});

Deno.test("unmarked and multi-marking leaves remain in exhaustive scope", async () => {
  const discovery = { ...input.discovery, leaf_categories: [
    { id: 2, pagetitle: "Кабель ВВГ 2x1.5" },
    { id: 3, pagetitle: "3x1.5" },
    { id: 4, pagetitle: "Разное" },
    { id: 5, pagetitle: "2x1.5 и 3x1.5" },
  ] };
  const seen: string[] = [];
  const result = await selectCompleteCategoryPrice({ ...input, discovery }, deps((url) => {
    const leaf = new URL(String(url)).searchParams.get("category") ?? "";
    seen.push(leaf);
    const rows = leaf === "3x1.5" ? [raw("462", "Кабель ВВГ 3*1,5", 462)]
      : leaf === "Разное" ? [raw("301", "Кабель ВВГ 3*1,5 ГОСТ IK", 301)]
      : [raw("400", "Кабель ВВГ 3*1,5 A", 400)];
    return Promise.resolve(page(rows));
  }), new Map());
  assert(result.ok);
  assertEquals(result.product.id, "301");
  assertEquals(result.evidence.skipped_other_marking_leaves, 1);
  assertEquals(seen, ["3x1.5", "Разное", "2x1.5 и 3x1.5"]);
});

Deno.test("a cheaper exact class with intervening title words cannot be silently missed", async () => {
  const rows = [
    raw("301", "Кабель ВВГ 3*1,5 ГОСТ IK", 301),
    raw("260", "Кабель ВВГ ГОСТ 3*1,5", 260),
    raw("250", "Кабель силовой ВВГ 3*1,5", 250),
  ];
  const result = await selectCompleteCategoryPrice(input,
    deps(() => Promise.resolve(page(rows))), new Map());
  assert(result.ok);
  assertEquals(result.product.id, "250");
  assertEquals(result.evidence.matching_available, 3);
});

Deno.test("ambiguous same-size title cannot be excluded and yield a false minimum", async () => {
  for (const title of [
    "Кабель ВВГ 2*1,5 или 3*1,5",
    "Кабель АВВГ 3*1,5",
    "Кабель ВВГ 3*1,5*2",
    "Провод КГ 3*1,5",
    "ВВГнг 3*1,5",
  ]) {
    const result = await selectCompleteCategoryPrice(input,
      deps(() => Promise.resolve(page([
        raw("301", "Кабель ВВГ 3*1,5 ГОСТ IK", 301),
        raw("200", title, 200),
      ]))), new Map());
    assertEquals(result.ok, false, title);
    if (!result.ok) assertEquals(result.reason, "unverified_candidate", title);
  }
});

Deno.test("all leaves structurally disjoint rejects the scope without a catalog call", async () => {
  const discovery = { ...input.discovery, leaf_categories: [
    { id: 2, pagetitle: "2x1.5" }, { id: 3, pagetitle: "3x2.5" },
  ] };
  const result = await selectCompleteCategoryPrice({ ...input, discovery },
    deps(() => { throw new Error("must not fetch"); }), new Map());
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, "invalid_scope");
});

Deno.test("complete-category price finds text-query-omitted cheapest from unfiltered category", async () => {
  const cheap = raw("301", "Кабель ВВГ 3*1,5 ГОСТ IK", 301);
  const expensive = raw("462", "Кабель ВВГ 3*1,5 AT", 462);
  const otherCompound = raw("100", "Кабель ВВГ 3*2,5", 100);
  const seen: URL[] = [];
  const fetchImpl: typeof fetch = (url) => {
    const parsed = new URL(String(url));
    seen.push(parsed);
    return Promise.resolve(page([expensive, otherCompound, cheap]));
  };
  const cache: ProductCache = new Map();
  const result = await selectCompleteCategoryPrice(input, deps(fetchImpl), cache);
  assert(result.ok);
  assertEquals(result.product.id, "301");
  assertEquals(result.evidence.raw_rows, 3);
  assertEquals(result.evidence.matching_available, 2);
  assertEquals(result.evidence.unit, "м");
  assertEquals(cache.get("301")?.url, cheap.url);
  assertEquals([...cache.keys()], ["301"]);
  assertEquals(seen.length, 1);
  assertEquals(seen[0].searchParams.get("category"), "Лист 3x1.5");
  assertEquals(seen[0].searchParams.has("query"), false);
  assertEquals(seen[0].searchParams.get("per_page"), "50");
  assertEquals(seen[0].searchParams.get("page"), "1");
});

Deno.test("a cheapest product omitted from page one still wins after full pagination", async () => {
  const first = Array.from({ length: 50 }, (_, index) =>
    raw(String(index + 1), `Кабель ВВГ 3*1,5 ${index + 1}`, 500 + index));
  const second = raw("cheap-late", "Кабель ВВГ 3*1,5 поздняя карточка", 301);
  const seenPages: string[] = [];
  const result = await selectCompleteCategoryPrice(input, deps((url) => {
    const pageNumber = new URL(String(url)).searchParams.get("page") ?? "";
    seenPages.push(pageNumber);
    return Promise.resolve(page(pageNumber === "1" ? first : [second], 51));
  }), new Map());
  assert(result.ok);
  assertEquals(result.product.id, "cheap-late");
  assertEquals(result.evidence.raw_rows, 51);
  assertEquals(seenPages, ["1", "2"]);
});

Deno.test("expensive direction selects highest price only after complete scan", async () => {
  const rows = [raw("1", "Кабель ВВГ 3*1,5 A", 301), raw("2", "Кабель ВВГ 3*1,5 B", 462)];
  const result = await selectCompleteCategoryPrice({ ...input, request: { ...request, priceDirection: "expensive" } },
    deps(() => Promise.resolve(page(rows))), new Map());
  assert(result.ok);
  assertEquals(result.product.id, "2");
  assertEquals(result.evidence.selected_price, 462);
});

Deno.test("raw cap and too many leaves never become a partial superlative", async () => {
  let calls = 0;
  const overCap = await selectCompleteCategoryPrice(input, deps(() => {
    calls++;
    return Promise.resolve(page([raw("1", "Кабель ВВГ 3*1,5", 301)], 201));
  }), new Map());
  assertEquals(overCap, { ok: false, reason: "catalog_cap", message: "complete category exceeds 200 raw rows" });
  assertEquals(calls, 1);

  const tooMany = await selectCompleteCategoryPrice({ ...input, discovery: {
    ...input.discovery, leaf_categories: Array.from({ length: 9 }, (_, index) => ({ id: index + 2, pagetitle: `Лист ${index}` })),
  } }, deps(() => { throw new Error("must not fetch"); }), new Map());
  assertEquals(tooMany.ok, false);
  if (!tooMany.ok) assertEquals(tooMany.reason, "invalid_scope");
});

Deno.test("large taxonomy is allowed when structural pruning leaves a bounded proof scope", async () => {
  const leaf_categories = [
    ...Array.from({ length: 19 }, (_, index) => ({ id: index + 2, pagetitle: `2x${index + 1}` })),
    { id: 21, pagetitle: "3x1.5" },
  ];
  const discovery = { ...input.discovery, leaf_categories };
  const result = await selectCompleteCategoryPrice({ ...input, discovery }, deps((url) => {
    assertEquals(new URL(String(url)).searchParams.get("category"), "3x1.5");
    return Promise.resolve(page([raw("301", "Кабель ВВГ 3*1,5", 301)]));
  }), new Map());
  assert(result.ok);
  assertEquals(result.evidence.taxonomy_leaf_count, 20);
  assertEquals(result.evidence.skipped_other_marking_leaves, 19);
  const excessive = await selectCompleteCategoryPrice({ ...input, discovery: {
    ...input.discovery,
    leaf_categories: Array.from({ length: 257 }, (_, index) => ({ id: index + 2, pagetitle: `2x${index + 1}` })),
  } }, deps(() => { throw new Error("must not fetch"); }), new Map());
  assertEquals(excessive.ok, false);
  if (!excessive.ok) assertEquals(excessive.reason, "invalid_scope");
});

Deno.test("oversized unannounced response is rejected while streaming", async () => {
  let pulls = 0;
  const result = await selectCompleteCategoryPrice(input, deps(() => Promise.resolve(
    new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(1_000_000));
      },
    }), { headers: { "content-type": "application/json" } }),
  )), new Map());
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.reason, "catalog_failure");
    assert(result.message.includes("size limit"));
  }
  assert(pulls <= 5);
});

Deno.test("model-picked, unrelated or narrower scope is rejected before paid catalog calls", async () => {
  const invalidDiscoveries: CompleteCategoryPriceInput["discovery"][] = [
    { ...input.discovery, resolution_method: "model" },
    { ...input.discovery, resolution_method: "live_taxonomy" },
    { ...input.discovery, category: { id: 1, pagetitle: "Кабель КГ", total_products: 1 } },
    { ...input.discovery, category: { id: 2, pagetitle: "Кабель ВВГ 2x1.5", total_products: 1 },
      leaf_categories: [{ id: 2, pagetitle: "Кабель ВВГ 2x1.5" }] },
    { ...input.discovery, category: { id: 2, pagetitle: "Кабель ВВГ 3x1.5", total_products: 1 },
      leaf_categories: [{ id: 3, pagetitle: "Кабель ВВГ 3x1.5" }] },
  ];
  for (const discovery of invalidDiscoveries) {
    const result = await selectCompleteCategoryPrice({ ...input, discovery },
      deps(() => { throw new Error("must not fetch"); }), new Map());
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.reason, "invalid_scope");
  }
  const exactLeaf = { ...input.discovery,
    category: { id: 2, pagetitle: "Кабель ВВГ 3x1.5", total_products: 1 },
    leaf_categories: [{ id: 2, pagetitle: "Кабель ВВГ 3x1.5" }],
  };
  const accepted = await selectCompleteCategoryPrice({ ...input, discovery: exactLeaf },
    deps(() => Promise.resolve(page([raw("1", "Кабель ВВГ 3*1,5", 301)]))), new Map());
  assertEquals(accepted.ok, true);
});

Deno.test("page failure, changed total, missing rows and duplicate IDs fail closed", async () => {
  const first = Array.from({ length: 50 }, (_, index) => raw(String(index), `Кабель ВВГ 3*1,5 ${index}`, 400 + index));
  for (const second of [
    page([], 51, 503),
    page([raw("50", "Кабель ВВГ 3*1,5", 301)], 52),
    page([], 51),
    page([first[0]], 51),
  ]) {
    const cache: ProductCache = new Map();
    const result = await selectCompleteCategoryPrice(input, deps((url) =>
      Promise.resolve(new URL(String(url)).searchParams.get("page") === "1"
        ? page(first, 51) : second)), cache);
    assertEquals(result.ok, false);
    assertEquals(cache.size, 0);
  }
});

Deno.test("one failed leaf invalidates the entire discovered multi-leaf scope", async () => {
  const discovery = { ...input.discovery, leaf_categories: [
    { id: 2, pagetitle: "Лист A" }, { id: 3, pagetitle: "Лист B" },
  ] };
  const result = await selectCompleteCategoryPrice({ ...input, discovery }, deps((url) => {
    const leaf = new URL(String(url)).searchParams.get("category");
    return Promise.resolve(leaf === "Лист A"
      ? page([raw("1", "Кабель ВВГ 3*1,5", 301)])
      : page([], 0, 503));
  }), new Map());
  assertEquals(result.ok, false);
});

Deno.test("mixed or missing unit prevents comparing incomparable exact candidates", async () => {
  const metre = raw("1", "Кабель ВВГ 3*1,5", 301);
  const packageUnit = raw("2", "Кабель ВВГ 3*1,5 упаковка", 250, [
    { key: "edinica_izmereniya", caption_ru: "Единица измерения", value_ru: "уп" },
  ]);
  packageUnit.options = packageUnit.options.filter((option) => option.key !== "edinica_izmereniya" || option.value_ru === "уп");
  const mixed = await selectCompleteCategoryPrice(input,
    deps(() => Promise.resolve(page([metre, packageUnit]))), new Map());
  assertEquals(mixed.ok, false);
  if (!mixed.ok) {
    assertEquals(mixed.reason, "mixed_units");
    assertEquals(mixed.unit_options, ["м", "уп"]);
  }
  const missingUnit = { ...metre, options: [] };
  const missing = await selectCompleteCategoryPrice(input,
    deps(() => Promise.resolve(page([missingUnit]))), new Map());
  assertEquals(missing.ok, false);
  if (!missing.ok) assertEquals(missing.reason, "unverified_candidate");
});

Deno.test("restricted, unpriced and explicit-zero items cannot win a superlative", async () => {
  const rows = [
    raw("restricted", "Кабель ВВГ 3*1,5", 1, [{ key: "ogranichennyy_prosmotr", value_ru: "Да" }]),
    raw("unpriced", "Кабель ВВГ 3*1,5", 0),
    raw("zero", "Кабель ВВГ 3*1,5", 20, [], [{ city: "Караганда", amount: 0 }]),
    raw("wrong", "Кабель ВВГ 3*2,5", 10),
    raw("good", "Кабель ВВГ 3*1,5 ГОСТ", 301),
  ];
  const cache: ProductCache = new Map();
  const result = await selectCompleteCategoryPrice(input, deps(() => Promise.resolve(page(rows))), cache);
  assert(result.ok);
  assertEquals(result.product.id, "good");
  assertEquals(result.evidence.restricted_excluded, 1);
  assertEquals(result.evidence.unpriced_excluded, 1);
  assertEquals(result.evidence.zero_stock_excluded, 1);
  assertEquals([...cache.keys()], ["good"]);
});

Deno.test("unverified stock, malformed page and contradictory category rows cannot prove a price", async () => {
  for (const candidate of [
    { ...raw("1", "Кабель ВВГ 3*1,5", 301), warehouses: [] },
    { ...raw("1", "Кабель ВВГ 3*1,5", 301), warehouses: [{ city: "Караганда", amount: "5" }] },
    { ...raw("1", "Кабель ВВГ 3*1,5", 301), warehouses: [{ city: "", amount: 5 }] },
    { ...raw("1", "Кабель ВВГ 3*1,5", 301), url: "https://evil.example/catalog/x/y/z/" },
  ]) {
    const result = await selectCompleteCategoryPrice(input,
      deps(() => Promise.resolve(page([candidate]))), new Map());
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.reason, "unverified_candidate");
  }
  const malformed = await selectCompleteCategoryPrice(input,
    deps(() => Promise.resolve(new Response(JSON.stringify({ data: { results: [] } }), {
      status: 200, headers: { "content-type": "application/json" },
    }))), new Map());
  assertEquals(malformed.ok, false);
  const foreignLeaf = await selectCompleteCategoryPrice(input,
    deps(() => Promise.resolve(page([{ ...raw("1", "Кабель ВВГ 3*1,5", 301), category: "Другой лист" }]))),
    new Map());
  assertEquals(foreignLeaf.ok, false);
  if (!foreignLeaf.ok) assertEquals(foreignLeaf.reason, "catalog_partial");
});

Deno.test("malformed unrelated option entries do not turn a completed proof into a connection error", async () => {
  const item = { ...raw("301", "Кабель ВВГ 3*1,5", 301), options: [
    null,
    { key: "edinica_izmereniya", caption_ru: "Единица измерения", value_ru: "м" },
  ] };
  const result = await selectCompleteCategoryPrice(input,
    deps(() => Promise.resolve(page([item]))), new Map());
  assert(result.ok);
  assertEquals(result.product.id, "301");
});
