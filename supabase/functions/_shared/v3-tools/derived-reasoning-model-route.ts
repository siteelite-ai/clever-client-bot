import {
  buildOpenRouterModelRouting,
  type OpenRouterModelRouting,
} from "./model-routing.ts";

export type DerivedReasoningDeploymentVariant = "production" | "preview";

export function previewDerivedReasoningExperimentEnabled(
  variant: DerivedReasoningDeploymentVariant,
  previewModel?: string | null,
): boolean {
  return variant === "preview" && Boolean(previewModel?.trim());
}

/** A project-wide secret may be present in both functions. Only the preview
 * wrapper may use it; production retains the database classifier setting. */
export function selectDerivedReasoningModel(input: {
  variant: DerivedReasoningDeploymentVariant;
  classifierModel: string;
  previewModel?: string | null;
}): string {
  const previewModel = previewDerivedReasoningExperimentEnabled(
      input.variant,
      input.previewModel,
    )
    ? input.previewModel?.trim()
    : null;
  return previewModel || input.classifierModel;
}

/** Only an explicitly configured preview A/B run is single-model. With no
 * override, preview retains the same fallback chain as production. */
export function derivedReasoningModelRouting(input: {
  variant: DerivedReasoningDeploymentVariant;
  model: string;
  productionFallbacks: string[];
  previewModel?: string | null;
}): OpenRouterModelRouting {
  return buildOpenRouterModelRouting(
    input.model,
    previewDerivedReasoningExperimentEnabled(input.variant, input.previewModel)
      ? []
      : input.productionFallbacks,
  );
}

/** Keep an explicitly configured preview forced-schema measurement on
 * OpenRouter only. Baseline preview and production retain provider failover. */
export function allowDerivedReasoningProviderFailover(
  variant: DerivedReasoningDeploymentVariant,
  phase: string,
  previewModel?: string | null,
): boolean {
  return !(previewDerivedReasoningExperimentEnabled(variant, previewModel) &&
    phase === "derived_reasoning");
}

/** Provider fields are untrusted. Persist only bounded machine identifiers,
 * never arbitrary returned text in the per-attempt diagnostic. */
export function safeDerivedReasoningModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const model = value.trim();
  if (model.length === 0 || model.length > 120) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*\/[A-Za-z0-9][A-Za-z0-9._:+/-]*$/u
      .test(model)
    ? model
    : null;
}

export function safeDerivedReasoningProvider(value: unknown): string {
  return value === "openrouter" || value === "lovable" ? value : "unknown";
}

export function safeDerivedReasoningFinish(value: unknown): string {
  return value === "stop" || value === "length" ||
      value === "tool_calls" || value === "function_call" ||
      value === "content_filter" || value === "error"
    ? value
    : "other";
}

export function safeDerivedReasoningToolName(value: unknown): string {
  if (value === "declare_selection_reasoning") return value;
  if (value === "google:python_interpreter") {
    return "unexpected_python_interpreter";
  }
  return "unexpected_tool";
}

export function safeDerivedReasoningErrorType(value: unknown): string {
  return value === "TimeoutError" || value === "AbortError" ||
      value === "UpstreamHttpError" || value === "TypeError"
    ? value
    : "other_error";
}
