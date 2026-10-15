// Pure helpers kept separate from the network handler for fast offline tests.
export interface SettingsRow {
  id: string;
  volt220_api_token: string | null;
  openrouter_api_key: string | null;
  google_api_key: string | null;
  ai_provider: string;
  ai_model: string;
  classifier_provider: string;
  classifier_model: string;
  classifier_prompt: string | null;
  active_pipeline: string;
}

const modelPattern = /^[a-zA-Z0-9][a-zA-Z0-9_./:+-]{0,127}$/;

export function modelId(value: unknown): string | null {
  return typeof value === 'string' && modelPattern.test(value) ? value : null;
}

export function replacement(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 2048 && !/\s/.test(trimmed) ? trimmed : null;
}

export function publicSettings(row: SettingsRow) {
  return {
    id: row.id,
    hasVolt220ApiToken: Boolean(row.volt220_api_token),
    hasOpenrouterKey: Boolean(row.openrouter_api_key),
    hasGoogleApiKey: Boolean(row.google_api_key),
    ai_provider: row.ai_provider,
    ai_model: row.ai_model,
    classifier_provider: row.classifier_provider,
    classifier_model: row.classifier_model,
    classifier_prompt: row.classifier_prompt,
    active_pipeline: row.active_pipeline,
  };
}
