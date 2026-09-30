export interface GeneralInquiryRouteInput {
  intentMode: "select" | "inquire";
  exactProductInquiry: boolean;
  namedSeriesInquiry: boolean;
  catalogGroundingRequired: boolean;
  recentProductEvidence: boolean;
  activeSelectionScope?: boolean;
}

export const GENERAL_INQUIRY_UNAVAILABLE_TEXT =
  "Не удалось вовремя подготовить надёжный консультационный ответ. Повторите вопрос — поиск товаров при этом не запускался.";

/**
 * Informational electrical questions are consultations, not empty catalog
 * searches.  Exact products, named series and follow-ups about already shown
 * cards keep their evidence-backed routes; every other inquiry can be answered
 * in one bounded tool-free step.  The decision contains no product or category
 * vocabulary and therefore applies consistently across domains.
 */
export function shouldAnswerGeneralInquiryDirectly(
  input: GeneralInquiryRouteInput,
): boolean {
  return !input.activeSelectionScope &&
    input.intentMode === "inquire" &&
    !input.exactProductInquiry &&
    !input.namedSeriesInquiry &&
    !input.catalogGroundingRequired &&
    !input.recentProductEvidence;
}

export function buildGeneralInquiryMessages(
  userMessage: string,
): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: [
        "Ты электротехнический консультант 220volt.kz.",
        "Ответь прямо на информационный вопрос клиента; это не запрос на поиск товаров.",
        "Покажи существенные зависимости и, если есть числа, короткий проверяемый расчёт с единицами.",
        "Отделяй общеизвестный ориентир от обязательного требования производителя или проекта.",
        "Для потенциально опасного подключения укажи условие применимости и что должен проверить квалифицированный электрик.",
        "Если для однозначного ответа не хватает одного критичного параметра, задай один конкретный уточняющий вопрос.",
        "Не называй товары, цены, наличие или факты живого каталога; не говори, что товары не найдены; не упоминай внутренние инструменты.",
        "Ответь на языке клиента, кратко и по существу.",
      ].join(" "),
    },
    { role: "user", content: userMessage },
  ];
}
