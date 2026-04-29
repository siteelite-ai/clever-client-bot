// Deno-тесты для catalog/api-client.ts.
// Все запуски замокированы — НИ ОДНОГО реального HTTP-вызова.
//
// Покрытие:
//   • searchProducts: ok, empty, all_zero_price, http_error, timeout,
//                     empty_degraded (Q3 recovery), unsafe_param_blocked,
//                     option_filters сериализация + alias-расширение,
//                     ?sort= НЕ отправляется (Q1).
//   • getCategoryOptions: ok, empty, double-unwrap (Q2), retry-on-timeout,
//                         http_error, parse_error.
//   • unwrapDouble: разные варианты обёрток.

import {
  assertEquals,
  assertExists,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  searchProducts,
  getCategoryOptions,
  unwrapDouble,
  createProductionApiClientDeps,
  type ApiClientDeps,
  type RawProduct,
} from "./api-client.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeFetch(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
): typeof fetch {
  return ((url: string, init: RequestInit = {}) => {
    return Promise.resolve(handler(String(url), init));
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deps(fetchFn: typeof fetch, overrides: Partial<ApiClientDeps> = {}): ApiClientDeps {
  return {
    baseUrl: "https://api.example.test",
    apiToken: "test-token",
    fetch: fetchFn,
    timeoutMs: { products: 500, categoryOptions: 500 },
    ...overrides,
  };
}

const P = (id: number, price: number, extra: Partial<RawProduct> = {}): RawProduct => ({
  id,
  name: `name-${id}`,
  pagetitle: `pagetitle-${id}`,
  url: `/p/${id}`,
  price,
  ...extra,
});

// ─── searchProducts: happy paths ────────────────────────────────────────────

Deno.test("searchProducts: ok — фильтрует price<=0 и считает zeroPriceFiltered", async () => {
  let calledUrl = "";
  const f = makeFetch((url) => {
    calledUrl = url;
    return jsonResponse({
      data: { results: [P(1, 100), P(2, 0), P(3, 50), P(4, -5)], total: 4 },
    });
  });

  const r = await searchProducts({ query: "лампа" }, deps(f));

  assertEquals(r.status, "ok");
  assertEquals(r.products.length, 2);
  assertEquals(r.products.map((p) => p.id), [1, 3]);
  assertEquals(r.zeroPriceFiltered, 2);
  assertEquals(r.totalFromApi, 4);
  assert(calledUrl.includes("/products?"));
  assert(calledUrl.includes("query=%D0%BB%D0%B0%D0%BC%D0%BF%D0%B0"));
  assert(calledUrl.includes("per_page=30"));
  // Q1: ?sort= НЕ должен попадать в URL.
  assert(!calledUrl.includes("sort="));
});

Deno.test("searchProducts: empty — API вернул total=0 без quirk-ключей", async () => {
  const f = makeFetch(() => jsonResponse({ data: { results: [], total: 0 } }));
  const r = await searchProducts({ query: "abc" }, deps(f));
  assertEquals(r.status, "empty");
  assertEquals(r.products.length, 0);
  assertEquals(r.zeroPriceFiltered, 0);
});

Deno.test("searchProducts: all_zero_price — есть товары, но все с price=0", async () => {
  const f = makeFetch(() => jsonResponse({
    data: { results: [P(1, 0), P(2, 0)], total: 2 },
  }));
  const r = await searchProducts({ query: "abc" }, deps(f));
  assertEquals(r.status, "all_zero_price");
  assertEquals(r.products.length, 0);
  assertEquals(r.zeroPriceFiltered, 2);
  assertEquals(r.totalFromApi, 2);
});

Deno.test("searchProducts: http_error — 500 с body", async () => {
  const f = makeFetch(() => new Response("boom", { status: 500 }));
  const r = await searchProducts({ query: "abc" }, deps(f));
  assertEquals(r.status, "http_error");
  assertEquals(r.httpStatus, 500);
  assert((r.errorMessage ?? "").includes("boom"));
});

Deno.test("searchProducts: timeout (AbortError)", async () => {
  const f = makeFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
    const sig = (init.signal as AbortSignal | undefined);
    sig?.addEventListener("abort", () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    });
  }));
  const r = await searchProducts({ query: "abc" }, deps(f, { timeoutMs: { products: 30 } }));
  assertEquals(r.status, "timeout");
});

// ─── F.4.3: единая retry-политика на searchProducts ────────────────────────

