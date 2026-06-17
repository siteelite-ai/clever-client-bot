// Centralized LLM model identifiers.
// PRIMARY = free model via OpenRouter (deepseek v3.1 free tier).
// FALLBACK = paid Claude, used only when PRIMARY fails (429 / 5xx / parse error).
//
// Switch by editing this file or overriding via app_settings.ai_model.

export const PRIMARY_LLM_MODEL = "deepseek/deepseek-chat-v3.1:free";
export const FALLBACK_LLM_MODEL = "anthropic/claude-sonnet-4.5";

// Backwards-compatible alias used across the codebase.
export const DEFAULT_LLM_MODEL = PRIMARY_LLM_MODEL;

/**
 * Decide whether a non-OK OpenRouter response should trigger a fallback retry
 * with the paid model.
 */
export function shouldFallback(status: number): boolean {
  return status === 429 || status === 402 || (status >= 500 && status < 600);
}
