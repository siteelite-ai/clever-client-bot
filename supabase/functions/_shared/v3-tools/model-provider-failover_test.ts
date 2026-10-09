import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
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

Deno.test("a rejected primary network fetch uses one fallback without opening quota cooldown", async () => {
  const urls: string[] = [];
  const cooldown = createProviderQuotaCooldown();
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("primary")) throw new TypeError("fetch failed");
    return Response.json({ choices: [{ message: { content: "recovered" } }] });
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
  assertEquals(first.provider, "fallback");
  assertEquals(first.failedOver, true);
  assertEquals(first.primarySkipped, false);
  assertEquals(first.primaryStatus, undefined);
  assertEquals(
    (await first.response.json()).choices[0].message.content,
    "recovered",
  );
  assertEquals(second.primarySkipped, false);
  assertEquals(urls, [
    "https://primary.test/chat",
    "https://fallback.test/chat",
    "https://primary.test/chat",
    "https://fallback.test/chat",
  ]);
});

Deno.test("HTTP 200 unusable completion envelopes use only one fallback", async () => {
  const unusableBodies = [
    "not json",
    JSON.stringify({ error: { message: "upstream unavailable" } }),
    JSON.stringify({ choices: [] }),
    JSON.stringify({
      choices: [{ finish_reason: "error", message: { content: "" } }],
    }),
    JSON.stringify({ choices: [{ finish_reason: "stop" }] }),
  ];
  for (const primaryBody of unusableBodies) {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      return url.includes("primary")
        ? new Response(primaryBody, { status: 200 })
        : Response.json({ choices: [{ message: { content: "fallback" } }] });
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
    });
    assertEquals(result.provider, "fallback");
    assertEquals(result.failedOver, true);
    assertEquals(result.primaryStatus, 200);
    assertEquals(
      (await result.response.json()).choices[0].message.content,
      "fallback",
    );
    assertEquals(urls, [
      "https://primary.test/chat",
      "https://fallback.test/chat",
    ]);
  }
});

Deno.test("a usable HTTP 200 completion remains on the primary with its body readable", async () => {
  let calls = 0;
  const payload = {
    choices: [{ finish_reason: "stop", message: { content: "ok" } }],
  };
  const fetchImpl = (async () => {
    calls += 1;
    return Response.json(payload);
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
  });
  assertEquals(result.provider, "primary");
  assertEquals(result.failedOver, false);
  assertEquals(await result.response.json(), payload);
  assertEquals(calls, 1);
});

Deno.test("HTTP 200 envelope validation does not reinterpret caller-specific content", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return Response.json({
      choices: [{ finish_reason: "stop", message: { content: null } }],
    });
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
  });
  assertEquals(result.failedOver, false);
  assertEquals(calls, 1);
});

Deno.test("without an enabled fallback the primary HTTP 200 body remains untouched", async () => {
  const result = await fetchChatCompletionWithFailover({
    primary: { id: "primary", url: "https://primary.test/chat", apiKey: "p" },
    body: { messages: [] },
    fetchImpl: (async () =>
      new Response("not json", { status: 200 })) as typeof fetch,
  });
  assertEquals(result.failedOver, false);
  assertEquals(result.provider, "primary");
  assertEquals(await result.response.text(), "not json");
});

Deno.test("a network rejection without a fallback preserves the original error", async () => {
  const failure = new TypeError("fetch failed");
  const fetchImpl = (async () => {
    throw failure;
  }) as typeof fetch;
  const caught = await assertRejects(() =>
    fetchChatCompletionWithFailover({
      primary: { id: "primary", url: "https://primary.test/chat", apiKey: "p" },
      body: { messages: [] },
      fetchImpl,
    })
  );
  assertStrictEquals(caught, failure);
});

Deno.test("abort, timeout and non-network exceptions never switch providers", async () => {
  for (
    const failure of [
      new DOMException("cancelled", "AbortError"),
      new DOMException("deadline", "TimeoutError"),
      new Error("bug in fetch implementation"),
    ]
  ) {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw failure;
    }) as typeof fetch;
    const caught = await assertRejects(() =>
      fetchChatCompletionWithFailover({
        primary: {
          id: "primary",
          url: "https://primary.test/chat",
          apiKey: "p",
        },
        fallback: {
          id: "fallback",
          url: "https://fallback.test/chat",
          apiKey: "f",
        },
        body: { messages: [] },
        fetchImpl,
      })
    );
    assertStrictEquals(caught, failure);
    assertEquals(calls, 1);
  }
});

Deno.test("an aborted signal prevents failover even if fetch rejects with TypeError", async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    controller.abort(new DOMException("deadline", "TimeoutError"));
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await assertRejects(() =>
    fetchChatCompletionWithFailover({
      primary: { id: "primary", url: "https://primary.test/chat", apiKey: "p" },
      fallback: {
        id: "fallback",
        url: "https://fallback.test/chat",
        apiKey: "f",
      },
      body: { messages: [] },
      signal: controller.signal,
      fetchImpl,
    }), TypeError);
  assertEquals(calls, 1);
});

Deno.test("a deadline during HTTP 200 envelope inspection never starts fallback", async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    controller.abort(new DOMException("deadline", "TimeoutError"));
    return Response.json({ choices: [] });
  }) as typeof fetch;
  await assertRejects(
    () =>
      fetchChatCompletionWithFailover({
        primary: {
          id: "primary",
          url: "https://primary.test/chat",
          apiKey: "p",
        },
        fallback: {
          id: "fallback",
          url: "https://fallback.test/chat",
          apiKey: "f",
        },
        body: { messages: [] },
        signal: controller.signal,
        fetchImpl,
      }),
    DOMException,
  );
  assertEquals(calls, 1);
});

Deno.test("request serialization errors are not mistaken for network failures", async () => {
  const body: Record<string, unknown> = { messages: [] };
  body.circular = body;
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return Response.json({ choices: [] });
  }) as typeof fetch;
  await assertRejects(() =>
    fetchChatCompletionWithFailover({
      primary: { id: "primary", url: "https://primary.test/chat", apiKey: "p" },
      fallback: {
        id: "fallback",
        url: "https://fallback.test/chat",
        apiKey: "f",
      },
      body,
      fetchImpl,
    }), TypeError);
  assertEquals(calls, 0);
});

Deno.test("a fallback response is returned once even when its envelope is unusable", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return Response.json({ choices: [] });
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
  });
  assertEquals(result.provider, "fallback");
  assertEquals(result.failedOver, true);
  assertEquals(calls, 2);
});

Deno.test("streaming completions are not parsed as JSON by the failover wrapper", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response('data: {"choices":[]}\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  const result = await fetchChatCompletionWithFailover({
    primary: { id: "primary", url: "https://primary.test/chat", apiKey: "p" },
    fallback: {
      id: "fallback",
      url: "https://fallback.test/chat",
      apiKey: "f",
    },
    body: { messages: [], stream: true },
    fetchImpl,
  });
  assertEquals(result.failedOver, false);
  assertEquals(await result.response.text(), 'data: {"choices":[]}\n\n');
  assertEquals(calls, 1);
});
