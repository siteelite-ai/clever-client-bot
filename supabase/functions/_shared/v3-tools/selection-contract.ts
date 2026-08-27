import type { ProductRef } from "./types.ts";
import type { Criterion } from "./criteria-gate.ts";

export interface SelectionTargetReport {
  target: string;
  passed_ids: string[];
  rejected_ids: string[];
  per_product: Array<{
    id: string;
    matched: string[];
    missing: string[];
    coverage: number;
  }>;
}

export interface SelectionTargetProjection {
  product_class: string;
  application_context: string[];
}

/**
 * Keeps the verified product class monotonic across failed render attempts.
 * A newly declared class may initialize an empty contract, but it may refine
 * an existing class only after at least one live card proves that refinement.
 */
export function advanceSelectionTarget(
  currentTarget: string | null,
  declaredTarget: string,
  verifiedProductCount: number,
  groundedAliasExpansion = false,
): string | null {
  const current = String(currentTarget ?? "").trim();
  const declared = String(declaredTarget ?? "").trim();
  if (!declared) return current || null;
  if (!current) return declared;
  return verifiedProductCount > 0 && (
      selectionTargetPreservesGroundedBase(current, declared) || groundedAliasExpansion
    )
    ? declared
    : current;
}

/**
 * A later model turn may refine the already grounded class, but it cannot
 * replace it with a sibling merely because the new pool proves that sibling.
 * This is intentionally lexical and category-neutral: the frozen base token
 * must remain present after normal inflection/stemming. Independent alias
 * recovery is handled before a class is frozen, never by self-authorizing a
 * new render target from the products it just searched.
 */
export function selectionTargetPreservesGroundedBase(
  currentTarget: string | null,
  declaredTarget: string,
): boolean {
  const current = String(currentTarget ?? "").trim();
  const declared = String(declaredTarget ?? "").trim();
  if (!current) return Boolean(declared);
  if (!declared) return false;
  return selectionTargetIsDeclared(current, declared);
}

