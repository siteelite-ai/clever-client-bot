/** Build a stable OpenRouter model-fallback chain. The primary model always
 * stays first; blank and duplicate fallbacks are removed. */
export function buildModelFallbackChain(
  primary: string,
  fallbacks: string[],
): string[] {
  return [...new Set([primary, ...(Array.isArray(fallbacks) ? fallbacks : [])]
    .map((model) => String(model ?? "").trim())
    .filter(Boolean))];
}

export function parseConfiguredModelFallbacks(value: string | null | undefined): string[] {
  if (!value) return [];
  return [...new Set(value
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean))];
}

export type OpenRouterModelRouting =
  | { model: string }
  | { models: string[] };

/** Preserve the existing single-model request unless fallback models were
 * explicitly configured. This keeps new external model destinations opt-in. */
export function buildOpenRouterModelRouting(
  primary: string,
  fallbacks: string[],
): OpenRouterModelRouting {
  const models = buildModelFallbackChain(primary, fallbacks);
  if (models.length === 0) throw new Error("Primary OpenRouter model is required");
  return models.length === 1 ? { model: models[0] } : { models };
}
