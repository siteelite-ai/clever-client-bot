import type { ProductFull } from "./types.ts";

export type PriceUnitBasis = "piece" | "package" | "other" | "unknown";

function safeText(value: unknown, limit: number): string {
  return String(value ?? "").replace(/[<>\p{Cc}]/gu, " ")
    .replace(/\s+/gu, " ").trim().slice(0, limit);
}

export function isExactPriceUnitQuestion(message: string): boolean {
  const text = safeText(message, 1_000).toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е");
  return /(?:цен\p{L}*|стоим\p{L}*|сколько\s+стоит|за\s+какую\s+единиц\p{L}*)/u
    .test(text) &&
    /(?:за\s+(?:штук\p{L}*|шт\.?|упаковк\p{L}*|блистер\p{L}*|пачк\p{L}*|единиц\p{L}*)|\/\s*(?:шт\.?|уп\.?|упак\p{L}*)|единиц\p{L}*\s+(?:цен\p{L}*|измерен\p{L}*))/u
      .test(text);
}

export function classifyCatalogPriceUnit(
  unit: string | null | undefined,
): PriceUnitBasis {
  const normalized = safeText(unit, 40).toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е").replace(/[.\s]/gu, "");
  if (!normalized) return "unknown";
  if (/^(?:шт|штук\p{L}*)$/u.test(normalized)) return "piece";
  if (/^(?:уп|упак\p{L}*|блистер\p{L}*|пачк\p{L}*)$/u.test(normalized)) {
    return "package";
  }
  return "other";
}

/** Exact-item unit questions have a catalog-grounded, stable answer, not an
 * LLM guess about whether a displayed amount refers to a piece or a pack. */
export function buildExactPriceUnitAnswer(
  product: Pick<ProductFull, "pagetitle" | "price" | "unit">,
): { text: string; basis: PriceUnitBasis; unit: string | null } {
  const title = safeText(product.pagetitle, 240);
  const unit = safeText(product.unit, 40) || null;
  const basis = classifyCatalogPriceUnit(unit);
  const price = Number(product.price).toLocaleString("ru-RU")
    .replace(/\u00a0/gu, " ").replace(/\u202f/gu, " ");
  const prefix = `Товар «${title}».`;
  if (basis === "piece") {
    return {
      basis,
      unit,
      text:
        `${prefix} Цена ${price} ₸ за одну штуку по единице каталога «${unit}». Сама единица цены не раскрывает количество элементов внутри упаковки.`,
    };
  }
  if (basis === "package") {
    return {
      basis,
      unit,
      text:
        `${prefix} Цена ${price} ₸ за упаковку. Поштучная цена по карточке не подтверждена.`,
    };
  }
  if (basis === "other") {
    return {
      basis,
      unit,
      text:
        `${prefix} Цена ${price} ₸ за единицу «${unit}». Поштучная цена и количество в упаковке по карточке не подтверждены.`,
    };
  }
  return {
    basis,
    unit,
    text:
      `${prefix} Цена ${price} ₸ указана в каталоге, но единицу цены и количество в упаковке по карточке подтвердить нельзя.`,
  };
}
