export type UserIntentMode = "select" | "inquire";

/**
 * A factual explanation of an explicitly named series must consult the live
 * catalog before it can finish. Deictic follow-ups such as "эта серия" are
 * excluded because they rely on evidence persisted from the preceding turn.
 */
export function extractNamedSeriesToken(message: string): string | null {
  const normalized = message.toLocaleLowerCase("ru").replace(/ё/g, "е");
  const match = normalized.match(/(?:^|[^\p{L}])сер(?:ия|ии|ию|ией)\s+[«"']?([\p{L}][\p{L}\d-]{3,})/u);
  if (!match || /^(?:этой|эта|эту|данной|данная|данную|такой|такая)$/u.test(match[1])) return null;
  return match[1];
}

export function requiresCatalogGroundingForInquiry(message: string): boolean {
  return extractNamedSeriesToken(message) !== null;
}

const PRODUCT_SELECTION_VERB = /(?:^|[^\p{L}])(?:найд\p{L}*|ищ\p{L}*|подбер\p{L}*|предлож\p{L}*|покаж\p{L}*|нуж\p{L}*|хоч\p{L}*|выбер\p{L}*)(?=$|[^\p{L}])/u;
const EXPLICIT_PRODUCT_COMMAND = /(?:^|[^\p{L}])(?:найд\p{L}*|ищ\p{L}*|подбер\p{L}*|предлож\p{L}*|покаж\p{L}*|выбер\p{L}*)(?=$|[^\p{L}])/u;
const SOFT_PRODUCT_REQUEST = /(?:^|[^\p{L}])(?:нуж\p{L}*|хоч\p{L}*)\s+(.+)/u;
const STORE_SERVICE_TERM = /(?:^|[^\p{L}])(?:доставк\p{L}*|доставля\p{L}*|самовывоз\p{L}*|отправк\p{L}*|оплат\p{L}*|оплати\p{L}*|рассрочк\p{L}*|возврат\p{L}*|возвращ\p{L}*|вернут\p{L}*|обмен\p{L}*|гарант\p{L}*|скидк\p{L}*|акци\p{L}*|оферт\p{L}*)(?=$|[^\p{L}])/u;
const SERVICE_AS_REQUEST_OBJECT = /(?:^|[^\p{L}])(?:найд\p{L}*|ищ\p{L}*|подбер\p{L}*|предлож\p{L}*|покаж\p{L}*|выбер\p{L}*|нуж\p{L}*|хоч\p{L}*)\s+(?:(?!(?:с|со|по|для)(?=$|[^\p{L}]))\p{L}+\s+){0,2}(?:доставк\p{L}*|доставля\p{L}*|самовывоз\p{L}*|отправк\p{L}*|оплат\p{L}*|оплати\p{L}*|рассрочк\p{L}*|возврат\p{L}*|возвращ\p{L}*|вернут\p{L}*|обмен\p{L}*|гарант\p{L}*|скидк\p{L}*|акци\p{L}*|оферт\p{L}*)(?=$|[^\p{L}])/u;

function hasIndependentProductTask(clause: string): boolean {
  if (isStorePolicyInquiry(clause) || SERVICE_AS_REQUEST_OBJECT.test(clause)) return false;
  if (EXPLICIT_PRODUCT_COMMAND.test(clause)) return true;
  const soft = clause.match(SOFT_PRODUCT_REQUEST);
  if (!soft) return false;
  let objectPhrase = soft[1];
  const service = STORE_SERVICE_TERM.exec(objectPhrase);
  if (service) {
    // "Нужен кабель с доставкой": the service is an adjunct to a separate
    // product object. "Нужна быстрая доставка": it is the object itself.
    const beforeService = objectPhrase.slice(0, service.index);
    const adjunct = beforeService.match(/^(.*?)\s+(?:с|со|по|для)\s*$/u);
    if (!adjunct) return false;
    objectPhrase = adjunct[1];
  }
  const object = objectPhrase.match(/\p{L}{3,}/gu)?.at(-1);
  return Boolean(object && !/ть(?:ся)?$/u.test(object));
}

/** A policy question in a separate clause must not erase a product task. */
export function hasMixedProductPolicyRequest(message: string): boolean {
  const clauses = message.toLocaleLowerCase("ru").replace(/ё/g, "е")
    .split(/\s+(?:и|потом|также)\s+|[,;]/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (clauses.length < 2) return false;
  return clauses.some(hasIndependentProductTask) &&
    clauses.some((clause) => isStorePolicyInquiry(clause));
}

/**
 * Store terms are not product facets. A customer asking about the store's
 * delivery, payment or after-sale rules needs knowledge-base evidence. Keep
 * catalog requests that merely mention a service ("найди кабель с доставкой")
 * on the selection route.
 */
export function isStorePolicyInquiry(message: string): boolean {
  const normalized = message.toLocaleLowerCase("ru").replace(/ё/g, "е");
  if (!STORE_SERVICE_TERM.test(normalized)) return false;
  // Per-item warranty/return questions need that item's evidence, not a
  // generic store policy paragraph that may state a different term.
  if (/(?:на|для|у)\s+(?:эт\p{L}*|данн\p{L}*|указанн\p{L}*|конкретн\p{L}*)\s+\p{L}+/u.test(normalized)) {
    return false;
  }
  if (/(?:вернут\p{L}*|обмен\p{L}*|гарант\p{L}*)\s+(?:эт\p{L}*|данн\p{L}*|указанн\p{L}*|конкретн\p{L}*)\s+\p{L}+/u.test(normalized)) {
    return false;
  }
  if (/(?:гарант\p{L}*|возврат\p{L}*|обмен\p{L}*)[^.!?]{0,100}(?:на|для|у)\s+\p{L}+\s+(?:[А-ЯЁA-Z][\p{L}\p{N}-]+|[a-z]{3,})/u.test(message)) {
    // "Гарантия на светильник Gauss" is an item-specific question even
    // without an article or numeric model code.
    return false;
  }

  const policyObject = /(?:^|[^\p{L}])(?:услови\p{L}*|правил\p{L}*|тариф\p{L}*|стоимост\p{L}*|цен\p{L}*|срок\p{L}*|способ\p{L}*|порядок|вариант\p{L}*)(?:\s+\p{L}+)?\s+(?:доставк\p{L}*|самовывоз\p{L}*|отправк\p{L}*|оплат\p{L}*|рассрочк\p{L}*|возврат\p{L}*|обмен\p{L}*|гарант\p{L}*)/u;
  const asksPolicyAction = /(?:^|[^\p{L}])(?:как|когда|где|сколько)\s+(?:\p{L}+\s+){0,2}(?:доставк\p{L}*|доставля\p{L}*|самовывоз\p{L}*|отправк\p{L}*|оплат\p{L}*|оплати\p{L}*|возврат\p{L}*|возвращ\p{L}*|вернут\p{L}*|обмен\p{L}*)/u;
  const servicePermission = /(?:^|[^\p{L}])(?:можно|могу\s+ли|можем\s+ли|возможн\p{L}*)\s+(?:ли\s+)?(?:\p{L}+\s+){0,2}(?:доставк\p{L}*|доставля\p{L}*|самовывоз\p{L}*|отправк\p{L}*|оплат\p{L}*|оплати\p{L}*|возврат\p{L}*|возвращ\p{L}*|вернут\p{L}*|обмен\p{L}*)/u;
  const directAvailability = /(?:^|[^\p{L}])(?:есть\s+ли|возможн\p{L}*\s+ли)\s+(?:у\s+вас\s+)?(?:доставк\p{L}*|самовывоз\p{L}*|оплат\p{L}*|рассрочк\p{L}*|возврат\p{L}*|обмен\p{L}*|гарант\p{L}*)/u;
  const asksToLearn = /(?:хоч\p{L}*\s+узнат\p{L}*|расскаж\p{L}*|объясн\p{L}*|уточн\p{L}*)\s+(?:(?:мне|пожалуйста|про|об|о)\s+){0,3}(?:доставк\p{L}*|самовывоз\p{L}*|оплат\p{L}*|рассрочк\p{L}*|возврат\p{L}*|обмен\p{L}*|гарант\p{L}*|скидк\p{L}*|акци\p{L}*)/u;
  const directTopic = /^(?:а\s+)?(?:доставк\p{L}*|доставля\p{L}*|самовывоз\p{L}*|оплат\p{L}*|рассрочк\p{L}*|возврат\p{L}*|обмен\p{L}*|гарант\p{L}*)(?=$|[^\p{L}])/u;
  const policyQuestion = policyObject.test(normalized) ||
    asksPolicyAction.test(normalized) || servicePermission.test(normalized) ||
    directAvailability.test(normalized) ||
    asksToLearn.test(normalized) || directTopic.test(normalized) ||
    SERVICE_AS_REQUEST_OBJECT.test(normalized);
  if (!policyQuestion) return false;

  if (hasMixedProductPolicyRequest(normalized)) {
    // The query contains both a product task and a store-policy task. A
    // policy-only answer would silently discard the requested product.
    return false;
  }
  if (PRODUCT_SELECTION_VERB.test(normalized) && !SERVICE_AS_REQUEST_OBJECT.test(normalized) &&
    !policyObject.test(normalized) &&
    !asksToLearn.test(normalized)) return false;
  // "Есть ли кабель с доставкой?" asks about product availability, unlike
  // "Есть ли доставка?" whose grammatical object is the service itself.
  if (/(?:есть\s+ли|име(?:ется|ются)|прода(?:е(?:те|шь)|ются))/u.test(normalized) &&
    !directAvailability.test(normalized) && !policyObject.test(normalized)) return false;
  return true;
}

export function resolveNamedSeriesToken(
  message: string,
  recentDialogue: Array<{ role: "user" | "assistant"; content: string }>,
): string | null {
  const direct = extractNamedSeriesToken(message);
  if (direct) return direct;
  const normalized = message.toLocaleLowerCase("ru").replace(/ё/g, "е");
  if (!/(?:этой|данной|указанной|названной)\s+серии/u.test(normalized)) return null;
  for (const fragment of [...recentDialogue].reverse()) {
    // Generated prose can contain phrases such as "серия отличается...".
    // Only the user's explicit entity mention is authoritative across turns.
    if (fragment.role !== "user") continue;
    const inherited = extractNamedSeriesToken(fragment.content);
    if (inherited) return inherited;
  }
  return null;
}

// Product questions are evidence requests, not new selections. This distinction
// controls whether the factual explanation beside render_products is visible.
export function detectUserIntentMode(message: string): UserIntentMode {
  const normalized = message.toLowerCase().replace(/ё/g, "е");
  // A service explanation in a second clause must not switch an explicit
  // product selection into the tool-free informational route.
  if (hasMixedProductPolicyRequest(normalized)) return "select";
  if (isStorePolicyInquiry(normalized)) return "inquire";
  // Explanation requests must keep their prose even when the answer also
  // contains product cards. Conversely, a catalog imperative wins over words
  // such as "характеристика": in "найди автомат ... характеристика C" that
  // word is a filter, not a request to explain an existing product.
  const explanation = /(?:^|[^\p{L}])(?:расскаж\p{L}*|объясн\p{L}*|почему|чем\s+хорош\p{L}*|преимуществ\p{L}*|особенност\p{L}*|чем\s+отлича\p{L}*|в\s+чем\s+разниц\p{L}*)(?=$|[^\p{L}])/u;
  if (explanation.test(normalized)) return "inquire";
  const selection = /(?:^|[^\p{L}])(?:найд\p{L}*|ищ\p{L}*|подбер\p{L}*|предлож\p{L}*|покаж\p{L}*|нуж\p{L}*|хоч\p{L}*|выбер\p{L}*)(?=$|[^\p{L}])/u;
  if (selection.test(normalized)) return "select";
  const inquiry = /(указан[аы]?|за упаковк|за штук|за шт\.?|сколько штук|сколько в упаковк|что входит|входит ли|комплектац|характеристик|состав|совместим|подойдет(?:\s+ли|\s+или\s+нет)|подходит(?:\s+ли|\s+или\s+нет)|подходят ли|точно\s+подход|годится ли|хватит|можно ли|нужно ли|почему|нельзя|чем отличает|в чем разниц|разница между|отличие|отличия|какая мощност|какое напряжен|какой цвет|какой размер|какие размеры|какой диаметр|для чего|как работает|как пользоват|инструкц|гарант|срок служб|расход|потребл|расшифров)/u;
  if (inquiry.test(normalized)) return "inquire";
  // Availability questions are catalog selections, even when a compact
  // product code makes the sentence look SKU-like. Explicit factual and
  // suitability questions above still win, so "есть ли гарантия/разница" is
  // not converted into a product browse.
  const availability = /(?:есть\s+ли|у\s+(?:вас|тебя)\s+есть|име(?:ется|ются)|прода(?:е(?:те|шь)|ются)|быва(?:ет|ют)\s+ли)/u;
  if (availability.test(normalized)) return "select";
  const hasQuestion = /\?/.test(normalized);
  const hasSkuLike = /(\b\d{4,}\b|\b[a-zа-я]+[-\s]?\d{2,}[a-zа-я0-9-]*\b|«[^»]+»|"[^"]+")/iu.test(normalized);
  return hasQuestion && hasSkuLike ? "inquire" : "select";
}

// A card is visually perceived as a recommendation. When the user asks why a
// referenced item is unsuitable and the consultant concludes that it is not,
// keep the evidence-based explanation but do not render that item as an offer.
export function shouldSuppressNegativeSuitabilityCard(userMessage: string, assistantText: string): boolean {
  const user = userMessage.toLowerCase().replace(/ё/g, "е");
  const answer = assistantText.toLowerCase().replace(/ё/g, "е");
  const asksSuitability = /(подойдет\s+или\s+нет|подходит\s+или\s+нет|почему.{0,80}(?:нельзя|не\s+подход|не\s+год)|можно\s+ли.{0,80}использ|годится\s+ли)/u.test(user);
  const rejectsProduct = /(не\s+годит|не\s+подход|нельзя\s+использ|не\s+рекоменд|не\s+стоит\s+использ|экономия\s+не\s+в\s+том\s+месте|только\s+для.{0,80}помещен)/u.test(answer);
  return asksSuitability && rejectsProduct;
}
