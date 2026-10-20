import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  PREVIEW_QA_SECRET_ENV,
  PREVIEW_SECRET_ENV,
  PREVIEW_SECRET_HEADER,
  previewSecretAuthorized,
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
