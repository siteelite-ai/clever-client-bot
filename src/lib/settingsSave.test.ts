import { describe, expect, it, vi } from 'vitest';
import {
  buildSettingsUpdate,
  saveSettingsWithBaseline,
  type SettingsNonSecrets,
  type SettingsSecrets,
} from './settingsSave';
import {
  appSettingsSelect,
  canPingSavedCustomModel,
  canStartPrivatePing,
  parsePrivatePingOutcome,
  parsePrivateSecretConfiguration,
  privateSettingsUpdate,
} from './privateIntegrationSecrets';

const nonSecrets: SettingsNonSecrets = {
  ai_provider: 'openrouter',
  ai_model: 'example/model',
  classifier_provider: 'auto',
  classifier_model: 'example/classifier',
};

const loaded: SettingsSecrets = {
  volt220_api_token: 'catalog-before',
  openrouter_api_key: 'router-before',
  google_api_key: 'hidden-google-before',
};

describe('admin settings save payload', () => {
  it('sends the existing non-secret fields but no unchanged secret, including the hidden Google key', () => {
    expect(buildSettingsUpdate(loaded, { ...loaded }, nonSecrets)).toEqual(nonSecrets);
  });

  it('sends only the one replaced key alongside non-secret fields', () => {
    expect(buildSettingsUpdate(loaded, {
      ...loaded,
      openrouter_api_key: 'router-after',
    }, nonSecrets)).toEqual({
      ...nonSecrets,
      openrouter_api_key: 'router-after',
    });
  });

  it('sends null for an explicitly cleared key and does not treat initial null as a change', () => {
    expect(buildSettingsUpdate(loaded, {
      ...loaded,
      volt220_api_token: '',
    }, nonSecrets)).toEqual({
      ...nonSecrets,
      volt220_api_token: null,
    });

    expect(buildSettingsUpdate({ ...loaded, volt220_api_token: null }, {
      ...loaded,
      volt220_api_token: '',
    }, nonSecrets)).toEqual(nonSecrets);
  });

  it('advances the baseline only after a successful save, so repeated saves omit that key', async () => {
    const persist = vi.fn(async () => undefined);
    const edited = { ...loaded, openrouter_api_key: 'router-after' };

    const baseline = await saveSettingsWithBaseline(loaded, edited, nonSecrets, persist);
    expect(persist).toHaveBeenNthCalledWith(1, {
      ...nonSecrets,
      openrouter_api_key: 'router-after',
    });

    await saveSettingsWithBaseline(baseline, edited, nonSecrets, persist);
    expect(persist).toHaveBeenNthCalledWith(2, nonSecrets);
  });

  it('keeps the old baseline after a failed save, so retry includes the key again', async () => {
    let baseline = loaded;
    const edited = { ...loaded, volt220_api_token: 'catalog-after' };
    const persist = vi.fn()
      .mockRejectedValueOnce(new Error('save failed'))
      .mockResolvedValueOnce(undefined);

    await expect(saveSettingsWithBaseline(baseline, edited, nonSecrets, persist))
      .rejects.toThrow('save failed');
    expect(baseline).toBe(loaded);

    baseline = await saveSettingsWithBaseline(baseline, edited, nonSecrets, persist);
    expect(persist).toHaveBeenNthCalledWith(1, {
      ...nonSecrets,
      volt220_api_token: 'catalog-after',
    });
    expect(persist).toHaveBeenNthCalledWith(2, {
      ...nonSecrets,
      volt220_api_token: 'catalog-after',
    });
    expect(baseline.volt220_api_token).toBe('catalog-after');
  });
});

describe('private integration-secret mode', () => {
  it('uses an explicit non-secret projection, while legacy mode remains unchanged', () => {
    expect(appSettingsSelect(false)).toBe('*');
    const projection = appSettingsSelect(true).split(',');
    expect(projection).toEqual(expect.arrayContaining([
      'id', 'ai_model', 'classifier_model', 'classifier_prompt', 'active_pipeline',
    ]));
    expect(projection).not.toEqual(expect.arrayContaining([
      'volt220_api_token', 'openrouter_api_key', 'google_api_key',
    ]));
  });

  it('cannot include any secret in the ordinary settings-save payload', () => {
    const mixedSettings = {
      ...nonSecrets,
      volt220_api_token: 'must-not-send',
      openrouter_api_key: 'must-not-send',
      google_api_key: 'must-not-send',
    };
    expect(privateSettingsUpdate(mixedSettings)).toEqual(nonSecrets);
  });

  it('accepts only configured booleans and drops accidental value fields', () => {
    expect(parsePrivateSecretConfiguration({
      configured: {
        volt220_api_token: true,
        openrouter_api_key: false,
        google_api_key: true,
        openrouter_value: 'must-not-retain',
      },
      secret: 'must-not-retain',
    })).toEqual({
      volt220_api_token: true,
      openrouter_api_key: false,
      google_api_key: true,
    });
  });

  it('fails closed on an absent or malformed configured flag', () => {
    expect(() => parsePrivateSecretConfiguration(null)).toThrow();
    expect(() => parsePrivateSecretConfiguration({ configured: {
      volt220_api_token: true,
      openrouter_api_key: 'hidden-key',
      google_api_key: false,
    } })).toThrow();
  });

  it('treats a server cooldown as a neutral rate limit, not a broken model', () => {
    expect(parsePrivatePingOutcome(null, 429)).toBe('rate_limited');
    expect(parsePrivatePingOutcome({ ok: false, status: 'rate_limited' }, null)).toBe('rate_limited');
    expect(parsePrivatePingOutcome({ ok: true, status: 'ok' }, 200)).toBe('ok');
    expect(parsePrivatePingOutcome({ ok: false, status: 'provider_error' }, 200)).toBe('provider_error');
    expect(parsePrivatePingOutcome({ ok: false, status: 'timeout' }, 200)).toBe('timeout');
    expect(parsePrivatePingOutcome({ ok: true, status: 'invalid' }, 200)).toBe('error');
  });

  it('permits a private custom-model ping only after saving it as an active model', () => {
    expect(canPingSavedCustomModel('custom/new', true, 'google/gemini-2.5-flash', null)).toBe(false);
    expect(canPingSavedCustomModel('custom/saved', true, 'custom/saved', null)).toBe(true);
    expect(canPingSavedCustomModel('custom/classifier', true, null, 'custom/classifier')).toBe(true);
    expect(canPingSavedCustomModel('google/gemini-2.5-flash', false, null, null)).toBe(true);
  });

  it('does not launch another paid ping while one is pending or its cooldown remains', () => {
    expect(canStartPrivatePing(1_000, 1_030, false)).toBe(false);
    expect(canStartPrivatePing(1_030, 1_030, true)).toBe(false);
    expect(canStartPrivatePing(1_030, 1_030, false)).toBe(true);
  });
});
