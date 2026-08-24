import type { ProductRef } from "./types.ts";

export interface ShrinkFitRequest {
  objectDiameterMm: number;
  searchNoun: string;
}

function norm(value: string): string {
  return String(value ?? "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
}

/** Recognizes a dimensional fit task, not a product alias lookup. */
export function classifyShrinkFitRequest(message: string): ShrinkFitRequest | null {
  const value = norm(message);
  if (!/трубк\p{L}*/u.test(value) || !/(?:термоусад\p{L}*|(?:^|[^\p{L}\p{N}])тту(?=$|[^\p{L}\p{N}]))/u.test(value)) return null;
  const diameter = value.match(/(?:диаметр\p{L}*|[ø⌀])\s*(?:кабел\p{L}*\s*)?(\d+(?:[.,]\d+)?)\s*мм/u) ??
    value.match(/кабел\p{L}*[^\d]{0,24}(\d+(?:[.,]\d+)?)\s*мм/u);
  if (!diameter) return null;
  const objectDiameterMm = Number(diameter[1].replace(",", "."));
  if (!Number.isFinite(objectDiameterMm) || objectDiameterMm <= 0) return null;
  const literalNoun = value.match(/термоусад\p{L}*/u)?.[0] ?? value.match(/(?:^|[^\p{L}\p{N}])(тту)(?=$|[^\p{L}\p{N}])/u)?.[1] ?? "трубка";
  return { objectDiameterMm, searchNoun: literalNoun };
}

export function extractDimensionalSpan(product: ProductRef): { before: number; after: number } | null {
  const evidence = [product.pagetitle, ...(product.short_traits ?? [])].join(" ");
  const match = evidence.match(/(\d+(?:[.,]\d+)?)\s*[\/хx]\s*(\d+(?:[.,]\d+)?)\s*(?:мм)?/iu);
  if (!match) return null;
  const first = Number(match[1].replace(",", "."));
  const second = Number(match[2].replace(",", "."));
  if (!Number.isFinite(first) || !Number.isFinite(second) || first <= 0 || second <= 0 || first === second) return null;
  return { before: Math.max(first, second), after: Math.min(first, second) };
}

export function selectDimensionallyCompatibleProducts(
  products: ProductRef[],
  objectDiameterMm: number,
  limit = 6,
): ProductRef[] {
  const seen = new Set<string>();
  return products
    .map((product) => ({ product, span: extractDimensionalSpan(product) }))
    .filter((item): item is { product: ProductRef; span: { before: number; after: number } } => Boolean(
      item.span && item.span.before > objectDiameterMm && item.span.after < objectDiameterMm
    ))
    .sort((left, right) => {
      const leftMargin = left.span.before - objectDiameterMm + objectDiameterMm - left.span.after;
      const rightMargin = right.span.before - objectDiameterMm + objectDiameterMm - right.span.after;
      return leftMargin - rightMargin || left.product.price - right.product.price;
    })
    .filter(({ product }) => {
      if (seen.has(product.id)) return false;
      seen.add(product.id);
      return true;
    })
    .slice(0, Math.max(1, Math.min(limit, 10)))
    .map(({ product }) => product);
}

