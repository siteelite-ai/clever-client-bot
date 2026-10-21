// Exercise the actual HTTP handler without sockets, database, catalog or AI
// traffic. This is not live catalog evidence and does not enable the QA lane
// in production unless a separate strong secret is configured there.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CATALOG_QA_SECRET_ENV,
  CATALOG_QA_SECRET_HEADER,
} from "../_shared/v3-tools/catalog-health-preflight.ts";

const secret = "catalog_qa_fixture_secret_0123456789abcdef";
const healthyProduct = {
  id: 1,
  pagetitle: "Fixture product",
  price: 100,
  url: "https://220volt.kz/catalog/test/fixtures/product/",
};
const values: Record<string, string | undefined> = {
  SUPABASE_URL: "https://fixture.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "offline-service-role",
  CATALOG_API_BASE_URL: "https://fixture.catalog.invalid/api",
  CHAT_V3_ADMISSION_MODE: "off",
  [CATALOG_QA_SECRET_ENV]: secret,
};

const originalEnvGet = Deno.env.get;
const originalServe = Deno.serve;
let handler: ((request: Request) => Promise<Response>) | null = null;
Deno.env.get = (name: string) => values[name];
(Deno as unknown as { serve: typeof Deno.serve }).serve = ((
  callback: (request: Request) => Promise<Response>,
) => {
  handler = callback;
  return { shutdown() {}, finished: Promise.resolve() };
}) as unknown as typeof Deno.serve;
await import("./index.ts");
addEventListener("unload", () => {
  Deno.env.get = originalEnvGet;
  (Deno as unknown as { serve: typeof Deno.serve }).serve = originalServe;
});

function post(body: unknown, headerSecret?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (headerSecret !== undefined) {
    headers[CATALOG_QA_SECRET_HEADER] = headerSecret;
  }
  return new Request(
    "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
    { method: "POST", headers, body: JSON.stringify(body) },
  );
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function invoke(body: unknown, headerSecret?: string): Promise<Response> {
  if (!handler) throw new Error("handler not registered");
  return await handler(post(body, headerSecret));
}

Deno.test("catalog QA rejects disabled, missing and wrong secrets before DB or catalog", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("network must not be reached");
  }) as typeof fetch;
  try {
    for (
      const candidate of [
        undefined,
        "wrong_secret_0123456789abcdef012345",
        "short",
      ]
    ) {
      const response = await invoke(
        { type: "catalog_health_preflight" },
        candidate,
      );
      assertEquals(response.status, 404);
      assertEquals(response.headers.get("Access-Control-Allow-Origin"), null);
      assertEquals(response.headers.get("Cache-Control"), "no-store");
      assertEquals(await response.json(), { error: "Not found" });
    }
    values[CATALOG_QA_SECRET_ENV] = undefined;
    const disabled = await invoke({ type: "catalog_health_preflight" }, secret);
    assertEquals(disabled.status, 404);
    assertEquals(fetchCalls, 0);
  } finally {
    values[CATALOG_QA_SECRET_ENV] = secret;
    globalThis.fetch = originalFetch;
  }
});

Deno.test("catalog QA uses current settings and emits sanitized two-route result without AI calls", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  globalThis.setInterval = ((callback, delay, ...args) => {
    const id = originalSetInterval(callback, delay, ...args);
    intervals.add(id);
    return id;
  }) as typeof setInterval;
  const routes: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    routes.push(`${request.method} ${url.pathname}${url.search}`);
    if (
      url.origin === "https://fixture.supabase.invalid" &&
      url.pathname === "/rest/v1/app_settings"
    ) {
      return json({
        openrouter_api_key: "private-openrouter-do-not-expose",
        volt220_api_token: "private-catalog-do-not-expose",
        classifier_model: "offline-model",
      });
    }
    if (url.origin === "https://fixture.catalog.invalid") {
      assertEquals(
        request.headers.get("Authorization"),
        "Bearer private-catalog-do-not-expose",
      );
      if (url.pathname === "/api/categories") {
        assertEquals(
          url.searchParams.toString(),
          "parent=0&depth=10&per_page=200&page=1",
        );
        return json({
          data: { results: [{ id: 1, pagetitle: "Root", children: [] }] },
        });
      }
      if (url.pathname === "/api/products") {
        assertEquals(
          url.searchParams.toString(),
          "per_page=20&page=1&min_price=1",
        );
        return json({ data: { results: [healthyProduct] } });
      }
    }
    throw new Error(`unexpected outbound route: ${url.origin}${url.pathname}`);
  }) as typeof fetch;
  try {
    const response = await invoke({ type: "catalog_health_preflight" }, secret);
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("Access-Control-Allow-Origin"), null);
    assertEquals(response.headers.get("Cache-Control"), "no-store");
    const body = await response.text();
    assertEquals(JSON.parse(body), {
      ok: true,
      status: "ready",
      checks: {
        categories: { status: "ok", http_status: 200 },
        products: { status: "ok", http_status: 200 },
      },
    });
    assert(!body.includes("private-") && !body.includes("fixture."));
    assertEquals(
      routes.filter((route) => route.startsWith("GET /api/")).length,
      2,
    );
  } finally {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
  }
});

Deno.test("catalog QA reports actual taxonomy 500 but does not spend a model request", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  globalThis.setInterval = ((callback, delay, ...args) => {
    const id = originalSetInterval(callback, delay, ...args);
    intervals.add(id);
    return id;
  }) as typeof setInterval;
  const routes: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    routes.push(url.pathname);
    if (url.pathname === "/rest/v1/app_settings") {
      return json({ volt220_api_token: "private-catalog-do-not-expose" });
    }
    if (url.pathname === "/api/categories") {
      return json({ secret_body: "hidden" }, 500);
    }
    if (url.pathname === "/api/products") {
      return json({ data: { results: [healthyProduct] } });
    }
    throw new Error(`unexpected outbound route: ${url.pathname}`);
  }) as typeof fetch;
  try {
    const response = await invoke({ type: "catalog_health_preflight" }, secret);
    assertEquals(response.status, 503);
    assertEquals(response.headers.get("Cache-Control"), "no-store");
    const body = await response.text();
    const parsed = JSON.parse(body);
    assertEquals(parsed.ok, false);
    assertEquals(parsed.classification, "upstream");
    assertEquals(parsed.checks.categories.http_status, 500);
    assertEquals(parsed.checks.products.status, "ok");
    assert(!body.includes("secret_body") && !body.includes("private-catalog"));
    assertEquals(routes, [
      "/rest/v1/app_settings",
      "/api/categories",
      "/api/products",
    ]);
  } finally {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
  }
});

Deno.test("ordinary invalid chat remains on the existing public validation path", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("invalid chat must not reach network");
  }) as typeof fetch;
  try {
    const response = await invoke({ message: "" });
    assertEquals(response.status, 400);
    assertEquals(response.headers.get("Access-Control-Allow-Origin"), "*");
    assertEquals((await response.json()).error, "invalid_request");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
