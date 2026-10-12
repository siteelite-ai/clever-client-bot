import type { ExactCompoundMarkingRequest } from "./exact-compound-marking-policy.ts";
import type { ProposeClarificationInput } from "./propose-clarification.ts";

// The values come from live catalog data, not a product/category dictionary.
// Keep the same small grammar accepted by the request parser and widget chips.
const SAFE_SALE_UNIT = /^[\p{L}\p{N}][\p{L}\p{N}./% -]{0,11}$/u;

export function exactCompoundUnitScopeNotice(
  direction: "cheapest" | "expensive",
  selectedUnit: string,
): string {
  const extreme = direction === "cheapest" ? "минимальную" : "максимальную";
  return `В каталоге есть товары с разными единицами продажи. Показываю ${extreme} цену среди товаров за «${selectedUnit}». Цены за разные единицы напрямую не сравниваю.`;
}

/**
 * Each chip is a self-contained customer query. It does not trust a browser
 * slot to carry category/price scope: the next turn must repeat the full
 * category proof for the unit the customer explicitly selects.
 */
export function exactCompoundSaleUnitChoices(
  request: ExactCompoundMarkingRequest,
  unitOptions: readonly string[],
): ProposeClarificationInput | null {
  if (
    !request.priceDirection || !request.query.trim() ||
    request.query.length > 160 || unitOptions.length < 2 ||
    unitOptions.length > 5
  ) return null;
  if (unitOptions.some((unit) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(unit))) {
    return null;
  }
  const units = unitOptions.map((unit) =>
    unit.normalize("NFKC").trim()
      .toLocaleLowerCase("ru-RU").replace(/ё/gu, "е")
  );
  if (
    units.some((unit) => !SAFE_SALE_UNIT.test(unit)) ||
    new Set(units).size !== units.length
  ) return null;
  const order = request.priceDirection === "cheapest"
    ? "самый дешевый"
    : "самый дорогой";
  const options = units.map((unit) => ({
    value: `найди ${request.query} ${order} за единицу «${unit}»`,
    label: `За ${unit}`,
  }));
  if (
    options.some(({ value, label }) =>
      value.length > 2000 ||
      label.length > 160
    )
  ) return null;
  return {
    question: "Нужна цена за другую единицу продажи? Выберите вариант:",
    facet_key: "sale_unit",
    options,
  };
}
