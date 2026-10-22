import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createRouteQaHandler,
  ROUTE_QA_MAX_AGE_SECONDS,
  ROUTE_QA_MAX_FUTURE_SECONDS,
  ROUTE_QA_SECRET_ENV,
  ROUTE_QA_SECRET_HEADER,
  routeQaSecretAuthorized,
} from "./route-qa-gate.ts";

const issuedSeconds = Math.floor(Date.now() / 1000);
const runId = `${issuedSeconds}_${"0123456789abcdef".repeat(2)}`;
const secret = `${runId}_${"Ab3_".repeat(16)}`;
const wrong = `${runId}_${"Zx9_".repeat(16)}`;

Deno.test("route QA gate uses a dedicated server-side credential", () => {
  assertEquals(ROUTE_QA_SECRET_ENV, "VOLT220_ROUTE_QA_SECRET");
  assertEquals(ROUTE_QA_SECRET_HEADER, "x-volt220-route-qa-secret");
});

Deno.test("route QA comparison fails closed for absent, weak and incorrect credentials", async () => {
  for (const configured of [undefined, null, "", "short", "bad secret", "a".repeat(257)]) {
    assertEquals(await routeQaSecretAuthorized(secret, configured), false);
  }
  for (const provided of [null, "", "short", "bad secret", wrong, `${secret}x`]) {
    assertEquals(await routeQaSecretAuthorized(provided, secret), false);
  }
  assertEquals(await routeQaSecretAuthorized(secret, secret), true);
  assertEquals(await routeQaSecretAuthorized(secret.toLowerCase(), secret), false);
  assertEquals(await routeQaSecretAuthorized("q".repeat(64), "q".repeat(64)), false);
});

Deno.test("route QA credential expires even while its server-side secret remains set", async () => {
  assertEquals(ROUTE_QA_MAX_AGE_SECONDS, 20 * 60);
  assertEquals(ROUTE_QA_MAX_FUTURE_SECONDS, 120);
  assertEquals(await routeQaSecretAuthorized(secret, secret,
    issuedSeconds + ROUTE_QA_MAX_AGE_SECONDS), true);
  assertEquals(await routeQaSecretAuthorized(secret, secret,
    issuedSeconds + ROUTE_QA_MAX_AGE_SECONDS + 1), false);
  assertEquals(await routeQaSecretAuthorized(secret, secret,
    issuedSeconds - ROUTE_QA_MAX_FUTURE_SECONDS), true);
  assertEquals(await routeQaSecretAuthorized(secret, secret,
    issuedSeconds - ROUTE_QA_MAX_FUTURE_SECONDS - 1), false);
  assertEquals(await routeQaSecretAuthorized(secret, secret, Number.NaN), false);
});

Deno.test("route QA wrapper cannot invoke a paid handler with an expired configured key", async () => {
  let calls = 0;
  const staleRunId = `${issuedSeconds - ROUTE_QA_MAX_AGE_SECONDS - 5}_${"0123456789abcdef".repeat(2)}`;
  const stale = `${staleRunId}_${"Ab3_".repeat(16)}`;
  const wrapped = createRouteQaHandler(async () => {
    calls++;
    return new Response("unexpected");
  }, () => stale);
  const response = await wrapped(new Request("https://qa.example.test/", {
    method: "POST",
    headers: { [ROUTE_QA_SECRET_HEADER]: stale },
  }));
  assertEquals(response.status, 403);
  assertEquals(calls, 0);
});

Deno.test("route QA wrapper rejects every unauthorized method before handler invocation", async () => {
  let calls = 0;
  const wrapped = createRouteQaHandler(async () => {
    calls++;
    return new Response("unexpected");
  }, () => secret);
  for (const method of ["POST", "GET", "OPTIONS"]) {
    for (const supplied of [undefined, wrong]) {
      const headers = supplied ? { [ROUTE_QA_SECRET_HEADER]: supplied } : undefined;
      const response = await wrapped(new Request("https://qa.example.test/", { method, headers }));
      assertEquals(response.status, 403);
      assertEquals(response.headers.get("access-control-allow-origin"), null);
      assertEquals(response.headers.get("cache-control"), "no-store");
    }
  }
  assertEquals(calls, 0);
});

Deno.test("route QA wrapper fails closed when its server secret is unset or unreadable", async () => {
  let calls = 0;
  const handler = async () => {
    calls++;
    return new Response("unexpected");
  };
  for (const readEnv of [
    () => undefined,
    () => "short",
    () => { throw new Error("environment unavailable"); },
  ]) {
    const wrapped = createRouteQaHandler(handler, readEnv);
    const response = await wrapped(new Request("https://qa.example.test/", {
      method: "POST",
      headers: { [ROUTE_QA_SECRET_HEADER]: secret },
    }));
    assertEquals(response.status, 403);
  }
  assertEquals(calls, 0);
});

Deno.test("route QA wrapper returns 405 for authorized GET without calling handler", async () => {
  let calls = 0;
  const wrapped = createRouteQaHandler(async () => {
    calls++;
    return new Response("unexpected");
  }, () => secret);
  const response = await wrapped(new Request("https://qa.example.test/", {
    headers: { [ROUTE_QA_SECRET_HEADER]: secret },
  }));
  assertEquals(response.status, 405);
  assertEquals(response.headers.get("allow"), "POST");
  assertEquals(calls, 0);
});

Deno.test("route QA wrapper forwards authorized POST body without forwarding QA credential", async () => {
  let calls = 0;
  const wrapped = createRouteQaHandler(async (request) => {
    calls++;
    assertEquals(request.headers.get(ROUTE_QA_SECRET_HEADER), null);
    assertEquals(request.headers.get("authorization"), "Bearer test-jwt");
    try {
      await request.json();
    } catch {
      return new Response("invalid_json", { status: 400 });
    }
    return new Response("unexpected");
  }, () => secret);
  const response = await wrapped(new Request("https://qa.example.test/", {
    method: "POST",
    headers: {
      [ROUTE_QA_SECRET_HEADER]: secret,
      Authorization: "Bearer test-jwt",
      "Content-Type": "application/json",
    },
    body: "{",
  }));
  assertEquals(response.status, 400);
  assertEquals(calls, 1);
});
