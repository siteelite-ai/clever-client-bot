export interface ReplacementAxisEvidence {
  key: string;
  ids: string[];
  total?: number;
}

export interface RankedReplacementCandidate {
  id: string;
  matched_axis_keys: string[];
}

/**
 * Ranks only candidates proven by independent searches over model-selected
 * replacement axes. More matching axes rank first; among equally supported
 * candidates, evidence from the most selective axis ranks first. Exact or
 * equivalent replacement policy is intentionally left to the caller and must
 * not use this near-match fallback.
 */
export function rankSplitReplacementCandidates(
  axes: ReplacementAxisEvidence[],
  excludedIds: ReadonlySet<string>,
  limit = 8,
): RankedReplacementCandidate[] {
  if (axes.length < 2) return [];
  const byId = new Map<string, { matched: string[]; bestAxisTotal: number; order: number }>();
  let order = 0;
  for (const axis of axes) {
    const seenOnAxis = new Set<string>();
    for (const rawId of axis.ids) {
      const id = String(rawId);
      if (!id || excludedIds.has(id) || seenOnAxis.has(id)) continue;
      seenOnAxis.add(id);
      const existing = byId.get(id) ?? { matched: [], bestAxisTotal: Number.POSITIVE_INFINITY, order: order++ };
      if (!existing.matched.includes(axis.key)) existing.matched.push(axis.key);
      if (Number.isFinite(axis.total) && Number(axis.total) > 0) {
        existing.bestAxisTotal = Math.min(existing.bestAxisTotal, Number(axis.total));
      }
      byId.set(id, existing);
    }
  }
  return [...byId.entries()]
    .filter(([, value]) => value.matched.length >= 1)
    .sort((left, right) =>
      right[1].matched.length - left[1].matched.length ||
      left[1].bestAxisTotal - right[1].bestAxisTotal ||
      left[1].order - right[1].order
    )
    .slice(0, Math.max(1, limit))
    .map(([id, value]) => ({ id, matched_axis_keys: value.matched }));
}
