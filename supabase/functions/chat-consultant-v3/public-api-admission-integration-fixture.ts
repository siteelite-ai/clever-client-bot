// Evaluate before index.ts so the real production handler is captured without
// opening an HTTP socket. Runtime credentials and admission limits are local
// fixture values; tests never reach Supabase, the catalog, or OpenRouter.

const values: Record<string, string> = {
  SUPABASE_URL: "https://fixture.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "offline-service-role",
  CATALOG_API_BASE_URL: "https://fixture.catalog.invalid/api",
  CHAT_V3_ADMISSION_MODE: "off",
  PUBLIC_API_ADMISSION_MODE: "off",
  PUBLIC_SUBJECT_ADMISSION_MODE: "off",
  PUBLIC_SUBJECT_PROOF_KID: "fixture-key",
  PUBLIC_SUBJECT_PROOF_HMAC_KEY: btoa("a".repeat(32)).replace(/=+$/u, ""),
  PUBLIC_SUBJECT_LIMIT_PER_MINUTE: "5",
  PUBLIC_SUBJECT_LIMIT_IN_FLIGHT: "2",
  PUBLIC_API_MODEL_LIMIT_PER_MINUTE: "2",
  PUBLIC_API_MODEL_LIMIT_IN_FLIGHT: "1",
  PUBLIC_API_CATALOG_LIMIT_PER_MINUTE: "3",
  PUBLIC_API_CATALOG_LIMIT_IN_FLIGHT: "2",
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

export function setPublicAdmissionMode(mode: "off" | "enforce"): void {
  values.PUBLIC_API_ADMISSION_MODE = mode;
}

export function setSubjectAdmissionMode(mode: "off" | "observe" | "enforce"): void {
  values.PUBLIC_SUBJECT_ADMISSION_MODE = mode;
}

export function offlineAdmissionHandler(): (request: Request) => Promise<Response> {
  if (!handler) throw new Error("The production handler did not register");
  return handler;
}

export function restoreAdmissionFixture(): void {
  Deno.env.get = originalGet;
  (Deno as unknown as { serve: typeof Deno.serve }).serve = originalServe;
}