function captionText(value: unknown, limit = 100): string {
  return String(value ?? "")
    .replace(/[<>\p{Cc}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

function formatCriterionValue(criterion: Criterion): string {
  const unit = captionText(criterion.unit ?? "", 16);
  const suffix = unit ? ` ${unit}` : "";
  if (criterion.op === "range" && Array.isArray(criterion.value)) {
    return `${captionText(criterion.value[0], 24)}–${captionText(criterion.value[1], 24)}${suffix}`;
  }
  const value = captionText(criterion.value, 60);
  if (criterion.op === "min") return `${criterion.exclusive ? "более" : "от"} ${value}${suffix}`;
  if (criterion.op === "max") return `${criterion.exclusive ? "менее" : "до"} ${value}${suffix}`;
  return `${value}${suffix}`;
}

/**
 * Builds a deterministic explanation only after target and criteria gates have
 * passed. This preserves the consultant's machine-readable reasoning when a
 * provider emits a tool call without visible prose. It contains no catalog
 * facts beyond the exact verified render contract and no product vocabulary.
 */
export function buildSelectionEvidenceCaption(
  targetValue: unknown,
  criteria: Criterion[],
): string | null {
  const target = parseSelectionTarget(targetValue);
  const mandatory = (Array.isArray(criteria) ? criteria : [])
    .filter((criterion) => criterion?.key && criterion.value !== undefined && (criterion.level ?? "A") === "A")
    .slice(0, 6);
  if (mandatory.length === 0) return null;
  const context = target.application_context.map((item) => captionText(item, 80)).filter(Boolean).slice(0, 3);
  const clauses = mandatory.map((criterion) =>
    `${captionText(criterion.key, 80)} — ${formatCriterionValue(criterion)}`
  );
  const prefix = context.length > 0
    ? `Для задачи «${context.join(", ")}»`
    : "Для этой задачи";
  return `${prefix} проверены обязательные параметры товара: ${clauses.join("; ")}. Ниже — варианты, прошедшие эти условия.`;
}

/**
 * Guarantees a visible, truthful explanation for every successful selection
 * render. Prefer the verified criterion evidence above. When a provider leaves
 * the machine-readable criterion list empty, fall back only to the already
 * verified target contract: application context and product class. This keeps
 * the reasoning visible without inventing catalog characteristics.
 */
export function buildSelectionRenderCaption(
  targetValue: unknown,
  criteria: Criterion[],
): string {
  const evidenceCaption = buildSelectionEvidenceCaption(targetValue, criteria);
  if (evidenceCaption) return evidenceCaption;

  const target = parseSelectionTarget(targetValue);
  const context = target.application_context
    .map((item) => captionText(item, 80))
    .filter(Boolean)
    .slice(0, 3);
  const productClass = captionText(target.product_class, 100);
  const subject = productClass
    ? `варианты класса «${productClass}»`
    : "варианты товаров";
  if (context.length > 0) {
    return `Для задачи «${context.join(", ")}» показываю ${subject}, прошедшие проверку соответствия заявленному типу товара.`;
  }
  return `Показываю ${subject}, прошедшие проверку соответствия заявленному типу товара.`;
}

/** Keeps class identity separate from suitability/application constraints. */
export function parseSelectionTarget(value: unknown): SelectionTargetProjection {
  if (typeof value === "string") {
    return { product_class: value.trim(), application_context: [] };
  }
  if (!value || typeof value !== "object") return { product_class: "", application_context: [] };
  const raw = value as Record<string, unknown>;
  return {
    product_class: typeof raw.product_class === "string" ? raw.product_class.trim() : "",
    application_context: Array.isArray(raw.application_context)
      ? raw.application_context.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 6)
      : [],
  };
}

const META_WORDS = new Set([
  "товар", "товары", "товара", "вариант", "варианты", "модель", "модели",
  "оборудование", "решение", "подходящий", "подходящие", "нужный", "нужные",
  "каталог", "ассортимент", "сайт", "цена", "бюджет", "для", "или", "под",
  "with", "from", "product", "products",
]);

function normalize(value: string): string {
  return String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/giu, " ")
    .trim();
}

/** Item identity fields describe one source record, not a reusable product
 * class. This is a schema-role boundary (not a product vocabulary): a source
 * brand, model, localized title, article or catalog code can never prove that
 * an analog belongs to the requested class. Explicit same-identity wishes are
 * handled by the ordinary user-backed criteria contract instead. */
function isItemIdentityLabel(value: string): boolean {
  const label = ` ${normalize(value)} `;
  return /(?:^| )(?:brand|vendor|manufacturer|producer|trademark|бренд|производител\p{L}*|торгов\p{L}* марк\p{L}*|марка|model|series|collection|модел\p{L}*|сери\p{L}*|коллекц\p{L}*|name|title|наименован\p{L}*|назван\p{L}*|article|артикул|sku|код номенклатур\p{L}*|идентификатор|barcode|штрихкод)(?: |$)/u.test(label);
}

function stem(token: string): string {
  if (/^[a-z0-9]+$/u.test(token)) return token;
  if (token.length >= 7) return token.slice(0, 5);
  if (token.length >= 5) return token.slice(0, 4);
  return token;
}

function meaningfulTokens(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of normalize(value).split(/\s+/u)) {
    if (!token || token.length < 3 || META_WORDS.has(token) || /^\d+$/u.test(token)) continue;
    const key = stem(token);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function meaningfulRawTokens(value: string): string[] {
  return normalize(value).split(/\s+/u)
    .filter((token) => token && token.length >= 3 && !META_WORDS.has(token) && !/^\d+$/u.test(token));
}

/**
 * Allows a frozen shorthand to expand into a formal live class only when the
 * initial explanation explicitly declared the two forms as a parenthetical
 * alias and both retain a shared class head. The shared head is the safety
 * boundary: prose such as "voltage stabilizer (UPS)" cannot turn one sibling
 * class into another, even if the searched taxonomy contains the new class.
 */
export function selectionTargetAliasExpansionIsGrounded(
  currentTarget: string | null,
  declaredTarget: string,
  initialEvidence: string,
  liveClass: string,
): boolean {
  const current = String(currentTarget ?? "").trim();
  const declared = String(declaredTarget ?? "").trim();
  const evidence = String(initialEvidence ?? "");
  const taxonomy = String(liveClass ?? "").trim();
  if (!current || !declared || !evidence || !taxonomy) return false;
  if (!(
    selectionTargetIsDeclared(declared, taxonomy) ||
    selectionTargetIsDeclared(taxonomy, declared)
  )) return false;

  const currentTokens = meaningfulTokens(current);
  const declaredTokens = meaningfulTokens(declared);
  const shared = currentTokens.filter((token) => declaredTokens.includes(token));
  const currentOnly = currentTokens.filter((token) => !declaredTokens.includes(token));
  const declaredOnly = declaredTokens.filter((token) => !currentTokens.includes(token));
  if (shared.length === 0 || currentOnly.length === 0 || declaredOnly.length === 0) return false;

  const containsAll = (container: string, wanted: string[]) => {
    const tokens = new Set(meaningfulTokens(container));
    return wanted.every((token) => tokens.has(token));
  };
  const aliasPairs = evidence.matchAll(/([^().!?\n]{1,120})\s*\(([^()\n]{2,50})\)/gu);
  for (const match of aliasPairs) {
    const phrase = match[1];
    const parenthetical = match[2];
    if (
      containsAll(phrase, declaredTokens) && containsAll(parenthetical, currentOnly) ||
      containsAll(phrase, currentTokens) && containsAll(parenthetical, declaredOnly)
    ) return true;
  }
  return false;
}
/**
 * Recognises only an explicit list of bare product-class heads. This is much
 * narrower than splitting every conjunction: sockets and switches is a set
 * of alternative classes, while motion sensor and illuminance remains one
 * compound identity contract because one side contains more than one
 * meaningful token. Keeping that distinction prevents an attribute joined by
 * "and" from silently becoming optional.
 */
function bareClassAlternatives(value: string): string[] | null {
  const raw = String(value ?? "").trim();
  const connector = /(?:[,;/]|(?<!\p{L})(?:и|или|and|or)(?!\p{L}))/iu;
  if (!connector.test(raw)) return null;
  const parts = raw
    .split(/\s*(?:[,;/]|(?<!\p{L})(?:и|или|and|or)(?!\p{L}))\s*/iu)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2 || parts.some((part) => meaningfulRawTokens(part).length !== 1)) return null;
  return parts;
}

/**
 * Catalog families and standards are often written either as one compact code
 * or as adjacent title tokens (for example `ABcd` vs `AB cd`). Treat only an
 * exact concatenation of consecutive live-title tokens as the same identity;
 * substring matching is deliberately forbidden so a broad word cannot prove a
 * different class.
 */
function productEvidenceMatchesToken(product: ProductRef, rawTargetToken: string): boolean {
  const evidenceTokens = normalize(productEvidence(product)).split(/\s+/u).filter(Boolean);
  const targetStem = stem(rawTargetToken);
  if (evidenceTokens.some((token) => token.length >= 3 && stem(token) === targetStem)) return true;
  if (rawTargetToken.length > 16 || evidenceTokens.length < 2) return false;
  for (let start = 0; start < evidenceTokens.length - 1; start += 1) {
    let compact = evidenceTokens[start];
    for (let end = start + 1; end < Math.min(evidenceTokens.length, start + 4); end += 1) {
      compact += evidenceTokens[end];
      if (compact === rawTargetToken) return true;
      if (compact.length >= rawTargetToken.length) break;
    }
  }
  return false;
}

/** A render target must already be present in the customer's request or in the
 * consultant's initial product-class declaration. Later search vocabulary is
 * not allowed to rename the target to a sibling class. */
export function selectionTargetIsDeclared(target: string, initialEvidence: string): boolean {
  const targetTokens = meaningfulTokens(target);
  if (targetTokens.length === 0) return false;
  const evidence = new Set(meaningfulTokens(initialEvidence));
  const matched = targetTokens.filter((token) => evidence.has(token)).length;
  return targetTokens.length <= 2
    ? matched === targetTokens.length
    : matched >= 2 && matched / targetTokens.length >= 0.75;
}

/** Freeze the product-class declaration before explicit search planning can
 * add sibling category names. The boundary is linguistic workflow vocabulary,
 * not a product/category dictionary, so a longer expert explanation remains
 * available while "what I will search" cannot rename the target. */
export function initialSelectionDeclaration(text: string): string {
  return String(text ?? "")
    .split(/(?<!\p{L})(?:(?:сейчас|теперь)\s+)?(?:смотрю|посмотрю|проверяю|проверю|искать\s+буду|буду\s+искать|иду\s+(?:смотреть|проверять|искать))(?!\p{L})/iu)[0]
    .trim();
}

/**
 * Supplies a conservative terminal target when discovery succeeded but the
 * model exhausted the turn before emitting `render_products`. The target is
 * live taxonomy, accepted only when that same base class was already declared
 * by the user or the consultant before search planning began.
 */
export function bootstrapSelectionTargetFromTaxonomy(
  initialEvidence: string,
  liveClass: string,
): string | null {
  const candidate = String(liveClass ?? "").trim();
  if (!candidate || meaningfulTokens(candidate).length === 0) return null;
  return selectionTargetIsDeclared(candidate, initialEvidence) ? candidate : null;
}

/** Prefer the short noun that discovery actually resolved when it was already
 * stated before search. This preserves a customer's ordinary class wording
 * even when the live category has a longer formal title. Full-message nouns
 * are deliberately rejected so a timeout fallback cannot turn the whole
 * request into a product class. */
export function bootstrapSelectionTargetFromDiscovery(
  initialEvidence: string,
  resolvedFrom: string,
  liveClass: string,
): string | null {
  const resolved = String(resolvedFrom ?? "").trim();
  const resolvedTokens = meaningfulTokens(resolved);
  const rawTokenCount = normalize(resolved).split(/\s+/u).filter(Boolean).length;
  const taxonomyBase = bootstrapSelectionTargetFromTaxonomy(initialEvidence, liveClass);
  const taxonomyTokens = meaningfulTokens(taxonomyBase ?? "");
  if (
    taxonomyBase &&
    taxonomyTokens.length > 0 &&
    taxonomyTokens.length < resolvedTokens.length &&
    selectionTargetIsDeclared(taxonomyBase, resolved)
  ) {
    return taxonomyBase;
  }
  if (
    resolvedTokens.length > 0 &&
    resolvedTokens.length <= 3 &&
    rawTokenCount <= 3 &&
    selectionTargetIsDeclared(resolved, initialEvidence)
  ) {
    return resolved;
  }
  return taxonomyBase;
}

/** A discovered taxonomy label cannot declare itself. It may complete a
 * render target only when that same live base class was already grounded in
 * the pre-search request/reasoning. */
export function selectionTargetDeclarationIsGrounded(
  target: string,
  initialEvidence: string,
  liveClass: string,
): boolean {
  if (selectionTargetIsDeclared(target, initialEvidence)) return true;
  const groundedLiveClass = bootstrapSelectionTargetFromTaxonomy(initialEvidence, liveClass);
  if (
    groundedLiveClass &&
    selectionTargetIsDeclared(target, groundedLiveClass)
  ) return true;

  // Some formal taxonomy classes begin with a word derived from the short
  // customer noun (for example noun → adjective) and add a catalog head that
  // ordinary speech omits. Allow that completion only when the leading target
  // token is already present before search AND the complete target is proven
  // by independent live taxonomy. Requiring the leading token prevents a
  // shared trailing umbrella noun from authorizing a sibling modifier.
  const targetTokens = meaningfulTokens(target);
  const initialTokens = new Set(meaningfulTokens(initialEvidence));
  const leadingTargetIsGrounded = targetTokens.length >= 2 && initialTokens.has(targetTokens[0]);
  const targetMatchesLiveClass = selectionTargetIsDeclared(target, liveClass) ||
    selectionTargetIsDeclared(liveClass, target);
  return leadingTargetIsGrounded && targetMatchesLiveClass;
}

/**
 * A short continuation may omit the class already shown in the previous
 * product batch. Accept that class only with two independent proofs: it is
 * present in prior dialogue evidence and it is the same live taxonomy class
 * discovered for the current turn. Either signal alone remains insufficient.
 */
export function continuedSelectionTargetIsGrounded(
  target: string,
  priorDialogueEvidence: string,
  liveClass: string,
  resolvedFrom = "",
): boolean {
  const priorBase = resolvedFrom
    ? bootstrapSelectionTargetFromDiscovery(
      priorDialogueEvidence,
      resolvedFrom,
      liveClass,
    )
    : null;
  const priorDeclaresTarget = selectionTargetIsDeclared(target, priorDialogueEvidence) || Boolean(
    priorBase && selectionTargetIsDeclared(priorBase, target),
  );
  return Boolean(
    target &&
    liveClass &&
    priorDeclaresTarget &&
    selectionTargetIsDeclared(liveClass, target),
  );
}

/**
 * A provider may accidentally append a mandatory attribute to product_class
 * even though it also serialized that attribute as a level-A criterion. The
 * server may keep the already grounded base class only when every added class
 * token is represented by that mandatory criterion. The criteria gate remains
 * responsible for proving the attribute on every card, so this cannot turn an
 * unverified application phrase into product identity.
 */
export function selectionTargetExtensionIsCriterionBacked(
  baseTarget: string,
  extendedTarget: string,
  criteria: Criterion[],
): boolean {
  const baseTokens = new Set(meaningfulTokens(baseTarget));
  const extraTokens = meaningfulTokens(extendedTarget).filter((token) => !baseTokens.has(token));
  if (baseTokens.size === 0 || extraTokens.length === 0) return false;
  const mandatoryEvidence = new Set((Array.isArray(criteria) ? criteria : [])
    .filter((criterion) => criterion && (criterion.level ?? "A") === "A")
    .flatMap((criterion) => meaningfulTokens(`${criterion.key} ${String(criterion.value ?? "")}`)));
  return mandatoryEvidence.size > 0 && extraTokens.every((token) => mandatoryEvidence.has(token));
}

/**
 * A provider may correctly describe a class-defining facet in the structured
 * selection target but leave the matching criterion advisory. Promote only
 * values explicitly repeated in the product-class part of that structured
 * target. Application context is deliberately excluded: it may contain the
 * source SKU, brand or use case and therefore cannot define replacement
 * identity. The resulting criterion is still verified against live catalog
 * evidence before any card is rendered, so model prose cannot prove itself or
 * rename a sibling.
 */
export function promoteSelectionTargetBackingCriteria(
  baseTarget: string | null,
  targetValue: unknown,
  criteria: Criterion[],
): { criteria: Criterion[]; promoted: Criterion[]; backing: Criterion[] } {
  const base = String(baseTarget ?? "").trim();
  const target = parseSelectionTarget(targetValue);
  if (
    !base || !target.product_class ||
    !selectionTargetIsDeclared(base, target.product_class)
  ) {
    return {
      criteria: (Array.isArray(criteria) ? criteria : []).map((criterion) => ({ ...criterion })),
      promoted: [],
      backing: [],
    };
  }
  const baseTokens = new Set(meaningfulTokens(base));
  const targetTokens = new Set(
    meaningfulTokens(target.product_class).filter((token) => !baseTokens.has(token)),
  );
  const promoted: Criterion[] = [];
  const backing: Criterion[] = [];
  const next = (Array.isArray(criteria) ? criteria : []).map((criterion) => {
    if (isItemIdentityLabel(criterion.key)) return { ...criterion };
    const rawValues = Array.isArray(criterion.value)
      ? criterion.value
      : [criterion.value];
    const valueTokens = meaningfulTokens(rawValues.map(String).join(" "));
    if (!valueTokens.some((token) => targetTokens.has(token))) {
      return { ...criterion };
    }
    const upgraded = { ...criterion, level: "A" as const };
    backing.push(upgraded);
    if ((criterion.level ?? "A") === "B") promoted.push(upgraded);
    return upgraded;
  });
  return { criteria: next, promoted, backing };
}

/**
 * Preserve a suitability constraint that the provider repeated verbatim in
 * the structured application context. This is intentionally narrower than
 * treating the whole context as product identity: only an existing criterion
 * value may be upgraded, every value token must be present in the context,
 * and source-record fields (brand, model, title, article, etc.) are excluded.
 * The catalog criteria gate must still prove the upgraded value on every card.
 *
 * This matters most when a replacement anchor is absent. In that branch the
 * source card cannot prove the class, so dropping a declared mounting method
 * or application would otherwise allow a sibling product to pass a generic
 * product-class gate.
 */
export function promoteSelectionApplicationBackingCriteria(
  targetValue: unknown,
  criteria: Criterion[],
): { criteria: Criterion[]; promoted: Criterion[]; backing: Criterion[] } {
  const target = parseSelectionTarget(targetValue);
  const contextMeaningfulTokens = target.application_context.flatMap(meaningfulTokens);
  const contextTokens = new Set(
    target.application_context.flatMap((item) =>
      normalize(item).split(/\s+/u).filter((token) => token.length >= 2)
    ),
  );
  if (!target.product_class || contextTokens.size === 0) {
    return {
      criteria: (Array.isArray(criteria) ? criteria : []).map((criterion) => ({ ...criterion })),
      promoted: [],
      backing: [],
    };
  }

  const promoted: Criterion[] = [];
  const backing: Criterion[] = [];
  const editDistance = (left: string, right: string) => {
    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let row = 1; row <= left.length; row += 1) {
      let diagonal = previous[0];
      previous[0] = row;
      for (let column = 1; column <= right.length; column += 1) {
        const above = previous[column];
        previous[column] = Math.min(
          previous[column] + 1,
          previous[column - 1] + 1,
          diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
        );
        diagonal = above;
      }
    }
    return previous[right.length];
  };
  const next = (Array.isArray(criteria) ? criteria : []).map((criterion) => {
    if (isItemIdentityLabel(criterion.key)) return { ...criterion };
    const rawValues = Array.isArray(criterion.value) ? criterion.value : [criterion.value];
    const valueTokens = rawValues
      .flatMap((value) => normalize(String(value ?? "")).split(/\s+/u))
      .filter((token) => token.length >= 2 && !META_WORDS.has(token));
    const meaningfulValueTokens = rawValues.flatMap((value) => meaningfulTokens(String(value ?? "")));
    const exactMeaningfulMatches = meaningfulValueTokens.filter((token) =>
      contextMeaningfulTokens.includes(token)
    ).length;
    const morphologicallyRepeated = meaningfulValueTokens.length > 0 && meaningfulValueTokens.every((token) =>
      contextMeaningfulTokens.some((contextToken) => {
        if (token === contextToken) return true;
        const allowedDistance = exactMeaningfulMatches > 0 ? 2 : 1;
        return Math.min(token.length, contextToken.length) >= 4 &&
          editDistance(token, contextToken) <= allowedDistance;
      })
    );
    const literallyRepeated = valueTokens.length > 0 && valueTokens.every((token) => contextTokens.has(token));
    if (!literallyRepeated && !morphologicallyRepeated) {
      return { ...criterion };
    }
    const upgraded = { ...criterion, level: "A" as const };
    backing.push(upgraded);
    if ((criterion.level ?? "A") === "B") promoted.push(upgraded);
    return upgraded;
  });
  return { criteria: next, promoted, backing };
}

