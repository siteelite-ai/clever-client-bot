import type { CoverageDiagnostic } from "./measured-point-range-relation.ts";
import type { MeasuredConjunctionDiagnostic } from "./measured-requirement-conjunction.ts";

/** Attribute failure to the complete contract that actually decided the
 * outcome, not the deliberately limited one-relation checker. An unknown
 * clause/unit is an unknown property, never permission to blame an earlier
 * independently proven voltage/current. Clear stale attribution on success. */
export function measurementFailureUnits(input: {
  failed: boolean;
  structuredConjunction: boolean;
  conjunction?: MeasuredConjunctionDiagnostic | null;
  singleRelation?: CoverageDiagnostic | null;
}): string[] {
  if (!input.failed) return [];
  if (input.structuredConjunction) {
    if (!input.conjunction || input.conjunction.code === "covered") return [];
    if (input.conjunction.code === "unresolved_customer_operating_point") {
      return [...new Set(input.conjunction.unresolved_operating_units ?? [])];
    }
    return [
      ...new Set(input.conjunction.clause_quantities?.map((q) => q.unit) ?? []),
    ];
  }
  if (input.singleRelation?.code === "covered") return [];
  return [
    ...new Set(input.singleRelation?.quantities?.map((q) => q.unit) ?? []),
  ];
}

/** A failed product proof is not a missing customer fact. No model prose,
 * unverified product or arbitrary contact enters this terminal notice. */
export function selectionVerificationNotice(input: {
  customerInputsAccepted: boolean;
  uncoveredUnits?: readonly string[];
  managerPhone?: string | null;
}): string {
  const labels: Record<string, string> = {
    "в": "напряжение",
    "кв": "напряжение",
    "а": "ток",
    "ма": "ток",
    "вт": "мощность",
    "квт": "мощность",
    "мм": "размеры",
    "см": "размеры",
    "м": "размеры",
    "м²": "площадь",
    "лм": "световой поток",
  };
  const properties = [
    ...new Set(
      (input.uncoveredUnits ?? [])
        .map((unit) => labels[unit.toLocaleLowerCase("ru-RU")]).filter(Boolean),
    ),
  ].slice(0, 3);
  const lead = input.customerInputsAccepted
    ? "Указанные вами исходные данные учтены."
    : "Ответ получен, но автоматическая проверка исходных данных не завершилась.";
  const gap = properties.length
    ? `Не удалось подтвердить по характеристикам товаров: ${
      properties.join(", ")
    }.`
    : "Не удалось подтвердить пригодность товаров по каталогу.";
  const contact = typeof input.managerPhone === "string" &&
      /^\+7\d{10}$/u.test(input.managerPhone)
    ? `Для проверки подбора позвоните менеджеру: ${input.managerPhone}.`
    : "Для проверки подбора свяжитесь с менеджером через страницу контактов сайта.";
  return `${lead} ${gap} Неподтверждённые варианты не показываю. ${contact}`;
}
