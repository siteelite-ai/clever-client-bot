// Import before the real handler in the offline integration test. These
// isolate-local markers mirror the preview bootstrap, never request input.
(globalThis as typeof globalThis & {
  __VOLT220_FUNCTION_VARIANT__?: "preview";
  __VOLT220_ADMISSION_SCOPE__?: "preview";
}).__VOLT220_FUNCTION_VARIANT__ = "preview";
(globalThis as typeof globalThis & {
  __VOLT220_ADMISSION_SCOPE__?: "preview";
}).__VOLT220_ADMISSION_SCOPE__ = "preview";

const values: Record<string, string> = {
  SUPABASE_URL: "https://fixture.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "offline-service-role",
  CATALOG_API_BASE_URL: "https://fixture.catalog.invalid/api",
  VOLT220_V3_PREVIEW_SECRET: "offline-preview-secret-000000000000000001",
  LOVABLE_AGENT_FAILOVER_PREVIEW_ENABLED: "true",
  LOVABLE_API_KEY: "offline-lovable",
  LOVABLE_AGENT_MODEL: "offline-lovable-model",
  OPENROUTER_API_KEY: "offline-openrouter",
  VOLT220_API_TOKEN: "offline-catalog",
  CHAT_V3_ADMISSION_MODE: "off",
};

const originalGet = Deno.env.get;
const originalServe = Deno.serve;
let handler: ((request: Request) => Promise<Response>) | null = null;

Deno.env.get = (name: string) => values[name];
(Deno as unknown as { serve: typeof Deno.serve }).serve = ((
  callback: (request: Request) => Promise<Response>,
) => {
  handler = callback;
  return { shutdown() {}, finished: Promise.resolve() };
}) as unknown as typeof Deno.serve;

export function offlineProviderFailoverHandler(): (
  request: Request,
) => Promise<Response> {
  if (!handler) throw new Error("The production handler did not register");
  return handler;
}

export function restoreOfflineProviderFailoverFixture(): void {
  Deno.env.get = originalGet;
  (Deno as unknown as { serve: typeof Deno.serve }).serve = originalServe;
  delete (globalThis as typeof globalThis & {
    __VOLT220_FUNCTION_VARIANT__?: "preview";
    __VOLT220_ADMISSION_SCOPE__?: "preview";
  }).__VOLT220_FUNCTION_VARIANT__;
  delete (globalThis as typeof globalThis & {
    __VOLT220_ADMISSION_SCOPE__?: "preview";
  }).__VOLT220_ADMISSION_SCOPE__;
}
