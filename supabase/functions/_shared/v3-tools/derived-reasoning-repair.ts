/** One bounded repair decision for the derived reasoning tool contract. */
export type DerivedReasoningRepairReason =
  | "invalid_declaration"
  | "environmental_protection"
  | "paired_fit"
  | "product_measurement";

export interface DerivedReasoningRepairInput {
  resolvedText: string | null | undefined;
  environmentalProtectionMissing: boolean;
  pairedFitMissing: boolean;
  productMeasurementMissing: boolean;
  providerAttempts: number;
}

export function chooseDerivedReasoningRepair(
  input: DerivedReasoningRepairInput,
): DerivedReasoningRepairReason | null {
  // The provider retry and contract repair share a two-call budget. Keep the
  // existing safety-specific repairs ahead of the generic malformed-contract
  // case, so an exposed installation or unproven measured pair still receives
  // the more useful correction (and its existing fail-closed terminal).
  if (input.providerAttempts >= 2) return null;
  if (input.environmentalProtectionMissing) return "environmental_protection";
  if (input.pairedFitMissing) return "paired_fit";
  if (!input.resolvedText?.trim()) return "invalid_declaration";
  if (input.productMeasurementMissing) return "product_measurement";
  return null;
}

export const INVALID_DERIVED_DECLARATION_CORRECTION =
  "Предыдущий вызов declare_selection_reasoning не прошёл проверку: даже длинный текст мог противоречить измерению клиента или живым фасетам. Перепроверь каждый технический тезис по запросу клиента и схеме, убери неподтверждённые измерения, значения и классификации; не объявляй товары подходящими. Повтори вызов: reasoning — 1–3 предложения; measurement_scope — одно из per_product, system_total, not_applicable; compatible_classifications, excluded_classifications, required_facet_values и explicit_customer_classifications — массивы (пустые, если обоснованных ID нет). Сохраняй исходный класс товара, используй только ID живой схемы и не пропускай обязательные поля. Не добавляй числовой порог только ради заполнения контракта.";
