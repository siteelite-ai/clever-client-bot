import { describe, expect, it, vi } from 'vitest';
import {
  buildSettingsUpdate,
  saveSettingsWithBaseline,
  type SettingsNonSecrets,
  type SettingsSecrets,
} from './settingsSave';

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
