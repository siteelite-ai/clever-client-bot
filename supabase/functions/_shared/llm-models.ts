// Centralized LLM model identifiers (all via OpenRouter).
// PRIMARY = Gemini 2.5 Flash — strong tool-calling, ~15× cheaper than Claude.
// FALLBACK = Claude Sonnet 4.5, used only when PRIMARY fails (429 / 5xx).

export const PRIMARY_LLM_MODEL = "google/gemini-2.5-flash";
export const FALLBACK_LLM_MODEL = "anthropic/claude-sonnet-4.5";

// Backwards-compatible alias used across the codebase.
export const DEFAULT_LLM_MODEL = PRIMARY_LLM_MODEL;

/**
 * Decide whether a non-OK OpenRouter response should trigger a fallback retry
 * with the paid Claude model.
 */
export function shouldFallback(status: number): boolean {
  return status === 429 || status === 402 || (status >= 500 && status < 600);
}
