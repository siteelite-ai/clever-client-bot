// Static ESM import order matters: this fixture executes before index.ts.
// A separate import map may redirect index.ts to a clean archived revision.
// No real listener, credentials, catalog or provider is used.
const values: Record<string, string> = {
  SUPABASE_URL: "https://fixture.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "offline-service-role",
  CATALOG_API_BASE_URL: "https://fixture.catalog.invalid/api",
  OPENROUTER_API_KEY: "offline-openrouter",
  VOLT220_API_TOKEN: "offline-catalog",
  CHAT_V3_ADMISSION_MODE: "off",
};
const originalGet = Deno.env.get;
const originalServe = Deno.serve;
let handler: ((request: Request) => Promise<Response>) | null = null;
Deno.env.get = (name: string) => values[name];
(Deno as unknown as { serve: typeof Deno.serve }).serve = ((
  callback: (
    request: Request,
  ) => Promise<Response>,
) => {
  handler = callback;
  return { shutdown() {}, finished: Promise.resolve() };
}) as unknown as typeof Deno.serve;

export function offlineHandler(): (request: Request) => Promise<Response> {
  if (!handler) throw new Error("HTTP handler did not register");
  return handler;
}

export function restoreFixture(): void {
  Deno.env.get = originalGet;
  (Deno as unknown as { serve: typeof Deno.serve }).serve = originalServe;
}
