-- Disposable PostgreSQL 16 ONLY. Apply the real additive migration, then the
-- disposable fixture, then this file with psql -v cutover_case=NAME. Run the
-- MANUAL script in a NEW psql process with ON_ERROR_STOP=1 and require a
-- nonzero exit AND the expected static "Cutover refused:" error below. A
-- syntax error must not count as a passing negative test. Then run
-- failure-assert.sql with the same cutover_case.
-- Each case requires its own fresh disposable database.
-- Supported cases: required-private-missing, required-private-mismatch,
-- optional-private-missing, optional-private-mismatch, optional-private-only,
-- required-legacy-missing, zero-settings, two-settings.
-- Expected error text:
--   required-private-missing, required-private-mismatch:
--     Cutover refused: required private credentials do not match
--   optional-private-missing, optional-private-mismatch:
--     Cutover refused: optional private credential does not match
--   optional-private-only:
--     Cutover refused: optional credential presence differs
--   required-legacy-missing:
--     Cutover refused: required legacy credentials are absent
--   zero-settings, two-settings:
--     Cutover refused: app_settings must contain exactly one row
\if :{?cutover_case}
\else
  \echo 'cutover_case is required'
  \quit 3
\endif

SELECT set_config('ci.cutover_case', :'cutover_case', false);

DO $case$
BEGIN
  CASE current_setting('ci.cutover_case')
    WHEN 'required-private-missing' THEN
      DELETE FROM public.integration_secrets WHERE key = 'openrouter_api_key';
    WHEN 'required-private-mismatch' THEN
      UPDATE public.integration_secrets
         SET secret_value = 'ci-private-mismatch'
       WHERE key = 'volt220_api_token';
    WHEN 'optional-private-missing' THEN
      DELETE FROM public.integration_secrets WHERE key = 'google_api_key';
    WHEN 'optional-private-mismatch' THEN
      UPDATE public.integration_secrets
         SET secret_value = 'ci-private-mismatch'
       WHERE key = 'google_api_key';
    WHEN 'optional-private-only' THEN
      UPDATE public.app_settings SET google_api_key = NULL;
    WHEN 'required-legacy-missing' THEN
      UPDATE public.app_settings SET openrouter_api_key = NULL;
    WHEN 'zero-settings' THEN
      DELETE FROM public.app_settings;
    WHEN 'two-settings' THEN
      INSERT INTO public.app_settings (id, ai_model)
      VALUES ('22222222-2222-4222-8222-222222222222', 'ci-other-model');
    ELSE
      RAISE EXCEPTION 'Unknown cutover negative test case';
  END CASE;
END;
$case$;
