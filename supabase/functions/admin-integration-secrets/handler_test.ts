import {
  handleAdminIntegrationSecrets,
  type SecretKey,
  type SecretStoreDependencies,
} from "./handler.ts";

const endpoint = "https://example.supabase.co/functions/v1/admin-integration-secrets";
const origin = "https://clever-client-bot.lovable.app";
const allowedOrigins = new Set([origin]);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function fixture(configuredModels: string[] = []) {
  const data = new Map<SecretKey, string>([
    ["openrouter_api_key", "private-openrouter-token"],
    ["volt220_api_token", "private-catalog-token"],
  ]);
  const calls = { verified: 0, role: 0, reads: 0, modelChecks: 0, claims: 0, pings: 0 };
  const deps: SecretStoreDependencies = {
    async verifyUser(token) {
      calls.verified++;
      return token === "valid-user-token" ? "user-1" : null;
    },
    async isAdmin(userId) {
      calls.role++;
      return userId === "user-1";
    },
    async listConfigured() {
      return [...data.keys()];
    },
    async replaceSecret(key, value) {
      data.set(key, value);
    },
    async clearSecret(key) {
      data.delete(key);
    },
    async readSecret(key) {
      calls.reads++;
      return data.get(key) ?? null;
    },
    async isConfiguredModel(model) {
      calls.modelChecks++;
      return configuredModels.includes(model);
    },
    async claimPing(userId) {
      assert(userId === "user-1", "cooldown must be per verified user");
      calls.claims++;
      return calls.claims === 1;
    },
    async pingOpenRouter(secret, model) {
      calls.pings++;
      assert(secret === "private-openrouter-token", "server-side secret read failed");
      assert(model === "google/gemini-2.5-flash", "model id changed");
      return "ok";
    },
  };
  return { data, deps, calls };
}