/** Restore an earlier proof-qualified class criterion after later compatibility
 * normalization. Same-key replacements are intentional: an accidental scalar
 * relation must not overwrite the live facet value that defined the target. */
export function restoreSelectionTargetBackingCriteria(
  criteria: Criterion[],
  backing: Criterion[],
): Criterion[] {
  const normalizeKey = (value: string) => String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/[^a-zа-я0-9]+/giu, " ")
    .trim();
  const restored = (Array.isArray(backing) ? backing : [])
    .filter((criterion) => criterion?.key)
    .map((criterion) => ({ ...criterion, level: "A" as const }));
  if (restored.length === 0) {
    return (Array.isArray(criteria) ? criteria : []).map((criterion) => ({ ...criterion }));
  }
  const restoredKeys = new Set(restored.map((criterion) => normalizeKey(criterion.key)));
  return [
    ...(Array.isArray(criteria) ? criteria : [])
      .filter((criterion) => !restoredKeys.has(normalizeKey(criterion.key)))
      .map((criterion) => ({ ...criterion })),
    ...restored,
  ];
}

/**
 * Reject a card when its visible title explicitly names a sibling value of a
 * mandatory categorical facet. Catalog traits remain the primary proof, but
 * they cannot overrule a direct customer-visible contradiction such as a
 * `ceiling` title under a mandatory `console-mounted` criterion. The sibling
 * vocabulary comes exclusively from the discovered live facet, so this guard
 * contains no product-specific dictionary.
 */
