/**
 * Server-only credential cutover. The default preserves the existing settings
 * path exactly; each Edge bundle has its own project-secret switch because
 * Supabase environment variables are shared by all functions in a project.
 * Never select the mode from an HTTP request, browser setting, or DB row.
 */
export type IntegrationSecretKey =
  | "openrouter_api_key"
  | "volt220_api_token"
  | "google_api_key";

export type IntegrationSecretMode = "legacy" | "shadow" | "private-required";

export type IntegrationSecretBundle =
  | "chat-consultant"
  | "chat-consultant-v2"
  | "chat-consultant-v3-production"
  | "chat-consultant-v3-preview"
  | "chat-consultant-v3-closure-preview"
  | "search-products"
  | "knowledge-process";

export function integrationSecretBundleForV3(
  deploymentVariant: "production" | "preview",
  closurePreview: boolean,
): IntegrationSecretBundle {
  return closurePreview
    ? "chat-consultant-v3-closure-preview"
    : deploymentVariant === "preview"
    ? "chat-consultant-v3-preview"
    : "chat-consultant-v3-production";
}

const MODE_ENV: Record<IntegrationSecretBundle, string> = {
  "chat-consultant": "INTEGRATION_SECRETS_MODE_CHAT_CONSULTANT",
  "chat-consultant-v2": "INTEGRATION_SECRETS_MODE_CHAT_CONSULTANT_V2",
  "chat-consultant-v3-production":
    "INTEGRATION_SECRETS_MODE_CHAT_CONSULTANT_V3_PRODUCTION",
  "chat-consultant-v3-preview":
    "INTEGRATION_SECRETS_MODE_CHAT_CONSULTANT_V3_PREVIEW",
  "chat-consultant-v3-closure-preview":
    "INTEGRATION_SECRETS_MODE_CHAT_CONSULTANT_V3_CLOSURE_PREVIEW",
  "search-products": "INTEGRATION_SECRETS_MODE_SEARCH_PRODUCTS",
  "knowledge-process": "INTEGRATION_SECRETS_MODE_KNOWLEDGE_PROCESS",
};

export class IntegrationSecretConfigurationError extends Error {
  constructor() {
    super("integration_secret_unavailable");
    this.name = "IntegrationSecretConfigurationError";
  }
}

export function integrationSecretModeForBundle(
  bundle: IntegrationSecretBundle,
  readEnv: (name: string) => string | undefined = (name) => Deno.env.get(name),
): IntegrationSecretMode {
  const configured = readEnv(MODE_ENV[bundle]);
  if (configured === undefined || configured === "") return "legacy";
  if (configured === "shadow" || configured === "private-required" ||
    configured === "legacy") return configured;
  // A typo must not silently select the less restrictive legacy path.
  throw new IntegrationSecretConfigurationError();
}

export interface SecretComparisonEvent {
  key: IntegrationSecretKey;
  privateReadOk: boolean;
  privatePresent: boolean;
  legacyPresent: boolean;
  fingerprintMatch: boolean | null;
}

// deno-lint-ignore no-explicit-any
export type IntegrationSecretReader = { from: (table: string) => any };

async function readPrivateSecret(
  client: IntegrationSecretReader,
  key: IntegrationSecretKey,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const query = client.from("integration_secrets")
      .select("secret_value")
      .eq("key", key);
    const bounded = signal && typeof query.abortSignal === "function"
      ? query.abortSignal(signal)
      : query;
    const { data, error } = await bounded.maybeSingle();
    if (error) throw new IntegrationSecretConfigurationError();
    const value = data?.secret_value;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    // PostgREST errors may include SQL and response details; never leak them.
    throw new IntegrationSecretConfigurationError();
  }
}

async function sameFingerprint(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const x = new Uint8Array(left);
  const y = new Uint8Array(right);
  let different = 0;
  for (let i = 0; i < x.length; i++) different |= x[i] ^ y[i];
  return different === 0;
}

/**
 * Legacy: never touch the private table and return the existing source.
 * Shadow: return the existing source, only compare hashes/presence in memory.
 * Private-required: never invoke the legacy reader, fail closed if absent.
 */
export async function resolveIntegrationSecret(
  client: IntegrationSecretReader | null,
  key: IntegrationSecretKey,
  mode: IntegrationSecretMode,
  readLegacy: () => string | null | Promise<string | null>,
  onShadowComparison?: (event: SecretComparisonEvent) => void,
  signal?: AbortSignal,
  allowMissingPrivate = false,
): Promise<string | null> {
  if (mode === "legacy") return await readLegacy();
  if (mode === "private-required") {
    if (!client) throw new IntegrationSecretConfigurationError();
    const value = await readPrivateSecret(client, key, signal);
    if (!value && !allowMissingPrivate) throw new IntegrationSecretConfigurationError();
    return value;
  }

  const legacy = await readLegacy();
  let privateValue: string | null = null;
  let privateReadOk = true;
  try {
    if (!client) throw new IntegrationSecretConfigurationError();
    privateValue = await readPrivateSecret(client, key, signal);
  } catch {
    privateReadOk = false;
  }
  try {
    onShadowComparison?.({
      key,
      privateReadOk,
      privatePresent: privateValue !== null,
      legacyPresent: legacy !== null && legacy !== "",
      fingerprintMatch: privateValue && legacy
        ? await sameFingerprint(privateValue, legacy)
        : null,
    });
  } catch {
    // Observability must never affect live answers.
  }
  return legacy;
}
