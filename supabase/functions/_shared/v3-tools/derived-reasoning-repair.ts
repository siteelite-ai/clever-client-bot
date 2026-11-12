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
  /** Server-authorized exception: one narrow repair of the first usable
   * response after a primary timeout. Never a reset of the attempt counter. */
  timeoutFallbackProjectionRepair?: boolean;
}

/** A timeout produced no declaration to correct. The fallback's accepted
 * customer state can support exactly one product-only correction, not a new
 * full declaration, provider failover loop or a fourth logical model call.
 * These are server-observed facts, never request/header/model switches. */
export function canRepairTimedOutFallback(input: {
  providerAttempts: number;
  primaryTimedOut: boolean;
  customerStateAccepted: boolean;
  narrowProjectionAvailable: boolean;
  fallbackProvider: string;
  independentProviderRetryEnabled: boolean;
  aborted: boolean;
}): boolean {
  return input.providerAttempts === 2 && input.primaryTimedOut &&
    input.customerStateAccepted && input.narrowProjectionAvailable &&
    input.fallbackProvider === "openrouter" &&
    !input.independentProviderRetryEnabled && !input.aborted;
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
  /** A separate, server-verified per-card gate covers the sole obligation. */
  independentCardProofCoversRequiredMeasurement?: boolean;
}): RequiredProductMeasurementGap | null {
  if (
    !input.required || input.measurementScope === "system_total" ||
    input.pairedFitProven
  ) return null;
  if (input.competingThresholds) return "competing_thresholds";
  if (input.independentCardProofCoversRequiredMeasurement) return null;
  return input.scalarProjectionAllowed &&
      input.mandatoryMeasuredCriterionProjected
    ? null
    : "unprojectable_criterion";
}

export function chooseDerivedReasoningRepair(
  input: DerivedReasoningRepairInput,
): DerivedReasoningRepairReason | null {
  // The normal provider retry and contract repair share a two-call budget.
  // A server-authorized timeout fallback may use a third call for one narrow
  // projection repair, under the same deadline. That third call cannot use
  // the separate measured-product transport retry (enforced by the caller).
  // Ordinary paths retain their released budget and transport retry policy.
  // Keep safety-specific repairs ahead of the generic malformed-contract case.
  if (input.providerAttempts >= 2 &&
    !(input.providerAttempts === 2 && input.timeoutFallbackProjectionRepair === true)) return null;
  if (input.environmentalProtectionMissing) return "environmental_protection";
  if (input.pairedFitMissing) return "paired_fit";
  if (!input.resolvedText?.trim()) return "invalid_declaration";
  if (input.productMeasurementMissing) return "product_measurement";
  return null;
}

export const INVALID_DERIVED_DECLARATION_CORRECTION =
  "Предыдущий вызов declare_selection_reasoning не прошёл проверку: даже длинный текст мог противоречить измерению клиента или живым фасетам. Перепроверь каждый технический тезис по запросу клиента и схеме, убери неподтверждённые измерения, значения и классификации; не объявляй товары подходящими. Повтори вызов: reasoning — 1–3 предложения; measurement_scope — одно из per_product, system_total, not_applicable; compatible_classifications, excluded_classifications, required_facet_values и explicit_customer_classifications — массивы (пустые, если обоснованных ID нет). Сохраняй исходный класс товара, используй только ID живой схемы и не пропускай обязательные поля. Не добавляй числовой порог только ради заполнения контракта.";

/** One policy for the original derivation and its repair. A previous model
 * draft is not an authority that can create immutable customer constraints. */
export const MEASUREMENT_OWNERSHIP_POLICY =
  "Разделяй три вида данных: подтверждённые параметры объекта клиента; обязательные свойства выбираемого изделия; собственные предварительные предположения. Параметр объекта не равен одноимённому параметру изделия: между ними нужно проверяемое отношение совместимости. Не округляй измерение объекта до ближайшего значения фасета и не делай такое значение обязательным равенством изделия. Одно отношение совместимости не доказывает другие независимые свойства. Если сервер передал verified_measurement_relations, используй только описанное отношение, а не новое равенство; это не доказательство пригодности конкретной карточки. Сохраняй все требования клиента и обоснованные условия безопасности, но перепроверяй и отзывай собственные неподтверждённые предположения, включая предположения предыдущего черновика. Не добавляй обязательное значение лишь потому, что оно есть в схеме или в выборке. Для разных свойств допустимы несколько независимых требований; для одного свойства не оставляй конкурирующие обязательные уровни. Если обязательное свойство действительно нельзя определить, назови недостающий факт, а не придумывай порог.";

export const PRODUCT_MEASUREMENT_CORRECTION =
  "Предыдущая попытка оставила непроверяемое числовое требование или конкурирующие уровни одного свойства. Перепроверь происхождение каждого требования: сохрани подтверждённые условия клиента, отдельно сформулируй каждое обоснованное отношение к параметру товара с единицами измерения. Не требуется сводить разные свойства к одному числу. Отзови неподтверждённое модельное равенство, а не превращай его в новое обязательное условие клиента. Для точного значения используй required_facet_values только если доказано, что именно оно необходимо; если несколько живых значений удовлетворяют одному отношению, не выбирай одно обязательное равенство. Не считай промежуточный расчёт итоговым параметром другого изделия. Не ослабляй условия клиента или безопасности ради выдачи.";
