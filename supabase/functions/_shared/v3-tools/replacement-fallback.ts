export interface ReplacementAxisEvidence {
  key: string;
  ids: string[];
}

export interface RankedReplacementCandidate {
  id: string;
  matched_axis_keys: string[];
}

/**
 * Ranks only candidates proven by independent searches over model-selected
 * replacement axes. With two axes an ordinary analogue may match either axis;
 * with three or more it must match all but one. Exact/equivalent replacement
 * policy is intentionally left to the caller and must not use this fallback.
 */
export function rankSplitReplacementCandidates(
  axes: ReplacementAxisEvidence[],
  excludedIds: ReadonlySet<string>,
  limit = 8,
): RankedReplacementCandidate[] {
  if (axes.length < 2) return [];
  const byId = new Map<string, { matched: string[]; order: number }>();
  let order = 0;
  for (const axis of axes) {
    const seenOnAxis = new Set<string>();
    for (const rawId of axis.ids) {
      const id = String(rawId);
      if (!id || excludedIds.has(id) || seenOnAxis.has(id)) continue;
      seenOnAxis.add(id);
      const existing = byId.get(id) ?? { matched: [], order: order++ };
      if (!existing.matched.includes(axis.key)) existing.matched.push(axis.key);
      byId.set(id, existing);
    }
  }
  const minMatches = axes.length === 2 ? 1 : axes.length - 1;
  return [...byId.entries()]
    .filter(([, value]) => value.matched.length >= minMatches)
    .sort((left, right) => right[1].matched.length - left[1].matched.length || left[1].order - right[1].order)
    .slice(0, Math.max(1, limit))
    .map(([id, value]) => ({ id, matched_axis_keys: value.matched }));
}
