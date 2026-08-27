import { hasActionableSelectionReasoning } from "./agent-performance.ts";
import {
  minimumCompatibilityRelationCount,
  reasoningNeedsCompatibilityRelations,
} from "./compatibility-contract.ts";

/**
 * Whether the consultant has already produced enough machine-checkable
 * reasoning to search instead of asking an optional preference question.
 * This combines independent numeric axes with a two-sided compatibility
 * contract; it contains no category or product vocabulary.
 */
export function hasActionableSelectionContract(text: string): boolean {
  return hasActionableSelectionReasoning(text) ||
    minimumCompatibilityRelationCount(text) >= 2 ||
    reasoningNeedsCompatibilityRelations(text);
}

export interface ClarificationContinuationInput {
  intentMode: "select" | "inquire";
  hasDiscovery: boolean;
  userMessage: string;
  question: string;
  facetKey: string;
  options: Array<{ value?: string; label?: string }>;
}

const OBJECTIVE_CLARIFICATION = /(?:мощност|напряж|нагруз|потреблен|ток(?:а|у|ом)?\b|ампер|вольт|ватт|фаз|сечен|диаметр|размер|длин|высот|температур|давлен|расход|ёмкост|емкост|частот|скорост|крутящ|цокол|степен[ьи]\s+защит|\bip\s*\d|полюс|контакт|разъ[её]м|монтаж|установк|совместим)/iu;
const OPTIONAL_PREFERENCE_CLARIFICATION = /(?:предпочит|нравит|что\s+ближе|какой\s+(?:вариант|формат|стиль|дизайн|цвет)|какого\s+(?:цвета|стиля|дизайна)|рассматрива(?:ете|ешь)|по\s+(?:внешнему\s+виду|дизайну|стилю))/iu;

function normalizePreference(value: string): string {
  return String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * A live facet may contain several equally valid aesthetic or presentation
 * variants. When the customer did not ask to choose between those variants,
 * that optional preference must not block an otherwise ordinary selection.
 * Objective/safety/compatibility questions remain untouched. The policy uses
 * only linguistic intent and actual tool arguments, not a product dictionary.
 */
export function shouldContinueSelectionPastOptionalClarification(
  input: ClarificationContinuationInput,
): boolean {
  if (input.intentMode !== "select" || !input.hasDiscovery) return false;
  const questionAndFacet = `${input.question}\n${input.facetKey}`;
  if (OBJECTIVE_CLARIFICATION.test(questionAndFacet)) return false;
  if (!OPTIONAL_PREFERENCE_CLARIFICATION.test(input.question)) return false;

  const user = normalizePreference(input.userMessage);
  const explicitlyNamedOptions = input.options
    .map((option) => normalizePreference(option.value || option.label || ""))
    .filter((option) => option.length >= 2 && user.includes(option));
  return new Set(explicitlyNamedOptions).size < 2;
}
