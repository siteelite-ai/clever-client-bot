import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { compileApplicationCandidatePageRecovery as plan } from "./application-candidate-page-recovery.ts";
const base = { search: { mode: "by_filter" as const, category: "Verified category", per_page: 50, max_price: 2000 },
  ready: true, applicationGap: true, subjectProved: true, lexicalRequirement: false,
  verifiedLeaf: "Verified category", verifiedCategories: ["Verified category"], rawTotal: 100, rawCoverage: "partial" as const };

Deno.test("known-class candidate continuation preserves an owned query rather than rejecting its wire mode", () => {
  const input = { ...base, search: { ...base.search, mode: "by_query" as const, query: "owned class query" } };
  assertEquals(plan(input), [{ ...input.search, page: 2 }]);
});
Deno.test("unknown pagination coverage does not erase a known-class application gap", () => {
  const input = { ...base, rawCoverage: "unknown" as const, rawTotal: 0 };
  assertEquals(plan(input)?.map(p => p.page), [2, 3, 4]);
});
Deno.test("a verified parent scope remains the same scope, not an unlicensed new leaf", () => {
  const input = { ...base, verifiedLeaf: "", verifiedCategories: ["Verified category", "Leaf A", "Leaf B"] };
  assertEquals(plan(input), [{ ...input.search, page: 2 }]);
});
