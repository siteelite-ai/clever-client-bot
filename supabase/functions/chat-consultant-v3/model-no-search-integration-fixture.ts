// Evaluate this setup module before importing index.ts in the offline
// integration test. Static imports are resolved by Deno before test execution
// and need no runtime network permission for the pinned esm.sh dependency.
// The handler cannot bind a socket; server environment values are synthetic.

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

/** Opt in only before a dynamic handler import in an isolated offline test. */
export function enableVerifiedFactsInOfflineFixture(): void {
  values.VOLT220_VERIFIED_FACTS_PRODUCTION_ENABLED = "true";
}

/** Opt in before importing the handler; production's default remains OFF. */
export function enableDirectAnalogProofInOfflineFixture(): void {
  enableVerifiedFactsInOfflineFixture();
  values.VOLT220_DIRECT_ANALOG_PROOF_PRODUCTION_ENABLED = "true";
}

/** Toggle the server-only emergency path without changing production env. */
export function setTaxonomyOutageExactLookupInOfflineFixture(enabled: boolean): void {
  if (enabled) values.VOLT220_TAXONOMY_OUTAGE_EXACT_LOOKUP_ENABLED = "true";
  else delete values.VOLT220_TAXONOMY_OUTAGE_EXACT_LOOKUP_ENABLED;
}

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
  if (!handler) throw new Error("The production handler did not register");
  return handler;
}

export function restoreOfflineModuleSetup(): void {
  Deno.env.get = originalGet;
  (Deno as unknown as { serve: typeof Deno.serve }).serve = originalServe;
}
