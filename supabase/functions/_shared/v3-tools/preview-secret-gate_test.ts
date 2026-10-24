import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  closureTestScopeEnabled,
  CLOSURE_TEST_ACCESS_ENV_PREFIX,
  CLOSURE_TEST_CATALOG_ENV_PREFIX,
  PREVIEW_QA_SECRET_ENV,
  PREVIEW_SECRET_ENV,
  PREVIEW_SECRET_HEADER,
  previewSecretAuthorized,
  readClosureTestSecret,
} from "./preview-secret-gate.ts";

const secret = `${crypto.randomUUID().replaceAll("-", "")}${
  crypto.randomUUID().replaceAll("-", "")
}`;
const qaSecret = `${crypto.randomUUID().replaceAll("-", "")}${
  crypto.randomUUID().replaceAll("-", "")
}`;

Deno.test("preview gate uses a separate server-only secret header", () => {
  assertEquals(PREVIEW_SECRET_ENV, "VOLT220_V3_PREVIEW_SECRET");
  assertEquals(PREVIEW_QA_SECRET_ENV, "VOLT220_V3_QA_SECRET");
  assertEquals(PREVIEW_SECRET_HEADER, "x-volt-preview-secret");
  assertEquals(CLOSURE_TEST_ACCESS_ENV_PREFIX, "V3_CLOSURE_ACCESS_");
  assertEquals(CLOSURE_TEST_CATALOG_ENV_PREFIX, "V3_CLOSURE_CATALOG_");
});

Deno.test("temporary closure secrets cannot opt production or ordinary preview in", () => {
  assertEquals(closureTestScopeEnabled("preview", "closure_preview"), true);
  for (const [scope, marker] of [
    ["production", "closure_preview"],
    ["preview", undefined],
    ["preview", "derived_reasoning_retry"],
    [undefined, "closure_preview"],
  ]) {
    assertEquals(closureTestScopeEnabled(scope, marker), false);
  }
});

Deno.test("closure credentials resolve only an exact, fresh per-run environment name", async () => {
  const now = 1_800_000_000;
  const hex = "0123456789abcdef".repeat(2);
  const random = "A1b2C3d4E5f6G7h8".repeat(4);
  assertEquals(random.length, 64);
  const runId = `${now}_${hex}`;
  const supplied = `${runId}_${random}`;
  const configured = "different_configured_value_0123456789abcdef012345";
  const reads: string[] = [];
  const readEnv = (name: string) => {
    reads.push(name);
    return configured;
  };
  assertEquals(
    readClosureTestSecret("access", "preview", "closure_preview", supplied, readEnv, now),
    configured,
  );
  assertEquals(reads, [`V3_CLOSURE_ACCESS_${runId}`]);
  assertEquals(
    readClosureTestSecret("catalog", "preview", "closure_preview", supplied, readEnv, now),
    configured,
  );
  assertEquals(reads.at(-1), `V3_CLOSURE_CATALOG_${runId}`);
  assertEquals(await previewSecretAuthorized(supplied, undefined, undefined, configured), false);
  assertEquals(await previewSecretAuthorized(supplied, undefined, undefined, supplied), true);
});

Deno.test("closure lookup fails closed before env reads for other lanes and stale/malformed values", () => {
  const now = 1_800_000_000;
  const hex = "0123456789abcdef".repeat(2);
  const random = "A".repeat(64);
  const valid = `${now}_${hex}_${random}`;
  let reads = 0;
  const readEnv = (_name: string) => {
    reads++;
    return valid;
  };
  for (const [scope, marker] of [
    ["production", "closure_preview"],
    ["preview", undefined],
    ["preview", "derived_reasoning_retry"],
  ]) {
    assertEquals(readClosureTestSecret("access", scope, marker, valid, readEnv, now), undefined);
  }
  for (const bad of [
    null,
    "short",
    `${now}_${hex}_${random.slice(1)}`,
    `${now}_${hex.toUpperCase()}_${random}`,
    `${now - 1_201}_${hex}_${random}`,
    `${now + 121}_${hex}_${random}`,
  ]) {
    assertEquals(readClosureTestSecret("catalog", "preview", "closure_preview", bad, readEnv, now), undefined);
  }
  assertEquals(reads, 0);
  assertEquals(
    readClosureTestSecret("access", "preview", "closure_preview", `${now - 1_200}_${hex}_${random}`, readEnv, now),
    valid,
  );
  assertEquals(
    readClosureTestSecret("access", "preview", "closure_preview", `${now + 120}_${hex}_${random}`, readEnv, now),
    valid,
  );
  assertEquals(reads, 2);
});

