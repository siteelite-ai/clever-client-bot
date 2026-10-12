import { measuredLoadGuidanceCanProceed } from "./selection-readiness.ts";

export interface MeasuredBreakerGuidance {
  answer: string;
  current_a: number;
  suggested_rating_a: number | null;
  supply: "single_phase" | "three_phase";
  conditional_supply: boolean;
}

const STANDARD_BREAKER_RATINGS_A = [6, 10, 16, 20, 25, 32, 40, 50, 63, 80, 100];

function numberFrom(value: string): number | null {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(".", ",");
}

function nextStandardRating(current: number): number | null {
  return STANDARD_BREAKER_RATINGS_A.find((rating) => rating >= current) ?? null;
}

/**
 * A measured engineering question needs a visible calculation before any SKU
 * search. This router is deliberately independent from product/category
 * aliases: it recognises the protection-device noun, a measured load and a
 * guidance question. Direct catalogue imperatives remain in the ordinary
 * readiness/search pipeline.
 */
export function buildMeasuredBreakerGuidance(
  message: string,
): MeasuredBreakerGuidance | null {
  const source = String(message ?? "").trim();
  if (!source) return null;
  const breaker = /(?:автомат\p{L}*(?:\s+выключател\p{L}*)?|выключател\p{L}*\s+автомат\p{L}*)/iu.test(source);
  const guidance = measuredLoadGuidanceCanProceed(source) ||
    /(?:рассчитай|рассчитать|определи|определить)[^.!?\n]{0,80}(?:номинал|ток|автомат)/iu.test(source);
  const catalogImperative = /(?:^|[^\p{L}])(?:найд\p{L}*|подбер\p{L}*|покаж\p{L}*|предлож\p{L}*|выбер\p{L}*|купи\p{L}*)(?=$|[^\p{L}])/iu.test(source);
  if (!breaker || !guidance || catalogImperative) return null;

  const powerKw = numberFrom(source.match(/(\d+(?:[.,]\d+)?)\s*к\s*вт(?=$|[^\p{L}\p{N}])/iu)?.[1] ?? "");
  const explicitCurrent = numberFrom(source.match(/(\d+(?:[.,]\d+)?)\s*а(?=$|[^\p{L}\p{N}])/iu)?.[1] ?? "");
  if (powerKw === null && explicitCurrent === null) return null;

  const threePhase = /(?:тр[её]хфаз\p{L}*|3\s*фаз\p{L}*|\b(?:380|400)\s*в\b)/iu.test(source);
  const singlePhase = /(?:однофаз\p{L}*|1\s*фаз\p{L}*|\b(?:220|230)\s*в\b)/iu.test(source);
  const supply: MeasuredBreakerGuidance["supply"] = threePhase ? "three_phase" : "single_phase";
  const conditionalSupply = !threePhase && !singlePhase;
  const voltage = supply === "three_phase"
    ? (/\b380\s*в\b/iu.test(source) ? 380 : 400)
    : (/\b220\s*в\b/iu.test(source) ? 220 : 230);
  const calculatedCurrent = explicitCurrent ?? (
    supply === "three_phase"
      ? powerKw! * 1000 / (Math.sqrt(3) * voltage)
      : powerKw! * 1000 / voltage
  );
  const suggested = nextStandardRating(calculatedCurrent);
  const supplyText = supply === "three_phase"
    ? `трёхфазном вводе ${voltage} В`
    : `однофазном вводе ${voltage} В`;
  const premise = conditionalSupply ? `Если ввод однофазный ${voltage} В, ` : `При ${supplyText} `;
  const calculation = powerKw !== null
    ? supply === "three_phase"
      ? `${fmt(powerKw)} кВт / (√3 × ${voltage} В) ≈ ${fmt(calculatedCurrent)} А на фазу`
      : `${fmt(powerKw)} кВт / ${voltage} В ≈ ${fmt(calculatedCurrent)} А`
    : `указанный рабочий ток составляет ${fmt(calculatedCurrent)} А`;
  const ratingText = suggested === null
    ? "расчётный ток выше 100 А — нужен проектный расчёт, а не выбор ближайшего модульного номинала"
    : `ближайший стандартный номинал без занижения расчётного тока — ${suggested} А`;
  const phaseCaveat = conditionalSupply
    ? " Если ввод трёхфазный, результат будет другим — уточните напряжение и число фаз."
    : "";

  return {
    answer: `${premise}${calculation}; ${ratingText}. Для обычной бытовой линии чаще рассматривают характеристику C, но окончательный тип зависит от пусковых токов нагрузки. Автомат защищает кабель, поэтому этот номинал допустим только после проверки сечения и материала кабеля, способа прокладки, вводного лимита и селективности.${phaseCaveat}`,
    current_a: calculatedCurrent,
    suggested_rating_a: suggested,
    supply,
    conditional_supply: conditionalSupply,
  };
}
