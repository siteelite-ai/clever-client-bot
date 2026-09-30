import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createProviderQuotaCooldown,
  fetchChatCompletionWithFailover,
  isChatCompletionFailoverEnabled,
  isProviderErrorFinishReason,
  isQuotaLimitedForbiddenResponse,
  shouldFailoverChatCompletion,
} from "./model-provider-failover.ts";

Deno.test("preview failover opt-in cannot enable the production function", () => {
  assertEquals(
    isChatCompletionFailoverEnabled({
      deploymentVariant: "production",
      previewEnabled: "true",
    }),
    false,
  );
  assertEquals(
    isChatCompletionFailoverEnabled({
      deploymentVariant: "preview",
      previewEnabled: "true",
    }),
    true,
  );
  assertEquals(
    isChatCompletionFailoverEnabled({
      deploymentVariant: "preview",
      previewEnabled: "false",
    }),
    false,
  );
});

Deno.test("legacy global failover remains an explicit project-wide opt-in", () => {
  assertEquals(
    isChatCompletionFailoverEnabled({
      deploymentVariant: "production",
      globalEnabled: "true",
      previewEnabled: "false",
    }),
    true,
  );
});

Deno.test("provider failover is limited to quota, capacity and transient failures", () => {
  for (const status of [402, 408, 409, 429, 500, 503]) {
    assertEquals(shouldFailoverChatCompletion(status), true);
  }
  for (const status of [400, 401, 403, 404, 422]) {
    assertEquals(shouldFailoverChatCompletion(status), false);
  }
});

Deno.test("HTTP 200 completion envelopes still reject an explicit provider error finish", () => {
  assertEquals(isProviderErrorFinishReason("error"), true);
  assertEquals(isProviderErrorFinishReason(" ERROR "), true);
  assertEquals(isProviderErrorFinishReason("stop"), false);
  assertEquals(isProviderErrorFinishReason(undefined), false);
});

Deno.test("fallback preserves tools but replaces provider-specific model routing", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl =
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return url.includes("primary")
        ? new Response("quota", { status: 402 })
        : Response.json({ choices: [] });
    }) as typeof fetch;
  const result = await fetchChatCompletionWithFailover({
    primary: { id: "primary", url: "https://primary.test/chat", apiKey: "p" },
    fallback: {
      id: "fallback",
      url: "https://fallback.test/chat",
      apiKey: "f",
      model: "fallback/model",
    },
    body: {
      models: ["primary/a", "primary/b"],
      messages: [{ role: "user", content: "test" }],
      tools: [{ type: "function", function: { name: "search_catalog" } }],
    },
    fetchImpl,
  });
  assertEquals(result.provider, "fallback");
  assertEquals(result.failedOver, true);
  assertEquals(result.primaryStatus, 402);
  assertEquals(calls.length, 2);
  assertEquals(calls[1].body.model, "fallback/model");
  assertEquals("models" in calls[1].body, false);
  assertEquals(calls[1].body.tools, calls[0].body.tools);
});

Deno.test("authentication failures do not change provider", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  const result = await fetchChatCompletionWithFailover({
    primary: { id: "primary", url: "https://primary.test/chat", apiKey: "p" },
    fallback: {
      id: "fallback",
      url: "https://fallback.test/chat",
      apiKey: "f",
      model: "fallback/model",
    },
    body: { model: "primary/model", messages: [] },
    fetchImpl,
  });
  assertEquals(result.provider, "primary");
  assertEquals(result.response.status, 401);
  assertEquals(calls, 1);
});

