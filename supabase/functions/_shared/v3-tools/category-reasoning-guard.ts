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

export interface GroundedCategoryRecoveryScope<T extends DiscoveredCategoryScope> {
  discovery: T;
  targets: string[];
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

function evidenceAffirmsToken(evidence: string, token: string): boolean {
  const tokens = norm(evidence).split(" ").filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    if (!tokenMatches(token, tokens[index])) continue;
    // In a transformation request (`replace X with Y`) X is the source being
    // removed, not positive evidence for the target category. A later mention
    // after `with/на` can still affirm the same class independently.
    let belongsToReplacementSource = false;
    for (let start = index - 1; start >= Math.max(0, index - 12); start -= 1) {
      if (!tokens[start].startsWith("замен")) continue;
      const separator = tokens.slice(start + 1, Math.min(tokens.length, index + 13)).indexOf("на");
      if (separator >= 0 && index < start + 1 + separator) belongsToReplacementSource = true;
      break;
    }
    if (belongsToReplacementSource) continue;
    const context = tokens.slice(Math.max(0, index - 5), Math.min(tokens.length, index + 15)).join(" ");
    const rejected = /(?:(?:^|\s)не\s+(?:то|подход\p{L}*|нуж\p{L}*|соответ\p{L}*|верн\p{L}*)|(?:^|\s)(?:ошибоч\p{L}*|неверн\p{L}*|отсеч\p{L}*|исключ\p{L}*|убра\p{L}*|лишн\p{L}*)|(?:^|\s)нуж\p{L}*\s+друг\p{L}*|(?:^|\s)треб\p{L}*\s+друг\p{L}*)/u.test(context);
    if (!rejected) return true;
  }
  return false;
}

/**
 * Checks whether a complete live category label is affirmed on the target
 * side of the customer's request. Unlike plain token overlap, a mention on
 * the source side of a `replace X with Y` transformation is not positive
 * evidence for keeping X as the destination category.
 */
export function categoryLabelIsAffirmedAsTarget(label: string, evidence: string): boolean {
  const tokens = significantTokens(label);
  return tokens.length > 0 && tokens.every((token) => evidenceAffirmsToken(evidence, token));
}

function leafSupported(leaf: string, umbrella: string, evidence: string): boolean {
  const distinctive = distinctiveLeafTokens(leaf, umbrella);
  // A leaf whose name is indistinguishable from the umbrella provides no
  // semantic assertion to verify and is safe to keep.
  if (distinctive.length === 0) return true;
  // Every semantic assertion introduced by the leaf name must be present. A
  // shared requested feature alone (for example, "с датчиком движения") must
  // not justify an unrelated sibling modifier such as "уличный".
  // A rejected branch is not positive evidence merely because its name occurs
  // in the explanation ("this branch does not fit; choose another type").
  return distinctive.every((token) => evidenceAffirmsToken(evidence, token));
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
 * A successful taxonomy lookup is not automatically a successful intent
 * resolution. Preserve all live discoveries and rank only those whose class
 * is grounded in the frozen selection evidence. Newer grounded scopes win;
 * an ungrounded corrective lookup cannot erase an earlier useful umbrella.
 */
export function rankGroundedCategoryRecoveryScopes<T extends DiscoveredCategoryScope>(
  discoveries: readonly T[],
  declaredReasoning: string,
  limit = 4,
): Array<GroundedCategoryRecoveryScope<T>> {
  const selected: Array<GroundedCategoryRecoveryScope<T>> = [];
  const seen = new Set<string>();
  for (let index = discoveries.length - 1; index >= 0; index -= 1) {
    const discovery = discoveries[index];
    const targets = groundedCategoryRecoveryQueries(discovery, declaredReasoning, 20);
    if (targets.length === 0) continue;
    const umbrella = discovery.category?.pagetitle?.trim() ?? "";
    const umbrellaGrounded = significantTokens(umbrella).every((token) =>
      evidenceAffirmsToken(declaredReasoning, token)
    );
    const hasGroundedDistinctiveLeaf = targets.some((target) =>
      distinctiveLeafTokens(target, umbrella).length > 0
    );
    // `leafSupported()` deliberately treats a leaf identical to its umbrella
    // as harmless during an already-scoped search. Scope ranking is stricter:
    // an exact leaf cannot make an unrelated corrective discovery ground
    // itself; the umbrella must be affirmed by frozen intent evidence.
    if (!umbrellaGrounded && !hasGroundedDistinctiveLeaf) continue;
    const signature = [
      norm(umbrella),
      ...targets.map(norm).sort(),
    ].join("|");
    if (seen.has(signature)) continue;
    seen.add(signature);
    selected.push({ discovery, targets });
    if (selected.length >= Math.max(1, limit)) break;
  }
  return selected;
}

/** Keep terminal candidates inside taxonomy leaves explicitly grounded by the
 * consultant's reasoning. Every significant token of a target leaf must be
 * evidenced by the product title or its live leaf category. */
export function filterProductsByGroundedCategoryTargets<T extends { pagetitle: string; leaf_category?: string | null }>(
  products: T[],
  targets: string[],
  umbrella = "",
  declaredReasoning = "",
): T[] {
  const grounded = [...new Set((targets ?? []).map((target) => target.trim()).filter(Boolean))];
  if (grounded.length === 0) return [];
  const umbrellaTokens = significantTokens(umbrella);
  const targetTokenSets = grounded.map((target) => significantTokens(target));
  const umbrellaClassTokens = umbrellaTokens.filter((token) =>
    targetTokenSets.some((tokens) => tokens.some((candidate) => tokenMatches(token, candidate)))
  );
  const recurringTargetTokens = targetTokenSets[0]?.filter((token) =>
    targetTokenSets.slice(1).every((tokens) => tokens.some((candidate) => tokenMatches(token, candidate)))
  ) ?? [];
  const classTokens = umbrellaClassTokens.length > 0 ? umbrellaClassTokens : recurringTargetTokens;
  const distinctiveByTarget = grounded.map((target) =>
    significantTokens(target).filter((token) =>
      !classTokens.some((classToken) => tokenMatches(token, classToken))
    )
  );
  const hasDistinctiveTargets = distinctiveByTarget.some((tokens) => tokens.length > 0);
  return products.filter((product) => {
    if (product.leaf_category && declaredReasoning && !leafSupported(product.leaf_category, umbrella, declaredReasoning)) {
      return false;
    }
    const exactLeaf = norm(product.leaf_category ?? "");
    if (exactLeaf && grounded.some((target) => norm(target) === exactLeaf)) return true;
    const evidenceTokens = significantTokens(`${product.pagetitle} ${product.leaf_category ?? ""}`);
    const umbrellaMatched = classTokens.length === 0 || classTokens.every((token) =>
      evidenceTokens.some((candidate) => tokenMatches(token, candidate))
    );
    if (!umbrellaMatched) return false;
    if (!hasDistinctiveTargets) return true;
    return distinctiveByTarget.some((tokens) => tokens.some((token) =>
      evidenceTokens.some((candidate) => tokenMatches(token, candidate))
    ));
  });
}

/**
 * Last-resort query ladder for a failed multiword semantic query. Each token is
 * still only a hint; callers must require the same token in catalog evidence.
 */
export function groundedTokenRecoveryQueries(searchQuery: string, limit = 8): string[] {
  const tokens = significantTokens(searchQuery);
  return [...new Set(tokens)].slice(0, Math.max(1, limit));
}

export interface TokenRecoveryCandidate {
  query: string;
  total: number;
}

function transliterateRuToken(value: string): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
    и: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
    с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh",
    щ: "shch", ы: "y", э: "e", ю: "yu", я: "ya", ь: "", ъ: "",
  };
  return [...value].map((char) => map[char] ?? char).join("");
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (shorter.length === longer.length) {
    let mismatches = 0;
    for (let index = 0; index < shorter.length; index += 1) {
      if (shorter[index] !== longer[index] && ++mismatches > 1) return false;
    }
    return true;
  }
  let shortIndex = 0;
  let longIndex = 0;
  let skipped = false;
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex += 1;
      longIndex += 1;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    longIndex += 1;
  }
  return true;
}

