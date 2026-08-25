/**
 * Monotonic candidate proof ledger.
 *
 * A recovery search may produce a broader pool than the one that already
 * passed another mandatory contract. The broader pool is evidence for the new
 * condition only; it must not erase prior proofs. Applying every active proof
 * as an intersection makes the invariant explicit and category-agnostic:
 * downstream validation can only keep or remove candidates, never introduce
 * an item that has not passed an earlier mandatory proof.
 */

export interface CandidateProof {
  kind: string;
  ids: readonly string[];
}

export interface CandidateProofIntersection {
  ids: string[];
  input_count: number;
  removed_by: Array<{ kind: string; removed: number }>;
}

export function intersectCandidateProofs(
  candidateIds: readonly string[],
  proofs: readonly CandidateProof[],
): CandidateProofIntersection {
  let ids = [...new Set(candidateIds.map(String).filter(Boolean))];
  const inputCount = ids.length;
  const removedBy: Array<{ kind: string; removed: number }> = [];

  for (const proof of proofs) {
    const allowed = new Set(proof.ids.map(String).filter(Boolean));
    const before = ids.length;
    ids = ids.filter((id) => allowed.has(id));
    removedBy.push({ kind: proof.kind, removed: before - ids.length });
  }

  return { ids, input_count: inputCount, removed_by: removedBy };
}