Deno.test("only an explicit per-key quota 403 may use the fallback", async () => {
  assertEquals(
    await isQuotaLimitedForbiddenResponse(
      Response.json({
        error: { message: "Key limit exceeded (total limit)", code: 403 },
      }, { status: 403 }),
    ),
    true,
  );
  assertEquals(
    await isQuotaLimitedForbiddenResponse(
      Response.json({ error: { message: "Forbidden", code: 403 } }, {
        status: 403,
      }),
    ),
    false,
  );

  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    return url.includes("primary")
      ? Response.json({
        error: { message: "Key limit exceeded (total limit)", code: 403 },
      }, { status: 403 })
      : Response.json({ choices: [] });
  }) as typeof fetch;
  const result = await fetchChatCompletionWithFailover({
    primary: { id: "primary", url: "https://primary.test/chat", apiKey: "p" },
    fallback: {
      id: "fallback",
      url: "https://fallback.test/chat",
      apiKey: "f",
    },
    body: { messages: [] },
    fetchImpl,
    quotaCooldown: createProviderQuotaCooldown(),
  });
  assertEquals(result.provider, "fallback");
  assertEquals(result.failedOver, true);
  assertEquals(result.primaryStatus, 403);
  assertEquals(urls, [
    "https://primary.test/chat",
    "https://fallback.test/chat",
  ]);
});

Deno.test("confirmed quota failure opens a bounded cooldown without another primary call", async () => {
  let now = 1_000;
  let calls = 0;
  const cooldown = createProviderQuotaCooldown({
    now: () => now,
    quotaCooldownMs: 30_000,
  });
  const fetchImpl = (async () => {
    calls += 1;
    return new Response("quota", { status: 402 });
  }) as typeof fetch;
  const request = {
    primary: { id: "primary", url: "https://primary.test/chat", apiKey: "p" },
    body: { messages: [] },
    fetchImpl,
    quotaCooldown: cooldown,
  };

  const first = await fetchChatCompletionWithFailover(request);
  const second = await fetchChatCompletionWithFailover(request);
  assertEquals(first.response.status, 402);
  assertEquals(first.primarySkipped, false);
  assertEquals(second.response.status, 402);
  assertEquals(second.primarySkipped, true);
  assertEquals(calls, 1);

  now += 30_001;
  const afterExpiry = await fetchChatCompletionWithFailover(request);
  assertEquals(afterExpiry.primarySkipped, false);
  assertEquals(calls, 2);
});

Deno.test("an enabled fallback remains available while the primary quota cooldown is open", async () => {
  let calls = 0;
  const urls: string[] = [];
  const cooldown = createProviderQuotaCooldown();
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls += 1;
    urls.push(url);
    return url.includes("primary")
      ? new Response("quota", { status: 402 })
      : Response.json({ choices: [] });
  }) as typeof fetch;
  const request = {
    primary: { id: "primary", url: "https://primary.test/chat", apiKey: "p" },
    fallback: {
      id: "fallback",
      url: "https://fallback.test/chat",
      apiKey: "f",
    },
    body: { messages: [] },
    fetchImpl,
    quotaCooldown: cooldown,
  };

  const first = await fetchChatCompletionWithFailover(request);
  const second = await fetchChatCompletionWithFailover(request);
  assertEquals(first.failedOver, true);
  assertEquals(first.primarySkipped, false);
  assertEquals(second.failedOver, true);
  assertEquals(second.primarySkipped, true);
  assertEquals(calls, 3);
  assertEquals(urls, [
    "https://primary.test/chat",
    "https://fallback.test/chat",
    "https://fallback.test/chat",
  ]);
});

Deno.test("non-quota client errors never open the cooldown", async () => {
  let calls = 0;
  const cooldown = createProviderQuotaCooldown();
  const fetchImpl = (async () => {
    calls += 1;
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  const request = {
    primary: { id: "primary", url: "https://primary.test/chat", apiKey: "p" },
    body: { messages: [] },
    fetchImpl,
    quotaCooldown: cooldown,
  };

  const first = await fetchChatCompletionWithFailover(request);
  const second = await fetchChatCompletionWithFailover(request);
  assertEquals(first.primarySkipped, false);
  assertEquals(second.primarySkipped, false);
  assertEquals(calls, 2);
});
