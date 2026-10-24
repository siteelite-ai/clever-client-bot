import {
  IntegrationSecretConfigurationError,
  integrationSecretBundleForV3,
  integrationSecretModeForBundle,
  resolveIntegrationSecret,
  type IntegrationSecretReader,
  type SecretComparisonEvent,
} from "./integration-secrets.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function reader(value: string | null, fail = false): {
  client: IntegrationSecretReader;
  calls: () => number;
} {
  let count = 0;
  return {
    calls: () => count,
    client: {
      from(table: string) {
        count++;
        assert(table === "integration_secrets", "private table only");
        return {
          select(column: string) {
            assert(column === "secret_value", "secret column only");
            return {
              eq(field: string, key: string) {
                assert(field === "key", "exact key selection");
                assert(key === "openrouter_api_key", "requested key only");
                return {
                  maybeSingle: async () => ({
                    data: value === null ? null : { secret_value: value },
                    error: fail ? { message: "sensitive SQL error" } : null,
                  }),
                };
              },
            };
          },
        };
      },
    },
  };
}

Deno.test("secret mode defaults to legacy per bundle and rejects invalid configuration", () => {
  assert(integrationSecretBundleForV3("production", false) === "chat-consultant-v3-production", "production bundle");
  assert(integrationSecretBundleForV3("preview", false) === "chat-consultant-v3-preview", "preview bundle");
  assert(integrationSecretBundleForV3("production", true) === "chat-consultant-v3-closure-preview", "closure bundle");
  assert(integrationSecretModeForBundle("chat-consultant-v3-production", () => undefined) === "legacy", "default legacy");
  assert(integrationSecretModeForBundle("chat-consultant-v3-production", (name) =>
    name === "INTEGRATION_SECRETS_MODE_CHAT_CONSULTANT_V3_PRODUCTION"
      ? "private-required"
      : undefined) === "private-required", "production switch");
  assert(integrationSecretModeForBundle("chat-consultant-v3-preview", (name) =>
    name === "INTEGRATION_SECRETS_MODE_CHAT_CONSULTANT_V3_PREVIEW"
      ? "shadow"
      : undefined) === "shadow", "preview switch independent");
  let rejected = false;
  try {
    integrationSecretModeForBundle("search-products", () => "privat-required");
  } catch (e) {
    rejected = e instanceof IntegrationSecretConfigurationError;
  }
  assert(rejected, "unknown mode fails closed");
});

Deno.test("legacy never reads the private table", async () => {
  const privateDb = reader("private-key");
  const value = await resolveIntegrationSecret(
    privateDb.client,
    "openrouter_api_key",
    "legacy",
    () => "legacy-key",
  );
  assert(value === "legacy-key", "legacy value unchanged");
  assert(privateDb.calls() === 0, "no private read");
});

Deno.test("shadow compares in memory and returns legacy even if private read fails", async () => {
  const privateDb = reader("other-key");
  const events: SecretComparisonEvent[] = [];
  const value = await resolveIntegrationSecret(
    privateDb.client,
    "openrouter_api_key",
    "shadow",
    () => "legacy-key",
    (event) => events.push(event),
  );
  assert(value === "legacy-key", "shadow leaves behavior unchanged");
  assert(events.length === 1 && events[0].fingerprintMatch === false, "hash mismatch observed");
  assert(!JSON.stringify(events).includes("legacy-key"), "comparison emits no value");
  const failing = reader(null, true);
  const fallback = await resolveIntegrationSecret(
    failing.client,
    "openrouter_api_key",
    "shadow",
    () => "legacy-key",
    (event) => events.push(event),
  );
  assert(fallback === "legacy-key", "shadow read failure does not break service");
  assert(events[1].privateReadOk === false, "failure shown without raw error");
  const matching = reader("legacy-key");
  await resolveIntegrationSecret(
    matching.client,
    "openrouter_api_key",
    "shadow",
    () => "legacy-key",
    (event) => events.push(event),
  );
  assert(events[2].fingerprintMatch === true, "matching hash observed");
  const survivesLoggerFailure = await resolveIntegrationSecret(
    matching.client,
    "openrouter_api_key",
    "shadow",
    () => "legacy-key",
    () => { throw new Error("telemetry offline"); },
  );
  assert(survivesLoggerFailure === "legacy-key", "shadow logger cannot break live result");
});

Deno.test("private-required never invokes legacy and fails with a sanitized error", async () => {
  let legacyReads = 0;
  const privateDb = reader("private-key");
  const value = await resolveIntegrationSecret(
    privateDb.client,
    "openrouter_api_key",
    "private-required",
    () => { legacyReads++; return "legacy-key"; },
  );
  assert(value === "private-key" && legacyReads === 0, "private-only read");
  for (const missing of [reader(null), reader(null, true)]) {
    let message = "";
    try {
      await resolveIntegrationSecret(
        missing.client,
        "openrouter_api_key",
        "private-required",
        () => { legacyReads++; return "legacy-key"; },
      );
    } catch (error) {
      message = (error as Error).message;
    }
    assert(message === "integration_secret_unavailable", "sanitized failure");
    assert(legacyReads === 0, "no legacy fallback on failure");
  }
  const optional = await resolveIntegrationSecret(
    reader(null).client,
    "openrouter_api_key",
    "private-required",
    () => { legacyReads++; return "legacy-key"; },
    undefined,
    undefined,
    true,
  );
  assert(optional === null && legacyReads === 0, "optional private key never falls back");
});
