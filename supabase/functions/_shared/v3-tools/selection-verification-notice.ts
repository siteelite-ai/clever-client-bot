/** A failed product proof is not a missing customer fact. No model prose,
 * unverified product or arbitrary contact enters this terminal notice. */
export function selectionVerificationNotice(input: {
  customerInputsAccepted: boolean;
  uncoveredUnits?: readonly string[];
  managerPhone?: string | null;
}): string {
  const labels: Record<string, string> = {
    "в": "напряжение", "кв": "напряжение",
    "а": "ток", "ма": "ток",
    "вт": "мощность", "квт": "мощность",
    "мм": "размеры", "см": "размеры", "м": "размеры",
    "м²": "площадь", "лм": "световой поток",
  };
  const properties = [...new Set((input.uncoveredUnits ?? [])
    .map(unit => labels[unit.toLocaleLowerCase("ru-RU")]).filter(Boolean))].slice(0, 3);
  const lead = input.customerInputsAccepted
    ? "Указанные вами исходные данные учтены."
    : "Ответ получен, но автоматическая проверка исходных данных не завершилась.";
  const gap = properties.length
    ? `Не удалось подтвердить по характеристикам товаров: ${properties.join(", ")}.`
    : "Не удалось подтвердить пригодность товаров по каталогу.";
  const contact = typeof input.managerPhone === "string" && /^\+7\d{10}$/u.test(input.managerPhone)
    ? `Для проверки подбора позвоните менеджеру: ${input.managerPhone}.`
    : "Для проверки подбора свяжитесь с менеджером через страницу контактов сайта.";
  return `${lead} ${gap} Неподтверждённые варианты не показываю. ${contact}`;
}
