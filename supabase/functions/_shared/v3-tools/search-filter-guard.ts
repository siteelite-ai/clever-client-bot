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

import {
  extractClientQuantities,
  normalizeUnit,
} from "./criteria-consistency.ts";
import {
  canonicalMeasurementUnit,
  extractReasoningBounds,
} from "./criteria-reasoning.ts";
import { extractPostNominalCatalogQualifier } from "./declared-alias-contract.ts";
import {
  resolveAbbreviatedNumericFacetValueEvidence,
  resolveCompactFacetCodeEvidence,
  resolveCompoundFacetValueEvidence,
} from "./compact-facet-code.ts";
import { isAdministrativeCatalogField } from "./catalog-field-policy.ts";
import { customerOwnsIdentityValue } from "./identity-provenance.ts";
import {
  customerOwnsAbsentFacetValue,
  isAbsenceOrUnknownFacetValue,
} from "./facet-value-semantics.ts";

export interface SearchFacetValue {
  value: string;
}

export interface SearchFacet {
  key: string;
  caption?: string;
  unit?: string | null;
  values: SearchFacetValue[];
}

export interface DroppedSearchFilter {
  key: string;
  value: string;
  reason:
    | "unknown_facet"
    | "unknown_value"
    | "not_declared_in_reasoning"
    | "negated_by_user"
    | "non_atomic_value"
    | "unit_conflict";
}

export interface SearchFilterGuardResult {
  args: Record<string, unknown>;
  /** A model-owned by_query appearance claim needs a verified broad browse. */
  requiresBroadBrowse: boolean;
  kept: Array<{ key: string; value: string }>;
  user_backed: Array<{ key: string; value: string }>;
  inferred: Array<{ key: string; value: string }>;
  subsumed: Array<
    { key: string; value: string; by_key: string; by_value: string }
  >;
  dropped: DroppedSearchFilter[];
}

export interface SearchFilterInferencePolicy {
  /** Keep validated options but do not infer a new per-card numeric facet. */
  allowDerivedNumericFacetInference?: boolean;
  /**
   * Structured reasoning already carries a machine-readable declaration.
   * When it is present, free prose may explain the choice but must not invent
   * an additional hidden catalog filter that the declaration did not own.
   */
  allowProseOnlyFacetInference?: boolean;
  /** Values already proved from the customer's request before model reasoning. */
  authoritativeFacetValues?: FacetValueEvidence[];
  /** The current customer turn, never the accumulated conversation history. */
  currentUserMessage?: string;
  /** Product target established by server state, not args.category or model prose. */
  trustedActiveProductTarget?: string | null;
  /** Previously confirmed customer request, only when it is the active selection. */
  trustedBaseUserMessage?: string | null;
}

export interface FacetValueEvidence {
  key: string;
  value: string;
}

/**
 * Merge a short attribute continuation with the previously proven selection.
 * A value in the current turn replaces every older value on the same live
 * facet; values on other facets remain binding. This is category-neutral and
 * depends only on live facet keys, never on colour/product dictionaries.
 */
export function mergeFacetValuesWithCurrentOverrides(
  inherited: FacetValueEvidence[],
  current: FacetValueEvidence[],
): FacetValueEvidence[] {
  const overriddenKeys = new Set(current.map(({ key }) => key));
  return [
    ...inherited.filter(({ key }) => !overriddenKeys.has(key)),
    ...current,
  ]
    .filter((item, index, all) =>
      all.findIndex((candidate) =>
        candidate.key === item.key && candidate.value === item.value
      ) === index
    );
}

export interface ReasoningFacetProjection {
  kept: Array<{ key: string; value: string }>;
  user_backed: Array<{ key: string; value: string }>;
}

/**
 * Compile an explicit compact customer code into canonical live facet values.
 * The shared resolver requires one unique full-code decomposition across at
 * least two distinct axes. Conflicting codes for the same axis fail closed;
 * model prose is deliberately absent from this proof path.
 */
export function projectExplicitCompactFacetValues(
  facets: SearchFacet[],
  userMessage: string,
): ReasoningFacetProjection {
  const resolved = resolveCompactFacetCodeEvidence(userMessage, facets)
    .flatMap(({ axes }) => axes.map(({ key, value }) => ({ key, value })));
  resolved.push(
    ...resolveCompoundFacetValueEvidence(userMessage, facets)
      .map(({ axis }) => ({ key: axis.key, value: axis.value })),
  );
  resolved.push(
    ...resolveAbbreviatedNumericFacetValueEvidence(userMessage, facets)
      .map(({ axis }) => ({ key: axis.key, value: axis.value })),
  );
  const valuesByKey = new Map<string, Set<string>>();
  for (const { key, value } of resolved) {
    const values = valuesByKey.get(key) ?? new Set<string>();
    values.add(value);
    valuesByKey.set(key, values);
  }
  if ([...valuesByKey.values()].some((values) => values.size !== 1)) {
    return { kept: [], user_backed: [] };
  }
  const kept = [...valuesByKey].map(([key, values]) => ({
    key,
    value: [...values][0],
  }));
  return { kept, user_backed: kept.map((item) => ({ ...item })) };
}

export interface BooleanFilterFallbackResult {
  args: Record<string, unknown>;
  removed: Array<{ key: string; value: string }>;
}

/** A customer-owned scalar/cardinality requirement compiled by the visible
 * request boundary. Keeping this as a structural interface avoids coupling
 * the facet guard to any product vocabulary. */
export interface ExplicitVisibleRequirement {
  op?: "eq" | "min" | "max";
  value?: string | number;
  unit?: string;
  matches: (evidence: string) => boolean;
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

function replacementIdentityKind(
  facet: Pick<SearchFacet, "key" | "caption">,
): "brand" | "model" | null {
  const label = norm(`${facet.key} ${facet.caption ?? ""}`);
  if (
    /(?:^| )(?:brand|vendor|manufacturer|producer|trademark|бренд|производител\p{L}*|торгов\p{L}* марк\p{L}*|марка)(?: |$)/u
      .test(label)
  ) {
    return "brand";
  }
  if (
    /(?:^| )(?:model|series|collection|модел\p{L}*|сери\p{L}*|коллекц\p{L}*)(?: |$)/u
      .test(label)
  ) return "model";
  return null;
}

export function isReplacementIdentityFacet(
  facet: Pick<SearchFacet, "key" | "caption">,
): boolean {
  return replacementIdentityKind(facet) !== null;
}

/**
 * Resolves an omitted brand/series filter only from a structural relation in
 * the customer's request: the identity immediately follows the discovered
 * product class. A canonical live value may extend that token, but it must be
 * the only matching identity value. This prevents free-prose brand collisions.
 */
export function explicitPostNominalIdentityFacet(
  facets: SearchFacet[],
  userMessage: string,
  discoveredClass: string,
): { key: string; value: string } | null {
  const qualifier = extractPostNominalCatalogQualifier(
    userMessage,
    discoveredClass,
  );
  const wanted = norm(qualifier ?? "");
  if (!wanted) return null;
  const matches = facets.flatMap((facet) => {
    if (!isReplacementIdentityFacet(facet)) return [];
    return facet.values.flatMap(({ value }) => {
      const canonical = norm(value);
      if (
        !canonical ||
        !(canonical === wanted || canonical.startsWith(`${wanted} `)) ||
        !customerOwnsIdentityValue({
          facetLabel: `${facet.key} ${facet.caption ?? ""}`,
          value,
          userMessage,
          categoryLabel: discoveredClass,
        })
      ) return [];
      return [{ key: facet.key, value }];
    });
  });
  return matches.length === 1 ? matches[0] : null;
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

/** Explicit source brand/model/series values to exclude from ordinary analogs. */
export function explicitReplacementIdentityValues(
  facets: SearchFacet[],
  userMessage: string,
): string[] {
  const evidence = ` ${norm(userMessage)} `;
  const found = new Set<string>();
  for (const facet of facets) {
    const kind = replacementIdentityKind(facet);
    if (!kind || explicitlyRequiresSameIdentity(userMessage, kind)) continue;
    for (const candidate of facet.values) {
      const value = norm(candidate.value);
      if (value && evidence.includes(` ${value} `)) found.add(candidate.value);
    }
  }
  return [...found];
}

function replacementIdentityHints(userMessage: string): string[] {
  const found = new Set<string>();
  for (const match of userMessage.matchAll(/\b\d{2,}(?:-\d{1,})+\b/gu)) {
    found.add(match[0]);
  }
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
  for (const quoted of userMessage.matchAll(/[«"]([^»"]{2,})[»"]/gu)) {
    found.add(quoted[1]);
  }
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
    const matches = productTitles.filter((title) =>
      ` ${norm(title)} `.includes(wanted)
    ).length;
    return matches > 0 && matches < productTitles.length;
  });
}

function explicitlyRequiresSameIdentity(
  userMessage: string,
  kind: "brand" | "model",
): boolean {
  const text = norm(userMessage);
  if (kind === "brand") {
    return /(?:тот же бренд|такой же бренд|этот же бренд|того же бренда|тот же производитель|того же производителя|та же марка|той же марки|same brand|same manufacturer)/u
      .test(text);
  }
  return /(?:та же модель|той же модели|такую же модель|та же серия|той же серии|такой же серии|same model|same series)/u
    .test(text);
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
  if (
    args.mode !== "by_filter" || !args.options ||
    typeof args.options !== "object"
  ) {
    return { args, removed: [] };
  }
  const nextOptions: Record<string, unknown> = {
    ...(args.options as Record<string, unknown>),
  };
  const removed: ReplacementIdentityFilterResult["removed"] = [];
  for (const facet of facets) {
    const kind = replacementIdentityKind(facet);
    if (
      !kind || explicitlyRequiresSameIdentity(userMessage, kind) ||
      nextOptions[facet.key] === undefined
    ) continue;
    const values = Array.isArray(nextOptions[facet.key])
      ? (nextOptions[facet.key] as unknown[]).map(String)
      : [];
    delete nextOptions[facet.key];
    removed.push({ key: facet.key, values, kind });
  }
  if (removed.length === 0) return { args, removed };
  const nextArgs = { ...args };
  if (Object.keys(nextOptions).length > 0) nextArgs.options = nextOptions;
  else delete nextArgs.options;
  return { args: nextArgs, removed };
}

export function dropImplicitReplacementIdentityCriteria<
  T extends { key: string },
>(
  criteria: T[],
  facets: SearchFacet[],
  userMessage: string,
): { criteria: T[]; removed: T[] } {
  const kept: T[] = [];
  const removed: T[] = [];
  for (const criterion of criteria) {
    const criterionLabel = norm(criterion.key);
    const facet = facets.find((candidate) => {
      const key = norm(candidate.key);
      const caption = norm(candidate.caption ?? "");
      return criterionLabel === key || criterionLabel === caption ||
        Boolean(
          criterionLabel && caption &&
            (criterionLabel.includes(caption) ||
              caption.includes(criterionLabel)),
        );
    });
    const kind = facet
      ? replacementIdentityKind(facet)
      : replacementIdentityKind({ key: criterion.key, caption: criterion.key });
    if (kind && !explicitlyRequiresSameIdentity(userMessage, kind)) {
      removed.push(criterion);
    } else kept.push(criterion);
  }
  return { criteria: kept, removed };
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
  const lookalikes: Record<string, string> = {
    а: "a",
    в: "b",
    е: "e",
    к: "k",
    м: "m",
    н: "h",
    о: "o",
    р: "p",
    с: "c",
    т: "t",
    у: "y",
    х: "x",
  };
  return norm(value)
    .replace(/[авекмнорстух]/gu, (char) => lookalikes[char] ?? char)
    .replace(/\s+/g, "");
}

const RU_SUFFIXES = [
  "ыми",
  "ими",
  "ого",
  "его",
  "ому",
  "ему",
  "ая",
  "яя",
  "ое",
  "ее",
  "ой",
  "ей",
  "ом",
  "ем",
  "ую",
  "юю",
  "ый",
  "ий",
  "ые",
  "ие",
  "ых",
  "их",
  "ам",
  "ям",
  "ах",
  "ях",
  "ов",
  "ев",
  "у",
  "ю",
  "а",
  "я",
  "о",
  "е",
  "ы",
  "и",
];
const RU_ADJECTIVE_SUFFIXES = [
  "ыми",
  "ими",
  "ого",
  "его",
  "ому",
  "ему",
  "ая",
  "яя",
  "ое",
  "ее",
  "ой",
  "ей",
  "ом",
  "ем",
  "ую",
  "юю",
  "ый",
  "ий",
  "ые",
  "ие",
  "ых",
  "их",
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
  if (
    sharedLength >= 4 &&
    leftStem.slice(0, sharedLength) === rightStem.slice(0, sharedLength)
  ) return true;
  // Short adjective roots are common in live facet values (`белый` →
  // `белые`). Accept a three-letter root only when both words have an
  // explicit adjective ending and reduce to the exact same root. This remains
  // morphological rather than a product/colour dictionary and cannot match a
  // neighbouring noun merely because its first three letters coincide.
  if (
    leftStem === rightStem &&
    leftStem.length >= 3 &&
    RU_ADJECTIVE_SUFFIXES.some((suffix) => left.endsWith(suffix)) &&
    RU_ADJECTIVE_SUFFIXES.some((suffix) => right.endsWith(suffix))
  ) return true;
  // A previous generic "one changed letter" rule treated unrelated neighbours
  // such as `свет` and `свеча` as the same root. Preserve only the
  // structurally identifiable soft-sign noun → -н- adjective transition
  // (`медь` ↔ `медный`); arbitrary substitutions are not evidence.
  if (
    leftStem.length === rightStem.length &&
    leftStem.length >= 4 &&
    leftStem.slice(0, -1) === rightStem.slice(0, -1)
  ) {
    const endings = new Set([leftStem.at(-1), rightStem.at(-1)]);
    if (endings.has("ь") && endings.has("н")) return true;
  }
  return false;
}

/** Prevent a model from reusing a customer's exact scalar under another
 * physical unit. The rule is dimension-agnostic: it compares only canonical
 * units exposed by the live facet with explicit number+unit pairs in the
 * customer's own text. Different computed values remain valid. */
function numericFacetValueConflictsWithUserMeasurement(
  value: string,
  facet: SearchFacet,
  userEvidence: string,
  declaredEvidence: string = userEvidence,
): boolean {
  const exactNumber = norm(value).match(/^\d+(?:[.,]\d+)?$/u)?.[0];
  if (!exactNumber) return false;
  const scalar = Number(exactNumber.replace(",", "."));
  if (!Number.isFinite(scalar)) return false;
  const expectedUnits = new Set(
    [
      facet.unit ?? "",
      ...String(facet.caption ?? "").split(",").slice(1)
        .flatMap((suffix) => suffix.match(/[a-zа-я°]{1,10}[²³]?\d?/giu) ?? []),
    ].map(canonicalMeasurementUnit).filter(Boolean),
  );
  const sameScalar = extractClientQuantities(userEvidence)
    .filter((quantity) => quantity.value === scalar);
  if (sameScalar.length === 0) return false;
  // A scalar that the customer supplied only as a physical measurement may
  // not be projected onto an unlabelled/unitless catalog axis. Otherwise a
  // nearby product word can relabel `25 m²` as `25 LEDs`, poles, pieces, etc.
  // Genuine unitless counts remain available because they are not returned by
  // extractClientQuantities unless the number is followed by a measurement.
  if (expectedUnits.size === 0) {
    const facetTokens = norm(facet.caption ?? facet.key).split(" ").filter((
      token,
    ) => token.length >= 3);
    const declaredUnitNamesTheFacet = extractClientQuantities(declaredEvidence)
      .filter((quantity) => quantity.value === scalar)
      .some((quantity) => {
        const unit = norm(quantity.unit);
        return facetTokens.some((token) =>
          token === unit || tokensMatchByStem(token, unit)
        );
      });
    return !facetMeaningIsFullyEvidenced(facet, declaredEvidence) &&
      !declaredUnitNamesTheFacet;
  }
  return sameScalar.every((quantity) =>
    !expectedUnits.has(canonicalMeasurementUnit(quantity.unit))
  );
}

function sameFacetValue(left: string, right: string): boolean {
  if (norm(left) === norm(right)) return true;
  return /\d/.test(left + right) && codeNorm(left) === codeNorm(right);
}

function visibleRequirementAuthorizesFacetValue(
  facet: SearchFacet,
  value: string,
  requirements: ExplicitVisibleRequirement[],
): boolean {
  const canonical = norm(value);
  if (!canonical) return false;
  const evidence = `${facet.caption || facet.key}: ${value}${
    facet.unit ? ` ${facet.unit}` : ""
  }`;
  return requirements.some((requirement) =>
    requirement?.op === "eq" &&
    requirement.value !== undefined &&
    sameFacetValue(String(requirement.value), value) &&
    requirement.matches(evidence)
  );
}

/**
 * A selectable facet value represents one product property. Search-keyword
 * dumps and other list-like metadata are sometimes exposed by the legacy
 * catalog as facets too; accepting them lets candidate-card content become a
 * self-reinforcing filter. Keep the boundary structural and vocabulary-free.
 */
function isAtomicFacetValue(value: string): boolean {
  const text = String(value ?? "").trim();
  if (!text || text.length > 240) return false;
  const commaParts = text.split(",").map((part) => part.trim()).filter(Boolean);
  return commaParts.length <= 5;
}

function evidenceStatus(
  value: string,
  userEvidence: string,
): "affirmed" | "negated" | "absent" {
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
    const structuralTokens = new Set([
      "для",
      "или",
      "and",
      "or",
      "with",
      "без",
      "при",
      "под",
      "над",
      "тип",
      "вида",
      "вид",
      "класс",
      "серия",
      "вариант",
    ]);
    const valueTokens = wanted.split(" ").filter((token) =>
      !structuralTokens.has(token) && (token.length >= 3 || /\d/u.test(token))
    );
    const evidenceTokens = evidence.split(" ").filter((token) =>
      !structuralTokens.has(token) && (token.length >= 3 || /\d/u.test(token))
    );
    if (
      valueTokens.length > 0 &&
      valueTokens.every((token) =>
        evidenceTokens.some((candidate) => tokensMatchByStem(token, candidate))
      )
    ) {
      return "affirmed";
    }
    return "absent";
  }

