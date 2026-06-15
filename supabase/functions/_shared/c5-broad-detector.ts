// c5-broad-detector.ts
//
// Detector for "underspecified-broad" catalog queries: пользователь явно ищет
// товар (intent='catalog'), но НЕ назвал конкретный товар и категория либо
// отсутствует, либо слишком общая на фоне нескольких модификаторов. В этом
// случае слепой поиск даёт мусор; правильнее задать ОДИН точечный вопрос про
// ключевой физический параметр (площадь/мощность/назначение и т.п.).
//
// Полностью data-agnostic: НИКАКИХ whitelist категорий, blacklist слов или
// детекторов «м²». Работает на полях классификатора.
//
// Условия (все обязательны):
//   1. intent === 'catalog'
//   2. has_product_name === false           (нет конкретной карточки)
//   3. is_replacement !== true              (не сценарий замены)
//   4. sub_intent ∈ {null, 'facets', 'spec'} (catalog-поиск, не accessory/compare)
//   5. modifiers.length >= MIN_MODIFIERS     (есть что уточнять)
//   6. product_category пустая ИЛИ
//      product_category непустая, но ОДНОСЛОВНАЯ и при этом modifiers.length >= BROAD_MODIFIERS_THRESHOLD
//      (категория есть, но слишком общая на фоне множества требований)
//
// Метрика: c5_broad_detected_total{category=<...>, modifiers_count=<N>}

export interface BroadDetectorInput {
  intent?: string | null;
  has_product_name?: boolean | null;
  is_replacement?: boolean | null;
  sub_intent?: string | null;
  product_category?: string | null;
  search_modifiers?: unknown;
}

export interface BroadDetectorResult {
  triggered: boolean;
  reason: string;
  modifiersCount: number;
  category: string | null;
}

const MIN_MODIFIERS = 1;
const BROAD_MODIFIERS_THRESHOLD = 2;
const ALLOWED_SUB_INTENTS = new Set([null, undefined, "facets", "spec"]);

function normalizeModifiers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isSingleWord(s: string): boolean {
  return s.trim().split(/\s+/).length === 1;
}

export function detectUnderspecifiedBroad(input: BroadDetectorInput): BroadDetectorResult {
  const modifiers = normalizeModifiers(input.search_modifiers);
  const category = (input.product_category ?? "").trim() || null;
  const base: Omit<BroadDetectorResult, "triggered" | "reason"> = {
    modifiersCount: modifiers.length,
    category,
  };

  if (input.intent !== "catalog") {
    return { ...base, triggered: false, reason: "intent_not_catalog" };
  }
  if (input.has_product_name === true) {
    return { ...base, triggered: false, reason: "has_product_name" };
  }
  if (input.is_replacement === true) {
    return { ...base, triggered: false, reason: "is_replacement" };
  }
  if (!ALLOWED_SUB_INTENTS.has(input.sub_intent ?? null)) {
    return { ...base, triggered: false, reason: `sub_intent_${input.sub_intent}` };
  }
  if (modifiers.length < MIN_MODIFIERS) {
    return { ...base, triggered: false, reason: "no_modifiers" };
  }

  // Gate 1 (detector): triggered = (no category) OR (single-word category).
  // Gate 2 (LLM helper, askBroadClarify): возвращает пустой question если запрос
  // уже достаточно специфичен → silent fallback на обычный pipeline.
  if (!category) {
    return { ...base, triggered: true, reason: "no_category" };
  }
  if (isSingleWord(category)) {
    if (modifiers.length >= BROAD_MODIFIERS_THRESHOLD) {
      return { ...base, triggered: true, reason: "broad_single_word_category_multi_mods" };
    }
    return { ...base, triggered: true, reason: "broad_single_word_category" };
  }
  return { ...base, triggered: false, reason: "category_specific_enough" };
}

