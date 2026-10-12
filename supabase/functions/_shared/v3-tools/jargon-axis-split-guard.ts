/**
 * Recheck every independent jargon axis at the emission boundary. A split is
 * only truthful when both its base and each labelled alternative still have
 * admissible cards. The caller supplies the section/series guard, not the
 * full conjunctive final-card guard: independent axes are intentionally
 * partial matches. A persisted named-series section cannot be bypassed by a
 * later unscoped axis recovery.
 */
export function guardJargonAxisSplitSections<
  T extends { ids: string[] },
>(
  sections: readonly T[],
  guardIds: (ids: string[]) => string[],
): T[] | null {
  if (sections.length < 2) return null;
  const guarded: T[] = [];
  for (const section of sections) {
    const original = new Set(section.ids);
    const safeIds = guardIds([...section.ids]);
    if (
      safeIds.length === 0 ||
      safeIds.some((id) => !original.has(id))
    ) return null;
    guarded.push({ ...section, ids: [...new Set(safeIds)] });
  }
  return guarded;
}
