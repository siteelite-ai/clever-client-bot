-- Run ONLY on a fresh disposable PostgreSQL 16 database AFTER applying
-- 20261022060000_admin_integration_secrets.sql, using psql ON_ERROR_STOP=1.
-- Never target live Supabase.
-- Example (replace only the connection string with a disposable database):
-- psql -X -v ON_ERROR_STOP=1 "$DISPOSABLE_PG_URL" \
--   -f docs/security/integration-secrets-cutover-local-test.sql
\ir integration-secrets-cutover-disposable-schema.sql
\ir integration-secrets-cutover-MANUAL.sql

BEGIN;
DO $test$
DECLARE
  v_row public.app_settings%ROWTYPE;
  v_error text;
BEGIN
  IF (SELECT count(*) FROM public.app_settings) <> 1 THEN
    RAISE EXCEPTION 'Cutover test: settings row count changed';
  END IF;
  SELECT * INTO STRICT v_row FROM public.app_settings;
  IF v_row.openrouter_api_key IS NOT NULL
     OR v_row.volt220_api_token IS NOT NULL
     OR v_row.google_api_key IS NOT NULL THEN
    RAISE EXCEPTION 'Cutover test: a legacy credential remains';
  END IF;
  IF v_row.ai_model <> 'ci-model-before' THEN
    RAISE EXCEPTION 'Cutover test: unrelated setting changed';
  END IF;
  IF (SELECT count(*) FROM public.integration_secrets) <> 3 THEN
    RAISE EXCEPTION 'Cutover test: private rows were changed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.app_settings'::regclass
      AND tgname = 'reject_app_settings_legacy_integration_secret_write'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Cutover test: legacy write guard is absent';
  END IF;

  -- Match the guard's static error rather than merely accepting any failure.
  BEGIN
    UPDATE public.app_settings
       SET openrouter_api_key = 'ci-attempted-restoration';
    RAISE EXCEPTION 'Cutover test: legacy OpenRouter write was accepted';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
    IF v_error <> 'Legacy integration secret columns are read-only after cutover' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    UPDATE public.app_settings
       SET volt220_api_token = 'ci-attempted-restoration';
    RAISE EXCEPTION 'Cutover test: legacy catalog write was accepted';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
    IF v_error <> 'Legacy integration secret columns are read-only after cutover' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    UPDATE public.app_settings
       SET google_api_key = 'ci-attempted-restoration';
    RAISE EXCEPTION 'Cutover test: legacy Google write was accepted';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
    IF v_error <> 'Legacy integration secret columns are read-only after cutover' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    INSERT INTO public.app_settings
      (id, openrouter_api_key, ai_model)
    VALUES ('22222222-2222-4222-8222-222222222222',
            'ci-attempted-restoration', 'ci-other-model');
    RAISE EXCEPTION 'Cutover test: INSERT with legacy secret was accepted';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
    IF v_error <> 'Legacy integration secret columns are read-only after cutover' THEN
      RAISE;
    END IF;
  END;

  -- Non-secret settings must remain editable through the ordinary table.
  UPDATE public.app_settings SET ai_model = 'ci-model-after'
    WHERE id = v_row.id;
  IF (SELECT ai_model FROM public.app_settings WHERE id = v_row.id)
     <> 'ci-model-after' THEN
    RAISE EXCEPTION 'Cutover test: non-secret setting update failed';
  END IF;
END;
$test$;
ROLLBACK;
