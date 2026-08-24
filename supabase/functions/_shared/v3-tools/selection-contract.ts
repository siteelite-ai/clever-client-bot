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

function productEvidence(product: ProductRef): string {
  return [
    product.pagetitle,
    product.leaf_category ?? "",
    ...(Array.isArray(product.short_traits) ? product.short_traits : []),
    product.description_excerpt ?? "",
  ].join(" ");
}

/**
 * Verifies the model's structured selection target against catalog evidence.
 * It is deliberately domain-agnostic: no product names, brands or aliases are
 * embedded here. Russian inflections are compared by a conservative prefix,
 * while Latin codes/abbreviations remain exact.
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
    // Rich targets (class + use context + execution) require at least 75% of
    // their independently stated signals, so a broad sibling cannot pass by
    // sharing only a generic noun such as "светильник".
    const passes = tokens.length <= 2
      ? matched.length >= 1
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
