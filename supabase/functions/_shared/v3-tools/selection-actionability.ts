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
