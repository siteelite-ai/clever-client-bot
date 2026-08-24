import type { ProductRef } from "./types.ts";

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
  const tokens = meaningfulTokens(target);
  const perProduct = products.map((product) => {
    const evidence = new Set(meaningfulTokens(productEvidence(product)));
    const matched = tokens.filter((token) => evidence.has(token));
    const missing = tokens.filter((token) => !evidence.has(token));
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
  const ordinary = verifySelectionTarget(input.target, input.products);
  if (ordinary.passed_ids.length > 0) return ordinary;
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
