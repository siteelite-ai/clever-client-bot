import {
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleRetiredBetaSearch } from "./retired-handler.ts";

Deno.test("retired beta search rejects anonymous search without reading its body", async () => {
  const request = new Request(
    "https://example.test/functions/v1/chat-consultant-beta-search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid json",
    },
  );

  const response = handleRetiredBetaSearch(request);
  assertEquals(response.status, 410);
  assertEquals(response.headers.get("cache-control"), "no-store");
  assertEquals(response.headers.get("access-control-allow-origin"), "*");
  assertEquals(response.headers.get("x-content-type-options"), "nosniff");
  assertFalse(request.bodyUsed);
  assertEquals(await response.json(), {
    error: "gone",
    code: "BETA_SEARCH_RETIRED",
    message: "Этот тестовый поиск отключён. Используйте основной чат на сайте.",
  });
});

Deno.test("retired beta search never serves results on other methods", async () => {
  for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
    const request = new Request(
      "https://example.test/functions/v1/chat-consultant-beta-search?query_word=lamp",
      {
        method,
      },
    );
    const response = handleRetiredBetaSearch(request);
    assertEquals(response.status, 410, method);
    assertEquals((await response.json()).code, "BETA_SEARCH_RETIRED", method);
  }
});

Deno.test("retired beta search answers browser preflight without paid work", async () => {
  const request = new Request(
    "https://example.test/functions/v1/chat-consultant-beta-search",
    {
      method: "OPTIONS",
      headers: {
        Origin: "https://220volt.testdevops.ru",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    },
  );
  const response = handleRetiredBetaSearch(request);
  assertEquals(response.status, 204);
  assertEquals(await response.text(), "");
  assertEquals(
    response.headers.get("access-control-allow-methods"),
    "GET, POST, OPTIONS",
  );
  assertEquals(response.headers.get("cache-control"), "no-store");
});
