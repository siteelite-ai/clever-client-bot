import { redactInternals } from "./internals-guard.ts";

/**
 * A blocking clarification is a question, not a provisional recommendation.
 * Keep the model's reasoning in its original declaration/checkpoint; this
 * renderer must never publish it while the missing customer input is pending.
 * The same rule applies to every product family and every clarification route.
 */
export interface BlockingClarificationPublicAnswerInput {
  question: unknown;
  /** Intentionally ignored: not yet verified against the customer's answer. */
  provisionalReasoning?: unknown;
}

export const BLOCKING_CLARIFICATION_PREFACE =
  "Для подбора нужен ответ на один вопрос:";

/** Return null rather than publishing a malformed or internal question. */
export function renderBlockingClarificationAnswer(
  { question }: BlockingClarificationPublicAnswerInput,
): string | null {
  if (typeof question !== "string" || question.length > 1400) return null;

  // Match the existing visible-facet text semantics: no control characters,
  // raw HTML brackets, or multiline model formatting in customer text.
  const visible = question
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/</gu, "‹")
    .replace(/>/gu, "›")
    .replace(/\s+/gu, " ")
    .trim();
  if (
    visible.length < 8 || visible.length > 350 ||
    !/\p{L}/u.test(visible) ||
    (visible.match(/[?？]/gu)?.length ?? 0) > 1 ||
    /\bf\d+v\d+\b/iu.test(visible) ||
    /(?:https?:\/\/|www\.)\S+/iu.test(visible) ||
    /\[[^\]]+\]\([^)]*\)/u.test(visible)
  ) return null;

  const guarded = redactInternals(visible);
  if (
    guarded.redacted || !guarded.text.trim() ||
    guarded.text.length > 350
  ) return null;
  return `${BLOCKING_CLARIFICATION_PREFACE}\n\n${guarded.text}`;
}
