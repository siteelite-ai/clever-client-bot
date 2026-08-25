import {
  extractPortableTechnicalRequirements,
  extractReplacementLookupKeys,
} from "./replacement-preflight.ts";
import type { CatalogSearchState } from "./catalog-search-outcome.ts";

export type SelectionCriterionSource =
  | "user_literal"
  | "anchor_trait"
  | "live_facet"
  | "model_inference";

export interface SelectionPlanCriterion {
  value: string;
  source: SelectionCriterionSource;
}

export interface ReplacementSelectionPlan {
  mode: "replacement";
  anchor_state: CatalogSearchState;
  source_identifiers: string[];
  portable_requirements: SelectionPlanCriterion[];
}

export function buildReplacementSelectionPlan(
  userMessage: string,
  anchorState: CatalogSearchState,
): ReplacementSelectionPlan {
  return {
    mode: "replacement",
    anchor_state: anchorState,
    source_identifiers: extractReplacementLookupKeys(userMessage).modelCodes,
    portable_requirements: extractPortableTechnicalRequirements(userMessage)
      .map((value) => ({ value, source: "user_literal" as const })),
  };
}

/**
 * This hint communicates server evidence, not a replacement decision. The
 * consultant keeps ownership of product-class reasoning while being prevented
 * from repeating a lookup that the server already proved unproductive.
 */
export function selectionPlanSystemHint(
  plan: ReplacementSelectionPlan | null,
): string {
  if (!plan || plan.anchor_state !== "anchor_missing") return "";
  const explicit = plan.portable_requirements.map((item) => item.value).join(
    ", ",
  );
  return [
    "<selection_plan>",
    "Сервер уже проверил точные идентификаторы исходной модели и не нашёл её карточку в актуальном каталоге.",
    "Не повторяй поиск исходной модели и не завершай ответ только из-за отсутствующего якоря.",
    "Опирайся на собственное уже сформулированное рассуждение о классе товара: открой живую категорию и ищи кандидатов по буквальным требованиям пользователя и подтверждённым live-фасетам.",
    "Не превращай модельную догадку о характеристике в обязательный параметр, пока она не подтверждена каталогом.",
    explicit
      ? `Буквальные переносимые требования пользователя: ${explicit}.`
      : "Буквальные переносимые технические требования в запросе не извлечены.",
    "Если найдены только кандидаты того же класса без доказанной эквивалентности, честно назови их возможными вариантами для дальнейшей сверки.",
    "</selection_plan>",
  ].join("\n");
}
