export interface SettingsSecrets {
  volt220_api_token: string | null;
  openrouter_api_key: string | null;
  google_api_key: string | null;
}

export interface SettingsNonSecrets {
  ai_provider: string;
  ai_model: string;
  classifier_provider: string;
  classifier_model: string;
}

export type SettingsUpdate = SettingsNonSecrets & Partial<SettingsSecrets>;

const SECRET_FIELDS = [
  'volt220_api_token',
  'openrouter_api_key',
  'google_api_key',
] as const;

function normalizeSecrets(secrets: SettingsSecrets): SettingsSecrets {
  return {
    volt220_api_token: secrets.volt220_api_token || null,
    openrouter_api_key: secrets.openrouter_api_key || null,
    google_api_key: secrets.google_api_key || null,
  };
}

export function buildSettingsUpdate(
  baseline: SettingsSecrets,
  current: SettingsSecrets,
  nonSecrets: SettingsNonSecrets,
): SettingsUpdate {
  const previous = normalizeSecrets(baseline);
  const next = normalizeSecrets(current);
  const update: SettingsUpdate = { ...nonSecrets };

  for (const field of SECRET_FIELDS) {
    if (next[field] !== previous[field]) {
      update[field] = next[field];
    }
  }

  return update;
}

// The caller replaces its baseline only after this resolves. A failed write
// leaves the old baseline intact, so retrying still sends the changed secret.
export async function saveSettingsWithBaseline(
  baseline: SettingsSecrets,
  current: SettingsSecrets,
  nonSecrets: SettingsNonSecrets,
  persist: (update: SettingsUpdate) => Promise<void>,
): Promise<SettingsSecrets> {
  await persist(buildSettingsUpdate(baseline, current, nonSecrets));
  return normalizeSecrets(current);
}