export function filterProductsByMandatoryFacetTitleContradictions<T extends ProductRef>(
  products: T[],
  criteria: Criterion[],
  facets: Array<{
    key: string;
    caption?: string | null;
    values?: Array<{ value: string }>;
  }>,
): { products: T[]; rejected_ids: string[] } {
  const mandatory = (Array.isArray(criteria) ? criteria : []).filter((criterion) =>
    criterion &&
    (criterion.level ?? "A") === "A" &&
    criterion.op === "eq" &&
    !isItemIdentityLabel(criterion.key)
  );
  if (mandatory.length === 0 || !Array.isArray(facets) || facets.length === 0) {
    return { products: [...products], rejected_ids: [] };
  }

  const constraints = facets.flatMap((facet) => {
    const facetLabels = [facet.key, facet.caption ?? ""].map(normalize).filter(Boolean);
    const matchingCriteria = mandatory.filter((criterion) =>
      facetLabels.includes(normalize(criterion.key))
    );
    if (matchingCriteria.length === 0) return [];
    const desired = matchingCriteria
      .flatMap((criterion) => Array.isArray(criterion.value) ? criterion.value : [criterion.value])
      .map((value) => normalize(String(value ?? "")))
      .filter(Boolean);
    const liveValues = (Array.isArray(facet.values) ? facet.values : [])
      .map(({ value }) => normalize(String(value ?? "")))
      .filter((value) => value.length >= 3 && /\p{L}/u.test(value));
    if (desired.length === 0 || liveValues.length < 2) return [];
    const siblings = liveValues.filter((value) => !desired.includes(value));
    return siblings.length > 0 ? [{ desired, siblings }] : [];
  });
  if (constraints.length === 0) return { products: [...products], rejected_ids: [] };

  const titleContains = (title: string, value: string) => {
    const haystack = ` ${normalize(title)} `;
    return haystack.includes(` ${value} `);
  };
  const rejected = new Set<string>();
  const safeProducts = products.filter((product) => {
    for (const constraint of constraints) {
      if (constraint.desired.some((value) => titleContains(product.pagetitle, value))) continue;
      if (constraint.siblings.some((value) => titleContains(product.pagetitle, value))) {
        rejected.add(product.id);
        return false;
      }
    }
    return true;
  });
  return { products: safeProducts, rejected_ids: [...rejected] };
}

