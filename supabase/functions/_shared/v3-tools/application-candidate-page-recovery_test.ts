import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applicationCandidatePageDecision, compileApplicationCandidatePageRecovery as plan, type ApplicationCandidatePageInput } from "./application-candidate-page-recovery.ts";
const input = { search: { mode: "by_filter" as const, category: "Verified leaf", per_page: 50,
  max_price: 2000, options: { live_axis: ["owned_value"] } }, ready: true,
  applicationGap: true, subjectProved: true, lexicalRequirement: false, verifiedCategories: ["Verified leaf"],
  rawTotal: 100, rawCoverage: "partial" as const };
Deno.test("application gap pagination preserves every original filter and owns an independent copy", () => {
  const pages = plan(input)!;
  assertEquals(pages, [{ ...input.search, page: 2 }]);
  pages[0].options!.live_axis[0] = "changed";
  assertEquals(input.search.options.live_axis[0], "owned_value");
});
Deno.test("application recovery does not replace lexical/type/readiness obligations", () => {
  for (const patch of [{ ready: false }, { applicationGap: false }, { subjectProved: false }, { lexicalRequirement: true },
    { verifiedCategories: ["Another leaf"] }]) assertEquals(plan({ ...input, ...patch }), null);
});
Deno.test("application recovery cannot broaden queries, scopes or completed pagination", () => {
  for (const patch of [{ query: "term" }, { mode: "by_query" as const }, { category_in: ["Another leaf"] },
    { page: 2 }, { per_page: 200 }, { sort_cheapest: true }, { anchor_leaf_category: "Other" }]) {
    assertEquals(plan({ ...input, search: { ...input.search, ...patch } }), null);
  }
  assertEquals(plan({ ...input, search: { ...input.search, options: { live_axis: ["a", "b"] } } }), null);
});
Deno.test("application candidate window is bounded and complete coverage makes no redundant call", () => {
  assertEquals(plan({ ...input, rawTotal: 100000 })!.map(p => p.page), [2, 3, 4]);
  assertEquals(plan({ ...input, rawCoverage: "complete_query_window" }), []);
  for (const rawTotal of [NaN, Infinity, -1, 0, 1.5]) assertEquals(plan({ ...input, rawTotal })!.map(p => p.page), [2, 3, 4]);
});
Deno.test("every admission denial reports a fixed structural reason without copying request text", () => {
  const cases: Array<[Partial<ApplicationCandidatePageInput>, string]> = [
    [{ ready: false }, "not_ready"], [{ subjectProved: false }, "subject_unproven"],
    [{ applicationGap: false }, "no_application_gap"], [{ lexicalRequirement: true }, "lexical_obligation"],
    [{ verifiedCategories: [] }, "unverified_scope"],
    [{ search: { ...input.search, mode: "by_article" as const } }, "unsupported_mode"],
    [{ search: { ...input.search, mode: "by_query" as const } }, "conflicting_identity"],
    [{ search: { ...input.search, sort_expensive: true } }, "ordered_or_replacement"],
    [{ search: { ...input.search, options: { axis: ["a", "b"] } } }, "fanout"],
    [{ search: { ...input.search, page: 2 } }, "invalid_window"],
  ];
  for (const [patch, reason] of cases) {
    const decision = applicationCandidatePageDecision({ ...input, ...patch });
    assertEquals(decision.reason, reason); assertEquals(decision.pages, null);
    assertEquals(Number.isInteger(decision.reasonCode) && decision.reasonCode > 0, true);
  }
});