Deno.test("searchProducts: F.4.3 retry on timeout, второй ответ ok", async () => {
  let callIndex = 0;
  const f = makeFetch((_url, init) => {
    callIndex++;
    if (callIndex === 1) {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init.signal as AbortSignal | undefined;
        sig?.addEventListener("abort", () => {
          const err = new Error("aborted"); err.name = "AbortError"; reject(err);
        });
      });
    }
    return Promise.resolve(jsonResponse({
      data: { results: [P(1, 100)], total: 1 },
    }));
  });
  const r = await searchProducts({ query: "drill" }, deps(f, { timeoutMs: { products: 30 } }));
  assertEquals(callIndex, 2, "должен быть ровно 1 retry");
  assertEquals(r.status, "ok");
  assertEquals(r.products.length, 1);
});

Deno.test("searchProducts: F.4.3 double-timeout → status='timeout' (без infinite retry)", async () => {
  let callIndex = 0;
  const f = makeFetch((_url, init) => {
    callIndex++;
    return new Promise<Response>((_resolve, reject) => {
      const sig = init.signal as AbortSignal | undefined;
      sig?.addEventListener("abort", () => {
        const err = new Error("aborted"); err.name = "AbortError"; reject(err);
      });
    });
  });
  const r = await searchProducts({ query: "drill" }, deps(f, { timeoutMs: { products: 20 } }));
  assertEquals(callIndex, 2, "ровно 2 попытки, без 3-й");
  assertEquals(r.status, "timeout");
});

Deno.test("searchProducts: F.4.3 НЕ ретраит HTTP 500 (только транспорт)", async () => {
  let callIndex = 0;
  const f = makeFetch(() => {
    callIndex++;
    return new Response("server err", { status: 500 });
  });
  const r = await searchProducts({ query: "drill" }, deps(f));
  assertEquals(callIndex, 1, "HTTP-ошибки — не транспортные, retry не применяется");
  assertEquals(r.status, "http_error");
  assertEquals(r.httpStatus, 500);
});

Deno.test("searchProducts: unsafe_param_blocked для control-chars", async () => {
  let called = false;
  const f = makeFetch(() => { called = true; return jsonResponse({}); });
  const r = await searchProducts({ query: "evil\x00query" }, deps(f));
  assertEquals(r.status, "http_error");
  assertEquals(r.errorMessage, "unsafe_param_blocked");
  assertEquals(called, false);
});

// ─── option_filters сериализация ────────────────────────────────────────────

Deno.test("searchProducts: optionFilters → options[key][]=value", async () => {
  let calledUrl = "";
  const f = makeFetch((url) => {
    calledUrl = url;
    return jsonResponse({ data: { results: [P(1, 10)], total: 1 } });
  });

  await searchProducts({
    query: "x",
    optionFilters: { color_key: ["red", "blue"] },
  }, deps(f));

  assert(calledUrl.includes("options%5Bcolor_key%5D%5B%5D=red"));
  assert(calledUrl.includes("options%5Bcolor_key%5D%5B%5D=blue"));
});

Deno.test("searchProducts: optionAliases дублируют ключ на все алиасы", async () => {
  let calledUrl = "";
  const f = makeFetch((url) => {
    calledUrl = url;
    return jsonResponse({ data: { results: [P(1, 10)], total: 1 } });
  });

  await searchProducts({
    query: "x",
    optionFilters: { color: ["red"] },
    optionAliases: { color: ["color_a", "color_b"] },
  }, deps(f));

  // canonical "color" НЕ отправляется — только алиасы.
  assert(!calledUrl.includes("options%5Bcolor%5D%5B%5D=red"));
  assert(calledUrl.includes("options%5Bcolor_a%5D%5B%5D=red"));
  assert(calledUrl.includes("options%5Bcolor_b%5D%5B%5D=red"));
});

// ─── Q3 recovery ────────────────────────────────────────────────────────────

Deno.test("searchProducts: empty_degraded — Q3 recovery находит товары без не-ASCII ключа", async () => {
  let callIndex = 0;
  const f = makeFetch((url) => {
    callIndex++;
    if (callIndex === 1) {
      // Первый запрос — с не-ASCII ключом, total=0.
      assert(url.includes("color_%D2%AF") || /%D[0-9A-F]/.test(url),
        "first call must include non-ASCII option key");
      return jsonResponse({ data: { results: [], total: 0 } });
    }
    // Recovery: без подозрительного ключа — есть товары.
    assert(!/options%5Bcolor_%D2/.test(url),
      "recovery call must NOT include suspect non-ASCII key");
    return jsonResponse({ data: { results: [P(1, 100)], total: 5 } });
  });

  const r = await searchProducts({
    query: "x",
    optionFilters: { "color_ү": ["red"] }, // не-ASCII ключ
  }, deps(f));

  assertEquals(callIndex, 2);
  assertEquals(r.status, "empty_degraded");
  assertEquals(r.products.length, 0);
  assertExists(r.degradedHint);
  assertEquals(r.degradedHint!.suspectedQuirkKey, "color_ү");
  assertEquals(r.degradedHint!.recoveredCount, 5);
});