  let sawNegated = false;
  for (const index of occurrences) {
    const prefix = evidence.slice(Math.max(0, index - 40), index).trim();
    const negated =
      /(?:^|\s)(?:не|без|кроме|исключая|никаких?)\s+(?:\S+\s+){0,2}$/u.test(
        prefix,
      );
    if (!negated) return "affirmed";
    sawNegated = true;
  }
  return sawNegated ? "negated" : "absent";
}

function contradictedByUser(value: string, userEvidence: string): boolean {
  if (evidenceStatus(value, userEvidence) === "negated") return true;
  const valueTokens = new Set(
    norm(value).split(" ").filter((token) => token.length >= 3),
  );
  const tokens = norm(userEvidence).split(" ").filter(Boolean);
  for (let index = 0; index < tokens.length; index++) {
    if (!["не", "без", "кроме", "исключая"].includes(tokens[index])) continue;
    const negatedWindow = tokens.slice(index + 1, index + 5);
    if (negatedWindow.some((token) => valueTokens.has(token))) return true;
  }
  return false;
}

function explicitlyAffirmedByUser(
  value: string,
  userEvidence: string,
): boolean {
  if (contradictedByUser(value, userEvidence)) return false;
  const normalizedValue = norm(value);
  // Mixed-script technical markings are common in human input (`E27`/`Е27`,
  // `C16`/`С16`). Treat only values containing both a letter and a digit as
  // portable codes, then compare their compact visual forms. Ordinary words
  // continue through the stricter token/morphology path below.
  if (/\p{L}/u.test(normalizedValue) && /\d/u.test(normalizedValue)) {
    const wanted = codeNorm(value);
    const evidenceCodes = String(userEvidence ?? "")
      .match(/[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu)
      ?.map(codeNorm) ?? [];
    if (wanted && evidenceCodes.includes(wanted)) return true;
  }
  const isEvidenceToken = (token: string) =>
    token.length >= 3 || /\d/.test(token) || /^[a-z]+$/u.test(token);
  const valueTokens = norm(value)
    .split(" ")
    .filter(isEvidenceToken);
  const evidenceTokens = norm(userEvidence)
    .split(" ")
    .filter(isEvidenceToken);
  if (valueTokens.length === 0 || evidenceTokens.length === 0) return false;
  return valueTokens.every((token) =>
    evidenceTokens.some((candidate) => (
      token === candidate || tokensMatchByStem(token, candidate)
    ))
  );
}

function facetValueAppearsOnlyAsMeasurementNoun(
  value: string,
  userEvidence: string,
): boolean {
  const valueTokens = norm(value).split(" ").filter(Boolean);
  if (valueTokens.length !== 1 || /\d/u.test(valueTokens[0])) return false;
  const evidenceTokens = norm(userEvidence).split(" ").filter(Boolean);
  const matches: number[] = [];
  for (const [index, token] of evidenceTokens.entries()) {
    if (token === valueTokens[0] || tokensMatchByStem(token, valueTokens[0])) {
      matches.push(index);
    }
  }
  return matches.length > 0 &&
    matches.every((index) =>
      index > 0 && /^\d+(?:[.,]\d+)?$/u.test(evidenceTokens[index - 1])
    );
}

/**
 * Shape, style and design are customer preferences, not engineering facts
 * that the consultant can derive from a room or an application. Recognize
 * the axis through live facet metadata, not through product-specific terms.
 * Other facets (for example mounting or IP protection) retain their existing
 * reasoning-based completion rules.
 */
function isAppearanceFacet(facet: SearchFacet): boolean {
  return norm(`${facet.key} ${facet.caption ?? ""}`).split(" ").some((token) =>
    /^(?:shape|style|design|appearance|form|forma|форм[аыуе]|формой|стил[ьяюеи]|стилем|дизайн[а-я]*|внешн[а-я]*)$/u
      .test(token)
  );
}

export interface AppearanceEvidenceScope {
  /** Never supply merged customer history here. */
  currentUserMessage: string;
  /** Only a target already established by the server may resolve ellipsis. */
  trustedActiveProductTarget?: string | null;
  /** An active, server-confirmed base request; arbitrary history is not proof. */
  trustedBaseUserMessage?: string | null;
}

export interface CustomerAppearanceFacetInput extends AppearanceEvidenceScope {
  facet: SearchFacet;
  value: string;
}

const APPEARANCE_AXIS_WORD =
  /^(?:shape|style|design|appearance|form|forma|форм(?:а|ы|е|у|ой|ою|ам|ами|ах)?|стил(?:ь|я|ю|ем|е|и|ей|ями|ях)?|дизайн\p{L}*|внешн\p{L}*)$/u;
const REQUEST_WORD =
  /^(?:нуж\p{L}*|ищ\p{L}*|хоч\p{L}*|найд\p{L}*|подбер\p{L}*|подбира\p{L}*|подобра\p{L}*|покаж\p{L}*|показы\p{L}*|предлож\p{L}*|дай|дайте|давайте|looking|want|need|find|show)$/u;
const RELATION_PREPOSITION =
  /^(?:для|в|во|на|под|над|к|ко|у|с|со|из|около|возле|при|вместо|for|in|to|with)$/u;
const ELLIPTICAL_FOLLOWER =
  /^(?:есть|бывает|найдется|найдутся|имеется|будет|будут|ли|же|а|или|для|в|на|под|пожалуйста|please|available)$/u;
const ELLIPTICAL_PREFIX =
  /^(?:а|ну|так|тогда|именно|только|пожалуйста|мне|у|вас|есть|ли|же|можно|давайте|please)$/u;
const NEGATIVE_DEMAND =
  /^(?:надо|подход\p{L}*|устраива\p{L}*|интересу\p{L}*)$/u;
const SOURCE_PRODUCT_QUALIFIER =
  /^(?:стар\p{L}*|прежн\p{L}*|нынешн\p{L}*|текущ\p{L}*|имеющ\p{L}*|установлен\p{L}*)$/u;
const REPLACEMENT_FOLLOWER = /^(?:взамен|вместо|друг\p{L}*)$/u;
const REPLACEMENT_VERB = /^(?:замен\p{L}*|поменя\p{L}*)$/u;
const AXIS_PREDICATE_WORD =
  /^(?:должн\p{L}*|обязательн\p{L}*|нужн\p{L}*|быть|будет|пусть|хоч\p{L}*)$/u;

function appearanceWordMatches(left: string, right: string): boolean {
  if (left === right) return true;
  const leftStem = stemRu(left);
  const rightStem = stemRu(right);
  if (leftStem.length >= 3 && leftStem === rightStem) return true;
  // Generic facet evidence tolerates shared prefixes, but appearance values
  // cannot: a catalog shape `круг` must not match a model name `Круговорот`.
  // A distinct stem is accepted only as a derived adjective (`овал` →
  // `овальная`, `классика` → `классическая`).
  const isAdjective = (word: string) =>
    RU_ADJECTIVE_SUFFIXES.some((suffix) => word.endsWith(suffix));
  const derivesAdjective = (noun: string, adjective: string) => {
    if (!isAdjective(adjective)) return false;
    const nounStem = stemRu(noun);
    const adjectiveStem = stemRu(adjective);
    if (nounStem.length < 4) return false;
    const possibleStems = ["л", "н", "ов", "ев", "ск"]
      .map((suffix) => `${nounStem}${suffix}`);
    if (nounStem.endsWith("л")) possibleStems.push(`${nounStem}ьн`);
    // The productive -ика → -ическая transition is morphological, not a
    // hard-coded style name.
    if (noun.endsWith("ика") && noun.length >= 7) {
      possibleStems.push(`${noun.slice(0, -3)}ическ`);
    }
    return possibleStems.includes(adjectiveStem);
  };
  return derivesAdjective(left, right) || derivesAdjective(right, left);
}

function appearanceClauses(text: string): string[][] {
  return String(text ?? "")
    .split(/[\n.!?;,]+/u)
    .map((clause) => norm(clause).split(" ").filter(Boolean))
    .flatMap((tokens) => {
      const clauses: string[][] = [];
      let start = 0;
      for (let index = 1; index < tokens.length; index++) {
        if (
          !["и", "а", "но"].includes(tokens[index]) ||
          !(
            REQUEST_WORD.test(tokens[index + 1] ?? "") ||
            (tokens[index + 1] === "не" &&
              REQUEST_WORD.test(tokens[index + 2] ?? ""))
          )
        ) continue;
        clauses.push(tokens.slice(start, index));
        start = index + 1;
      }
      clauses.push(tokens.slice(start));
      return clauses.filter((part) => part.length > 0);
    });
}

function appearanceTargetWords(facet: SearchFacet): string[] {
  return norm(facet.caption ?? "")
    .split(" ")
    .filter((token) => token.length >= 4 && !APPEARANCE_AXIS_WORD.test(token));
}

function appearanceValueAt(
  tokens: string[],
  start: number,
  valueTokens: string[],
): boolean {
  return valueTokens.length > 0 &&
    valueTokens.every((valueToken, offset) =>
      tokens[start + offset] !== undefined &&
      appearanceWordMatches(valueToken, tokens[start + offset])
    );
}

function isAppearanceRequestTarget(
  tokens: string[],
  targetWords: string[],
): boolean {
  return tokens.some((token, index) =>
    targetWords.some((target) => appearanceWordMatches(target, token)) &&
    tokens.slice(Math.max(0, index - 5), index).some((previous) =>
      REQUEST_WORD.test(previous)
    )
  );
}

function appearanceRequestObject(tokens: string[]): string | null {
  const requestIndex = tokens.findIndex((token) => REQUEST_WORD.test(token));
  if (requestIndex < 0) return null;
  const boundary = tokens.findIndex((token, index) =>
    index > requestIndex && RELATION_PREPOSITION.test(token)
  );
  const objectPhrase = tokens.slice(
    requestIndex + 1,
    boundary < 0 ? undefined : boundary,
  );
  return objectPhrase.filter((token) =>
    token.length >= 3 && !APPEARANCE_AXIS_WORD.test(token) &&
    !RU_ADJECTIVE_SUFFIXES.some((suffix) => token.endsWith(suffix)) &&
    !REQUEST_WORD.test(token) && token !== "мне" && token !== "именно"
  ).at(-1) ?? null;
}

function appearanceValueIsCancelledInText(
  facet: SearchFacet,
  value: string,
  text: string,
): boolean {
  const valueTokens = norm(value).split(" ").filter(Boolean);
  const targetWords = appearanceTargetWords(facet);
  const clauses = appearanceClauses(text);
  return clauses.some((tokens, clauseIndex) =>
    tokens.some((token, index) => {
      if (!appearanceValueAt(tokens, index, valueTokens)) return false;
      const valueEnd = index + valueTokens.length;
      const hasLaterRequest = tokens.slice(valueEnd).some((candidate) =>
        REQUEST_WORD.test(candidate)
      ) || clauses.slice(clauseIndex + 1).some((laterClause) =>
        laterClause.some((candidate) =>
          REQUEST_WORD.test(candidate)
        )
      );
      if (
        appearanceValueDescribesSource(
          tokens,
          index,
          valueEnd,
          targetWords,
          hasLaterRequest,
        )
      ) return false;
      // «Не для круглого зала» negates an application/complement, not the
      // appearance of the product requested in another clause. Match the
      // adjective's local referent before treating nearby «не» as withdrawal.
      const referent = tokens[valueEnd] ?? "";
      if (
        RELATION_PREPOSITION.test(tokens[index - 1] ?? "") &&
        referent && !APPEARANCE_AXIS_WORD.test(referent) &&
        !targetWords.some((target) =>
          appearanceWordMatches(target, referent)
        )
      ) return false;
      if (
        tokens.slice(Math.max(0, index - 2), index).some((previous) =>
          previous === "не" || previous === "без" ||
          previous === "кроме" || previous === "исключая"
        )
      ) {
        return true;
      }
      // Negation of the demand can precede or follow the product phrase:
      // «не хочу люстру круглую», «круглая люстра не нужна».
      return tokens.some((candidate, candidateIndex) =>
        tokens[candidateIndex - 1] === "не" &&
        (REQUEST_WORD.test(candidate) || NEGATIVE_DEMAND.test(candidate))
      );
    })
  );
}

function appearanceReferentIsProduct(
  referent: string,
  targetWords: string[],
  requestObject: string | null,
  trustedActiveProductTarget: string | null,
): boolean {
  const trustedWords = norm(trustedActiveProductTarget ?? "")
    .split(" ").filter((token) => token.length >= 4);
  return [
    ...targetWords,
    ...trustedWords,
    ...(requestObject ? [requestObject] : []),
  ]
    .some((target) => appearanceWordMatches(target, referent));
}

function nearestAppearanceReferent(
  tokens: string[],
  before: number,
): string | null {
  for (let index = before - 1; index >= 0; index--) {
    const token = tokens[index];
    if (
      RELATION_PREPOSITION.test(token) ||
      APPEARANCE_AXIS_WORD.test(token) ||
      REQUEST_WORD.test(token) ||
      ELLIPTICAL_PREFIX.test(token) ||
      token === "не" || token === "без" ||
      RU_ADJECTIVE_SUFFIXES.some((suffix) => token.endsWith(suffix))
    ) continue;
    return token;
  }
  return null;
}

/** A user's description of the existing item is not a desired appearance.
 * Role is determined by request grammar (possession, old/current qualifiers,
 * and the source object of "replace X with Y"), not by fixture vocabulary. */
function appearanceValueDescribesSource(
  tokens: string[],
  valueIndex: number,
  valueEnd: number,
  targetWords: string[],
  hasLaterRequest = false,
): boolean {
  const before = tokens.slice(0, valueIndex);
  const requestIndex = before.findLastIndex((token) =>
    REQUEST_WORD.test(token)
  );
  const possessionIndex = before.findLastIndex((token, index) =>
    token === "у" && tokens[index + 1] === "меня" ||
    /^(?:мо[йяеию]|моего|моей|моими)$/u.test(token)
  );
  if (possessionIndex >= 0 && requestIndex < possessionIndex) return true;
  // «Есть круглая люстра, хочу овальную»: a declarative inventory phrase
  // before a new request describes the current item. A standalone
  // availability question («Есть круглая люстра?») remains a target request.
  if (
    hasLaterRequest && requestIndex < 0 &&
    before.includes("есть")
  ) return true;

  const replacementIndex = before.findLastIndex((token) =>
    REPLACEMENT_VERB.test(token)
  );
  if (
    replacementIndex >= 0 &&
    !before.slice(replacementIndex + 1).includes("на")
  ) return true;

  const nearbySourceQualifier = before.slice(Math.max(0, valueIndex - 4))
    .some((token) => SOURCE_PRODUCT_QUALIFIER.test(token));
  if (!nearbySourceQualifier) return false;
  return tokens.slice(Math.max(0, valueIndex - 3), valueEnd + 2)
    .some((token) =>
      targetWords.some((target) => appearanceWordMatches(target, token))
    );
}

/**
 * Prove the *referent* of a live appearance value in one text source. Word
 * stems alone are insufficient: «круглый зал» and «форма зала круглая» do
 * not select a round chandelier. We use local grammar and the live facet's
 * product noun, never an enumerated product or appearance-value dictionary.
 */
function appearanceClaimInText(
  facet: SearchFacet,
  value: string,
  text: string,
  trustedActiveProductTarget: string | null = null,
  allowUnanchoredQueryAdjective = false,
): boolean {
  if (!isAppearanceFacet(facet)) return false;
  const valueTokens = norm(value).split(" ").filter(Boolean);
  const targetWords = appearanceTargetWords(facet);
  const clauses = appearanceClauses(text);
  const hasTrustedTarget = Boolean(trustedActiveProductTarget?.trim());
  const hasMentionedProductTarget = clauses.some((tokens) =>
    tokens.some((token) =>
      targetWords.some((target) => appearanceWordMatches(target, token))
    )
  );

  for (const [clauseIndex, tokens] of clauses.entries()) {
    const priorOrCurrentRequest = clauses.slice(0, clauseIndex + 1).some(
      (candidate) => candidate.some((token) => REQUEST_WORD.test(token)),
    );
    const currentTurnHasTarget = clauses.slice(0, clauseIndex + 1).some(
      (candidate) => isAppearanceRequestTarget(candidate, targetWords),
    );
    const requestObject = appearanceRequestObject(tokens);
    const negatedDemand = tokens.some((token, index) =>
      tokens[index - 1] === "не" &&
      (REQUEST_WORD.test(token) || NEGATIVE_DEMAND.test(token))
    );
    for (let index = 0; index < tokens.length; index++) {
      if (!appearanceValueAt(tokens, index, valueTokens)) continue;
      const end = index + valueTokens.length;
      if (negatedDemand) continue;
      const hasLaterRequest = tokens.slice(end).some((token) =>
        REQUEST_WORD.test(token)
      ) || clauses.slice(clauseIndex + 1).some((laterClause) =>
        laterClause.some((token) => REQUEST_WORD.test(token))
      );
      if (
        appearanceValueDescribesSource(
          tokens,
          index,
          end,
          targetWords,
          hasLaterRequest,
        )
      ) {
        continue;
      }
      if (
        tokens.slice(Math.max(0, index - 2), index).some((token) =>
          token === "не" || token === "без" || token === "кроме"
        )
      ) continue;
      // Measurements such as «30 квадратов» are not a square fixture.
      if (index > 0 && /^\d+(?:[.,]\d+)?$/u.test(tokens[index - 1])) {
        continue;
      }

      const axisBefore = tokens.slice(Math.max(0, index - 3), index)
        .findLastIndex((token) => APPEARANCE_AXIS_WORD.test(token));
      if (axisBefore !== -1) {
        const axisIndex = Math.max(0, index - 3) + axisBefore;
        const subject = tokens.slice(axisIndex + 1, index)
          .filter((token) =>
            !RELATION_PREPOSITION.test(token) &&
            !AXIS_PREDICATE_WORD.test(token)
          );
        // In «форма зала круглая» the noun between axis and value owns the
        // adjective. A different current request elsewhere cannot override it.
        if (subject.length > 0) {
          if (
            subject.every((token) =>
              appearanceReferentIsProduct(
                token,
                targetWords,
                requestObject,
                trustedActiveProductTarget,
              )
            )
          ) return true;
          continue;
        }
        const referent = nearestAppearanceReferent(tokens, axisIndex);
        if (referent) {
          if (
            appearanceReferentIsProduct(
              referent,
              targetWords,
              requestObject,
              trustedActiveProductTarget,
            )
          ) return true;
          continue;
        }
        if (
          tokens.slice(0, axisIndex).some((token) =>
            REQUEST_WORD.test(token)
          ) ||
          currentTurnHasTarget || priorOrCurrentRequest || hasTrustedTarget
        ) return true;
        continue;
      }

      const axisAfter = tokens.slice(end, end + 3)
        .findIndex((token) => APPEARANCE_AXIS_WORD.test(token));
      if (axisAfter !== -1) {
        const axisIndex = end + axisAfter;
        // A noun immediately following the axis owns it («форма зала»).
        // A preposition starts an application complement instead («форма
        // для зала»), so it cannot relabel the preceding product adjective.
        const subject = RELATION_PREPOSITION.test(tokens[axisIndex + 1] ?? "")
          ? []
          : tokens.slice(axisIndex + 1, axisIndex + 3);
        if (
          subject.length > 0 &&
          !subject.every((token) =>
            appearanceReferentIsProduct(
              token,
              targetWords,
              requestObject,
              trustedActiveProductTarget,
            )
          ) &&
          !ELLIPTICAL_FOLLOWER.test(subject[0])
        ) continue;
        const referent = nearestAppearanceReferent(tokens, index);
        if (referent) {
          if (
            appearanceReferentIsProduct(
              referent,
              targetWords,
              requestObject,
              trustedActiveProductTarget,
            )
          ) return true;
          continue;
        }
        if (
          tokens.slice(0, index).some((token) => REQUEST_WORD.test(token)) ||
          currentTurnHasTarget || priorOrCurrentRequest || hasTrustedTarget
        ) return true;
        continue;
      }

      // Directly modified live product noun: «круглую люстру», not «люстру
      // для круглого зала». A relation preposition before the value indicates
      // the latter kind of complement, even when the noun happens to match.
      const preceding = tokens[index - 1] ?? "";
      const next = tokens[end] ?? "";
      const directTarget = targetWords.some((target) =>
        appearanceWordMatches(target, preceding) ||
        appearanceWordMatches(target, next)
      );
      if (directTarget && !RELATION_PREPOSITION.test(preceding)) return true;

      // The requested product can use a different noun from the live category
      // («круглая лампа» under «Светильники»). The noun immediately after the
      // adjective is the direct object only in a request clause, not after
      // «для/в/с» and not in an arbitrary phrase like «круг задач».
      const nearbyRequest = tokens.slice(Math.max(0, index - 2), index)
        .some((token) => REQUEST_WORD.test(token));
      if (
        nearbyRequest && !RELATION_PREPOSITION.test(preceding) &&
        next.length >= 3 && !ELLIPTICAL_FOLLOWER.test(next) &&
        !RELATION_PREPOSITION.test(next)
      ) return true;

      // The requested replacement can omit a repeated product noun after an
      // explicit source mention: «старая люстра круглая, новая нужна
      // овальная» / «у меня лофтовая люстра, хочу классическую». This is
      // customer-owned only when the product target is grounded elsewhere in
      // the same turn or by trusted server state.
      const replacementTarget = preceding === "на" &&
        tokens.slice(0, index).some((token) => REPLACEMENT_VERB.test(token));
      if (
        (hasMentionedProductTarget || hasTrustedTarget) &&
        (tokens.slice(0, index).some((token) => REQUEST_WORD.test(token)) ||
          replacementTarget) &&
        (!RELATION_PREPOSITION.test(preceding) || replacementTarget) &&
        (!next || ELLIPTICAL_FOLLOWER.test(next) ||
          REPLACEMENT_FOLLOWER.test(next))
      ) return true;

      // Postposed demand after an elliptical adjective, e.g. «а овальную
      // хочу», is a choice only when the product target is already grounded.
      if (
        (hasMentionedProductTarget || hasTrustedTarget) &&
        tokens.slice(0, index).every((token) =>
          ELLIPTICAL_PREFIX.test(token)
        ) &&
        REQUEST_WORD.test(next)
      ) return true;

      // Search-query fragments often omit the request verb. When checking a
      // model-originated query, an inflected appearance adjective attached to
      // an arbitrary noun is a *possible* product narrowing even if that noun
      // differs from the catalog class («круглую лампу» / «светильники»).
      // This deliberately broadens uncertain queries instead of silently
      // accepting them; it is never used to prove a customer-owned filter.
      if (
        allowUnanchoredQueryAdjective &&
        RU_ADJECTIVE_SUFFIXES.some((suffix) =>
          tokens[index].endsWith(suffix)
        ) &&
        next.length >= 3 && !ELLIPTICAL_FOLLOWER.test(next) &&
        !RELATION_PREPOSITION.test(next) &&
        !RELATION_PREPOSITION.test(preceding)
      ) return true;

      // «А круглая есть?» is only a product constraint when the server has
      // retained a proven active selection target. Mere chat history or a
      // model-supplied category cannot create that target.
      if (
        hasTrustedTarget &&
        (!next || ELLIPTICAL_FOLLOWER.test(next)) &&
        tokens.slice(0, index).every((token) =>
          ELLIPTICAL_PREFIX.test(token) || REQUEST_WORD.test(token)
        )
      ) return true;
    }
  }
  return false;
}

/** A new replacement starts a new product selection, so a shape/style owned
 * by the old item cannot silently transfer from the confirmed base request.
 * Inspect the source-object role, not a list of product names or facet values. */
function appearanceReplacesActiveProduct(
  text: string,
  facet: SearchFacet,
  trustedActiveProductTarget: string,
): boolean {
  const targetWords = [
    ...appearanceTargetWords(facet),
    ...norm(trustedActiveProductTarget).split(" ").filter((word) =>
      word.length >= 4
    ),
  ];
  return appearanceClauses(text).some((tokens) =>
    tokens.some((token, index) => {
      if (!REPLACEMENT_VERB.test(token)) return false;
      const after = tokens.slice(index + 1);
      const newItemIndex = after.indexOf("на");
      const source = newItemIndex < 0 ? after : after.slice(0, newItemIndex);
      const relationIndex = source.findIndex((word) =>
        RELATION_PREPOSITION.test(word)
      );
      if (
        source.some((word, sourceIndex) =>
          (relationIndex < 0 || sourceIndex < relationIndex) &&
          targetWords.some((target) => appearanceWordMatches(target, word))
        )
      ) return true;
      // «Хочу заменить на другую» elides the old object. A server-confirmed
      // active target, not free-form chat history, resolves that ellipsis.
      return newItemIndex === 0 && Boolean(after[1]);
    })
  );
}

/**
 * Pure customer provenance decision. `currentUserMessage` must be the latest
 * user turn, not model reasoning and not concatenated conversation history.
 * For a non-appearance facet this helper is intentionally inapplicable.
 */
export function resolveCustomerAppearanceFacetOwnership(
  input: CustomerAppearanceFacetInput,
): boolean {
  // A current-turn withdrawal defeats both current positive-looking words
  // and a previously confirmed base request. Canonical catalog nouns must be
  // matched morphologically here («круг» → «не круглую»).
  if (
    appearanceValueIsCancelledInText(
      input.facet,
      input.value,
      input.currentUserMessage,
    )
  ) {
    return false;
  }
  if (
    appearanceClaimInText(
      input.facet,
      input.value,
      input.currentUserMessage,
      input.trustedActiveProductTarget,
    )
  ) return true;
  if (
    !input.trustedActiveProductTarget?.trim() ||
    !input.trustedBaseUserMessage?.trim()
  ) return false;
  // A new, explicit shape/style/design choice replaces the inherited one.
  if (
    input.facet.values.some(({ value }) =>
      value !== input.value && appearanceClaimInText(
        input.facet,
        value,
        input.currentUserMessage,
        input.trustedActiveProductTarget,
      )
    )
  ) return false;
  if (
    appearanceReplacesActiveProduct(
      input.currentUserMessage,
      input.facet,
      input.trustedActiveProductTarget,
    )
  ) return false;
  return appearanceClaimInText(
    input.facet,
    input.value,
    input.trustedBaseUserMessage,
    input.trustedActiveProductTarget,
  ) && !contradictedByUser(input.value, input.currentUserMessage);
}

/** A structured model declaration (`shape: квадрат`) is a claim even when
 * preceding prose has no product noun. It never establishes customer ownership.
 * A room axis (`Форма зала: квадрат`) is not the live facet axis. */
function explicitAppearanceAxisDeclaration(
  facet: SearchFacet,
  value: string,
  text: string,
): boolean {
  const liveAxisWords = norm(`${facet.key} ${facet.caption ?? ""}`)
    .split(" ").filter((token) => APPEARANCE_AXIS_WORD.test(token));
  if (liveAxisWords.length === 0) return false;
  const valueTokens = norm(value).split(" ").filter(Boolean);
  const declarations = String(text ?? "").toLowerCase().matchAll(
    /([\p{L}\d_-]+)\s*[:=]\s*([\p{L}\d_-]+(?:\s+[\p{L}\d_-]+)*)/gu,
  );
  for (const [, axis, declaredValue] of declarations) {
    if (!liveAxisWords.includes(norm(axis))) continue;
    if (appearanceValueAt(norm(declaredValue).split(" "), 0, valueTokens)) {
      return true;
    }
  }
  return false;
}

/** Live-schema appearance claims in arbitrary model prose or a search query. */
export function appearanceFacetClaimsFromText(
  facets: SearchFacet[],
  text: string,
  options: {
    trustedActiveProductTarget?: string | null;
    /** Conservative model-query suspicion; never proves user provenance. */
    allowUnanchoredQueryAdjective?: boolean;
  } = {},
): FacetValueEvidence[] {
  return facets.filter(isAppearanceFacet).flatMap((facet) =>
    facet.values.flatMap(({ value }) =>
      (explicitAppearanceAxisDeclaration(facet, value, text) ||
          appearanceClaimInText(
            facet,
            value,
            text,
            options.trustedActiveProductTarget,
            options.allowUnanchoredQueryAdjective,
          ))
        ? [{ key: facet.key, value }]
        : []
    )
  );
}

function appearanceValueMentionedInText(
  facet: SearchFacet,
  value: string,
  text: string,
): boolean {
  if (!isAppearanceFacet(facet)) return false;
  const valueTokens = norm(value).split(" ").filter(Boolean);
  return appearanceClauses(text).some((tokens) =>
    tokens.some((token, index) => {
      if (!appearanceValueAt(tokens, index, valueTokens)) return false;
      // A number followed by «квадратов» is area, not a shape term.
      if (index > 0 && /^\d+(?:[.,]\d+)?$/u.test(tokens[index - 1])) {
        return false;
      }
      // A bare recovery token is ambiguous and must not become a narrow
      // search unless the customer owns the product appearance elsewhere.
      if (tokens.length === valueTokens.length) return true;
      if (
        tokens.slice(Math.max(0, index - 3), index + valueTokens.length + 3)
          .some((nearby) => APPEARANCE_AXIS_WORD.test(nearby))
      ) return true;
      // An adjective explicitly modifies some noun, possibly a room. Even
      // then the raw full-text query can accidentally narrow catalog search.
      return RU_ADJECTIVE_SUFFIXES.some((suffix) => token.endsWith(suffix));
    })
  );
}

/**
 * Query-safety signal, not a new customer constraint. Covers model-created
 * product modifiers and ambient room modifiers copied into raw text search.
 * The caller should broad-browse a verified category instead of executing a
 * narrow query when any unowned live appearance value is returned.
 */
export function unownedAppearanceMentionsInText(
  facets: SearchFacet[],
  text: string,
  scope: AppearanceEvidenceScope,
): FacetValueEvidence[] {
  return facets.filter(isAppearanceFacet).flatMap((facet) =>
    facet.values.flatMap(({ value }) =>
      (appearanceValueMentionedInText(facet, value, text) ||
          appearanceClaimInText(
            facet,
            value,
            text,
            scope.trustedActiveProductTarget,
            true,
          )) &&
        !customerOwnsAppearanceFacetValue(
          facet,
          value,
          scope.currentUserMessage,
          scope,
        )
        ? [{ key: facet.key, value }]
        : []
    )
  );
}

function customerOwnsAppearanceFacetValue(
  facet: SearchFacet,
  value: string,
  userEvidence: string,
  scope?: Partial<AppearanceEvidenceScope>,
): boolean {
  if (!isAppearanceFacet(facet)) return true;
  const currentUserMessage = scope?.currentUserMessage ?? userEvidence;
  if (
    facetValueAppearsOnlyAsMeasurementNoun(value, currentUserMessage) ||
    contradictedByUser(value, currentUserMessage)
  ) return false;
  return resolveCustomerAppearanceFacetOwnership({
    facet,
    value,
    currentUserMessage,
    trustedActiveProductTarget: scope?.trustedActiveProductTarget,
    trustedBaseUserMessage: scope?.trustedBaseUserMessage,
  });
}

function visualSingleLetter(value: string): string {
  const map: Record<string, string> = {
    а: "a",
    в: "b",
    е: "e",
    к: "k",
    м: "m",
    н: "h",
    о: "o",
    р: "p",
    с: "c",
    т: "t",
    у: "y",
    х: "x",
  };
  const normalized = norm(value);
  return normalized.length === 1 ? (map[normalized] ?? normalized) : normalized;
}

/** One-letter technical values are evidence only after the surrounding facet
 * meaning has already been proven in the same reasoning. */
function explicitlyAffirmedByFacetReasoning(
  value: string,
  evidence: string,
): boolean {
  const normalized = norm(value);
  const evidenceTokens = norm(evidence).split(" ");
  const valueTokens = normalized.split(" ").filter(Boolean);
  const shortCodes = valueTokens.filter((token) =>
    token.length === 1 && /\p{L}/u.test(token)
  );
  const nonCodeTokens = valueTokens.filter((token) =>
    !shortCodes.includes(token)
  );
  // A one-letter shortcut is valid only for a genuinely code-shaped value
  // such as `Type C`. Previously any one-letter word inside a compound live
  // value activated the shortcut: the conjunction `и` in a phrase like
  // `настольные и напольные` was then mistaken for a technical code and the
  // whole unrelated class became "proven". Structural code labels are the
  // only allowed companions; descriptive compound values must pass the full
  // token-by-token evidence check below.
  const codeOnlyValue = shortCodes.length === 1 &&
    nonCodeTokens.every((token) =>
      /^(?:тип|type|класс|class|характеристика|curve)$/u.test(token)
    );
  if (
    codeOnlyValue && shortCodes.some((code) => {
      const wanted = visualSingleLetter(code);
      return evidenceTokens.some((token) =>
        token.length === 1 && /\p{L}/u.test(token) &&
        visualSingleLetter(token) === wanted
      );
    })
  ) {
    return true;
  }
  if (
    /\d/u.test(normalized) && /\p{L}/u.test(normalized) &&
    codeNorm(evidence).includes(codeNorm(value))
  ) return true;
  return explicitlyAffirmedByUser(value, evidence);
}

function facetMeaningIsEvidenced(
  facet: SearchFacet,
  evidence: string,
): boolean {
  const facetTokens = norm(`${facet.key} ${facet.caption ?? ""}`)
    .split(" ")
    .filter((token) => token.length >= 4);
  const evidenceTokens = norm(evidence).split(" ").filter((token) =>
    token.length >= 4
  );
  return facetTokens.some((facetToken) =>
    evidenceTokens.some((token) => tokensMatchByStem(facetToken, token))
  );
}

function explicitShortFacetCodeIsLocallyEvidenced(
  facet: SearchFacet,
  value: string,
  evidence: string,
): boolean {
  const canonical = visualSingleLetter(value);
  if (canonical.length !== 1 || !/[a-z]/u.test(canonical)) return false;
  const rawTokens = String(evidence ?? "").match(/\d+(?:[.,]\d+)?|\p{L}+/gu) ??
    [];
  const facetTokens = norm(`${facet.key} ${facet.caption ?? ""}`)
    .split(" ")
    .filter((token) => token.length >= 4);
  if (facetTokens.length === 0) return false;
  return rawTokens.some((raw, index) => {
    if (raw.length !== 1 || visualSingleLetter(raw) !== canonical) return false;
    // In `16 А характеристика С`, the first lookalike is the physical unit,
    // not curve A. Preserve the number in tokenization so a one-letter token
    // directly following it cannot become a technical facet code merely
    // because the actual facet label is nearby.
    if (index > 0 && /^\d+(?:[.,]\d+)?$/u.test(rawTokens[index - 1])) {
      return false;
    }
    // A lowercase Cyrillic one-letter word is normally a preposition (`с`),
    // not a technical curve/code. Latin notation remains valid in either case;
    // Cyrillic lookalikes must be visibly code-shaped (uppercase).
    const codeShaped = /[a-z]/u.test(raw) ||
      raw === raw.toLocaleUpperCase("ru-RU");
    if (!codeShaped) return false;
    const nearby = rawTokens.slice(Math.max(0, index - 3), index + 4).map(norm);
    return facetTokens.some((facetToken) =>
      nearby.some((token) =>
        token === facetToken || tokensMatchByStem(facetToken, token)
      )
    );
  });
}

function facetMeaningIsFullyEvidenced(
  facet: SearchFacet,
  evidence: string,
): boolean {
  const facetTokens = norm(facet.caption ?? facet.key)
    .split(" ")
    .filter((token) => token.length >= 4);
  const evidenceTokens = norm(evidence).split(" ").filter((token) =>
    token.length >= 4
  );
  return facetTokens.length > 0 &&
    facetTokens.every((facetToken) =>
      evidenceTokens.some((token) =>
        token === facetToken || tokensMatchByStem(facetToken, token)
      )
    );
}

/**
 * A partial facet label is sufficient only when it cannot refer to a sibling
 * live axis exposing the same canonical value. For example, `белый свет`
 * names neither `Цвет корпуса = белый` nor `Цвет свечения = белый` precisely:
 * the shared word `цвет` must not arbitrarily select one of them. Conversely,
 * `1 полюс` still proves `Количество полюсов = 1`, even if another count facet
 * also exposes `1`, because the discriminating noun `полюсов` is present.
 *
 * This is deliberately driven by the current live schema and value, not by a
 * product/category dictionary.
 */
function facetMeaningIsDisambiguatedForValue(
  facet: SearchFacet,
  value: string,
  facets: SearchFacet[],
  evidence: string,
): boolean {
  if (!facetMeaningIsEvidenced(facet, evidence)) return false;

  const canonicalValue = norm(value);
  const siblings = facets.filter((candidate) =>
    candidate.key !== facet.key &&
    candidate.values.some((item) => norm(item.value) === canonicalValue)
  );
  if (siblings.length === 0) return true;

  const labelTokens = (candidate: SearchFacet) =>
    norm(candidate.caption || candidate.key)
      .split(" ")
      .filter((token) => token.length >= 4);
  const currentTokens = labelTokens(facet);
  const siblingTokens = siblings.flatMap(labelTokens);
  const evidenceTokens = norm(evidence).split(" ").filter((token) =>
    token.length >= 4
  );
  const discriminators = currentTokens.filter((token) =>
    !siblingTokens.some((sibling) =>
      token === sibling || tokensMatchByStem(token, sibling)
    )
  );
  return discriminators.some((discriminator) =>
    evidenceTokens.some((token) =>
      token === discriminator || tokensMatchByStem(discriminator, token)
    )
  );
}

/**
 * A colour/material/etc. value alone cannot identify which of two live
 * property axes the customer meant. In particular, `белый свет` is not proof
 * of `Цвет корпуса = белый` merely because the adjective matches. Use the
 * discovered sibling axes (rather than a product or colour dictionary) and
 * require the distinguishing axis word next to the customer's value.
 *
 * A short noun may name the same axis as a longer live label (`свет` next to
 * `свечения`); this narrow prefix allowance is local to the value phrase and
 * cannot turn a longer product noun (`светильник`) into the shorter axis.
 */
function customerOwnsFacetValueAxis(
  facet: SearchFacet,
  value: string,
  facets: SearchFacet[],
  userEvidence: string,
): boolean {
  const labelTokens = (candidate: SearchFacet) =>
    norm(candidate.caption || candidate.key).split(" ").filter((token) =>
      token.length >= 4
    );
  const ownTokens = labelTokens(facet);
  const valueTokens = significantValueTokens(value);
  if (ownTokens.length < 2 || valueTokens.length === 0) return true;

  const siblings = facets.filter((candidate) => {
    if (candidate.key === facet.key) return false;
    const otherTokens = labelTokens(candidate);
    if (otherTokens.length < 2) return false;
    const sharedLabel = ownTokens.some((token) =>
      otherTokens.some((other) =>
        token === other || tokensMatchByStem(token, other)
      )
    );
    const overlappingValue = candidate.values.some(({ value: otherValue }) =>
      significantValueTokens(otherValue).some((other) =>
        valueTokens.some((token) =>
          token === other || tokensMatchByStem(token, other)
        )
      )
    );
    return sharedLabel && overlappingValue;
  });
  if (siblings.length === 0) return true;

  const siblingTokens = siblings.flatMap(labelTokens);
  const discriminators = ownTokens.filter((token) =>
    !siblingTokens.some((other) =>
      token === other || tokensMatchByStem(token, other)
    )
  );
  if (discriminators.length === 0) return false;

  const userTokens = norm(userEvidence).split(" ").filter(Boolean);
  const axisMatches = (axis: string, word: string) =>
    axis === word || tokensMatchByStem(axis, word) ||
    (word.length >= 4 && word.length <= 6 &&
      axis.length >= word.length + 3 &&
      axis.slice(0, 3) === word.slice(0, 3));
  return userTokens.some((word, index) =>
    discriminators.some((axis) => axisMatches(axis, word)) &&
    userTokens.some((candidate, valueIndex) =>
      Math.abs(index - valueIndex) <= 3 &&
      valueTokens.some((token) =>
        token === stemRu(candidate) || tokensMatchByStem(token, candidate)
      )
    )
  );
}

const COMPOUND_COUNT_PREFIXES: ReadonlyArray<readonly [string, number]> = [
  ["одиннадцати", 11],
  ["двенадцати", 12],
  ["четырех", 4],
  ["восьми", 8],
  ["девяти", 9],
  ["десяти", 10],
  ["двух", 2],
  ["трех", 3],
  ["пяти", 5],
  ["шести", 6],
  ["семи", 7],
  ["одно", 1],
];

const SEPARATED_COUNT_WORDS: ReadonlyMap<string, number> = new Map([
  ["один", 1],
  ["одна", 1],
  ["одно", 1],
  ["одним", 1],
  ["одной", 1],
  ["два", 2],
  ["две", 2],
  ["двух", 2],
  ["двумя", 2],
  ["три", 3],
  ["трех", 3],
  ["тремя", 3],
  ["четыре", 4],
  ["четырех", 4],
  ["четырьмя", 4],
  ["пять", 5],
  ["пяти", 5],
  ["пятью", 5],
  ["шесть", 6],
  ["шести", 6],
  ["шестью", 6],
  ["семь", 7],
  ["семи", 7],
  ["семью", 7],
  ["восемь", 8],
  ["восьми", 8],
  ["восемью", 8],
  ["девять", 9],
  ["девяти", 9],
  ["девятью", 9],
  ["десять", 10],
  ["десяти", 10],
  ["десятью", 10],
  ["одиннадцать", 11],
  ["одиннадцати", 11],
  ["одиннадцатью", 11],
  ["двенадцать", 12],
  ["двенадцати", 12],
  ["двенадцатью", 12],
]);

const COUNT_FACET_MARKER = /^(?:количеств|числ|number|count)/u;
const COUNT_ADJECTIVE_ENDINGS = [
  "овыми",
  "евыми",
  "ового",
  "евого",
  "овому",
  "евому",
  "ьными",
  "ными",
  "овый",
  "евый",
  "ьный",
  "ный",
  "овая",
  "евая",
  "ьная",
  "ная",
  "овое",
  "евое",
  "ьное",
  "ное",
  "овые",
  "евые",
  "ьные",
  "ные",
  "овых",
  "евых",
  "ьных",
  "ных",
  "овым",
  "евым",
  "ьным",
  "ным",
  "овой",
  "евой",
  "ьной",
  "ной",
  "овую",
  "евую",
  "ьную",
  "ную",
] as const;

function countedNounStem(fragment: string): string {
  let stem = norm(fragment).replace(/\s+/gu, "");
  for (const ending of COUNT_ADJECTIVE_ENDINGS) {
    if (stem.endsWith(ending) && stem.length - ending.length >= 3) {
      stem = stem.slice(0, -ending.length);
      break;
    }
  }
  return stem.replace(/ь$/u, "");
}

function compoundCountClaims(
  evidence: string,
): Array<{ count: number; nounStem: string }> {
  const claims: Array<{ count: number; nounStem: string }> = [];
  for (const token of norm(evidence).split(" ").filter(Boolean)) {
    for (const [prefix, count] of COMPOUND_COUNT_PREFIXES) {
      if (!token.startsWith(prefix) || token.length - prefix.length < 4) {
        continue;
      }
      const nounStem = countedNounStem(token.slice(prefix.length));
      if (nounStem.length >= 3) claims.push({ count, nounStem });
      break;
    }
  }
  return claims;
}

function separatedCountClaims(
  evidence: string,
): Array<{ count: number; nounStem: string }> {
  const tokens = norm(evidence).split(" ").filter(Boolean);
  const claims: Array<{ count: number; nounStem: string }> = [];
  for (let index = 0; index + 1 < tokens.length; index++) {
    const rawCount = tokens[index];
    const numeric = rawCount.match(/^\d+$/u)?.[0];
    const count = numeric
      ? Number(numeric)
      : SEPARATED_COUNT_WORDS.get(rawCount);
    if (!Number.isInteger(count) || Number(count) < 1 || Number(count) > 12) {
      continue;
    }
    const nounStem = countedNounStem(stemRu(tokens[index + 1]));
    if (nounStem.length >= 3) claims.push({ count: Number(count), nounStem });
  }
  return claims;
}

/**
 * Resolve morphological cardinality such as `трехжильный`, `двухполюсный`
 * or `четырехэлементный` against a live count facet. The product noun is not
 * known here: the remainder of the compound adjective must match a noun in
 * the facet caption, and the facet itself must explicitly be a count axis.
 * Therefore unrelated measurements (`3 кВт`, `25 м²`) cannot open this path.
 */
function compoundCountFacetValue(
  facet: SearchFacet,
  evidence: string,
): SearchFacetValue | null {
  const labelTokens = norm(`${facet.caption ?? ""} ${facet.key}`)
    .split(" ")
    .filter(Boolean);
  if (!labelTokens.some((token) => COUNT_FACET_MARKER.test(token))) return null;
  const nounStems = labelTokens
    .filter((token) => token.length >= 3 && !COUNT_FACET_MARKER.test(token))
    .map((token) => countedNounStem(stemRu(token)))
    .filter((token) => token.length >= 3);
  if (nounStems.length === 0) return null;

  const claims = [
    ...compoundCountClaims(evidence),
    ...separatedCountClaims(evidence),
  ].filter(({ nounStem }) =>
    nounStems.some((facetStem) =>
      facetStem === nounStem ||
      Math.min(facetStem.length, nounStem.length) >= 3 &&
        (facetStem.startsWith(nounStem) || nounStem.startsWith(facetStem))
    )
  );
  const claimedCounts = [...new Set(claims.map(({ count }) => count))];
  if (claimedCounts.length !== 1) return null;
  const count = claimedCounts[0];
  const candidates = facet.values.filter(({ value }) => {
    if (!isAtomicFacetValue(value)) return false;
    const scalar = norm(value).match(/^(\d+(?:[.,]\d+)?)(?:\s|$)/u)?.[1];
    return scalar !== undefined && Number(scalar.replace(",", ".")) === count;
  });
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * A complete live label immediately followed by one of its exact values is a
 * stronger local declaration than unrelated numbers in neighbouring clauses.
 * This is intentionally token-adjacent: a label elsewhere in the paragraph
 * cannot relabel an application measurement as a product property.
 */
function explicitlyLabelledFacetValue(
  facet: SearchFacet,
  evidence: string,
): SearchFacetValue | null {
  const evidenceTokens = norm(evidence).split(" ").filter(Boolean);
  const labels = [
    facet.caption ?? "",
    String(facet.caption ?? "").split(",")[0],
    facet.key,
  ]
    .map((label) => norm(label).split(" ").filter(Boolean))
    .filter((tokens) => tokens.length > 0);
  const matches: SearchFacetValue[] = [];
  for (const labelTokens of labels) {
    for (
      let index = 0;
      index <= evidenceTokens.length - labelTokens.length;
      index++
    ) {
      if (
        !labelTokens.every((token, offset) =>
          evidenceTokens[index + offset] === token
        )
      ) continue;
      const valueStart = index + labelTokens.length;
      for (const candidate of facet.values) {
        if (!isAtomicFacetValue(candidate.value)) continue;
        const valueTokens = norm(candidate.value).split(" ").filter(Boolean);
        if (valueTokens.length === 0) continue;
        if (
          valueTokens.every((token, offset) =>
            evidenceTokens[valueStart + offset] === token
          )
        ) {
          // Normalization removes the dash in `label 4000–5000 K`. The first
          // endpoint is adjacent to the label but it is not an exact enum
          // declaration. Leave both endpoints to the range compiler.
          const numericValue = valueTokens.every((token) =>
            /^\d+(?:[.,]\d+)?$/u.test(token)
          );
          const followingToken =
            evidenceTokens[valueStart + valueTokens.length] ?? "";
          if (numericValue && /^\d+(?:[.,]\d+)?$/u.test(followingToken)) {
            continue;
          }
          matches.push(candidate);
        }
      }
    }
  }
  const unique = matches.filter((candidate, index, all) =>
    all.findIndex(({ value }) => norm(value) === norm(candidate.value)) ===
      index
  );
  return unique.length === 1 ? unique[0] : null;
}

/**
 * Projects an explicit consultant statement onto the live catalog schema even
 * when the following tool call omits that option. Only a complete facet label
 * (not one loose word) can open an axis, and exactly one canonical live value
 * must be evidenced on it. This makes the machine contract follow the visible
 * reasoning without guessing from product vocabulary or maintaining aliases.
 */
export function projectExplicitReasoningFacetValues(
  facets: SearchFacet[],
  declaredReasoning: string,
  userEvidence: string,
  appearanceScope?: Partial<AppearanceEvidenceScope>,
): ReasoningFacetProjection {
  const reasoning = ` ${norm(declaredReasoning)} `;
  const kept: ReasoningFacetProjection["kept"] = [];
  const userBacked: ReasoningFacetProjection["user_backed"] = [];

  for (const facet of facets) {
    if (isReplacementIdentityFacet(facet)) continue;
    const compoundCount = compoundCountFacetValue(facet, declaredReasoning);
    if (
      compoundCount && !contradictedByUser(compoundCount.value, userEvidence) &&
      customerOwnsAppearanceFacetValue(
        facet,
        compoundCount.value,
        userEvidence,
        appearanceScope,
      )
    ) {
      const item = { key: facet.key, value: compoundCount.value };
      kept.push(item);
      if (
        compoundCountFacetValue(facet, userEvidence)?.value ===
          compoundCount.value
      ) {
        userBacked.push(item);
      }
      continue;
    }
    const labelledValue = explicitlyLabelledFacetValue(
      facet,
      declaredReasoning,
    );
    if (
      labelledValue && !contradictedByUser(labelledValue.value, userEvidence) &&
      customerOwnsAppearanceFacetValue(
        facet,
        labelledValue.value,
        userEvidence,
        appearanceScope,
      ) &&
      (!isAbsenceOrUnknownFacetValue(labelledValue.value) ||
        customerOwnsAbsentFacetValue(
          facet,
          labelledValue.value,
          userEvidence,
        ))
    ) {
      const item = { key: facet.key, value: labelledValue.value };
      kept.push(item);
      if (
        explicitlyLabelledFacetValue(facet, userEvidence)?.value ===
          labelledValue.value ||
        customerOwnsAbsentFacetValue(facet, labelledValue.value, userEvidence)
      ) {
        userBacked.push(item);
      }
      continue;
    }
    const publicCaption = facet.caption ?? "";
    const labels = [publicCaption, publicCaption.split(",")[0], facet.key]
      .map(norm)
      .filter((label) => /[a-zа-я]/iu.test(label) && label.length >= 3);
    if (!labels.some((label) => reasoning.includes(` ${label} `))) continue;

    const candidates = facet.values.filter((candidate) => {
      if (!isAtomicFacetValue(candidate.value)) return false;
      if (
        !customerOwnsAppearanceFacetValue(
          facet,
          candidate.value,
          userEvidence,
          appearanceScope,
        )
      ) return false;
      if (
        isAbsenceOrUnknownFacetValue(candidate.value) &&
        !customerOwnsAbsentFacetValue(facet, candidate.value, userEvidence)
      ) return false;
      if (contradictedByUser(candidate.value, userEvidence)) return false;
      if (
        numericFacetValueConflictsWithUserMeasurement(
          candidate.value,
          facet,
          userEvidence,
          declaredReasoning,
        )
      ) return false;
      if (
        !numericFacetValueIsLocallyEvidenced(
          candidate.value,
          facet,
          declaredReasoning,
        )
      ) return false;
      if (!facetStateQualifierIsUserBacked(facet, declaredReasoning)) {
        return false;
      }
      return explicitlyAffirmedByFacetReasoning(
        candidate.value,
        declaredReasoning,
      );
    });
    if (candidates.length !== 1) continue;

    const item = { key: facet.key, value: candidates[0].value };
    kept.push(item);
    if (
      customerOwnsAbsentFacetValue(facet, candidates[0].value, userEvidence) ||
      explicitlyAffirmedByUser(candidates[0].value, userEvidence) &&
        facetMeaningIsEvidenced(facet, userEvidence)
    ) userBacked.push(item);
  }

  return { kept, user_backed: userBacked };
}

function numericFacetValueIsLocallyEvidenced(
  value: string,
  facet: SearchFacet,
  evidence: string,
): boolean {
  const normalizedValue = norm(value);
  if (!/\d/u.test(normalizedValue)) return true;
  if (/[a-zа-я]/iu.test(normalizedValue)) {
    // Compound numeric enums (`от -20 до +50 °C`, `220–240 V`, `IP65`) are
    // categorical strings in the catalog, but their numbers remain part of
    // the claim. A matching caption or shared word cannot authorize a value
    // whose actual numbers were never stated in the reasoning.
    const valueNumbers = normalizedValue.match(/\d+(?:[.,]\d+)?/gu) ?? [];
    if (valueNumbers.length === 0) return false;
    const evidenceTokens = norm(evidence).split(" ").filter(Boolean);
    const labels = [
      String(facet.caption ?? "").split(",")[0],
      facet.caption ?? "",
      facet.key,
    ].map((label) => norm(label).split(" ").filter(Boolean))
      .filter((tokens) => tokens.length > 0);
    return labels.some((labelTokens) => {
      for (
        let index = 0;
        index <= evidenceTokens.length - labelTokens.length;
        index++
      ) {
        if (
          !labelTokens.every((token, offset) =>
            evidenceTokens[index + offset] === token
          )
        ) continue;
        const localNumbers = new Set(
          evidenceTokens.slice(index, index + labelTokens.length + 14)
            .flatMap((token) => token.match(/\d+(?:[.,]\d+)?/gu) ?? [])
            .map((number) => number.replace(",", ".")),
        );
        if (
          valueNumbers.every((number) =>
            localNumbers.has(number.replace(",", "."))
          )
        ) {
          return true;
        }
      }
      return false;
    });
  }
  const publicLabel = String(facet.caption ?? "").trim() || facet.key;
  const labelBase = publicLabel.split(",")[0];
  const labelTokens = norm(labelBase).split(" ").filter((token) =>
    token.length >= 3
  );
  if (labelTokens.length === 0) return false;
  // Captions often start with a generic qualifier and end with the measured
  // property. Prefer the last meaningful token: in `Световой поток` the word
  // `поток`, not a nearby generic mention of `свет`, must anchor the number.
  const anchor =
    [...labelTokens].reverse().find((token) =>
      !/^(?:номинал|максимал|минимал|рабоч|общ|количеств|числ)/u.test(token)
    ) ?? labelTokens.at(-1)!;
  const expectedUnits = new Set([
    normalizeUnit(facet.unit ?? ""),
    ...String(facet.caption ?? "").split(",").slice(1)
      .flatMap((suffix) => suffix.match(/[a-zа-я°]{1,10}[²³]?\d?/giu) ?? [])
      .map(normalizeUnit),
  ].filter(Boolean));
  const exactNumber = normalizedValue.match(/^\d+(?:[.,]\d+)?$/u)?.[0];
  if (exactNumber && expectedUnits.size > 0) {
    const scalar = Number(exactNumber.replace(",", "."));
    const directional = extractReasoningBounds(evidence).some((bound) =>
      bound.value === scalar && expectedUnits.has(normalizeUnit(bound.unit))
    );
    // Once the consultant has stated that the product value must be above or
    // below the reference, exact equality to that same measured reference is
    // contradictory even if the literal number appears in the request.
    if (directional) return false;
    const literal = exactNumber.replace(/[.,]/u, "[.,]");
    const simpleUnit = String.raw`[a-zа-я°]{1,10}[²³]?\d?`;
    const measurement = new RegExp(
      `(?<![a-zа-я0-9])${literal}\\s*(${simpleUnit}(?:(?:/|\\s+на\\s+)${simpleUnit})?)(?![a-zа-я])`,
      "giu",
    );
    for (
      let match;
      (match = measurement.exec(String(evidence ?? ""))) !== null;
    ) {
      if (!expectedUnits.has(normalizeUnit(match[1]))) continue;
      const before = String(evidence ?? "").slice(
        Math.max(0, match.index - 48),
        match.index,
      );
      // An endpoint of a declared interval is not an exact product value.
      // The range compiler owns `4000–5000 K`; the exact-facet projector must
      // not independently freeze the upper endpoint as `= 5000 K`.
      if (
        /\d+(?:[.,]\d+)?\s*[–—-]\s*$/u.test(before) ||
        /от\s+\d+(?:[.,]\d+)?\s+до\s*$/iu.test(before)
      ) continue;
      return true;
    }
    // When the live facet declares a physical unit, a nearby word or a number
    // measured in another unit is never enough. Explicit label-adjacent enum
    // values were already handled above; falling through here caused a colour
    // temperature such as 4000 K to become `Световой поток = 4000 лм`.
    return false;
  }
  const evidenceTokens = norm(evidence).split(" ").filter(Boolean);
  const valueTokens = normalizedValue.split(" ").filter(Boolean);
  for (
    let index = 0;
    index <= evidenceTokens.length - valueTokens.length;
    index++
  ) {
    if (
      !valueTokens.every((token, offset) =>
        evidenceTokens[index + offset] === token
      )
    ) continue;
    // A unitless numeric facet must be named in the same compact phrase as the
    // number. A broad character window let a later product noun reclassify a
    // measured value from another dimension (`150–200 лк ... тип лампы` became
    // `Количество ламп = 150`). Five tokens preserve ordinary phrasing such as
    // `мощность светильника должна быть 100 Вт` without crossing into a later
    // sentence or parameter.
    const contextTokens = evidenceTokens.slice(
      Math.max(0, index - 5),
      Math.min(evidenceTokens.length, index + valueTokens.length + 6),
    );
    if (
      contextTokens.some((token) => (
        token === anchor || tokensMatchByStem(anchor, token) ||
        anchor.length >= 3 && token.length >= 3 &&
          (token.includes(anchor) || anchor.includes(token))
      ))
    ) return true;
  }
  return false;
}

/** A measured value belongs to a state-specific product facet only when the
 * customer named that state too. A bare reference such as "object 10 mm" may
 * guide a compatibility relation, but it cannot freeze both "before = 10"
 * and "after = 10" as user-authored product constraints. */
function facetStateQualifierIsUserBacked(
  facet: SearchFacet,
  evidence: string,
): boolean {
  const stateToken =
    /^(?:до|после|исходн\p{L}*|конечн\p{L}*|начальн\p{L}*|финальн\p{L}*|входн\p{L}*|выходн\p{L}*|before|after|initial|final|input|output)$/u;
  const qualifiers = norm(`${facet.key} ${facet.caption ?? ""}`).split(" ")
    .filter((token) => stateToken.test(token));
  if (qualifiers.length === 0) return true;
  const evidenceTokens = norm(evidence).split(" ").filter(Boolean);
  return qualifiers.some((qualifier) =>
    evidenceTokens.some((token) =>
      token === qualifier || tokensMatchByStem(token, qualifier)
    )
  ) && facetMeaningIsEvidenced(facet, evidence);
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
  if (
    compoundTokens.length <= narrowerTokens.length ||
    narrowerTokens.length === 0
  ) return false;
  return narrowerTokens.every((token) =>
    compoundTokens.some((candidate) => (
      token === candidate || tokensMatchByStem(token, candidate)
    ))
  );
}

const AFFIRMATIVE_VALUES = new Set([
  "да",
  "есть",
  "имеется",
  "присутствует",
  "yes",
  "true",
]);
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
  if (
    args.mode !== "by_filter" || !args.options ||
    typeof args.options !== "object"
  ) {
    return { args, removed: [] };
  }
  const options = args.options as Record<string, unknown>;
  const nextOptions: Record<string, string[]> = {};
  const removed: Array<{ key: string; value: string }> = [];

  for (const [key, rawValues] of Object.entries(options)) {
    const values = Array.isArray(rawValues)
      ? rawValues.map(String).filter(Boolean)
      : [];
    const facet = facets.find((candidate) => candidate.key === key);
    const vocabulary = new Set(
      (facet?.values ?? []).map((candidate) => norm(candidate.value)),
    );
    // Sparse catalog booleans often expose only "да"; products without the
    // feature omit the facet entirely instead of storing "нет". A vocabulary
    // containing only boolean literals is therefore boolean even when one side
    // is absent.
    const isBooleanFacet = vocabulary.size > 0 &&
      [...vocabulary].every((value) =>
        AFFIRMATIVE_VALUES.has(value) || NEGATIVE_VALUES.has(value)
      );
    const removable = isBooleanFacet && values.length > 0 &&
      values.every((value) => AFFIRMATIVE_VALUES.has(norm(value)));
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
  inferenceEvidence: string = declaredReasoning,
  explicitVisibleRequirements: ExplicitVisibleRequirement[] = [],
  inferencePolicy: SearchFilterInferencePolicy = {},
): SearchFilterGuardResult {
  const appearanceScope: AppearanceEvidenceScope = {
    currentUserMessage: inferencePolicy.currentUserMessage ?? userEvidence,
    trustedActiveProductTarget: inferencePolicy.trustedActiveProductTarget,
    trustedBaseUserMessage: inferencePolicy.trustedBaseUserMessage,
  };
  if (args.mode === "by_query") {
    const query = typeof args.query === "string" ? args.query : "";
    const unowned = unownedAppearanceMentionsInText(
      facets,
      query,
      appearanceScope,
    );
    return {
      // Do not rewrite a model-owned narrow query into an invalid empty
      // request or trust its category. The caller must honor this flag and
      // substitute a server-verified broad category browse before I/O.
      args,
      requiresBroadBrowse: unowned.length > 0,
      kept: [],
      user_backed: [],
      inferred: [],
      subsumed: [],
      dropped: unowned.map(({ key, value }) => ({
        key,
        value,
        reason: "not_declared_in_reasoning" as const,
      })),
    };
  }
  if (args.mode !== "by_filter") {
    return {
      args,
      requiresBroadBrowse: false,
      kept: [],
      user_backed: [],
      inferred: [],
      subsumed: [],
      dropped: [],
    };
  }

  const nextOptions: Record<string, string[]> = {};
  const kept: Array<{ key: string; value: string }> = [];
  const userBacked: Array<{ key: string; value: string }> = [];
  const inferred: Array<{ key: string; value: string }> = [];
  const subsumed: Array<
    { key: string; value: string; by_key: string; by_value: string }
  > = [];
  const dropped: DroppedSearchFilter[] = [];
  const unitConflictKeys = new Set<string>();
  const requestedOptions = args.options && typeof args.options === "object"
    ? args.options as Record<string, unknown>
    : {};

  for (const [key, rawValues] of Object.entries(requestedOptions)) {
    const values = Array.isArray(rawValues)
      ? rawValues.map(String).filter((v) => v.trim())
      : [];
    const facet = facets.find((candidate) =>
      candidate.key === key ||
      (candidate.caption && norm(candidate.caption) === norm(key))
    );
    if (!facet) {
      for (const value of values) {
        dropped.push({ key, value, reason: "unknown_facet" });
      }
      continue;
    }
    if (isAdministrativeCatalogField(facet)) {
      for (const value of values) {
        dropped.push({ key, value, reason: "unknown_facet" });
      }
      continue;
    }
    const canonicalKey = facet.key;

    for (const rawValue of values) {
      const canonical = facet.values.find((candidate) =>
        sameFacetValue(candidate.value, rawValue)
      )?.value;
      if (!canonical) {
        dropped.push({ key, value: rawValue, reason: "unknown_value" });
        continue;
      }
      if (!isAtomicFacetValue(canonical)) {
        dropped.push({ key, value: canonical, reason: "non_atomic_value" });
        continue;
      }
      if (
        isAbsenceOrUnknownFacetValue(canonical) &&
        !customerOwnsAbsentFacetValue(facet, canonical, userEvidence)
      ) {
        dropped.push({
          key,
          value: canonical,
          reason: "not_declared_in_reasoning",
        });
        continue;
      }
      if (
        numericFacetValueConflictsWithUserMeasurement(
          canonical,
          facet,
          userEvidence,
          declaredReasoning,
        )
      ) {
        unitConflictKeys.add(canonicalKey);
        dropped.push({ key, value: canonical, reason: "unit_conflict" });
        continue;
      }
      const visibleRequirementBacked = visibleRequirementAuthorizesFacetValue(
        facet,
        canonical,
        explicitVisibleRequirements,
      );
      if (
        !visibleRequirementBacked &&
        !numericFacetValueIsLocallyEvidenced(
          canonical,
          facet,
          declaredReasoning,
        )
      ) {
        dropped.push({
          key,
          value: canonical,
          reason: "not_declared_in_reasoning",
        });
        continue;
      }
      if (contradictedByUser(canonical, userEvidence)) {
        dropped.push({ key, value: canonical, reason: "negated_by_user" });
        continue;
      }
      if (
        !customerOwnsFacetValueAxis(
          facet,
          canonical,
          facets,
          userEvidence,
        )
      ) {
        dropped.push({
          key,
          value: canonical,
          reason: "not_declared_in_reasoning",
        });
        continue;
      }
      if (facetValueAppearsOnlyAsMeasurementNoun(canonical, userEvidence)) {
        dropped.push({
          key,
          value: canonical,
          reason: "not_declared_in_reasoning",
        });
        continue;
      }
      if (
        !customerOwnsAppearanceFacetValue(
          facet,
          canonical,
          userEvidence,
          appearanceScope,
        )
      ) {
        dropped.push({
          key,
          value: canonical,
          reason: "not_declared_in_reasoning",
        });
        continue;
      }
      const identityFacet = isReplacementIdentityFacet(facet);
      const authoritativeIdentity = identityFacet &&
        (inferencePolicy.authoritativeFacetValues ?? []).some((item) =>
          item.key === canonicalKey && sameFacetValue(item.value, canonical)
        );
      const customerIdentity = identityFacet && customerOwnsIdentityValue({
        facetLabel: `${facet.key} ${facet.caption ?? ""}`,
        value: canonical,
        userMessage: userEvidence,
        categoryLabel: typeof args.category === "string" ? args.category : null,
      });
      if (identityFacet && !customerIdentity && !authoritativeIdentity) {
        dropped.push({
          key,
          value: canonical,
          reason: "not_declared_in_reasoning",
        });
        continue;
      }
      const normalizedCanonical = norm(canonical);
      const isAffirmativeBoolean = AFFIRMATIVE_VALUES.has(normalizedCanonical);
      const facetLabel = facet.caption || facet.key;
      const labelUserStatus = isAffirmativeBoolean
        ? evidenceStatus(facetLabel, userEvidence)
        : "absent";
      if (labelUserStatus === "negated") {
        dropped.push({ key, value: canonical, reason: "negated_by_user" });
        continue;
      }
      // For a model-provided affirmative boolean, the evidence is the facet's
      // meaning ("Негорючесть") being declared, not the generic storage value
      // "Да". This remains strict: no missing boolean filter is inferred, and
      // a bare conversational "да" cannot activate an unrelated facet.
      const literalValueStatus =
        isAffirmativeBoolean && normalizedCanonical.length <= 3
          ? "absent"
          : evidenceStatus(canonical, declaredReasoning);
      const labelReasoningStatus = isAffirmativeBoolean
        ? evidenceStatus(facetLabel, declaredReasoning)
        : "absent";
      const status =
        visibleRequirementBacked || customerIdentity || authoritativeIdentity ||
          literalValueStatus === "affirmed" ||
          labelReasoningStatus === "affirmed"
          ? "affirmed"
          : literalValueStatus === "negated" ||
              labelReasoningStatus === "negated"
          ? "negated"
          : "absent";
      if (status !== "affirmed") {
        dropped.push({
          key,
          value: canonical,
          reason: status === "negated"
            ? "negated_by_user"
            : "not_declared_in_reasoning",
        });
        continue;
      }
      nextOptions[canonicalKey] ??= [];
      if (!nextOptions[canonicalKey].includes(canonical)) {
        nextOptions[canonicalKey].push(canonical);
      }
      kept.push({ key: canonicalKey, value: canonical });
      const pureNumericValue = /^\d+(?:[.,]\d+)?$/u.test(
        norm(canonical),
      );
      if (
        visibleRequirementBacked || customerIdentity || authoritativeIdentity ||
        customerOwnsAbsentFacetValue(facet, canonical, userEvidence) ||
        (explicitlyAffirmedByUser(canonical, userEvidence) &&
          facetStateQualifierIsUserBacked(facet, userEvidence) &&
          (!pureNumericValue || numericFacetValueIsLocallyEvidenced(
            canonical,
            facet,
            userEvidence,
          ))) ||
        (isAffirmativeBoolean && labelUserStatus === "affirmed")
      ) userBacked.push({ key: canonicalKey, value: canonical });
    }
  }

  // Scalar language such as "double" is normalized before catalog discovery
  // and therefore need not contain the literal stored value `2`. Project it
  // only when the requirement's own matcher identifies exactly one live
  // facet/value pair. This preserves omitted count/length filters without
  // letting a bare number activate poles, pack size, power, or another axis.
  for (const requirement of explicitVisibleRequirements) {
    if (requirement?.op !== "eq" || requirement.value === undefined) continue;
    const matches = facets.flatMap((facet) => {
      if (
        nextOptions[facet.key]?.length || isReplacementIdentityFacet(facet) ||
        isAdministrativeCatalogField(facet)
      ) return [];
      return facet.values.flatMap(({ value }) =>
        isAtomicFacetValue(value) &&
          (!isAbsenceOrUnknownFacetValue(value) ||
            customerOwnsAbsentFacetValue(facet, value, userEvidence)) &&
          !numericFacetValueConflictsWithUserMeasurement(
            value,
            facet,
            userEvidence,
            declaredReasoning,
          ) &&
          visibleRequirementAuthorizesFacetValue(facet, value, [requirement])
          ? [{ key: facet.key, value }]
          : []
      );
    });
    if (matches.length !== 1) continue;
    const item = matches[0];
    nextOptions[item.key] = [item.value];
    kept.push(item);
    userBacked.push(item);
    inferred.push(item);
  }

  // An explicitly named affirmative feature is stronger than a bare
  // conversational "да". When the live facet itself is present verbatim in
  // the customer's request and exposes exactly one affirmative value, project
  // that value even if the model omitted it. This is category-neutral and
  // cannot activate unrelated booleans because the facet label, not the stored
  // value, must be customer-backed.
  for (const facet of facets) {
    if (
      nextOptions[facet.key]?.length || isReplacementIdentityFacet(facet) ||
      isAdministrativeCatalogField(facet)
    ) continue;
    const affirmative = facet.values.filter((candidate) =>
      isAtomicFacetValue(candidate.value) &&
      AFFIRMATIVE_VALUES.has(norm(candidate.value))
    );
    if (affirmative.length !== 1) continue;
    const label = facet.caption || facet.key;
    if (evidenceStatus(label, userEvidence) !== "affirmed") continue;
    const item = { key: facet.key, value: affirmative[0].value };
    nextOptions[item.key] = [item.value];
    kept.push(item);
    userBacked.push(item);
    inferred.push(item);
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
  // Pure numbers are accepted only when the same compact user phrase also
  // names this exact live facet. This preserves unitless catalog constraints
  // such as "1 pole" without letting a budget become wattage, length or pack
  // size merely because the number happens to coincide.
  for (const facet of facets) {
    if (nextOptions[facet.key]?.length) continue;
    // Brand/model/series values are identifiers, not product properties. Never
    // synthesize them by scanning free prose: short identifiers such as the
    // brand "Свет" collide with ordinary words ("общего света") and can turn
    // a broad valid request into a permanently empty catalog intersection.
    // An identity option is still accepted when the model explicitly supplies
    // it and the normal evidence checks above confirm it.
    if (
      isReplacementIdentityFacet(facet) ||
      isAdministrativeCatalogField(facet)
    ) continue;
    const evidenced = facet.values.filter((candidate) => {
      const normalized = norm(candidate.value);
      if (!isAtomicFacetValue(candidate.value)) return false;
      if (
        !customerOwnsAppearanceFacetValue(
          facet,
          candidate.value,
          userEvidence,
          appearanceScope,
        )
      ) return false;
      if (
        numericFacetValueConflictsWithUserMeasurement(
          candidate.value,
          facet,
          userEvidence,
          declaredReasoning,
        )
      ) return false;
      if (
        !normalized || ["да", "нет", "есть", "отсутствует"].includes(normalized)
      ) return false;
      if (
        facetValueAppearsOnlyAsMeasurementNoun(candidate.value, userEvidence)
      ) return false;
      // The live schema can expose hundreds of values. First establish that
      // this value is actually present in the customer's text; only those
      // few candidates need the more expensive sibling-axis ambiguity check.
      // The numeric path has its own local-axis proof below.
      if (/^[a-zа-я]$/u.test(normalized)) return false;
      const hasLetters = /[a-zа-я]/iu.test(normalized);
      if (
        hasLetters &&
        !explicitlyAffirmedByUser(candidate.value, userEvidence)
      ) return false;
      if (
        !hasLetters &&
        !(/^\d+(?:[.,]\d+)?$/u.test(normalized) &&
          numericFacetValueIsLocallyEvidenced(
            candidate.value,
            facet,
            userEvidence,
          ) &&
          facetStateQualifierIsUserBacked(facet, userEvidence))
      ) return false;
      if (
        !customerOwnsFacetValueAxis(
          facet,
          candidate.value,
          facets,
          userEvidence,
        )
      ) return false;
      return true;
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
  for (const facet of facets) {
    if (
      nextOptions[facet.key]?.length || unitConflictKeys.has(facet.key) ||
      isReplacementIdentityFacet(facet) ||
      isAdministrativeCatalogField(facet)
    ) {
      continue;
    }
    // Missing numeric/options may be completed only from actual consultant
    // reasoning. At the discovery boundary declaredReasoning can contain only
    // the customer's application measurement (for example cable diameter),
    // which must not be copied into several product-state facets before the
    // consultant has expressed the directed compatibility relation.
    // This is model-reasoning completion, not customer-owned projection. The
    // facet meaning must be present, and candidate-level validation below
    // rejects an ambiguous shared root when sibling axes expose the same value
    // (`цвет корпуса` vs `цвет свечения`).
    if (inferencePolicy.allowProseOnlyFacetInference === false) continue;
    if (!facetMeaningIsEvidenced(facet, inferenceEvidence)) continue;
    const evidenced = facet.values.filter((candidate) => {
      const value = norm(candidate.value);
      if (!isAtomicFacetValue(candidate.value)) return false;
      if (
        !customerOwnsAppearanceFacetValue(
          facet,
          candidate.value,
          userEvidence,
          appearanceScope,
        )
      ) return false;
      if (!value || ["да", "нет", "есть", "отсутствует"].includes(value)) {
        return false;
      }
      if (
        inferencePolicy.allowDerivedNumericFacetInference === false &&
        /\d/u.test(value)
      ) return false;
      if (
        !numericFacetValueIsLocallyEvidenced(
          candidate.value,
          facet,
          inferenceEvidence,
        )
      ) {
        return false;
      }
      if (
        !explicitlyAffirmedByFacetReasoning(
          candidate.value,
          inferenceEvidence,
        )
      ) return false;
      if (
        !facetMeaningIsDisambiguatedForValue(
          facet,
          candidate.value,
          facets,
          inferenceEvidence,
        )
      ) return false;
      if (
        !customerOwnsFacetValueAxis(
          facet,
          candidate.value,
          facets,
          userEvidence,
        )
      ) return false;
      if (
        numericFacetValueConflictsWithUserMeasurement(
          candidate.value,
          facet,
          userEvidence,
          inferenceEvidence,
        )
      ) return false;
      return true;
    });
    if (evidenced.length !== 1) continue;
    const value = evidenced[0].value;
    nextOptions[facet.key] = [value];
    const item = { key: facet.key, value };
    kept.push(item);
    inferred.push(item);
  }

  // One-letter technical values are too short for ordinary free-text
  // projection. Admit them only when the customer writes a code-shaped token
  // next to the meaning of one unique live facet (`характеристика C`). This
  // is live-schema driven and a lowercase Cyrillic preposition cannot open it.
  // Run after reasoning projection so an already selected option keeps its
  // stable order while gaining customer-owned provenance.
  const shortCodeMatches = facets.flatMap((facet) => {
    if (
      isReplacementIdentityFacet(facet) ||
      isAdministrativeCatalogField(facet)
    ) return [];
    return facet.values.flatMap(({ value }) =>
      explicitShortFacetCodeIsLocallyEvidenced(facet, value, userEvidence)
        ? [{ key: facet.key, value }]
        : []
    );
  });
  if (shortCodeMatches.length === 1) {
    const item = shortCodeMatches[0];
    const alreadySelected = nextOptions[item.key]?.includes(item.value) ??
      false;
    if (!alreadySelected) {
      nextOptions[item.key] = [item.value];
      kept.push(item);
      inferred.push(item);
    }
    if (
      !userBacked.some((candidate) =>
        candidate.key === item.key && candidate.value === item.value
      )
    ) userBacked.push(item);
  }

  // A model can serialize two neighbouring scalar values onto the same live
  // facet (`25 A, 1 pole` -> current=[25,1]). Once at least one value on that
  // axis is explicitly customer-backed, unowned alternatives on the same axis
  // cannot broaden the query. Preserve every customer-backed alternative so
  // genuine requests such as "red or black" remain an OR search.
  for (const [key, values] of Object.entries({ ...nextOptions })) {
    const authoritativeValues = (inferencePolicy.authoritativeFacetValues ?? [])
      .filter((item) => item.key === key)
      .map((item) => item.value);
    const explicitValues = [
      ...new Set(
        authoritativeValues.length > 0
          ? authoritativeValues
          : userBacked.filter((item) => item.key === key).map((item) =>
            item.value
          ),
      ),
    ];
    if (explicitValues.length === 0) continue;
    const retained = values.filter((value) => explicitValues.includes(value));
    if (retained.length === 0 || retained.length === values.length) continue;
    nextOptions[key] = retained;
    for (let index = kept.length - 1; index >= 0; index--) {
      if (kept[index].key === key && !retained.includes(kept[index].value)) {
        dropped.push({
          key,
          value: kept[index].value,
          reason: "not_declared_in_reasoning",
        });
        kept.splice(index, 1);
      }
    }
    for (let index = inferred.length - 1; index >= 0; index--) {
      if (
        inferred[index].key === key && !retained.includes(inferred[index].value)
      ) {
        inferred.splice(index, 1);
      }
    }
    for (let index = userBacked.length - 1; index >= 0; index--) {
      if (
        userBacked[index].key === key &&
        !retained.includes(userBacked[index].value)
      ) userBacked.splice(index, 1);
    }
  }

  // A compound canonical value can already encode another explicit filter
  // ("Бытовые светильники накладные" includes mounting="накладной"). Sending
  // both to an inconsistent legacy catalog turns a valid request into an empty
  // intersection. Keep the richer value and remove only a strictly subsumed
  // option; the richer value remains an enforced render criterion.
  for (const [key, values] of Object.entries({ ...nextOptions })) {
    if (values.length === 0) continue;
    const covering = Object.entries(nextOptions).find((
      [otherKey, otherValues],
    ) => (
      otherKey !== key &&
      values.every((value) =>
        otherValues.some((otherValue) => valueSubsumes(otherValue, value))
      )
    ));
    if (!covering) continue;
    const [byKey, byValues] = covering;
    for (const value of values) {
      const byValue = byValues.find((candidate) =>
        valueSubsumes(candidate, value)
      );
      if (byValue) {
        subsumed.push({ key, value, by_key: byKey, by_value: byValue });
      }
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
  return {
    args: nextArgs,
    requiresBroadBrowse: false,
    kept,
    user_backed: userBacked,
    inferred,
    subsumed,
    dropped,
  };
}
