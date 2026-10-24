-- Disposable PostgreSQL 16 ONLY, after the real additive migration. This
-- second positive path proves Google can be absent on BOTH sides. Run in a
-- fresh database, independently of the main local-test.sql.
\ir integration-secrets-cutover-disposable-schema.sql

BEGIN;
UPDATE public.app_settings SET google_api_key = NULL;
DELETE FROM public.integration_secrets WHERE key = 'google_api_key';
COMMIT;

\ir integration-secrets-cutover-MANUAL.sql

DO $test$
BEGIN
  IF (SELECT count(*) FROM public.app_settings) <> 1
     OR EXISTS (
       SELECT 1 FROM public.app_settings
       WHERE openrouter_api_key IS NOT NULL
          OR volt220_api_token IS NOT NULL
          OR google_api_key IS NOT NULL
     )
     OR (SELECT count(*) FROM public.integration_secrets) <> 2
     OR EXISTS (
       SELECT 1 FROM public.integration_secrets WHERE key = 'google_api_key'
     ) THEN
    RAISE EXCEPTION 'Cutover test: optional-absent path failed';
  END IF;
END;
$test$;
