import type { SettingsNonSecrets } from './settingsSave';

export const PRIVATE_SECRET_KEYS = [
  'volt220_api_token',
  'openrouter_api_key',
  'google_api_key',
] as const;

export type PrivateSecretKey = typeof PRIVATE_SECRET_KEYS[number];
export type PrivateSecretConfiguration = Record<PrivateSecretKey, boolean>;
export type PrivatePingOutcome =
  | 'ok'
  | 'rate_limited'
  | 'not_configured'
  | 'not_saved'
  | 'provider_error'
  | 'timeout'
  | 'error';

// Keep the projection explicit: a wildcard SELECT would send stored secrets to
// the browser even if the UI never rendered their values.
export const PRIVATE_APP_SETTINGS_SELECT = [
  'id',
  'ai_provider',
  'ai_model',
  'classifier_provider',
  'classifier_model',
  'classifier_prompt',
  'active_pipeline',
].join(',');

export function appSettingsSelect(privateMode: boolean): string {
  return privateMode ? PRIVATE_APP_SETTINGS_SELECT : '*';
}

// Deliberately return a new object containing only non-secret fields. This
// prevents a future caller from accidentally spreading an app_settings row.
export function privateSettingsUpdate(nonSecrets: SettingsNonSecrets): SettingsNonSecrets {
  return {
    ai_provider: nonSecrets.ai_provider,
    ai_model: nonSecrets.ai_model,
    classifier_provider: nonSecrets.classifier_provider,
    classifier_model: nonSecrets.classifier_model,
  };
}

export function parsePrivateSecretConfiguration(payload: unknown): PrivateSecretConfiguration {
  if (!payload || typeof payload !== 'object' || !('configured' in payload)) {
    throw new Error('Secret configuration status is missing');
  }

  const configured = payload.configured as Record<string, unknown> | null;
  if (!configured || typeof configured !== 'object') {
    throw new Error('Secret configuration status is invalid');
  }

  for (const key of PRIVATE_SECRET_KEYS) {
    if (typeof configured[key] !== 'boolean') {
      throw new Error(`Secret configuration status is invalid for ${key}`);
    }
  }

  // Do not retain or surface any unexpected response property.
  return {
    volt220_api_token: configured.volt220_api_token as boolean,
    openrouter_api_key: configured.openrouter_api_key as boolean,
    google_api_key: configured.google_api_key as boolean,
  };
}

export function parsePrivatePingOutcome(payload: unknown, httpStatus: number | null): PrivatePingOutcome {
  if (httpStatus === 429) return 'rate_limited';
  if (httpStatus === 400) return 'not_saved';
  if (!payload || typeof payload !== 'object' || !('status' in payload)) return 'error';

  if (payload.status === 'rate_limited') return 'rate_limited';
  if (payload.status === 'not_configured') return 'not_configured';
  if (payload.status === 'provider_error') return 'provider_error';
  if (payload.status === 'timeout') return 'timeout';
  if (payload.status === 'ok' && 'ok' in payload && payload.ok === true) return 'ok';
  return 'error';
}

export function canPingSavedCustomModel(
  modelId: string,
  custom: boolean,
  savedAiModel: string | null,
  savedClassifierModel: string | null,
): boolean {
  return !custom || modelId === savedAiModel || modelId === savedClassifierModel;
}

export function canStartPrivatePing(now: number, blockedUntil: number, inFlight: boolean): boolean {
  return !inFlight && now >= blockedUntil;
}
