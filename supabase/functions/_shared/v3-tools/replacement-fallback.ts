export interface ReplacementAxisEvidence {
  key: string;
  ids: string[];
  total?: number;
}

export interface RankedReplacementCandidate {
  id: string;
  matched_axis_keys: string[];
}

export type NamedTraitEvidence = "proven" | "contradicted" | "absent";

function normalizeTraitLabel(value: string): string {
  return String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * An explicitly named trait outranks unrelated numbers elsewhere on the card.
 * Once a card says `Power: 5`, a `10` in its current, model or dimensions can
 * no longer prove `Power: 10` through a broad text fallback.
 */
export function classifyNamedTraitEvidence(
  shortTraits: string[] | null | undefined,
  caption: string,
  matches: (actual: string) => boolean,
): NamedTraitEvidence {
  const wanted = normalizeTraitLabel(caption);
  let found = false;
  for (const line of shortTraits ?? []) {
    const [rawCaption, ...rawValue] = line.split(":");
    if (!rawCaption || rawValue.length === 0 || normalizeTraitLabel(rawCaption) !== wanted) continue;
    found = true;
    if (matches(rawValue.join(":").trim())) return "proven";
  }
  return found ? "contradicted" : "absent";
}

/** Candidate ids proven on every independent replacement axis. */
export function intersectReplacementAxisEvidence(
  axes: ReplacementAxisEvidence[],
): string[] {
  if (axes.length < 2) return [];
  const first = [...new Set(axes[0].ids.map(String).filter(Boolean))];
  const remaining = axes.slice(1).map((axis) => new Set(axis.ids.map(String)));
  return first.filter((id) => remaining.every((ids) => ids.has(id)));
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
