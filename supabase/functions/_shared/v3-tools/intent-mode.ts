export type UserIntentMode = "select" | "inquire";

// Product questions are evidence requests, not new selections. This distinction
// controls whether the factual explanation beside render_products is visible.
export function detectUserIntentMode(message: string): UserIntentMode {
  const normalized = message.toLowerCase().replace(/ё/g, "е");
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
