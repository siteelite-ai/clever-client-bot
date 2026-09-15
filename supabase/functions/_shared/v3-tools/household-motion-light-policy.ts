import type { ProductRef } from "./types.ts";

export interface HouseholdMotionLightRequest {
  maxPrice: number | null;
  surfaceMountedRequired: boolean;
  householdRequired: boolean;
}

/**
 * Search by the customer-visible product class and feature, never by a known
 * brand or series. The broad last query recovers cards whose title omits the
 * class wording; the evidence verifier below is the only authority that may
 * admit them.
 */
export const HOUSEHOLD_MOTION_LIGHT_CATALOG_QUERIES = [
  "светильник с датчиком",
  "светильник с микроволновым сенсором",
  "датчик движения",
];

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
 * Route an explicit product-class + motion-feature request through one
 * evidence verifier. "Household" and "surface mounted" strengthen that same
 * contract when the customer states them; their absence must not prevent the
 * requested motion feature from being verified. Ambiguous light-fixture
 * questions without an explicit motion feature remain in the expert loop.
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
  if (!fixture || !motionSensor) return null;

  const budgetMatch = current.match(
    /(?:не\s+более|до|максимум)\s*([\d\s\u00a0]+(?:[.,]\d+)?)\s*(?:₸|тг|тенге)?/u,
  );
  return {
    maxPrice: budgetMatch ? parseNumber(budgetMatch[1]) : null,
    surfaceMountedRequired: surfaceMounted,
    householdRequired: household,
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

function hasMotionSensorEvidence(value: string): boolean {
  return /датчик\p{L}*\s+движени\p{L}*|микроволнов\p{L}*\s+сенсор\p{L}*|сенсор\p{L}*\s+движени\p{L}*/u
    .test(value);
}

function hasHouseholdUseEvidence(value: string): boolean {
  return /бытов\p{L}*|жил\p{L}*|квартир\p{L}*|для\s+дома/u
    .test(value);
}

function hasIncompatibleHouseholdUse(value: string): boolean {
  return /для\s+жкх|(?:^|[^\p{L}\p{N}])дпп(?:[^\p{L}\p{N}]|$)|промышлен\p{L}*|производствен\p{L}*|уличн\p{L}*|наружн\p{L}*|складск\p{L}*|парков\p{L}*|техническ\p{L}*/u
    .test(value);
}

function primaryUseEvidence(product: ProductRef): string {
  return norm([
    product.pagetitle,
    product.leaf_category ?? "",
    product.description_excerpt ?? "",
  ].join(" "));
}

function structuredUseEvidence(product: ProductRef): string {
  return norm((product.short_traits ?? []).filter((trait) =>
    /^(?:вид|тип)\s+светильника\s*:|^назначение\s*:|^область\s+применения\s*:/iu.test(trait)
  ).join(" "));
}

function householdMotionLightScore(product: ProductRef): number {
  const title = norm(product.pagetitle);
  const traits = norm((product.short_traits ?? []).join(" "));
  const useEvidence = primaryUseEvidence(product);
  const useFacets = structuredUseEvidence(product);
  return Number(hasMotionSensorEvidence(title)) * 8 +
    Number(hasMotionSensorEvidence(traits)) * 6 +
    Number(hasHouseholdUseEvidence(title)) * 4 +
    Number(hasHouseholdUseEvidence(useEvidence)) * 2 +
    Number(hasHouseholdUseEvidence(useFacets)) * 3 +
    Number(/накладн\p{L}*/u.test(traits));
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
  householdRequired = true,
): boolean {
  const facts = evidence(product);
  const identity = norm([
    product.pagetitle,
    product.leaf_category ?? "",
  ].join(" "));
  const structuralFacts = norm([
    product.pagetitle,
    product.leaf_category ?? "",
    ...(product.short_traits ?? []),
  ].join(" "));
  const priceFits = Number.isFinite(product.price) && product.price > 0 &&
    (maxPrice === null || product.price <= maxPrice);
  // Product class must come from the title/category. A standalone motion
  // sensor can mention the controlled fixture in its description.
  const fixture = /светильник\p{L}*/u.test(identity);
  const sensor = hasMotionSensorEvidence(facts);
  // Use class and mounting method are independent axes. A surface-mounted
  // industrial fixture is not household merely because it is "накладной".
  // A broad merchandising bucket (for example ЖКХ) is not treated as an
  // application veto when the primary product description explicitly proves
  // residential use. Direct incompatible claims in title/description and an
  // explicit industrial-use facet remain hard exclusions.
  const useEvidence = primaryUseEvidence(product);
  const useFacets = structuredUseEvidence(product);
  const householdUse = (
    hasHouseholdUseEvidence(useEvidence) || hasHouseholdUseEvidence(useFacets)
  ) && !hasIncompatibleHouseholdUse(useEvidence) &&
    !/промышлен\p{L}*|производствен\p{L}*|уличн\p{L}*|наружн\p{L}*/u.test(useFacets);
  const surfaceMounted = /накладн\p{L}*|настенн\p{L}*[-\s]+потолочн\p{L}*/u
    .test(structuralFacts);
  return priceFits && fixture && sensor &&
    (!householdRequired || householdUse) &&
    (!surfaceMountedRequired || surfaceMounted);
}

export function verifiedHouseholdMotionLights(
  products: ProductRef[],
  maxPrice: number | null,
  limit = 4,
  surfaceMountedRequired = true,
  householdRequired = true,
): ProductRef[] {
  const seen = new Set<string>();
  return products
    .filter((product) => isVerifiedHouseholdMotionLight(
      product,
      maxPrice,
      surfaceMountedRequired,
      householdRequired,
    ))
    .sort((left, right) => {
      const leftScore = householdMotionLightScore(left);
      const rightScore = householdMotionLightScore(right);
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
  "Подбираю бытовой накладной светильник со встроенным датчиком движения и проверяю цену по каталогу; модели без подтверждённого бытового или жилого применения не показываю.";

export const HOUSEHOLD_MOTION_LIGHT_GENERIC_INTRO =
  "Подбираю бытовой светильник со встроенным датчиком движения и проверяю цену по каталогу; модели без подтверждённого бытового или жилого применения не показываю.";

export const MOTION_LIGHT_GENERIC_INTRO =
  "Подбираю светильник со встроенным датчиком движения и проверяю заданный бюджет; карточки без подтверждённого датчика не показываю.";

export const HOUSEHOLD_MOTION_LIGHT_EMPTY =
  "В текущей выдаче каталога не удалось одновременно подтвердить бытовое накладное исполнение, датчик движения и заданный бюджет. Не буду заменять запрос обычным светильником или моделью без подтверждённого жилого применения; наличие подходящего варианта уточнит менеджер.";

export const MOTION_LIGHT_GENERIC_EMPTY =
  "В текущей выдаче каталога не удалось одновременно подтвердить светильник, датчик движения и заданный бюджет. Не буду заменять запрос обычным светильником; наличие подходящего варианта уточнит менеджер.";
