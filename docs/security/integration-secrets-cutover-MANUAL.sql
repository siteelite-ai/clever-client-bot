-- MANUAL, ONE-SHOT PRODUCTION CUTOVER. Do not put this file in
-- supabase/migrations or run it as part of an automatic deploy.
--
-- Prerequisites that SQL cannot establish: every live Edge consumer and the
-- admin UI have already passed a closed preview in private-required mode;
-- the production bundles are switched to that mode with NO legacy fallback.
-- The additive integration_secrets migration must already be applied, and
-- authorized server-side code must have populated it without exposing keys.
-- Run this whole file as one batch under an authorized database administrator.
-- Never print, export, or paste either table's secret values into a report.
-- A failed precondition rolls back BOTH the clearing and the write guard.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Block concurrent credential/settings writes across comparison and commit;
-- ordinary SELECTs can continue while this short transaction runs.
LOCK TABLE public.app_settings, public.integration_secrets
  IN SHARE ROW EXCLUSIVE MODE;

DO $cutover$
DECLARE
  v_settings record;
  v_updated integer;
BEGIN
  IF (SELECT count(*) FROM public.app_settings) <> 1 THEN
    RAISE EXCEPTION 'Cutover refused: app_settings must contain exactly one row';
  END IF;

  SELECT id, openrouter_api_key, volt220_api_token, google_api_key
    INTO STRICT v_settings
    FROM public.app_settings;

  IF v_settings.openrouter_api_key IS NULL
     OR v_settings.volt220_api_token IS NULL THEN
    RAISE EXCEPTION 'Cutover refused: required legacy credentials are absent';
  END IF;

  -- Values are compared only inside PostgreSQL. An absent or different row
  -- fails closed; no value, prefix, suffix, or hash is included in errors.
  IF NOT EXISTS (
    SELECT 1 FROM public.integration_secrets
    WHERE key = 'openrouter_api_key'
      AND secret_value = v_settings.openrouter_api_key
  ) OR NOT EXISTS (
    SELECT 1 FROM public.integration_secrets
    WHERE key = 'volt220_api_token'
      AND secret_value = v_settings.volt220_api_token
  ) THEN
    RAISE EXCEPTION 'Cutover refused: required private credentials do not match';
  END IF;

  -- Google is optional, but its presence and value must also agree on both
  -- sides. A private-only or legacy-only Google key is not silently ignored.
  IF v_settings.google_api_key IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.integration_secrets WHERE key = 'google_api_key'
    ) THEN
      RAISE EXCEPTION 'Cutover refused: optional credential presence differs';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.integration_secrets
    WHERE key = 'google_api_key'
      AND secret_value = v_settings.google_api_key
  ) THEN
    RAISE EXCEPTION 'Cutover refused: optional private credential does not match';
  END IF;

  UPDATE public.app_settings
     SET openrouter_api_key = NULL,
         volt220_api_token = NULL,
         google_api_key = NULL
   WHERE id = v_settings.id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'Cutover refused: expected exactly one settings update';
  END IF;
END;
$cutover$;

-- The table remains writable for ordinary settings. This guard blocks both
-- accidental INSERTs with a legacy key and any UPDATE that reinstates one.
-- It is installed in the same transaction as the NULL update.
CREATE FUNCTION public.reject_legacy_integration_secret_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $guard$
BEGIN
  IF NEW.openrouter_api_key IS NOT NULL
     OR NEW.volt220_api_token IS NOT NULL
     OR NEW.google_api_key IS NOT NULL THEN
    RAISE EXCEPTION 'Legacy integration secret columns are read-only after cutover';
  END IF;
  RETURN NEW;
END;
$guard$;

CREATE TRIGGER reject_app_settings_legacy_integration_secret_write
BEFORE INSERT OR UPDATE ON public.app_settings
FOR EACH ROW
EXECUTE FUNCTION public.reject_legacy_integration_secret_write();

COMMIT;

-- Emergency rollback is NOT a normal git revert: old bundles need keys in
-- app_settings, while this guard rejects restoring them. A DBA must first
-- verify the private keys remain current (especially after issuer rotation),
-- then in ONE transaction remove this trigger, restore the old columns from
-- the private store, and switch back to the old bundles/UI. That temporarily
-- re-exposes keys to administrators' browsers. Prefer fixing the new server
-- route; never restore a revoked or compromised credential.
