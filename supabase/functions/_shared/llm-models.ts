// Centralized LLM model identifiers (all via OpenRouter).
// PRIMARY = Claude Haiku 4.5 — 3x cheaper than Sonnet 4.5, testing quality.
// To rollback: change PRIMARY_LLM_MODEL back to "anthropic/claude-sonnet-4.5".
// FALLBACK = Gemini 2.5 Flash, used only when PRIMARY fails (429 / 5xx).

export const PRIMARY_LLM_MODEL = "anthropic/claude-haiku-4.5";
export const FALLBACK_LLM_MODEL = "google/gemini-2.5-flash";

// Backwards-compatible alias used across the codebase.
export const DEFAULT_LLM_MODEL = PRIMARY_LLM_MODEL;

export function shouldFallback(status: number): boolean {
  return status === 429 || status === 402 || (status >= 500 && status < 600);
}