/**
 * Compile a structured product-class refinement into a unique live facet
 * value when the provider omitted the equivalent criterion. Matching is
 * literal and value-driven: captions, category names, application context and
 * the facet vocabulary itself cannot self-authorize a class. In particular,
 * source SKUs and brands commonly repeated in application_context must never
 * become mandatory characteristics of an analog. Ambiguous values are
 * ignored.
 */
export function projectSelectionTargetFacetCriteria(
  baseTarget: string | null,
  targetValue: unknown,
  facets: Array<{
    key: string;
    caption?: string | null;
    unit?: string | null;
    values?: Array<{ value: string }>;
  }>,
): Criterion[] {
  const base = String(baseTarget ?? "").trim();
  const target = parseSelectionTarget(targetValue);
  if (
    !base || !target.product_class ||
    !selectionTargetIsDeclared(base, target.product_class)
  ) return [];
  const baseTokens = new Set(meaningfulTokens(base));
  const targetTokens = new Set(
    meaningfulTokens(target.product_class).filter((token) => !baseTokens.has(token)),
  );
  if (targetTokens.size === 0) return [];

  return (Array.isArray(facets) ? facets : []).flatMap((facet) => {
    if (isItemIdentityLabel(`${facet.key} ${facet.caption ?? ""}`)) return [];
    const matches = (Array.isArray(facet.values) ? facet.values : [])
      .map(({ value }) => String(value ?? "").trim())
      .filter(Boolean)
      .filter((value) => {
        const tokens = meaningfulTokens(value);
        return tokens.length > 0 && tokens.every((token) => targetTokens.has(token));
      });
    const unique = [...new Set(matches)];
    if (unique.length !== 1) return [];
    return [{
      key: String(facet.caption || facet.key),
      op: "eq" as const,
      value: unique[0],
      unit: facet.unit ?? undefined,
      level: "A" as const,
    }];
  });
}

