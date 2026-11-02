import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveUnrenderedSelectionContext } from "./unrendered-selection-context.ts";
import { joinCustomerTurns } from "./criteria-consistency.ts";
const base = {
  current: "Бетон, диаметр 8 мм, для перфоратора SDS-plus",
  enabled: true,
  boundary: {
    mode: "continuation" as const,
    confidence: 0.95,
    source: "model" as const,
    reason: "parameters of prior request",
  },
  newTask: false,
  strongerContext: false,
  replacement: false,
  lookupFailed: false,
  serverQueriesNewestFirst: ["Подбери сверло для стены"],
};
Deno.test("unrendered context: restore the server task, not a missing catalog noun guessed from the reply", () => {
  assertEquals(resolveUnrenderedSelectionContext(base), {
    status: "restored",
    sourceCount: 1,
    source: "completed_server_customer_queries",
    message: joinCustomerTurns([
      base.serverQueriesNewestFirst[0],
      base.current,
    ]),
  });
  const other = {
    ...base,
    current: "Нержавеющий, M8, 30 мм",
    serverQueriesNewestFirst: ["Подбери крепёж для фасада"],
  };
  const result = resolveUnrenderedSelectionContext(other);
  assertEquals(result.status, "restored");
  if (result.status === "restored") {
    assertEquals(
      result.message,
      joinCustomerTurns([other.serverQueriesNewestFirst[0], other.current]),
    );
  }
});
Deno.test("selection context: a fully rehydrated rendered base wins over raw customer logs without an adjective-only heuristic", () => {
  const rendered = "Подбери бур по бетону диаметром 10 мм";
  const result = resolveUnrenderedSelectionContext({
    ...base,
    verifiedRenderedBase: rendered,
    serverQueriesNewestFirst: ["Неподтверждённая другая задача"],
    lookupFailed: true,
  });
  assertEquals(result, {
    status: "restored",
    message: joinCustomerTurns([rendered, base.current]),
    sourceCount: 1,
    source: "completed_server_products_block",
    baseRequest: rendered,
  });
  assertEquals(
    resolveUnrenderedSelectionContext({
      ...base,
      verifiedRenderedBase: rendered,
      newTask: true,
    }),
    { status: "unchanged", message: base.current },
  );
});
Deno.test("unrendered context: OFF, new topic, replacement and established scope remain on their old paths", () => {
  for (
    const patch of [
      { enabled: false },
      { newTask: true },
      { strongerContext: true },
      { replacement: true },
      { current: "Новая тема. Найди кабель ВВГ 3*1,5" },
      { boundary: { ...base.boundary, mode: "new_task" as const } },
      { boundary: { ...base.boundary, confidence: 0.7 } },
      { boundary: { ...base.boundary, source: "fallback" as const } },
    ]
  ) {
    const value = { ...base, ...patch };
    assertEquals(resolveUnrenderedSelectionContext(value), {
      status: "unchanged",
      message: value.current,
    });
  }
});
Deno.test("unrendered context: absent or unavailable server evidence asks instead of trusting browser history", () => {
  for (
    const patch of [{ lookupFailed: true }, { serverQueriesNewestFirst: [] }]
  ) {
    const result = resolveUnrenderedSelectionContext({ ...base, ...patch });
    assertEquals(result.status, "needs_input");
    if (result.status === "needs_input") {
      assertEquals(result.reason, "missing_server_context");
    }
  }
});
Deno.test("unrendered context: ambiguous numerical corrections require explicit restatement, never stale filters", () => {
  for (
    const query of [
      "Подбери сверло диаметром 10 мм",
      "Подбери крепёж длиной 120 мм",
    ]
  ) {
    const result = resolveUnrenderedSelectionContext({
      ...base,
      serverQueriesNewestFirst: [query],
    });
    assertEquals(result.status, "needs_input");
    if (result.status === "needs_input") {
      assertEquals(result.reason, "ambiguous_quantity_override");
    }
  }
  assertEquals(
    resolveUnrenderedSelectionContext({
      ...base,
      serverQueriesNewestFirst: ["Подбери сверло диаметром 8 мм"],
    }).status,
    "restored",
  );
});
Deno.test("unrendered context: overlong task is rejected without deleting an old constraint", () => {
  for (
    const queries of [
      Array(9).fill("задача"),
      ["x".repeat(3001)],
      Array(3).fill("x".repeat(2900)),
      ["x".repeat(500)],
    ]
  ) {
    const result = resolveUnrenderedSelectionContext({
      ...base,
      serverQueriesNewestFirst: queries,
    });
    assertEquals(result.status, "needs_input");
    if (result.status === "needs_input") {
      assertEquals(result.reason, "context_limit");
    }
  }
});
