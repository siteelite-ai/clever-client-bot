import { modelId, publicSettings, replacement, type SettingsRow } from './security.ts';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

Deno.test('admin settings read returns presence only, never stored credentials', () => {
  const row: SettingsRow = {
    id: 'synthetic-row',
    volt220_api_token: 'catalog-test-sentinel',
    openrouter_api_key: 'router-test-sentinel',
    google_api_key: 'google-test-sentinel',
    ai_provider: 'openrouter',
    ai_model: 'google/gemini-2.5-flash',
    classifier_provider: 'openrouter',
    classifier_model: 'google/gemini-2.5-flash-lite',
    classifier_prompt: null,
    active_pipeline: 'v3',
  };
  const safe = publicSettings(row);
  const serialized = JSON.stringify(safe);
  assert(safe.hasVolt220ApiToken && safe.hasOpenrouterKey && safe.hasGoogleApiKey, 'presence flags missing');
  for (const sentinel of ['catalog-test-sentinel', 'router-test-sentinel', 'google-test-sentinel']) {
    assert(!serialized.includes(sentinel), 'credential leaked into response');
  }
  assert(!Object.keys(safe).some((name) => name.endsWith('_api_key') || name.endsWith('_api_token')), 'raw key name leaked');
});

Deno.test('secret replacements reject accidental empty/whitespace values', () => {
  assert(replacement('') === null, 'empty token accepted');
  assert(replacement('  ') === null, 'blank token accepted');
  assert(replacement('test token') === null, 'whitespace token accepted');
  assert(replacement('x'.repeat(2049)) === null, 'oversized token accepted');
  assert(replacement('  test-token  ') === 'test-token', 'valid replacement lost');
});

Deno.test('model identifiers are bounded and cannot inject request structure', () => {
  assert(modelId('anthropic/claude-sonnet-4.5') === 'anthropic/claude-sonnet-4.5', 'valid model rejected');
  assert(modelId('google/gemini-2.5-flash:free') === 'google/gemini-2.5-flash:free', 'variant rejected');
  for (const invalid of ['', 'bad model', 'bad\nmodel', 'x'.repeat(129), { id: 'model' }]) {
    assert(modelId(invalid) === null, 'invalid model accepted');
  }
});
