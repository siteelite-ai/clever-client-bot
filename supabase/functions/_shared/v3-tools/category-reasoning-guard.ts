// Keeps catalog category scope aligned with the consultant's declared reasoning.
// A category can be real (and therefore pass a whitelist) but still be the wrong
// sibling. Unsupported leaf categories are removed instead of guessed/replaced;
// the remaining facet filters then perform the safe category-wide search.

export interface DiscoveredCategoryScope {
  category?: { pagetitle?: string | null } | null;
  leaf_categories?: Array<{ pagetitle?: string | null }> | null;
}

export interface CategoryReasoningGuardResult {
  args: Record<string, unknown>;
  kept: string[];
  dropped: Array<{ category: string; reason: "not_declared_in_reasoning" }>;
}

const RU_SUFFIXES = [
  "ыми", "ими", "ого", "его", "ому", "ему",
  "ая", "яя", "ое", "ее", "ой", "ей", "ом", "ем", "ую", "юю",
  "ый", "ий", "ые", "ие", "ых", "их", "ам", "ям", "ах", "ях", "ов", "ев",
  "у", "ю", "а", "я", "о", "е", "ы", "и",
];

const GENERIC_TOKENS = new Set([
  "для", "товар", "товары", "категория", "категории", "оборудование", "изделие", "изделия",
]);

function norm(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stemRu(word: string): string {
  if (word.length < 5) return word;
  for (const suffix of RU_SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

function tokenMatches(left: string, right: string): boolean {
  if (left.length < 4 || right.length < 4) return false;
  const leftStem = stemRu(left);
  const rightStem = stemRu(right);
  const sharedLength = Math.min(leftStem.length, rightStem.length);
  return sharedLength >= 4 && leftStem.slice(0, sharedLength) === rightStem.slice(0, sharedLength);
}

function significantTokens(value: string): string[] {
  return norm(value).split(" ").filter((token) => token.length >= 4 && !GENERIC_TOKENS.has(token));
}

function distinctiveLeafTokens(leaf: string, umbrella: string): string[] {
  const umbrellaTokens = significantTokens(umbrella);
  return significantTokens(leaf).filter(
    (token) => !umbrellaTokens.some((umbrellaToken) => tokenMatches(token, umbrellaToken)),
  );
}

function leafSupported(leaf: string, umbrella: string, evidence: string): boolean {
  const distinctive = distinctiveLeafTokens(leaf, umbrella);
  // A leaf whose name is indistinguishable from the umbrella provides no
  // semantic assertion to verify and is safe to keep.
  if (distinctive.length === 0) return true;
  const evidenceTokens = significantTokens(evidence);
  // Every semantic assertion introduced by the leaf name must be present. A
  // shared requested feature alone (for example, "с датчиком движения") must
  // not justify an unrelated sibling modifier such as "уличный".
  return distinctive.every((token) => evidenceTokens.some((candidate) => tokenMatches(token, candidate)));
}

/** Canonical leaf names safe to use for one terminal semantic retry. */
export function groundedCategoryRecoveryQueries(
  discovered: DiscoveredCategoryScope | null,
  declaredReasoning: string,
  limit = 3,
): string[] {
  if (!discovered) return [];
  const umbrella = discovered.category?.pagetitle?.trim() ?? "";
  const leaves = (discovered.leaf_categories ?? [])
    .map((leaf) => leaf.pagetitle?.trim() ?? "")
    .filter(Boolean)
    .filter((leaf) => leafSupported(leaf, umbrella, declaredReasoning));
  const unique = [...new Map(leaves.map((leaf) => [norm(leaf), leaf])).values()];
  if (unique.length > 0) return unique.slice(0, Math.max(1, limit));
  const umbrellaTokens = significantTokens(umbrella);
  const evidenceTokens = significantTokens(declaredReasoning);
  const umbrellaGrounded = umbrellaTokens.length > 0 && umbrellaTokens.every(
    (token) => evidenceTokens.some((candidate) => tokenMatches(token, candidate)),
  );
  return umbrellaGrounded ? [umbrella] : [];
}

/**
 * Last-resort query ladder for a failed multiword semantic query. Each token is
 * still only a hint; callers must require the same token in catalog evidence.
 */
export function groundedTokenRecoveryQueries(searchQuery: string, limit = 8): string[] {
  const tokens = significantTokens(searchQuery);
  return [...new Set(tokens)].slice(0, Math.max(1, limit));
}

export function guardCategoryScopeByReasoning(
  args: Record<string, unknown>,
  discovered: DiscoveredCategoryScope | null,
  declaredReasoning: string,
): CategoryReasoningGuardResult {
  if (!discovered) return { args, kept: [], dropped: [] };
  const umbrella = discovered.category?.pagetitle?.trim() ?? "";
  const knownLeaves = new Map(
    (discovered.leaf_categories ?? [])
      .map((leaf) => leaf.pagetitle?.trim() ?? "")
      .filter(Boolean)
      .map((leaf) => [norm(leaf), leaf]),
  );
  if (knownLeaves.size === 0) return { args, kept: [], dropped: [] };

  const requested = [
    ...(typeof args.category === "string" ? [args.category] : []),
    ...(Array.isArray(args.category_in) ? args.category_in.map(String) : []),
  ].map((category) => category.trim()).filter(Boolean);

  const leafRequests = requested
    .map((category) => knownLeaves.get(norm(category)))
    .filter((category): category is string => Boolean(category));
  if (leafRequests.length === 0) return { args, kept: [], dropped: [] };

  const kept = leafRequests.filter((leaf) => leafSupported(leaf, umbrella, declaredReasoning));
  const dropped = leafRequests
    .filter((leaf) => !kept.includes(leaf))
    .map((category) => ({ category, reason: "not_declared_in_reasoning" as const }));
  if (dropped.length === 0) return { args, kept, dropped };

  const { category: _category, category_in: _categoryIn, ...rest } = args;
  const nextArgs = kept.length === 0
    ? rest
    : kept.length === 1
    ? { ...rest, category: kept[0] }
    : { ...rest, category_in: kept };
  return { args: nextArgs, kept, dropped };
}
