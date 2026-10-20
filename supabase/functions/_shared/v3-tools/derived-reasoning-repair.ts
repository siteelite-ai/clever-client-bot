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

export type RequiredProductMeasurementGap =
  | "unprojectable_criterion"
  | "competing_thresholds";

/** A required product-side measurement needs one enforceable card criterion.
 * A verified two-sided fit owns that obligation instead of a scalar, while a
 * system total must never become a requirement on each individual product. */
export function classifyRequiredProductMeasurementGap(input: {
  required: boolean;
  measurementScope: string | null | undefined;
  pairedFitProven: boolean;
  scalarProjectionAllowed: boolean;
  mandatoryMeasuredCriterionProjected: boolean;
  competingThresholds: boolean;
}): RequiredProductMeasurementGap | null {
  if (
    !input.required || input.measurementScope === "system_total" ||
    input.pairedFitProven
  ) return null;
  if (input.competingThresholds) return "competing_thresholds";
  return input.scalarProjectionAllowed &&
      input.mandatoryMeasuredCriterionProjected
    ? null
    : "unprojectable_criterion";
}

export function chooseDerivedReasoningRepair(
  input: DerivedReasoningRepairInput,
): DerivedReasoningRepairReason | null {
  // The normal provider retry and contract repair share a two-call budget.
  // The sole exception is one transport retry of a product_measurement
  // correction after a confirmed real HTTP 5xx, within the same turn deadline:
  // that can make at most three logical model calls, never a second repair.
  // Keep safety-specific repairs ahead of the generic malformed-contract case.
  if (input.providerAttempts >= 2) return null;
  if (input.environmentalProtectionMissing) return "environmental_protection";
  if (input.pairedFitMissing) return "paired_fit";
  if (!input.resolvedText?.trim()) return "invalid_declaration";
  if (input.productMeasurementMissing) return "product_measurement";
  return null;
}

export const INVALID_DERIVED_DECLARATION_CORRECTION =
  "Предыдущий вызов declare_selection_reasoning не прошёл проверку: даже длинный текст мог противоречить измерению клиента или живым фасетам. Перепроверь каждый технический тезис по запросу клиента и схеме, убери неподтверждённые измерения, значения и классификации; не объявляй товары подходящими. Повтори вызов: reasoning — 1–3 предложения; measurement_scope — одно из per_product, system_total, not_applicable; compatible_classifications, excluded_classifications, required_facet_values и explicit_customer_classifications — массивы (пустые, если обоснованных ID нет). Сохраняй исходный класс товара, используй только ID живой схемы и не пропускай обязательные поля. Не добавляй числовой порог только ради заполнения контракта.";
