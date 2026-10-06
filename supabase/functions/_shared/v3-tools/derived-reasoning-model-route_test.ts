import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  allowDerivedReasoningProviderFailover,
  derivedReasoningModelRouting,
  previewDerivedReasoningExperimentEnabled,
  safeDerivedReasoningErrorType,
  safeDerivedReasoningFinish,
  safeDerivedReasoningModelId,
  safeDerivedReasoningProvider,
  safeDerivedReasoningToolName,
  selectDerivedReasoningModel,
} from "./derived-reasoning-model-route.ts";

Deno.test("preview override is opt-in and never changes production selection", () => {
  const classifierModel = "anthropic/claude-sonnet-4.5";
  assertEquals(selectDerivedReasoningModel({
    variant: "preview",
    classifierModel,
    previewModel: null,
  }), classifierModel);
  assertEquals(selectDerivedReasoningModel({
    variant: "preview",
    classifierModel,
    previewModel: " anthropic/claude-haiku-4.5 ",
  }), "anthropic/claude-haiku-4.5");
  assertEquals(selectDerivedReasoningModel({
    variant: "production",
    classifierModel,
    previewModel: "anthropic/claude-haiku-4.5",
  }), classifierModel);
});

Deno.test("preview without explicit override retains the baseline model and fallback chain", () => {
  const classifierModel = "anthropic/claude-sonnet-4.5";
  assertEquals(previewDerivedReasoningExperimentEnabled("preview", null), false);
  assertEquals(previewDerivedReasoningExperimentEnabled("preview", "   "), false);
  assertEquals(selectDerivedReasoningModel({
    variant: "preview",
    classifierModel,
    previewModel: "   ",
  }), classifierModel);
  assertEquals(derivedReasoningModelRouting({
    variant: "preview",
    model: classifierModel,
    productionFallbacks: ["deepseek/deepseek-v4-flash"],
  }), { models: [classifierModel, "deepseek/deepseek-v4-flash"] });
});

Deno.test("explicit preview override has no hidden OpenRouter model chain", () => {
  assertEquals(previewDerivedReasoningExperimentEnabled(
    "preview",
    " anthropic/claude-haiku-4.5 ",
  ), true);
  assertEquals(derivedReasoningModelRouting({
    variant: "preview",
    model: "anthropic/claude-haiku-4.5",
    productionFallbacks: ["deepseek/deepseek-v4-flash"],
    previewModel: "anthropic/claude-haiku-4.5",
  }), { model: "anthropic/claude-haiku-4.5" });
  assertEquals(derivedReasoningModelRouting({
    variant: "preview",
    model: "google/gemini-2.5-flash",
    productionFallbacks: ["other/model"],
    previewModel: "anthropic/claude-haiku-4.5",
  }), { model: "google/gemini-2.5-flash" });
});

Deno.test("production forced reasoning retains its existing fallback routes", () => {
  assertEquals(derivedReasoningModelRouting({
    variant: "production",
    model: "anthropic/claude-sonnet-4.5",
    productionFallbacks: ["deepseek/deepseek-v4-flash"],
    previewModel: "anthropic/claude-haiku-4.5",
  }), { models: ["anthropic/claude-sonnet-4.5", "deepseek/deepseek-v4-flash"] });
  assertEquals(derivedReasoningModelRouting({
    variant: "production",
    model: "google/gemini-2.5-flash",
    productionFallbacks: [],
  }), { model: "google/gemini-2.5-flash" });
});

Deno.test("only explicit preview experiment disables provider failover", () => {
  assertEquals(allowDerivedReasoningProviderFailover("preview", "derived_reasoning"), true);
  assertEquals(allowDerivedReasoningProviderFailover("preview", "derived_reasoning", " "), true);
  assertEquals(allowDerivedReasoningProviderFailover("preview", "derived_reasoning", "anthropic/claude-haiku-4.5"), false);
  assertEquals(allowDerivedReasoningProviderFailover("preview", "final_render", "anthropic/claude-haiku-4.5"), true);
  assertEquals(allowDerivedReasoningProviderFailover("production", "derived_reasoning", "anthropic/claude-haiku-4.5"), true);
});

Deno.test("per-attempt diagnostics reject arbitrary provider-generated text", () => {
  assertEquals(safeDerivedReasoningModelId(" anthropic/claude-haiku-4.5 "), "anthropic/claude-haiku-4.5");
  assertEquals(safeDerivedReasoningModelId("customer secret or prompt"), null);
  assertEquals(safeDerivedReasoningModelId("https://host/path?key=secret"), null);
  assertEquals(safeDerivedReasoningModelId("a/" + "x".repeat(121)), null);
  assertEquals(safeDerivedReasoningProvider("openrouter"), "openrouter");
  assertEquals(safeDerivedReasoningProvider("customer text"), "unknown");
  assertEquals(safeDerivedReasoningFinish("tool_calls"), "tool_calls");
  assertEquals(safeDerivedReasoningFinish("customer text"), "other");
  assertEquals(safeDerivedReasoningToolName("declare_selection_reasoning"), "declare_selection_reasoning");
  assertEquals(safeDerivedReasoningToolName("google:python_interpreter"), "unexpected_python_interpreter");
  assertEquals(safeDerivedReasoningToolName("customer text"), "unexpected_tool");
  assertEquals(safeDerivedReasoningErrorType("TimeoutError"), "TimeoutError");
  assertEquals(safeDerivedReasoningErrorType("customer text"), "other_error");
});