/**
 * Compile compact structured application constraints into live categorical
 * facets when the provider omitted the corresponding criterion altogether.
 * A value must match every meaningful context token and be unique inside its
 * facet. Identity facets are excluded, numeric-only context is ignored, and
 * the resulting criterion still has to pass the catalog evidence gate.
 */
export function projectSelectionApplicationFacetCriteria(
  targetValue: unknown,
  facets: Array<{
    key: string;
    caption?: string | null;
    unit?: string | null;
    values?: Array<{ value: string }>;
  }>,
): Criterion[] {
  const target = parseSelectionTarget(targetValue);
  if (!target.product_class || target.application_context.length === 0) return [];

  const compactContexts = target.application_context
    .filter((item) => normalize(item).split(/\s+/u).filter(Boolean).length <= 4)
    .map((item) => ({ raw: normalize(item), tokens: meaningfulTokens(item) }))
    .filter((item) => item.tokens.length > 0);
  if (compactContexts.length === 0) return [];

  const editDistanceAtMostOne = (left: string, right: string) => {
    if (left === right) return true;
    if (Math.abs(left.length - right.length) > 1) return false;
    let leftIndex = 0;
    let rightIndex = 0;
    let edits = 0;
    while (leftIndex < left.length && rightIndex < right.length) {
      if (left[leftIndex] === right[rightIndex]) {
        leftIndex += 1;
        rightIndex += 1;
        continue;
      }
      edits += 1;
      if (edits > 1) return false;
      if (left.length > right.length) leftIndex += 1;
      else if (right.length > left.length) rightIndex += 1;
      else {
        leftIndex += 1;
        rightIndex += 1;
      }
    }
    return edits + Number(leftIndex < left.length || rightIndex < right.length) <= 1;
  };

  return (Array.isArray(facets) ? facets : []).flatMap((facet) => {
    if (isItemIdentityLabel(`${facet.key} ${facet.caption ?? ""}`)) return [];
    const matches = (Array.isArray(facet.values) ? facet.values : [])
      .map(({ value }) => String(value ?? "").trim())
      .filter(Boolean)
      .filter((value) => {
        const normalizedValue = normalize(value);
        const valueTokens = meaningfulTokens(value);
        if (valueTokens.length === 0) return false;
        return compactContexts.some((context) =>
          context.raw === normalizedValue ||
          valueTokens.every((valueToken) =>
            context.tokens.some((contextToken) =>
              valueToken === contextToken ||
              Math.min(valueToken.length, contextToken.length) >= 4 &&
                editDistanceAtMostOne(valueToken, contextToken)
            )
          )
        );
      });
    const unique = [...new Set(matches)];
    if (unique.length !== 1) return [];
    return [{
      key: String(facet.caption || facet.key),
      op: "eq" as const,
      value: unique[0],
      unit: facet.unit ?? undefined,
      level: "A" as const,
    }];
  });
}