/**
 * Exact normalized word evidence, plus a conservative transliteration match
 * for named series. The latter accepts only a one-character spelling gap in a
 * token of at least five characters (for example a doubled Latin consonant),
 * so prefixes inside unrelated title tokens still do not count. This is an
 * alphabetic rule derived from current evidence, not a product-name dictionary.
 */
export function titleContainsLiteralToken(title: string, token: string): boolean {
  const normalizedToken = norm(token);
  if (!normalizedToken || normalizedToken.includes(" ")) return false;
  const titleTokens = norm(title).split(" ");
  if (titleTokens.includes(normalizedToken)) return true;

  const transliteratedToken = transliterateRuToken(normalizedToken);
  if (transliteratedToken.length < 5 || !/^[a-z0-9]+$/u.test(transliteratedToken)) return false;
  return titleTokens.some((titleToken) => {
    const transliteratedTitle = transliterateRuToken(titleToken);
    return transliteratedTitle.length >= 5 &&
      /^[a-z0-9]+$/u.test(transliteratedTitle) &&
      transliteratedTitle[0] === transliteratedToken[0] &&
      transliteratedTitle.at(-1) === transliteratedToken.at(-1) &&
      editDistanceAtMostOne(transliteratedTitle, transliteratedToken);
  });
}

/** Keep only products whose title proves the current named series. */
export function filterProductsByNamedSeries<T extends { pagetitle: string }>(products: T[], seriesToken: string): T[] {
  return products.filter((product) => titleContainsLiteralToken(product.pagetitle, seriesToken));
}

/**
 * Select a literal title-token retry only when it is materially narrower than
 * the discovered category. This lets the consultant's own multiword canonical
 * query recover from catalog AND semantics without turning a generic token
 * into a broad substitution. No domain terms or translations live here.
 */
export function selectGroundedTokenRecoveryCandidate<T extends TokenRecoveryCandidate>(
  candidates: T[],
  categoryTotal: number,
): T | null {
  const normalizedCategoryTotal = Number.isFinite(categoryTotal) && categoryTotal > 0 ? categoryTotal : 0;
  const selectiveLimit = Math.max(50, Math.ceil(normalizedCategoryTotal * 0.1));
  return candidates.find(
    (candidate) => Number.isFinite(candidate.total) && candidate.total > 0 && candidate.total <= selectiveLimit,
  ) ?? null;
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
  const hasFacetScope = rest.options && typeof rest.options === "object" &&
    Object.keys(rest.options as Record<string, unknown>).length > 0;
  const nextArgs = kept.length === 0
    ? rest.mode === "by_filter" && !hasFacetScope && umbrella
      ? { ...rest, category: umbrella }
      : rest
    : kept.length === 1
    ? { ...rest, category: kept[0] }
    : { ...rest, category_in: kept };
  return { args: nextArgs, kept, dropped };
}
