import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { intersectCandidateProofs } from "./candidate-proof-ledger.ts";

Deno.test("candidate proofs are monotonic and preserve candidate order", () => {
  const result = intersectCandidateProofs(
    ["new-1", "paired-2", "paired-1", "new-2", "paired-2"],
    [
      { kind: "paired_compatibility", ids: ["paired-1", "paired-2"] },
      { kind: "selection_target", ids: ["paired-2"] },
    ],
  );
  assertEquals(result.ids, ["paired-2"]);
  assertEquals(result.input_count, 4);
  assertEquals(result.removed_by, [
    { kind: "paired_compatibility", removed: 2 },
    { kind: "selection_target", removed: 1 },
  ]);
});

Deno.test("an empty mandatory proof cannot be bypassed by a broad recovery", () => {
  assertEquals(
    intersectCandidateProofs(["a", "b"], [{ kind: "mandatory", ids: [] }]).ids,
    [],
  );
});

Deno.test("without active proofs recovery candidates remain unchanged and deduplicated", () => {
  assertEquals(intersectCandidateProofs(["b", "a", "b"], []).ids, ["b", "a"]);
});
