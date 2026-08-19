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

// Product questions are evidence requests, not new selections. This distinction
// controls whether the factual explanation beside render_products is visible.
export function detectUserIntentMode(message: string): UserIntentMode {
  const normalized = message.toLowerCase().replace(/ё/g, "е");
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
