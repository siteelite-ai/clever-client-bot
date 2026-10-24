// Exercise the deployed closure entrypoint's actual HTTP gates without a
// network, database, catalog, or model call. Credentials are synthetic.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CLOSURE_TEST_ACCESS_ENV_PREFIX,
  CLOSURE_TEST_CATALOG_ENV_PREFIX,
  PREVIEW_QA_SECRET_ENV,
  PREVIEW_SECRET_ENV,
  PREVIEW_SECRET_HEADER,
} from "../_shared/v3-tools/preview-secret-gate.ts";
import {
  CATALOG_QA_SECRET_ENV,
  CATALOG_QA_SECRET_HEADER,
} from "../_shared/v3-tools/catalog-health-preflight.ts";

const issuedSeconds = Math.floor(Date.now() / 1000);
const hex = "0123456789abcdef".repeat(2);
const random = "A1b2C3d4E5f6G7h8".repeat(4);
const accessRunId = `${issuedSeconds}_${hex}`;
const catalogRunId = `${issuedSeconds}_${"fedcba9876543210".repeat(2)}`;
const access = `${accessRunId}_${random}`;
const catalog = `${catalogRunId}_${random}`;
const accessEnv = `${CLOSURE_TEST_ACCESS_ENV_PREFIX}${accessRunId}`;
const catalogEnv = `${CLOSURE_TEST_CATALOG_ENV_PREFIX}${catalogRunId}`;
const expiredRunId = `${issuedSeconds - 1_201}_${hex}`;
const expiredAccess = `${expiredRunId}_${random}`;
const expiredCatalog = `${expiredRunId}_${random}`;
const legacyAccess = "legacy_access_fixture_0123456789abcdef0123456789";
const legacyCatalog = "legacy_catalog_fixture_0123456789abcdef0123456789";
const values: Record<string, string | undefined> = {
  SUPABASE_URL: "https://fixture.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "offline-service-role",
  CATALOG_API_BASE_URL: "https://fixture.catalog.invalid/api",
  CHAT_V3_ADMISSION_MODE: "off",
  [PREVIEW_SECRET_ENV]: legacyAccess,
  [PREVIEW_QA_SECRET_ENV]: undefined,
  [CATALOG_QA_SECRET_ENV]: legacyCatalog,
  [accessEnv]: access,
  [catalogEnv]: catalog,
  [`${CLOSURE_TEST_ACCESS_ENV_PREFIX}${expiredRunId}`]: expiredAccess,
  [`${CLOSURE_TEST_CATALOG_ENV_PREFIX}${expiredRunId}`]: expiredCatalog,
};

const originalEnvGet = Deno.env.get;
const originalServe = Deno.serve;
let handler: ((request: Request) => Promise<Response>) | null = null;
const envReads: string[] = [];
Deno.env.get = (name: string) => {
  envReads.push(name);
  return values[name];
};
(Deno as unknown as { serve: typeof Deno.serve }).serve = ((
  callback: (request: Request) => Promise<Response>,
) => {
  handler = callback;
  return { shutdown() {}, finished: Promise.resolve() };
}) as unknown as typeof Deno.serve;
await import("../chat-consultant-v3-closure-preview/index.ts");
addEventListener("unload", () => {
  Deno.env.get = originalEnvGet;
  (Deno as unknown as { serve: typeof Deno.serve }).serve = originalServe;
});

async function invoke(
  rawBody: string,
  accessSecret?: string,
  catalogSecret?: string,
): Promise<Response> {
  if (!handler) throw new Error("closure handler not registered");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (accessSecret !== undefined) headers[PREVIEW_SECRET_HEADER] = accessSecret;
  if (catalogSecret !== undefined) headers[CATALOG_QA_SECRET_HEADER] = catalogSecret;
  return await handler(new Request(
    "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3-closure-preview",
    { method: "POST", headers, body: rawBody },
  ));
}

Deno.test("closure access is additive and rejects absent, wrong, or weak credentials before body/network", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("network must not be reached");
  }) as typeof fetch;
  try {
    for (const supplied of [undefined, "wrong_fixture_0123456789abcdef0123456789", "short"]) {
      const response = await invoke("not JSON", supplied);
      assertEquals(response.status, 403);
      assertEquals(await response.json(), { error: "preview_access_denied" });
    }
    for (const supplied of [access, legacyAccess]) {
      const response = await invoke("not JSON", supplied);
      assertEquals(response.status, 400);
      assertEquals(await response.json(), { error: "invalid_json" });
    }
    const readsBeforeExpired = envReads.length;
    const expired = await invoke("not JSON", expiredAccess);
    assertEquals(expired.status, 403);
    assertEquals(envReads.slice(readsBeforeExpired).includes(`${CLOSURE_TEST_ACCESS_ENV_PREFIX}${expiredRunId}`), false);
    values[accessEnv] = undefined;
    const disabled = await invoke("not JSON", access);
    assertEquals(disabled.status, 403);
    values[accessEnv] = "short";
    const weak = await invoke("not JSON", access);
    assertEquals(weak.status, 403);
    assertEquals(fetchCalls, 0);
  } finally {
    values[accessEnv] = access;
    globalThis.fetch = originalFetch;
  }
});

Deno.test("closure catalog credential opens only the private preflight/probe routes", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async (input, init) => {
    fetchCalls++;
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === "/rest/v1/app_settings") {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error("catalog/model must not be reached");
  }) as typeof fetch;
  try {
    const preflight = JSON.stringify({ type: "catalog_health_preflight" });
    const probe = JSON.stringify({
      type: "catalog_route_probe", query: "Gallant", endpoint: "https://evil.invalid",
    });
    for (const body of [preflight, probe]) {
      for (const supplied of [undefined, "short", access]) {
        const denied = await invoke(body, access, supplied);
        assertEquals(denied.status, 404);
        assertEquals(await denied.json(), { error: "Not found" });
      }
    }
    assertEquals(fetchCalls, 0);
    const malformedProbe = await invoke(probe, access, catalog);
    assertEquals(malformedProbe.status, 400);
    assertEquals(await malformedProbe.json(), { error: "invalid_probe" });
    assertEquals(fetchCalls, 0);
    const authorizedPreflight = await invoke(preflight, access, catalog);
    assertEquals(authorizedPreflight.status, 503);
    assertEquals((await authorizedPreflight.json()).status, "unavailable");
    assertEquals(fetchCalls > 0, true);
    const readsBeforeExpired = envReads.length;
    const expired = await invoke(probe, access, expiredCatalog);
    assertEquals(expired.status, 404);
    assertEquals(envReads.slice(readsBeforeExpired).includes(`${CLOSURE_TEST_CATALOG_ENV_PREFIX}${expiredRunId}`), false);
    values[catalogEnv] = undefined;
    const disabled = await invoke(probe, access, catalog);
    assertEquals(disabled.status, 404);
    values[catalogEnv] = "short";
    const weak = await invoke(probe, access, catalog);
    assertEquals(weak.status, 404);
    const legacy = await invoke(probe, legacyAccess, legacyCatalog);
    assertEquals(legacy.status, 400);
  } finally {
    values[catalogEnv] = catalog;
    globalThis.fetch = originalFetch;
  }
});