/**
 * Decides whether render verification may return to an already grounded base
 * class after the model emitted a richer class phrase. The projection never
 * authorizes a sibling: the base must still be declared inside the proposed
 * target. Exact named-entity browsing is allowed to discard model-only class
 * adjectives because identity is proven independently by the entity token and
 * live category; ordinary selection still requires mandatory criterion proof.
 */
export function selectionTargetMayUseGroundedBase(
  baseTarget: string,
  extendedTarget: string,
  criteria: Criterion[],
  options: { replacement: boolean; exact_named_entity_grounded: boolean },
): boolean {
  if (!selectionTargetIsDeclared(baseTarget, extendedTarget)) return false;
  return options.replacement ||
    options.exact_named_entity_grounded ||
    selectionTargetExtensionIsCriterionBacked(baseTarget, extendedTarget, criteria);
}

function productEvidence(product: ProductRef): string {
  return [
    product.pagetitle,
    product.leaf_category ?? "",
  ].join(" ");
}

/**
 * Verifies the model's structured selection target against catalog evidence.
 * It is deliberately domain-agnostic: no product names, brands or aliases are
 * embedded here. Product identity is proven only by title and live taxonomy;
 * traits/descriptions can describe compatibility or usage but cannot rename a
 * sibling product class. Russian inflections are compared by a conservative
 * prefix, while Latin codes/abbreviations remain exact.
 */
export function verifySelectionTarget(
  target: string,
  products: ProductRef[],
): SelectionTargetReport {
  const alternatives = bareClassAlternatives(target);
  if (alternatives) {
    const alternativeReports = alternatives.map((alternative) =>
      verifySelectionTargetWithVisibleTitle(alternative, products)
    );
    const perProduct = products.map((product) => {
      const candidates = alternativeReports.map((report) => ({
        passed: report.passed_ids.includes(product.id),
        row: report.per_product.find((item) => item.id === product.id)!,
      }));
      const best = candidates.sort((left, right) =>
        Number(right.passed) - Number(left.passed) ||
        right.row.coverage - left.row.coverage ||
        right.row.matched.length - left.row.matched.length
      )[0];
      return { ...best.row, passes: best.passed };
    });
    return {
      target: String(target ?? "").trim(),
      passed_ids: perProduct.filter((item) => item.passes).map((item) => item.id),
      rejected_ids: perProduct.filter((item) => !item.passes).map((item) => item.id),
      per_product: perProduct.map(({ passes: _passes, ...item }) => item),
    };
  }
  const rawTokens = meaningfulRawTokens(target);
  const tokens = rawTokens.map(stem).filter((token, index, values) => values.indexOf(token) === index);
  const perProduct = products.map((product) => {
    const rawByStem = new Map(rawTokens.map((token) => [stem(token), token] as const));
    const matched = tokens.filter((token) => {
      const raw = rawByStem.get(token);
      return Boolean(raw && productEvidenceMatchesToken(product, raw));
    });
    const missing = tokens.filter((token) => !matched.includes(token));
    const coverage = tokens.length > 0 ? matched.length / tokens.length : 0;
    // One- or two-token canonical product classes need one literal proof.
    // Rich class names require at least 75% of their independently stated
    // identity signals. Application context is intentionally not accepted by
    // this function; it belongs in the separate criteria/relations contract.
    const passes = tokens.length === 1
      ? matched.length === 1
      : tokens.length === 2
      ? matched.length === 2
      : matched.length >= 2 && coverage >= 0.75;
    return { id: product.id, matched, missing, coverage, passes };
  });
  return {
    target: String(target ?? "").trim(),
    passed_ids: perProduct.filter((item) => item.passes).map((item) => item.id),
    rejected_ids: perProduct.filter((item) => !item.passes).map((item) => item.id),
    per_product: perProduct.map(({ passes: _passes, ...item }) => item),
  };
}