Deno.test("searchProducts: НЕТ recovery если все ключи ASCII", async () => {
  let callIndex = 0;
  const f = makeFetch(() => {
    callIndex++;
    return jsonResponse({ data: { results: [], total: 0 } });
  });
  const r = await searchProducts({
    query: "x",
    optionFilters: { color_ascii: ["red"] },
  }, deps(f));
  assertEquals(callIndex, 1); // recovery НЕ вызвался
  assertEquals(r.status, "empty");
});

// ─── getCategoryOptions ────────────────────────────────────────────────────

Deno.test("getCategoryOptions: ok — обычная обёртка { data: { options, category } }", async () => {
  let calledUrl = "";
  const f = makeFetch((url) => {
    calledUrl = url;
    return jsonResponse({
      data: {
        options: [{ key: "k1", caption_ru: "K1", values: [{ value_ru: "v1" }] }],
        category: { total_products: 42 },
      },
    });
  });
  const r = await getCategoryOptions("test-cat", deps(f));
  assertEquals(r.status, "ok");
  assertEquals(r.options.length, 1);
  assertEquals(r.totalProducts, 42);
  assert(calledUrl.includes("/categories/options?pagetitle=test-cat"));
});

Deno.test("getCategoryOptions: Q2 — double-wrap { data: { data: { options, category } } }", async () => {
  const f = makeFetch(() => jsonResponse({
    data: { data: {
      options: [{ key: "k1", values: [{ value_ru: "v1" }] }],
      category: { total_products: 7 },
    } },
  }));
  const r = await getCategoryOptions("cat", deps(f));
  assertEquals(r.status, "ok");
  assertEquals(r.options.length, 1);
  assertEquals(r.totalProducts, 7);
});

Deno.test("getCategoryOptions: empty — options=[]", async () => {
  const f = makeFetch(() => jsonResponse({
    data: { options: [], category: { total_products: 0 } },
  }));
  const r = await getCategoryOptions("cat", deps(f));
  assertEquals(r.status, "empty");
  assertEquals(r.options.length, 0);
});

Deno.test("getCategoryOptions: retry on timeout, второй ответ ok", async () => {
  let callIndex = 0;
  const f = makeFetch((_url, init) => {
    callIndex++;
    if (callIndex === 1) {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init.signal as AbortSignal | undefined;
        sig?.addEventListener("abort", () => {
          const err = new Error("aborted"); err.name = "AbortError"; reject(err);
        });
      });
    }
    return Promise.resolve(jsonResponse({
      data: { options: [{ key: "k", values: [{ value_ru: "v" }] }], category: { total_products: 1 } },
    }));
  });
  const r = await getCategoryOptions("cat", deps(f, { timeoutMs: { categoryOptions: 30 } }));
  assertEquals(callIndex, 2);
  assertEquals(r.status, "ok");
});

Deno.test("getCategoryOptions: http_error 500", async () => {
  const f = makeFetch(() => new Response("err", { status: 500 }));
  const r = await getCategoryOptions("cat", deps(f));
  assertEquals(r.status, "http_error");
  assertEquals(r.httpStatus, 500);
});

// ─── unwrapDouble unit ──────────────────────────────────────────────────────

Deno.test("unwrapDouble: один уровень data", () => {
  const r = unwrapDouble<{ options: unknown[] }>({ data: { options: [1, 2] } });
  assertEquals(r.options, [1, 2]);
});

Deno.test("unwrapDouble: двойная обёртка", () => {
  const r = unwrapDouble<{ options: unknown[] }>({ data: { data: { options: [9] } } });
  assertEquals(r.options, [9]);
});

Deno.test("unwrapDouble: уже распакованное возвращается как есть", () => {
  const r = unwrapDouble<{ options: unknown[] }>({ options: [1] });
  assertEquals(r.options, [1]);
});

// ─── factory ────────────────────────────────────────────────────────────────

Deno.test("createProductionApiClientDeps: trim trailing slash", () => {
  const d = createProductionApiClientDeps({ baseUrl: "https://x.test/api/", apiToken: "t" });
  assertEquals(d.baseUrl, "https://x.test/api");
});

Deno.test("createProductionApiClientDeps: throws on missing args", () => {
  let threw = false;
  try { createProductionApiClientDeps({ baseUrl: "", apiToken: "t" }); }
  catch { threw = true; }
  assertEquals(threw, true);
});