Deno.test("preview gate fails closed without a configured secret", async () => {
  for (
    const configured of [
      undefined,
      null,
      "",
      "short",
      "a".repeat(257),
      "bad secret",
    ]
  ) {
    assertEquals(await previewSecretAuthorized(secret, configured), false);
  }
});

Deno.test("preview gate rejects absent, wrong, weak, and malformed request secrets", async () => {
  for (
    const provided of [
      null,
      "",
      "short",
      "a".repeat(257),
      "bad secret",
      "a".repeat(64),
      `${secret.slice(0, -1)}${secret.endsWith("0") ? "1" : "0"}`,
      `${secret}\n`,
    ]
  ) {
    assertEquals(await previewSecretAuthorized(provided, secret), false);
  }
});

Deno.test("preview gate accepts only an exact full-length match", async () => {
  assertEquals(await previewSecretAuthorized(secret, secret), true);
  assertEquals(
    await previewSecretAuthorized(secret.toUpperCase(), secret),
    false,
  );
});

Deno.test("optional QA secret authorizes independently without changing the old secret", async () => {
  assertEquals(await previewSecretAuthorized(secret, secret, qaSecret), true);
  assertEquals(await previewSecretAuthorized(qaSecret, secret, qaSecret), true);
  assertEquals(await previewSecretAuthorized(qaSecret, undefined, qaSecret), true);
  assertEquals(await previewSecretAuthorized(secret, secret, "short"), true);
  assertEquals(await previewSecretAuthorized(qaSecret, secret), false);
  assertEquals(await previewSecretAuthorized(qaSecret, secret, "short"), false);
  assertEquals(await previewSecretAuthorized(secret, undefined, undefined), false);
});

Deno.test("both configured secrets remain exact-match and fail closed when invalid", async () => {
  const wrong = "x".repeat(64);
  assertEquals(await previewSecretAuthorized(wrong, secret, qaSecret), false);
  assertEquals(await previewSecretAuthorized(qaSecret.toUpperCase(), secret, qaSecret), false);
  assertEquals(await previewSecretAuthorized(qaSecret, "short", "invalid qa"), false);
  assertEquals(await previewSecretAuthorized(null, secret, qaSecret), false);
  assertEquals(await previewSecretAuthorized(qaSecret, undefined, "short"), false);
});

Deno.test("closure credential is additive and fails closed when absent or weak", async () => {
  const closureSecret = `${crypto.randomUUID().replaceAll("-", "")}${
    crypto.randomUUID().replaceAll("-", "")
  }`;
  const wrong = `${crypto.randomUUID().replaceAll("-", "")}${
    crypto.randomUUID().replaceAll("-", "")
  }`;
  assertEquals(await previewSecretAuthorized(closureSecret, secret, qaSecret), false);
  assertEquals(await previewSecretAuthorized(closureSecret, secret, qaSecret, closureSecret), true);
  assertEquals(await previewSecretAuthorized(secret, secret, qaSecret, closureSecret), true);
  assertEquals(await previewSecretAuthorized(qaSecret, secret, qaSecret, closureSecret), true);
  assertEquals(await previewSecretAuthorized(wrong, secret, qaSecret, closureSecret), false);
  for (const weak of [undefined, null, "", "short", "bad secret", "a".repeat(257)]) {
    assertEquals(await previewSecretAuthorized(closureSecret, undefined, undefined, weak), false);
  }
  assertEquals(await previewSecretAuthorized(null, undefined, undefined, closureSecret), false);
});
