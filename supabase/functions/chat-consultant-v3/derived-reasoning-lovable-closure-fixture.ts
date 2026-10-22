// Offline equivalent of the closed preview bootstrap, evaluated before the
// handler module. The marker cannot be supplied by a browser request.
(globalThis as typeof globalThis & {
  __VOLT220_ADMISSION_SCOPE__?: "preview";
  __VOLT220_DERIVED_REASONING_RETRY_SCOPE__?: "closure_preview";
}).__VOLT220_ADMISSION_SCOPE__ = "preview";
(globalThis as typeof globalThis & {
  __VOLT220_DERIVED_REASONING_RETRY_SCOPE__?: "closure_preview";
}).__VOLT220_DERIVED_REASONING_RETRY_SCOPE__ = "closure_preview";

const values: Record<string, string> = {
  SUPABASE_URL: "https://fixture.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "offline-service-role",
  CATALOG_API_BASE_URL: "https://fixture.catalog.invalid/api",
  VOLT220_V3_PREVIEW_SECRET: "offline-preview-secret-000000000000000001",
  OPENROUTER_API_KEY: "offline-openrouter",
  VOLT220_API_TOKEN: "offline-catalog",
  CHAT_V3_ADMISSION_MODE: "off",
  VOLT220_DERIVED_REASONING_LOVABLE_RETRY_CLOSURE_PREVIEW_ENABLED: "true",
  // Deliberately exercise the dangerous project-wide state: the closure-only
  // retry and any contract correction must still permit only two providers.
  LOVABLE_AGENT_FAILOVER_ENABLED: "true",
  LOVABLE_API_KEY: "offline-lovable",
  LOVABLE_AGENT_MODEL: "offline-lovable-model",
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

export function offlineClosureProviderHandler(): (
  request: Request,
) => Promise<Response> {
  if (!handler) throw new Error("The closure handler did not register");
  return handler;
}

export function restoreOfflineClosureProviderFixture(): void {
  Deno.env.get = originalGet;
  (Deno as unknown as { serve: typeof Deno.serve }).serve = originalServe;
  delete (globalThis as typeof globalThis & {
    __VOLT220_ADMISSION_SCOPE__?: "preview";
    __VOLT220_DERIVED_REASONING_RETRY_SCOPE__?: "closure_preview";
  }).__VOLT220_ADMISSION_SCOPE__;
  delete (globalThis as typeof globalThis & {
    __VOLT220_DERIVED_REASONING_RETRY_SCOPE__?: "closure_preview";
  }).__VOLT220_DERIVED_REASONING_RETRY_SCOPE__;
}
