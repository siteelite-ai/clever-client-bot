import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildSelectionSearchRecoveryPlan, isRecoverableSelectionSearchFailure } from "./selection-search-recovery.ts";

const facets = [
  { key: "feature", caption: "Функция", type: "string", unit: null, values: [{ value: "Да" }] },
  { key: "output", caption: "Поток", type: "number", unit: "лм", values: [{ value: "4000" }, { value: "5000" }] },
];

Deno.test("recovery plan first preserves exact filters and removes only category scope", () => {
  const plan = buildSelectionSearchRecoveryPlan({
    failed_args: {
      mode: "by_filter",
      category_in: ["Live leaf"],
      options: { feature: ["Да"] },
      max_price: 4000,
      sort_cheapest: true,
      per_page: 10,
    },
    facets,
    leaf_categories: ["Live leaf"],
    reasoning_criteria: [],
    compatibility_shaped: false,
  });
  assertEquals(plan[0].kind, "preserve_filters_expand_category_scope");
  assertEquals(plan[0].args, {
    mode: "by_filter",
    options: { feature: ["Да"] },
    max_price: 4000,
    sort_cheapest: true,
    per_page: 10,
  });
  assertEquals(plan[0].revalidate, ["selection_target", "mandatory_criteria", "compatibility", "budget"]);
});

Deno.test("reasoning criteria create bounded scoped then unscoped attempts", () => {
  const plan = buildSelectionSearchRecoveryPlan({
    failed_args: { mode: "by_filter", category_in: ["Live leaf"], per_page: 20 },
    facets,
    leaf_categories: ["Live leaf"],
    reasoning_criteria: [{ key: "Поток", op: "range", value: [3750, 5000], unit: "лм", level: "A" }],
    compatibility_shaped: false,
  });
  assertEquals(plan.map(({ kind }) => kind), [
    "project_reasoning_ranges_in_category",
    "project_reasoning_ranges_expand_category_scope",
  ]);
  assertEquals(plan[0].args.category_in, ["Live leaf"]);
  assertEquals(plan[1].args.category_in, undefined);
  assertEquals(plan[0].proven_criteria.length, 1);
  assert(plan.length <= 4);
});

Deno.test("paired compatibility cannot be replaced by scalar range recovery", () => {
  const plan = buildSelectionSearchRecoveryPlan({
    failed_args: { mode: "by_filter", category_in: ["Live leaf"], per_page: 20 },
    facets,
    leaf_categories: ["Live leaf"],
    reasoning_criteria: [{ key: "Поток", op: "range", value: [1, 2], unit: "лм", level: "A" }],
    compatibility_shaped: true,
  });
  assertEquals(plan, []);
});

Deno.test("policy contains no product vocabulary or hard-coded taxonomy", () => {
  const source = Deno.readTextFileSync(new URL("./selection-search-recovery.ts", import.meta.url));
  for (const forbidden of ["термоус", "люстр", "светильник", "кабель", "ибп", "korn"]) {
    assertEquals(source.toLocaleLowerCase("ru-RU").includes(forbidden), false);
  }
});

Deno.test("empty and structurally incomplete by-filter calls enter the same recovery controller", () => {
  assertEquals(isRecoverableSelectionSearchFailure(
    { mode: "by_filter", category_in: ["Live leaf"] },
    { ok: true, total: 0 },
  ), true);
  assertEquals(isRecoverableSelectionSearchFailure(
    { mode: "by_filter", per_page: 50 },
    { ok: false, error_code: "bad_input", message: "by_filter requires category/category_in or options" },
  ), true);
});

Deno.test("recovery controller does not swallow unrelated bad input or transport failures", () => {
  assertEquals(isRecoverableSelectionSearchFailure(
    { mode: "by_filter" },
    { ok: false, error_code: "bad_input", message: "invalid option value" },
  ), false);
  assertEquals(isRecoverableSelectionSearchFailure(
    { mode: "by_filter" },
    { ok: false, error_code: "catalog_timeout", message: "timeout" },
  ), false);
  assertEquals(isRecoverableSelectionSearchFailure(
    { mode: "by_query" },
    { ok: true, total: 0 },
  ), false);
});
