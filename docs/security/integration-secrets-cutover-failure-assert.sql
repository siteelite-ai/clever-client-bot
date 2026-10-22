-- Disposable PostgreSQL 16 ONLY. Run after an expected-failure cutover
-- attempt with psql -v ON_ERROR_STOP=1 -v cutover_case=NAME. It must inspect
-- the SAME disposable database as negative-case.sql, in a fresh connection.
\if :{?cutover_case}
\else
  \echo 'cutover_case is required'
  \quit 3
\endif

SELECT set_config('ci.cutover_case', :'cutover_case', false);

DO $test$
DECLARE
  v_row public.app_settings%ROWTYPE;
  v_case text := current_setting('ci.cutover_case');
BEGIN
  IF v_case = 'zero-settings' THEN
    IF EXISTS (SELECT 1 FROM public.app_settings) THEN
      RAISE EXCEPTION 'Cutover failure test: zero-settings fixture changed';
    END IF;
  ELSE
    SELECT * INTO STRICT v_row
      FROM public.app_settings
      WHERE id = '11111111-1111-4111-8111-111111111111';

    IF v_row.openrouter_api_key IS DISTINCT FROM
         CASE WHEN v_case = 'required-legacy-missing' THEN NULL
              ELSE 'ci-openrouter-placeholder' END
       OR v_row.volt220_api_token IS DISTINCT FROM 'ci-catalog-placeholder'
       OR v_row.google_api_key IS DISTINCT FROM
         CASE WHEN v_case = 'optional-private-only' THEN NULL
              ELSE 'ci-google-placeholder' END
       OR v_row.ai_model IS DISTINCT FROM 'ci-model-before' THEN
      RAISE EXCEPTION 'Cutover failure test: original settings changed';
    END IF;
  END IF;

  IF v_case = 'two-settings'
     AND (SELECT count(*) FROM public.app_settings) <> 2 THEN
    RAISE EXCEPTION 'Cutover failure test: second settings row changed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.app_settings'::regclass
      AND tgname = 'reject_app_settings_legacy_integration_secret_write'
      AND NOT tgisinternal
  ) OR to_regprocedure('public.reject_legacy_integration_secret_write()')
    IS NOT NULL THEN
    RAISE EXCEPTION 'Cutover failure test: write guard was installed';
  END IF;
END;
$test$;
