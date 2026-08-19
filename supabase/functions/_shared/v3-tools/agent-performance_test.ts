import { assert, assertEquals, assertLess } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  compactCatalogResultForLlm,
  forcedToolNameForAgentPhase,
  hasActionableSelectionReasoning,
  isToolAllowedInAgentPhase,
  nextAgentPhase,
  shouldDeferInquiryIntro,
  toolNamesForAgentPhase,
} from "./agent-performance.ts";
import type { ProductRef } from "./types.ts";

Deno.test("agent phase: successful discovery requires search and blocks rediscovery", () => {
  const phase = nextAgentPhase("open", {
    tool: "discover_category",
    ok: true,
    intentMode: "select",
    replacementIntent: false,
  });
  assertEquals(phase, "search_after_discovery");
  assert(!toolNamesForAgentPhase(phase).includes("discover_category"));
  assert(toolNamesForAgentPhase(phase).includes("search_catalog"));
  assert(!toolNamesForAgentPhase(phase).includes("jargon_recover_catalog"));
});

Deno.test("agent phase: jargon helper is unavailable initially and only opens after category_not_found", () => {
  assert(!toolNamesForAgentPhase("open").includes("jargon_recover_catalog"));
  assertEquals(nextAgentPhase("open", {
    tool: "discover_category",
    ok: false,
    errorCode: "category_not_found",
    intentMode: "select",
    replacementIntent: false,
  }), "jargon_after_failed_discovery");
  assert(toolNamesForAgentPhase("jargon_after_failed_discovery").includes("jargon_recover_catalog"));
  assertEquals(nextAgentPhase("open", {
    tool: "discover_category",
    ok: false,
    errorCode: "upstream_error",
    intentMode: "select",
    replacementIntent: false,
  }), "open");
});

Deno.test("agent phase: clarification is available only after discovery and before a non-empty search", () => {
  assert(!toolNamesForAgentPhase("open").includes("propose_clarification"));
  assert(toolNamesForAgentPhase("search_after_discovery").includes("propose_clarification"));
  assert(!toolNamesForAgentPhase("terminal_after_search").includes("propose_clarification"));
});

Deno.test("agent phase: quantified model reasoning removes optional clarification", () => {
  const reasoning = "Для комнаты 25 м² нужен поток 3000–4000 люмен и около 30–40 Вт";
  assert(hasActionableSelectionReasoning(reasoning));
  assert(!toolNamesForAgentPhase("search_after_discovery", { reasoningRequiresCatalog: true }).includes("propose_clarification"));
  assert(!hasActionableSelectionReasoning("Нужен кабель длиной 100 м, остальных данных пока нет"));
  assert(toolNamesForAgentPhase("search_after_discovery", { reasoningRequiresCatalog: false }).includes("propose_clarification"));
});

Deno.test("agent phase: server rejects model-emitted tools outside the advertised phase", () => {
  assert(!isToolAllowedInAgentPhase("search_after_discovery", "discover_category"));
  assert(!isToolAllowedInAgentPhase("terminal_after_search", "search_catalog"));
  assert(!isToolAllowedInAgentPhase("terminal_after_search", "unknown_tool"));
  assert(isToolAllowedInAgentPhase("terminal_after_search", "render_products"));
  assert(!isToolAllowedInAgentPhase("search_after_discovery", "propose_clarification", { reasoningRequiresCatalog: true }));
});

Deno.test("agent phase: non-empty ordinary selection search becomes terminal", () => {
  const phase = nextAgentPhase("search_after_discovery", {
    tool: "search_catalog",
    ok: true,
    total: 167,
    intentMode: "select",
    replacementIntent: false,
  });
  assertEquals(phase, "terminal_after_search");
  assertEquals(toolNamesForAgentPhase(phase), [
    "render_products",
  ]);
});

Deno.test("agent phase: non-empty replacement search must render instead of reopening search", () => {
  assertEquals(nextAgentPhase("search_after_discovery", {
    tool: "search_catalog",
    ok: true,
    total: 5,
    intentMode: "select",
    replacementIntent: true,
  }), "terminal_after_search");
});