/**
 * A one-token class is the entire customer-visible identity promise, so it
 * must occur in the card title rather than only in hidden taxonomy metadata.
 * Rich multi-token classes keep the ordinary title+taxonomy verifier because
 * catalog titles may legitimately abbreviate one part of a formal class.
 */
export function verifySelectionTargetWithVisibleTitle(
  target: string,
  products: ProductRef[],
): SelectionTargetReport {
  if (meaningfulTokens(target).length !== 1) return verifySelectionTarget(target, products);
  return verifySelectionTarget(
    target,
    products.map((product) => ({ ...product, leaf_category: null })),
  );
}

/**
 * Named-series browsing has two independent identity proofs: the exact series
 * token is visible in the card title, while the exact filtered leaf category
 * proves the product class. Some valid cards omit the generic noun from their
 * title (for example, title = collection + configuration only). Combine those
 * proofs without allowing a hidden category to rescue a card that does not
 * visibly prove the requested named entity.
 */
export function verifySelectionTargetWithNamedEntityCategory(input: {
  target: string;
  products: ProductRef[];
  named_entity: string;
}): SelectionTargetReport {
  const ordinary = verifySelectionTargetWithVisibleTitle(input.target, input.products);
  const entityTokens = meaningfulRawTokens(input.named_entity);
  if (entityTokens.length === 0) return ordinary;

  const categoryReport = verifySelectionTarget(input.target, input.products);
  const ordinaryPassed = new Set(ordinary.passed_ids);
  const categoryPassed = new Set(categoryReport.passed_ids);
  const accepted = new Set(input.products.filter((product) => {
    if (ordinaryPassed.has(product.id)) return true;
    if (!categoryPassed.has(product.id)) return false;
    const titleOnly = { ...product, leaf_category: null };
    return entityTokens.every((token) => productEvidenceMatchesToken(titleOnly, token));
  }).map((product) => product.id));
  if (accepted.size === ordinaryPassed.size) return ordinary;

  return {
    ...ordinary,
    passed_ids: input.products.filter((product) => accepted.has(product.id)).map((product) => product.id),
    rejected_ids: input.products.filter((product) => !accepted.has(product.id)).map((product) => product.id),
  };
}

/**
 * A model-owned, title-grounded search label may prove a subtype whose wording
 * differs from the structured target, while the live taxonomy proves the base
 * class. This does not introduce aliases: the distinctive label must occur
 * literally in every accepted title, the product must belong to the exact
 * search pool, and the target must itself contain the live base class.
 */
export function verifySelectionTargetWithGroundedSearch(input: {
  target: string;
  products: ProductRef[];
  live_class: string;
  grounded_label: string;
  grounded_ids: readonly string[];
}): SelectionTargetReport {
  const ordinary = verifySelectionTargetWithVisibleTitle(input.target, input.products);
  if (ordinary.passed_ids.length > 0) return ordinary;
  if (meaningfulTokens(input.target).length === 1) return ordinary;
  if (!selectionTargetIsDeclared(input.live_class, input.target)) return ordinary;

  const liveTokens = new Set(meaningfulTokens(input.live_class));
  const distinctive = meaningfulTokens(input.grounded_label).filter((token) => !liveTokens.has(token));
  if (distinctive.length === 0) return ordinary;

  const liveReport = verifySelectionTarget(input.live_class, input.products);
  const livePassed = new Set(liveReport.passed_ids);
  const groundedIds = new Set(input.grounded_ids.map(String));
  const additionallyPassed = input.products.filter((product) => {
    if (!livePassed.has(product.id) || !groundedIds.has(product.id)) return false;
    const evidence = new Set(meaningfulTokens(productEvidence(product)));
    return distinctive.every((token) => evidence.has(token));
  }).map((product) => product.id);
  if (additionallyPassed.length === 0) return ordinary;

  const accepted = new Set(additionallyPassed);
  return {
    ...ordinary,
    passed_ids: input.products.filter((product) => accepted.has(product.id)).map((product) => product.id),
    rejected_ids: input.products.filter((product) => !accepted.has(product.id)).map((product) => product.id),
  };
}
