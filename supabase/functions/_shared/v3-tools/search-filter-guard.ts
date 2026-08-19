// Pure guard for catalog facet filters.
//
// The model may suggest a real catalog value that the customer never requested
// (for example, a commercial/utility use class for a household fixture). Such a
// filter is syntactically valid and therefore dangerous: the catalog faithfully
// returns the wrong products. This guard only permits keys and canonical values
// from the latest discovery response, and only when the value is supported by
// the consultant's declared reasoning or the customer's wording. The customer's
// explicit negation always wins. Unproven filters are removed; the catalog can
// still search the discovered category and the evidence gate validates cards.

export interface SearchFacetValue {
  value: string;
}

export interface SearchFacet {
  key: string;
  caption?: string;
  values: SearchFacetValue[];
}

export interface DroppedSearchFilter {
  key: string;
  value: string;
  reason: "unknown_facet" | "unknown_value" | "not_declared_in_reasoning" | "negated_by_user";
}

export interface SearchFilterGuardResult {
  args: Record<string, unknown>;
  kept: Array<{ key: string; value: string }>;
  user_backed: Array<{ key: string; value: string }>;
  inferred: Array<{ key: string; value: string }>;
  subsumed: Array<{ key: string; value: string; by_key: string; by_value: string }>;
  dropped: DroppedSearchFilter[];
}

export interface BooleanFilterFallbackResult {
  args: Record<string, unknown>;
  removed: Array<{ key: string; value: string }>;
}

export interface ReplacementIdentityFilterResult {
  args: Record<string, unknown>;
  removed: Array<{ key: string; values: string[]; kind: "brand" | "model" }>;
}