Deno.test("agent phase: explanatory inquiry can render a previously found pool", () => {
  const phase = nextAgentPhase("open", {
    tool: "search_catalog",
    ok: true,
    total: 3,
    intentMode: "inquire",
    replacementIntent: false,
  });

  assertEquals(phase, "inquiry_with_results");
  assert(isToolAllowedInAgentPhase(phase, "lookup_knowledge"));
  assert(isToolAllowedInAgentPhase(phase, "search_catalog"));
  assert(isToolAllowedInAgentPhase(phase, "render_products"));
  assertEquals(forcedToolNameForAgentPhase(phase), null);
});

Deno.test("agent phase: further inquiry searches preserve render access", () => {
  assertEquals(nextAgentPhase("inquiry_with_results", {
    tool: "search_catalog",
    ok: true,
    total: 50,
    intentMode: "inquire",
    replacementIntent: false,
  }), "inquiry_with_results");
});

Deno.test("inquiry prose is deferred until evidence while selection reasoning stays visible", () => {
  assert(shouldDeferInquiryIntro("inquire", true, false, false));
  assert(!shouldDeferInquiryIntro("select", true, false, false));
  assert(!shouldDeferInquiryIntro("inquire", false, false, true));
  assert(!shouldDeferInquiryIntro("inquire", true, true, false));
});

Deno.test("agent phase: quantified reasoning forces exactly the next phase tool", () => {
  const ready = { reasoningRequiresCatalog: true };
  assertEquals(forcedToolNameForAgentPhase("open", ready), "discover_category");
  assertEquals(forcedToolNameForAgentPhase("search_after_discovery", ready), "search_catalog");
  assertEquals(forcedToolNameForAgentPhase("terminal_after_search", ready), "render_products");
  assertEquals(forcedToolNameForAgentPhase("open", { reasoningRequiresCatalog: false }), null);
});

Deno.test("agent phase: empty search keeps the established category and blocks lexical reinterpretation", () => {
  assertEquals(nextAgentPhase("search_after_discovery", {
    tool: "search_catalog",
    ok: true,
    total: 0,
    intentMode: "select",
    replacementIntent: false,
  }), "search_after_discovery");
  assert(!toolNamesForAgentPhase("search_after_discovery").includes("jargon_recover_catalog"));
  assertEquals(nextAgentPhase("search_after_discovery", {
    tool: "search_catalog",
    ok: true,
    total: 5,
    intentMode: "select",
    replacementIntent: true,
  }), "terminal_after_search");
});

Deno.test("agent phase: partial jargon result cannot be forced into product rendering", () => {
  assertEquals(nextAgentPhase("jargon_after_failed_discovery", {
    tool: "jargon_recover_catalog",
    ok: true,
    total: 2,
    partialMatch: true,
    intentMode: "select",
    replacementIntent: false,
  }), "jargon_after_failed_discovery");
  assertEquals(nextAgentPhase("jargon_after_failed_discovery", {
    tool: "jargon_recover_catalog",
    ok: true,
    total: 2,
    partialMatch: false,
    intentMode: "select",
    replacementIntent: false,
  }), "terminal_after_search");
});

Deno.test("LLM catalog view is bounded, relevance-ranked, and materially smaller", () => {
  const products: ProductRef[] = Array.from({ length: 30 }, (_, index) => ({
    id: String(index),
    pagetitle: `Светильник ${index}`,
    vendor: "Test",
    price: 1000 + index,
    stock: "in_stock",
    short_traits: Array.from({ length: 30 }, (__, trait) => `Характеристика ${trait}: ${index + trait}`),
    description_excerpt: "Описание ".repeat(200),
    warehouses: Array.from({ length: 10 }, (__, city) => ({ city: `Город ${city}`, qty: city + 1 })),
  }));
  products[25].short_traits.push("Световой поток: 5000 лм");

  const compacted = compactCatalogResultForLlm({ results: products, total: 167 }, "нужно 5000 лм для гостиной");
  assertEquals(compacted.result.results.length, 12);
  assertEquals(compacted.result.results[0].id, "25");
  assertEquals(compacted.result._llm_view, { returned: 12, available_in_tool_result: 30, total: 167 });
  assertLess(compacted.compactBytes, compacted.originalBytes * 0.35);
});
