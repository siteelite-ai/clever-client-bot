/** Admin-only API contract. No response contains a credential or its prefix. */
export const SECRET_KEYS = [
  "openrouter_api_key",
  "volt220_api_token",
  "google_api_key",
] as const;

export type SecretKey = (typeof SECRET_KEYS)[number];
export type PingStatus = "ok" | "provider_error" | "timeout";

export interface SecretStoreDependencies {
  verifyUser(token: string): Promise<string | null>;
  isAdmin(userId: string): Promise<boolean>;
  listConfigured(): Promise<SecretKey[]>;
  replaceSecret(key: SecretKey, value: string): Promise<void>;
  clearSecret(key: SecretKey): Promise<void>;
  readSecret(key: SecretKey): Promise<string | null>;
  isConfiguredModel(model: string): Promise<boolean>;
  claimPing(userId: string): Promise<boolean>;
  pingOpenRouter(secret: string, model: string): Promise<PingStatus>;
}

export const DEFAULT_ADMIN_ORIGINS = [
  "https://clever-client-bot.lovable.app",
  "https://chat-volt.testdevops.ru",
] as const;

const MAX_BODY_BYTES = 16_384;
const MAX_SECRET_LENGTH = 8_192;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;
// Curated release allowlist. A saved custom model can also be checked, but
// only after an exact server-side match against persisted nonsecret settings.
const PINGABLE_MODELS = new Set([
  "google/gemini-2.5-flash-lite",
  "google/gemini-2.0-flash-lite-001",
  "google/gemini-2.5-flash",
  "google/gemini-2.0-flash-001",
  "google/gemini-3.1-flash-lite-preview",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3-flash-preview",
  "google/gemini-2.5-pro",
]);

function isSecretKey(value: unknown): value is SecretKey {
  return typeof value === "string" &&
    (SECRET_KEYS as readonly string[]).includes(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
    "Access-Control-Allow-Methods": "GET, PUT, DELETE, POST, OPTIONS",
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
  });
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function json(status: number, payload: unknown, headers: Headers): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload), { status, headers: responseHeaders });
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get("content-type") ?? "")) {
    return null;
  }
  const declaredLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return null;
  }
  if (!req.body) return null;

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = req.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Never include parser errors: they can contain part of the secret body.
  }
  return null;
}

function configuredPayload(keys: SecretKey[]) {
  const found = new Set(keys);
  return {
    configured: {
      openrouter_api_key: found.has("openrouter_api_key"),
      volt220_api_token: found.has("volt220_api_token"),
      google_api_key: found.has("google_api_key"),
    },
  };
}

/**
 * CORS is an exact-origin allowlist, not authentication. Authorization is
 * always a server-verified Supabase user plus a server-side user_roles check.
 */
export async function handleAdminIntegrationSecrets(
  req: Request,
  deps: SecretStoreDependencies,
  allowedOrigins: ReadonlySet<string> = new Set(DEFAULT_ADMIN_ORIGINS),
): Promise<Response> {
  const origin = req.headers.get("Origin");
  if (origin !== null && !allowedOrigins.has(origin)) {
    return json(403, { error: "Origin is not allowed" }, corsHeaders(null));
  }
  const headers = corsHeaders(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (!["GET", "PUT", "DELETE", "POST"].includes(req.method)) {
    headers.set("Allow", "GET, PUT, DELETE, POST, OPTIONS");
    return json(405, { error: "Method not allowed" }, headers);
  }

  const authHeader = req.headers.get("Authorization")?.trim() ?? "";
  const match = /^Bearer ([^\s]+)$/i.exec(authHeader);
  if (!match) return json(401, { error: "Не авторизован" }, headers);

  try {
    const userId = await deps.verifyUser(match[1]);
    if (!userId) return json(401, { error: "Не авторизован" }, headers);
    if (!(await deps.isAdmin(userId))) {
      return json(403, { error: "Недостаточно прав" }, headers);
    }

    if (req.method === "GET") {
      return json(200, configuredPayload(await deps.listConfigured()), headers);
    }

    const payload = await readBody(req);
    if (!payload) return json(400, { error: "Некорректный JSON" }, headers);

    if (req.method === "PUT") {
      if (!exactKeys(payload, ["key", "value"]) || !isSecretKey(payload.key) ||
        typeof payload.value !== "string" ||
        payload.value.length < 8 || payload.value.length > MAX_SECRET_LENGTH ||
        payload.value !== payload.value.trim()) {
        return json(400, { error: "Некорректные параметры" }, headers);
      }
      await deps.replaceSecret(payload.key, payload.value);
      return json(200, configuredPayload(await deps.listConfigured()), headers);
    }

    if (req.method === "DELETE") {
      if (!exactKeys(payload, ["key"]) || !isSecretKey(payload.key)) {
        return json(400, { error: "Некорректные параметры" }, headers);
      }
      await deps.clearSecret(payload.key);
      return json(200, configuredPayload(await deps.listConfigured()), headers);
    }

    if (!exactKeys(payload, ["action", "model"]) ||
      payload.action !== "ping" || typeof payload.model !== "string" ||
      !MODEL_ID.test(payload.model)) {
      return json(400, { error: "Некорректные параметры" }, headers);
    }
    if (!PINGABLE_MODELS.has(payload.model) &&
      !(await deps.isConfiguredModel(payload.model))) {
      return json(400, { error: "Модель не настроена" }, headers);
    }
    const secret = await deps.readSecret("openrouter_api_key");
    if (!secret) return json(200, { ok: false, status: "not_configured" }, headers);
    if (!(await deps.claimPing(userId))) {
      return json(429, { ok: false, status: "rate_limited" }, headers);
    }
    const status = await deps.pingOpenRouter(secret, payload.model);
    return json(200, { ok: status === "ok", status }, headers);
  } catch {
    // Database/provider exceptions may contain submitted credentials or
    // request fragments. Never return or log their message.
    return json(503, { error: "Сервис временно недоступен" }, headers);
  }
}