function norm(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function replacementIdentityKind(facet: Pick<SearchFacet, "key" | "caption">): "brand" | "model" | null {
  const label = norm(`${facet.key} ${facet.caption ?? ""}`);
  if (/(?:^| )(?:brand|vendor|manufacturer|producer|trademark|бренд|производител\w*|торгов\w* марк\w*|марка)(?: |$)/u.test(label)) {
    return "brand";
  }
  if (/(?:^| )(?:model|series|collection|модел\w*|серия|серии|коллекц\w*)(?: |$)/u.test(label)) return "model";
  return null;
}

export function isReplacementIdentityFacet(facet: Pick<SearchFacet, "key" | "caption">): boolean {
  return replacementIdentityKind(facet) !== null;
}

/**
 * Find an explicitly named source model/series/collection in live facet
 * values. Brand values are intentionally excluded: a replacement may remain
 * within the same manufacturer, while the source product family must not be
 * offered back as its own analog.
 */
export function explicitReplacementModelValues(
  facets: SearchFacet[],
  userMessage: string,
): string[] {
  const evidence = ` ${norm(userMessage)} `;
  const found = new Set<string>();
  for (const facet of facets) {
    if (replacementIdentityKind(facet) !== "model") continue;
    for (const candidate of facet.values) {
      const value = norm(candidate.value);
      if (value && evidence.includes(` ${value} `)) found.add(candidate.value);
    }
  }
  return [...found];
}

function replacementIdentityHints(userMessage: string): string[] {
  const found = new Set<string>();
  for (const match of userMessage.matchAll(/\b\d{2,}(?:-\d{1,})+\b/gu)) found.add(match[0]);
  for (const match of userMessage.matchAll(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu)) {
    const raw = match[0];
    const compact = raw.replace(/[^\p{L}\p{N}]/gu, "");
    const hasLetter = /\p{L}/u.test(compact);
    const hasDigit = /\p{N}/u.test(compact);
    if (hasLetter && hasDigit && compact.length >= 5) found.add(raw);
    if (
      hasLetter &&
      !hasDigit &&
      compact.length >= 4 &&
      raw === raw.toLocaleUpperCase("ru") &&
      raw !== raw.toLocaleLowerCase("ru")
    ) found.add(raw);
  }
  for (const quoted of userMessage.matchAll(/[«"]([^»"]{2,})[»"]/gu)) found.add(quoted[1]);
  return [...found];
}

/**
 * Confirm source-family hints against the current catalog pool. A hint is an
 * identity only when it appears in some, but not all, titles: category and
 * functional tokens shared by every candidate cannot become exclusions.
 */
export function inferReplacementIdentityValues(
  userMessage: string,
  productTitles: string[],
): string[] {
  if (productTitles.length < 2) return [];
  return replacementIdentityHints(userMessage).filter((hint) => {
    const wanted = ` ${norm(hint)} `;
    if (!wanted.trim()) return false;
    const matches = productTitles.filter((title) => ` ${norm(title)} `.includes(wanted)).length;
    return matches > 0 && matches < productTitles.length;
  });
}

function explicitlyRequiresSameIdentity(userMessage: string, kind: "brand" | "model"): boolean {
  const text = norm(userMessage);
  if (kind === "brand") {
    return /(?:тот же бренд|такой же бренд|этот же бренд|того же бренда|тот же производитель|того же производителя|та же марка|той же марки|same brand|same manufacturer)/u.test(text);
  }
  return /(?:та же модель|той же модели|такую же модель|та же серия|той же серии|такой же серии|same model|same series)/u.test(text);
}

/**
 * An analog normally preserves functional characteristics, not the anchor's
 * identity. A model can repeat a brand/series value from the anchor title and
 * accidentally turn it into a hard catalog constraint. Remove such options
 * unless the customer explicitly asks for the same brand/model/series.
 */
export function dropImplicitReplacementIdentityFilters(
  args: Record<string, unknown>,
  facets: SearchFacet[],
  userMessage: string,
): ReplacementIdentityFilterResult {
  if (args.mode !== "by_filter" || !args.options || typeof args.options !== "object") {
    return { args, removed: [] };
  }
  const nextOptions: Record<string, unknown> = { ...(args.options as Record<string, unknown>) };
  const removed: ReplacementIdentityFilterResult["removed"] = [];
  for (const facet of facets) {
    const kind = replacementIdentityKind(facet);
    if (!kind || explicitlyRequiresSameIdentity(userMessage, kind) || nextOptions[facet.key] === undefined) continue;
    const values = Array.isArray(nextOptions[facet.key]) ? (nextOptions[facet.key] as unknown[]).map(String) : [];
    delete nextOptions[facet.key];
    removed.push({ key: facet.key, values, kind });
  }
  if (removed.length === 0) return { args, removed };
  const nextArgs = { ...args };
  if (Object.keys(nextOptions).length > 0) nextArgs.options = nextOptions;
  else delete nextArgs.options;
  return { args: nextArgs, removed };
}

export interface ReplacementIdentityProduct {
  pagetitle?: string | null;
  vendor?: string | null;
  short_traits?: string[] | null;
}

/**
 * Values removed from an analog search because they identify the source item
 * must also be excluded from recommendation cards. This closes the case where
 * the anchor SKU was not found first, so an ID-based anchor filter could not
 * protect the final render.
 */
export function productMatchesExcludedReplacementIdentity(
  product: ReplacementIdentityProduct,
  excludedValues: Iterable<string>,
): boolean {
  const evidence = norm([
    product.pagetitle ?? "",
    product.vendor ?? "",
    ...(product.short_traits ?? []),
  ].join(" "));
  if (!evidence) return false;
  return [...excludedValues]
    .map(norm)
    .filter(Boolean)
    .some((value) => ` ${evidence} `.includes(` ${value} `));
}

function codeNorm(value: string): string {
  return norm(value).replace(/\s+/g, "");
}

const RU_SUFFIXES = [
  "ыми", "ими", "ого", "его", "ому", "ему",
  "ая", "яя", "ое", "ее", "ой", "ей", "ом", "ем", "ую", "юю",
  "ый", "ий", "ые", "ие", "ых", "их", "ам", "ям", "ах", "ях", "ов", "ев",
  "у", "ю", "а", "я", "о", "е", "ы", "и",
];

function stemRu(word: string): string {
  if (word.length < 5) return word;
  for (const suffix of RU_SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

function tokensMatchByStem(left: string, right: string): boolean {
  if (left.length < 4 || right.length < 4) return false;
  const leftStem = stemRu(left);
  const rightStem = stemRu(right);
  const sharedLength = Math.min(leftStem.length, rightStem.length);
  if (sharedLength >= 4 && leftStem.slice(0, sharedLength) === rightStem.slice(0, sharedLength)) return true;
  // Common Russian noun→adjective derivation changes one final letter after
  // the same root (e.g. "медь" ↔ "медные"). Accept a single differing code
  // point only for equal stems with a stable 3-letter root.
  if (leftStem.length === rightStem.length && leftStem.length >= 4 && leftStem.slice(0, 3) === rightStem.slice(0, 3)) {
    let differences = 0;
    for (let index = 0; index < leftStem.length; index++) {
      if (leftStem[index] !== rightStem[index]) differences += 1;
    }
    if (differences === 1) return true;
  }
  return false;
}

function sameFacetValue(left: string, right: string): boolean {
  if (norm(left) === norm(right)) return true;
  return /\d/.test(left + right) && codeNorm(left) === codeNorm(right);
}

function evidenceStatus(value: string, userEvidence: string): "affirmed" | "negated" | "absent" {
  const wanted = norm(value);
  const evidence = norm(userEvidence);
  if (!wanted || !evidence) return "absent";

  const occurrences: number[] = [];
  let from = 0;
  while (from < evidence.length) {
    const index = evidence.indexOf(wanted, from);
    if (index < 0) break;
    occurrences.push(index);
    from = index + Math.max(1, wanted.length);
  }
  if (occurrences.length === 0) {
    const valueTokens = wanted.split(" ").filter((token) => token.length >= 4);
    const evidenceTokens = evidence.split(" ").filter((token) => token.length >= 4);
    if (
      valueTokens.length > 0 &&
      valueTokens.every((token) => evidenceTokens.some((candidate) => tokensMatchByStem(token, candidate)))
    ) {
      return "affirmed";
    }
    return "absent";
  }

  let sawNegated = false;
  for (const index of occurrences) {
    const prefix = evidence.slice(Math.max(0, index - 40), index).trim();
    const negated = /(?:^|\s)(?:не|без|кроме|исключая|никаких?)\s+(?:\S+\s+){0,2}$/u.test(prefix);
    if (!negated) return "affirmed";
    sawNegated = true;
  }
  return sawNegated ? "negated" : "absent";
}

function contradictedByUser(value: string, userEvidence: string): boolean {
  if (evidenceStatus(value, userEvidence) === "negated") return true;
  const valueTokens = new Set(norm(value).split(" ").filter((token) => token.length >= 3));
  const tokens = norm(userEvidence).split(" ").filter(Boolean);
  for (let index = 0; index < tokens.length; index++) {
    if (!["не", "без", "кроме", "исключая"].includes(tokens[index])) continue;
    const negatedWindow = tokens.slice(index + 1, index + 5);
    if (negatedWindow.some((token) => valueTokens.has(token))) return true;
  }
  return false;
}

function explicitlyAffirmedByUser(value: string, userEvidence: string): boolean {
  if (contradictedByUser(value, userEvidence)) return false;
  const isEvidenceToken = (token: string) => token.length >= 3 || /\d/.test(token) || /^[a-z]+$/u.test(token);
  const valueTokens = norm(value)
    .split(" ")
    .filter(isEvidenceToken);
  const evidenceTokens = norm(userEvidence)
    .split(" ")
    .filter(isEvidenceToken);
  if (valueTokens.length === 0 || evidenceTokens.length === 0) return false;
  return valueTokens.every((token) => evidenceTokens.some((candidate) => (
    token === candidate || tokensMatchByStem(token, candidate)
  )));
}

function significantValueTokens(value: string): string[] {
  return norm(value)
    .split(" ")
    .filter((token) => token.length >= 3 || /\d/.test(token))
    .map(stemRu);
}

function valueSubsumes(compound: string, narrower: string): boolean {
  const compoundTokens = significantValueTokens(compound);
  const narrowerTokens = significantValueTokens(narrower);
  if (compoundTokens.length <= narrowerTokens.length || narrowerTokens.length === 0) return false;
  return narrowerTokens.every((token) => compoundTokens.some((candidate) => (
    token === candidate || tokensMatchByStem(token, candidate)
  )));
}

const AFFIRMATIVE_VALUES = new Set(["да", "есть", "имеется", "присутствует", "yes", "true"]);
const NEGATIVE_VALUES = new Set(["нет", "отсутствует", "no", "false"]);

/**
 * Remove only affirmative filters from facets whose live vocabulary is
 * genuinely boolean. This is used after an empty strict search so products
 * with sparse boolean metadata can still be retrieved and then proven by the
 * criteria gate from their title/description. Negative requirements stay
 * strict: absence of evidence is not evidence of absence.
 */
export function dropAffirmativeBooleanFilters(
  args: Record<string, unknown>,
  facets: SearchFacet[],
): BooleanFilterFallbackResult {
  if (args.mode !== "by_filter" || !args.options || typeof args.options !== "object") {
    return { args, removed: [] };
  }
  const options = args.options as Record<string, unknown>;
  const nextOptions: Record<string, string[]> = {};
  const removed: Array<{ key: string; value: string }> = [];

  for (const [key, rawValues] of Object.entries(options)) {
    const values = Array.isArray(rawValues) ? rawValues.map(String).filter(Boolean) : [];
    const facet = facets.find((candidate) => candidate.key === key);
    const vocabulary = new Set((facet?.values ?? []).map((candidate) => norm(candidate.value)));
    // Sparse catalog booleans often expose only "да"; products without the
    // feature omit the facet entirely instead of storing "нет". A vocabulary
    // containing only boolean literals is therefore boolean even when one side
    // is absent.
    const isBooleanFacet = vocabulary.size > 0 &&
      [...vocabulary].every((value) => AFFIRMATIVE_VALUES.has(value) || NEGATIVE_VALUES.has(value));
    const removable = isBooleanFacet && values.length > 0 && values.every((value) => AFFIRMATIVE_VALUES.has(norm(value)));
    if (removable) {
      removed.push(...values.map((value) => ({ key, value })));
      continue;
    }
    if (values.length > 0) nextOptions[key] = values;
  }

  if (removed.length === 0) return { args, removed };
  const nextArgs = { ...args };
  if (Object.keys(nextOptions).length > 0) nextArgs.options = nextOptions;
  else delete nextArgs.options;
  return { args: nextArgs, removed };
}

export function guardSearchFilters(
  args: Record<string, unknown>,
  facets: SearchFacet[],
  declaredReasoning: string,
  userEvidence: string = declaredReasoning,
): SearchFilterGuardResult {
  if (args.mode !== "by_filter") {
    return { args, kept: [], user_backed: [], inferred: [], subsumed: [], dropped: [] };
  }

  const nextOptions: Record<string, string[]> = {};
  const kept: Array<{ key: string; value: string }> = [];
  const userBacked: Array<{ key: string; value: string }> = [];
  const inferred: Array<{ key: string; value: string }> = [];
  const subsumed: Array<{ key: string; value: string; by_key: string; by_value: string }> = [];
  const dropped: DroppedSearchFilter[] = [];
  const requestedOptions = args.options && typeof args.options === "object"
    ? args.options as Record<string, unknown>
    : {};

  for (const [key, rawValues] of Object.entries(requestedOptions)) {
    const values = Array.isArray(rawValues) ? rawValues.map(String).filter((v) => v.trim()) : [];
    const facet = facets.find((candidate) =>
      candidate.key === key || (candidate.caption && norm(candidate.caption) === norm(key))
    );
    if (!facet) {
      for (const value of values) dropped.push({ key, value, reason: "unknown_facet" });
      continue;
    }
    const canonicalKey = facet.key;

    for (const rawValue of values) {
      const canonical = facet.values.find((candidate) => sameFacetValue(candidate.value, rawValue))?.value;
      if (!canonical) {
        dropped.push({ key, value: rawValue, reason: "unknown_value" });
        continue;
      }
      if (contradictedByUser(canonical, userEvidence)) {
        dropped.push({ key, value: canonical, reason: "negated_by_user" });
        continue;
      }
      const status = evidenceStatus(canonical, declaredReasoning);
      if (status !== "affirmed") {
        dropped.push({
          key,
          value: canonical,
          reason: status === "negated" ? "negated_by_user" : "not_declared_in_reasoning",
        });
        continue;
      }
      nextOptions[canonicalKey] ??= [];
      if (!nextOptions[canonicalKey].includes(canonical)) nextOptions[canonicalKey].push(canonical);
      kept.push({ key: canonicalKey, value: canonical });
      if (explicitlyAffirmedByUser(canonical, userEvidence)) userBacked.push({ key: canonicalKey, value: canonical });
    }
  }

  // Complete, but never guess, facet filters that the customer stated
  // explicitly. LLM tool arguments are probabilistic and may omit one of the
  // constraints it correctly described (for example, household use while
  // retaining mounting type and a motion sensor). The live discovery result
  // is the vocabulary: add a missing facet only when exactly one canonical
  // value in that facet is evidenced by the customer's own words.
  //
  // Boolean labels such as "да"/"нет" are intentionally excluded: a generic
  // conversational "да" is not proof of an arbitrary boolean product facet.
  // Pure numbers are also excluded because a budget can accidentally equal an
  // unrelated wattage, length, or pack-size facet.
  for (const facet of facets) {
    if (nextOptions[facet.key]?.length) continue;
    // Brand/model/series values are identifiers, not product properties. Never
    // synthesize them by scanning free prose: short identifiers such as the
    // brand "Свет" collide with ordinary words ("общего света") and can turn
    // a broad valid request into a permanently empty catalog intersection.
    // An identity option is still accepted when the model explicitly supplies
    // it and the normal evidence checks above confirm it.
    if (isReplacementIdentityFacet(facet)) continue;
    const evidenced = facet.values.filter((candidate) => {
      const normalized = norm(candidate.value);
      if (!normalized || ["да", "нет", "есть", "отсутствует"].includes(normalized)) return false;
      if (!/[a-zа-я]/iu.test(normalized)) return false;
      return explicitlyAffirmedByUser(candidate.value, userEvidence);
    });
    if (evidenced.length !== 1) continue;
    const value = evidenced[0].value;
    nextOptions[facet.key] = [value];
    const item = { key: facet.key, value };
    kept.push(item);
    userBacked.push(item);
    inferred.push(item);
  }

  // A compound canonical value can already encode another explicit filter
  // ("Бытовые светильники накладные" includes mounting="накладной"). Sending
  // both to an inconsistent legacy catalog turns a valid request into an empty
  // intersection. Keep the richer value and remove only a strictly subsumed
  // option; the richer value remains an enforced render criterion.
  for (const [key, values] of Object.entries({ ...nextOptions })) {
    if (values.length === 0) continue;
    const covering = Object.entries(nextOptions).find(([otherKey, otherValues]) => (
      otherKey !== key && values.every((value) => otherValues.some((otherValue) => valueSubsumes(otherValue, value)))
    ));
    if (!covering) continue;
    const [byKey, byValues] = covering;
    for (const value of values) {
      const byValue = byValues.find((candidate) => valueSubsumes(candidate, value));
      if (byValue) subsumed.push({ key, value, by_key: byKey, by_value: byValue });
    }
    delete nextOptions[key];
    for (let index = kept.length - 1; index >= 0; index--) {
      if (kept[index].key === key) kept.splice(index, 1);
    }
    for (let index = inferred.length - 1; index >= 0; index--) {
      if (inferred[index].key === key) inferred.splice(index, 1);
    }
    for (let index = userBacked.length - 1; index >= 0; index--) {
      if (userBacked[index].key === key) userBacked.splice(index, 1);
    }
  }

  const nextArgs = { ...args };
  if (Object.keys(nextOptions).length > 0) nextArgs.options = nextOptions;
  else delete nextArgs.options;
  return { args: nextArgs, kept, user_backed: userBacked, inferred, subsumed, dropped };
}
