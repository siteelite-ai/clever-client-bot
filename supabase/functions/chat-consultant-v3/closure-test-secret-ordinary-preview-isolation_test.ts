// The ordinary preview entrypoint must not read or accept closure-run secrets,
// even when their environment values are present project-wide.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CLOSURE_TEST_ACCESS_ENV_PREFIX,
  CLOSURE_TEST_CATALOG_ENV_PREFIX,
  PREVIEW_SECRET_ENV,
  PREVIEW_SECRET_HEADER,
} from "../_shared/v3-tools/preview-secret-gate.ts";
import {
  CATALOG_QA_SECRET_ENV,
  CATALOG_QA_SECRET_HEADER,
} from "../_shared/v3-tools/catalog-health-preflight.ts";

const runId = `${Math.floor(Date.now() / 1000)}_${"0123456789abcdef".repeat(2)}`;
const suffix = "A1b2C3d4E5f6G7h8".repeat(4);
const temporary = `${runId}_${suffix}`;
const legacyAccess = "legacy_access_fixture_0123456789abcdef0123456789";
const legacyCatalog = "legacy_catalog_fixture_0123456789abcdef0123456789";
const values: Record<string, string | undefined> = {
  SUPABASE_URL: "https://fixture.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "offline-service-role",
  CATALOG_API_BASE_URL: "https://fixture.catalog.invalid/api",
  CHAT_V3_ADMISSION_MODE: "off",
  [PREVIEW_SECRET_ENV]: legacyAccess,
  [CATALOG_QA_SECRET_ENV]: legacyCatalog,
  [`${CLOSURE_TEST_ACCESS_ENV_PREFIX}${runId}`]: temporary,
  [`${CLOSURE_TEST_CATALOG_ENV_PREFIX}${runId}`]: temporary,
};

const originalEnvGet = Deno.env.get;
const originalServe = Deno.serve;
const envReads: string[] = [];
let handler: ((request: Request) => Promise<Response>) | null = null;
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
await import("../chat-consultant-v3-preview/index.ts");
addEventListener("unload", () => {
  Deno.env.get = originalEnvGet;
  (Deno as unknown as { serve: typeof Deno.serve }).serve = originalServe;
});

async function invoke(body: string, access: string, catalog?: string): Promise<Response> {
  if (!handler) throw new Error("ordinary preview handler not registered");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [PREVIEW_SECRET_HEADER]: access,
  };
  if (catalog) headers[CATALOG_QA_SECRET_HEADER] = catalog;
  return await handler(new Request(
    "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3-preview",
    { method: "POST", headers, body },
  ));
}

Deno.test("ordinary preview rejects fresh closure secrets without env lookup and retains legacy QA", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network must not be reached");
  }) as typeof fetch;
  try {
    const denied = await invoke("not JSON", temporary);
    assertEquals(denied.status, 403);
    assertEquals((await denied.json()).error, "preview_access_denied");
    assertEquals(envReads.includes(`${CLOSURE_TEST_ACCESS_ENV_PREFIX}${runId}`), false);

    const legacy = await invoke("not JSON", legacyAccess);
    assertEquals(legacy.status, 400);
    assertEquals((await legacy.json()).error, "invalid_json");

    const malformedProbe = JSON.stringify({
      type: "catalog_route_probe", query: "Gallant", endpoint: "https://evil.invalid",
    });
    const catalogDenied = await invoke(malformedProbe, legacyAccess, temporary);
    assertEquals(catalogDenied.status, 404);
    assertEquals(envReads.includes(`${CLOSURE_TEST_CATALOG_ENV_PREFIX}${runId}`), false);
    const legacyCatalogResponse = await invoke(malformedProbe, legacyAccess, legacyCatalog);
    assertEquals(legacyCatalogResponse.status, 400);
    assertEquals((await legacyCatalogResponse.json()).error, "invalid_probe");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
