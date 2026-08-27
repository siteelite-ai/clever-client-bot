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
): string | null {
  const current = String(currentTarget ?? "").trim();
  const declared = String(declaredTarget ?? "").trim();
  if (!declared) return current || null;
  if (!current) return declared;
  return verifiedProductCount > 0 ? declared : current;
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
  return Boolean(
    groundedLiveClass &&
    selectionTargetIsDeclared(target, groundedLiveClass),
  );
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
 * values explicitly repeated in that same structured target/context. The
 * resulting criterion is still verified against live catalog evidence before
 * any card is rendered, so model prose cannot prove itself or rename a sibling.
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
  const targetTokens = new Set(meaningfulTokens(
    `${target.product_class}\n${target.application_context.join("\n")}`,
  ).filter((token) => !baseTokens.has(token)));
  const promoted: Criterion[] = [];
  const backing: Criterion[] = [];
  const next = (Array.isArray(criteria) ? criteria : []).map((criterion) => {
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
 * Compile a structured target refinement into a unique live facet value when
 * the provider omitted the equivalent criterion. Matching is literal and
 * value-driven: captions, category names and the facet vocabulary itself
 * cannot self-authorize a class. Ambiguous values are ignored.
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
  const targetTokens = new Set(meaningfulTokens(
    `${target.product_class}\n${target.application_context.join("\n")}`,
  ).filter((token) => !baseTokens.has(token)));
  if (targetTokens.size === 0) return [];

  return (Array.isArray(facets) ? facets : []).flatMap((facet) => {
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
