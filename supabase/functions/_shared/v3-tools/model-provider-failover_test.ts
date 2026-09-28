import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  fetchChatCompletionWithFailover,
  shouldFailoverChatCompletion,
} from "./model-provider-failover.ts";

Deno.test("provider failover is limited to quota, capacity and transient failures", () => {
  for (const status of [402, 408, 409, 429, 500, 503]) {
    assertEquals(shouldFailoverChatCompletion(status), true);
  }
  for (const status of [400, 401, 403, 404, 422]) {
    assertEquals(shouldFailoverChatCompletion(status), false);
  }
});

Deno.test("fallback preserves tools but replaces provider-specific model routing", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return url.includes("primary")
      ? new Response("quota", { status: 402 })
      : Response.json({ choices: [] });
  }) as typeof fetch;
  const result = await fetchChatCompletionWithFailover({
    primary: { id: "primary", url: "https://primary.test/chat", apiKey: "p" },
    fallback: { id: "fallback", url: "https://fallback.test/chat", apiKey: "f", model: "fallback/model" },
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
    fallback: { id: "fallback", url: "https://fallback.test/chat", apiKey: "f", model: "fallback/model" },
    body: { model: "primary/model", messages: [] },
    fetchImpl,
  });
  assertEquals(result.provider, "primary");
  assertEquals(result.response.status, 401);
  assertEquals(calls, 1);
});
