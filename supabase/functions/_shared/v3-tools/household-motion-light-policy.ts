import type { ProductRef } from "./types.ts";

export interface HouseholdMotionLightRequest {
  maxPrice: number | null;
  surfaceMountedRequired: boolean;
}

function norm(value: string): string {
  return String(value ?? "").toLowerCase().replace(/ё/g, "е").replace(
    /\s+/g,
    " ",
  ).trim();
}

function parseNumber(value: string): number | null {
  const compact = value.replace(/[\s\u00a0]/gu, "").replace(/,/gu, ".");
  const parsed = Number(compact);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Route only an explicit, fully constrained request. Ambiguous light-fixture
 * questions remain in the expert loop so the model can reason and clarify.
 */
export function classifyHouseholdMotionLightRequest(
  message: string,
): HouseholdMotionLightRequest | null {
  const current = norm(message);
  const household = /бытов\p{L}*/u.test(current);
  const surfaceMounted = /накладн\p{L}*/u.test(current);
  const fixture = /светильник\p{L}*/u.test(current);
  const motionSensor =
    /(?:датчик\p{L}*\s+движени\p{L}*|микроволнов\p{L}*\s+сенсор\p{L}*|сенсор\p{L}*)/u
      .test(current);
  if (!household || !fixture || !motionSensor) return null;

  const budgetMatch = current.match(
    /(?:не\s+более|до|максимум)\s*([\d\s\u00a0]+(?:[.,]\d+)?)\s*(?:₸|тг|тенге)?/u,
  );
  return {
    maxPrice: budgetMatch ? parseNumber(budgetMatch[1]) : null,
    surfaceMountedRequired: surfaceMounted,
  };
}

function evidence(product: ProductRef): string {
  return norm([
    product.pagetitle,
    product.leaf_category ?? "",
    ...(Array.isArray(product.short_traits) ? product.short_traits : []),
    product.description_excerpt ?? "",
  ].join(" "));
}

/**
 * Enforce the user's declared axes after search. A broad catalog hit is never
 * enough: utility/industrial/outdoor fixtures are rejected even if they have a
 * motion sensor and fit the price.
 */
export function isVerifiedHouseholdMotionLight(
  product: ProductRef,
  maxPrice: number | null,
  surfaceMountedRequired = true,
): boolean {
  const title = norm(product.pagetitle);
  const facts = evidence(product);
  const priceFits = Number.isFinite(product.price) && product.price > 0 &&
    (maxPrice === null || product.price <= maxPrice);
  const fixture = /светильник\p{L}*/u.test(facts);
  const sensor =
    /датчик\p{L}*\s+движени\p{L}*|микроволнов\p{L}*\s+сенсор\p{L}*|сенсор\p{L}*/u
      .test(facts);
  // HALL is the catalog's visible household surface-fixture series marker;
  // normally the same fact is also present in the leaf category/description.
  const householdSurface =
    /бытов\p{L}*|накладн\p{L}*|(?:^|[^a-z])hall(?:[^a-z]|$)/u.test(facts);
  const surfaceMounted = /накладн\p{L}*|(?:^|[^a-z])hall(?:[^a-z]|$)/u.test(facts);
  const wrongUseClass = /для\s+жкх|промышлен\p{L}*|уличн\p{L}*|дпп/u.test(
    title,
  );
  return priceFits && fixture && sensor && householdSurface &&
    (!surfaceMountedRequired || surfaceMounted) && !wrongUseClass;
}

export function verifiedHouseholdMotionLights(
  products: ProductRef[],
  maxPrice: number | null,
  limit = 4,
  surfaceMountedRequired = true,
): ProductRef[] {
  const seen = new Set<string>();
  return products
    .filter((product) => isVerifiedHouseholdMotionLight(product, maxPrice, surfaceMountedRequired))
    .sort((left, right) => {
      const leftTitle = norm(left.pagetitle);
      const rightTitle = norm(right.pagetitle);
      const leftScore = Number(leftTitle.includes("hall")) * 4 +
        Number(leftTitle.includes("gauss")) * 2 +
        Number(leftTitle.includes("сенсор"));
      const rightScore = Number(rightTitle.includes("hall")) * 4 +
        Number(rightTitle.includes("gauss")) * 2 +
        Number(rightTitle.includes("сенсор"));
      return rightScore - leftScore || left.price - right.price;
    })
    .filter((product) => {
      if (seen.has(product.id)) return false;
      seen.add(product.id);
      return true;
    })
    .slice(0, Math.max(1, Math.min(limit, 8)));
}

export const HOUSEHOLD_MOTION_LIGHT_INTRO =
  "Подбираю бытовой накладной светильник со встроенным датчиком движения и проверяю цену по каталогу; варианты для ЖКХ, промышленные и уличные модели исключаю.";

export const HOUSEHOLD_MOTION_LIGHT_GENERIC_INTRO =
  "Подбираю бытовой светильник со встроенным датчиком движения и проверяю цену по каталогу; варианты для ЖКХ, промышленные и уличные модели исключаю.";

export const HOUSEHOLD_MOTION_LIGHT_EMPTY =
  "В текущей выдаче каталога не удалось одновременно подтвердить бытовое накладное исполнение, датчик движения и заданный бюджет. Не буду заменять запрос обычным светильником или моделью для ЖКХ; наличие подходящего варианта уточнит менеджер.";
