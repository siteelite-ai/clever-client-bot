import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildModelFallbackChain,
  buildOpenRouterModelRouting,
  parseConfiguredModelFallbacks,
} from "./model-routing.ts";

Deno.test("model fallback chain preserves the primary and removes duplicates", () => {
  assertEquals(
    buildModelFallbackChain(" primary/model ", ["fallback/model", "primary/model", "", "fallback/model"]),
    ["primary/model", "fallback/model"],
  );
});

Deno.test("model fallback chain stays usable without configured fallbacks", () => {
  assertEquals(buildModelFallbackChain("primary/model", []), ["primary/model"]);
});

Deno.test("configured model fallbacks are parsed from a comma-separated setting", () => {
  assertEquals(
    parseConfiguredModelFallbacks(" fallback/one, fallback/two, fallback/one, "),
    ["fallback/one", "fallback/two"],
  );
});

Deno.test("missing fallback setting keeps the fallback list empty", () => {
  assertEquals(parseConfiguredModelFallbacks(undefined), []);
  assertEquals(parseConfiguredModelFallbacks(""), []);
});

Deno.test("single-model routing preserves the existing OpenRouter request shape", () => {
  assertEquals(buildOpenRouterModelRouting("primary/model", []), { model: "primary/model" });
});

Deno.test("explicit fallbacks opt into OpenRouter model fallback routing", () => {
  assertEquals(
    buildOpenRouterModelRouting("primary/model", ["fallback/model"]),
    { models: ["primary/model", "fallback/model"] },
  );
});