function request(method: string, body?: unknown, token = "valid-user-token") {
  return new Request(endpoint, {
    method,
    headers: {
      Origin: origin,
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

Deno.test("admin secrets: GET exposes configured flags but no plaintext", async () => {
  const { deps } = fixture();
  const response = await handleAdminIntegrationSecrets(request("GET"), deps, allowedOrigins);
  assert(response.status === 200, "admin GET status");
  const body = await response.text();
  assert(body.includes('"openrouter_api_key":true'), "OpenRouter flag missing");
  assert(body.includes('"google_api_key":false'), "Google flag missing");
  assert(!body.includes("private-openrouter-token"), "plaintext escaped to GET");
  assert(response.headers.get("Cache-Control") === "no-store", "missing no-store");
  assert(response.headers.get("Access-Control-Allow-Origin") === origin, "wrong CORS");
});

Deno.test("admin secrets: missing/invalid JWT and non-admin denied", async () => {
  const { deps, calls } = fixture();
  const noToken = await handleAdminIntegrationSecrets(
    new Request(endpoint, { method: "GET", headers: { Origin: origin } }),
    deps,
    allowedOrigins,
  );
  assert(noToken.status === 401, "missing bearer accepted");
  assert(calls.verified === 0, "missing bearer reached verifier");
  const invalid = await handleAdminIntegrationSecrets(request("GET", undefined, "invalid"), deps, allowedOrigins);
  assert(invalid.status === 401, "invalid JWT accepted");
  const nonAdmin: SecretStoreDependencies = { ...deps, isAdmin: async () => false };
  const forbidden = await handleAdminIntegrationSecrets(request("GET"), nonAdmin, allowedOrigins);
  assert(forbidden.status === 403, "non-admin accepted");
});

Deno.test("admin secrets: exact-origin preflight and denial", async () => {
  const { deps, calls } = fixture();
  const good = await handleAdminIntegrationSecrets(
    new Request(endpoint, { method: "OPTIONS", headers: { Origin: origin } }),
    deps,
    allowedOrigins,
  );
  assert(good.status === 204, "valid preflight failed");
  assert(calls.verified === 0, "preflight reached auth");
  const evil = await handleAdminIntegrationSecrets(
    new Request(endpoint, {
      method: "OPTIONS",
      headers: { Origin: "https://clever-client-bot.lovable.app.evil.invalid" },
    }),
    deps,
    allowedOrigins,
  );
  assert(evil.status === 403, "lookalike origin accepted");
  assert(evil.headers.get("Access-Control-Allow-Origin") === null, "unknown origin reflected");
});

Deno.test("admin secrets: PUT and DELETE only touch requested allowlisted key", async () => {
  const { deps, data } = fixture();
  const replaced = await handleAdminIntegrationSecrets(
    request("PUT", { key: "openrouter_api_key", value: "new-private-openrouter-token" }),
    deps,
    allowedOrigins,
  );
  assert(replaced.status === 200, "PUT failed");
  assert(data.get("openrouter_api_key") === "new-private-openrouter-token", "PUT wrong value");
  assert(data.get("volt220_api_token") === "private-catalog-token", "PUT touched other key");
  assert(!(await replaced.text()).includes("new-private-openrouter-token"), "PUT reflected secret");
  const deleted = await handleAdminIntegrationSecrets(
    request("DELETE", { key: "openrouter_api_key" }),
    deps,
    allowedOrigins,
  );
  assert(deleted.status === 200, "DELETE failed");
  assert(!data.has("openrouter_api_key"), "DELETE did not clear key");
  assert(data.has("volt220_api_token"), "DELETE touched other key");
  const invalid = await handleAdminIntegrationSecrets(
    request("PUT", { key: "other_secret", value: "some-private-value" }),
    deps,
    allowedOrigins,
  );
  assert(invalid.status === 400, "unlisted secret accepted");
});

Deno.test("admin secrets: ping reads OpenRouter key only on server and sanitizes status", async () => {
  const { deps, calls } = fixture();
  const response = await handleAdminIntegrationSecrets(
    request("POST", { action: "ping", model: "google/gemini-2.5-flash" }),
    deps,
    allowedOrigins,
  );
  assert(response.status === 200, "ping HTTP status");
  const body = await response.text();
  assert(body === '{"ok":true,"status":"ok"}', "unexpected ping body");
  assert(calls.reads === 1 && calls.pings === 1, "ping did not use private server key");
  assert(!body.includes("private-openrouter-token"), "ping exposed secret");
  const repeated = await handleAdminIntegrationSecrets(
    request("POST", { action: "ping", model: "google/gemini-2.5-flash" }),
    deps,
    allowedOrigins,
  );
  assert(repeated.status === 429 && calls.pings === 1, "cooldown allowed paid repeat");
  const invalidModel = await handleAdminIntegrationSecrets(
    request("POST", { action: "ping", model: "https://evil.invalid/" }),
    deps,
    allowedOrigins,
  );
  assert(invalidModel.status === 400 && calls.pings === 1, "invalid model reached provider");
  const unlistedModel = await handleAdminIntegrationSecrets(
    request("POST", { action: "ping", model: "other/expensive-model" }),
    deps,
    allowedOrigins,
  );
  assert(unlistedModel.status === 400 && calls.pings === 1, "unlisted model reached provider");
});

Deno.test("admin secrets: only saved custom model may use bounded server ping", async () => {
  const savedCustom = "other/verified-custom";
  const { deps, calls } = fixture([savedCustom]);
  const customDeps: SecretStoreDependencies = {
    ...deps,
    async pingOpenRouter(secret, model) {
      calls.pings++;
      assert(secret === "private-openrouter-token", "custom ping did not use server secret");
      assert(model === savedCustom, "wrong custom model was sent");
      return "ok";
    },
  };
  const arbitrary = await handleAdminIntegrationSecrets(
    request("POST", { action: "ping", model: "other/expensive-unsaved" }),
    customDeps,
    allowedOrigins,
  );
  assert(arbitrary.status === 400 && calls.pings === 0, "unsaved model reached provider");
  const allowed = await handleAdminIntegrationSecrets(
    request("POST", { action: "ping", model: savedCustom }),
    customDeps,
    allowedOrigins,
  );
  assert(allowed.status === 200 && Number(calls.pings) === 1, "saved custom model was blocked");
  assert(calls.modelChecks === 2 && calls.claims === 1, "model/cost guards were bypassed");
  assert(!(await allowed.text()).includes("private-openrouter-token"), "custom ping leaked secret");
});

Deno.test("admin secrets: malformed and oversized bodies never reach storage", async () => {
  const { deps, data } = fixture();
  const malformed = await handleAdminIntegrationSecrets(
    new Request(endpoint, {
      method: "PUT",
      headers: {
        Origin: origin,
        Authorization: "Bearer valid-user-token",
        "Content-Type": "application/json",
      },
      body: '{"key":"openrouter_api_key","value":"sensitive-unclosed',
    }),
    deps,
    allowedOrigins,
  );
  assert(malformed.status === 400, "malformed JSON accepted");
  assert(!(await malformed.text()).includes("sensitive-unclosed"), "parser leaked input");
  const oversized = await handleAdminIntegrationSecrets(
    request("PUT", { key: "openrouter_api_key", value: "x".repeat(20_000) }),
    deps,
    allowedOrigins,
  );
  assert(oversized.status === 400, "oversized body accepted");
  assert(data.get("openrouter_api_key") === "private-openrouter-token", "invalid input mutated store");
});

Deno.test("admin secrets: storage errors never return exception text", async () => {
  const { deps } = fixture();
  const fail: SecretStoreDependencies = {
    ...deps,
    replaceSecret: async () => {
      throw new Error("private-secret-must-not-leak");
    },
  };
  const response = await handleAdminIntegrationSecrets(
    request("PUT", { key: "openrouter_api_key", value: "private-secret-must-not-leak" }),
    fail,
    allowedOrigins,
  );
  assert(response.status === 503, "storage failure status");
  assert(!(await response.text()).includes("private-secret-must-not-leak"), "exception leaked credential");
});
