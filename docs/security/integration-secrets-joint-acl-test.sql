-- Run ONLY in a disposable PostgreSQL 16 database after applying the exact
-- pinned #122 least-privilege migration and the actual #125 private-store
-- migration. This file applies MANUAL cutover to the disposable fixture only.
INSERT INTO public.integration_secrets (key, secret_value) VALUES
  ('openrouter_api_key', 'ci-openrouter-placeholder'),
  ('volt220_api_token', 'ci-catalog-placeholder'),
  ('google_api_key', 'ci-google-placeholder');

DO $preflight$
DECLARE
  checked_role text;
  privilege_name text;
  allowed boolean;
  expected boolean;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class
          WHERE oid = 'public.app_settings'::regclass) THEN
    RAISE EXCEPTION 'joint ACL: app_settings RLS was disabled';
  END IF;
  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'app_settings'
        AND policyname IN ('Only admins can read settings',
                           'Only admins can update settings')) <> 2 THEN
    RAISE EXCEPTION 'joint ACL: admin-only policies changed';
  END IF;

  FOREACH checked_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    FOREACH privilege_name IN ARRAY ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ] LOOP
      allowed := has_table_privilege(
        checked_role, 'public.app_settings', privilege_name
      );
      expected := checked_role = 'service_role'
        OR (checked_role = 'authenticated'
            AND privilege_name IN ('SELECT', 'UPDATE'));
      IF allowed IS DISTINCT FROM expected THEN
        RAISE EXCEPTION 'joint ACL: unexpected app_settings privilege for % / %',
          checked_role, privilege_name;
      END IF;

      allowed := has_table_privilege(
        checked_role, 'public.integration_secrets', privilege_name
      );
      expected := checked_role = 'service_role'
        AND privilege_name IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE');
      IF allowed IS DISTINCT FROM expected THEN
        RAISE EXCEPTION 'joint ACL: unexpected private-store privilege for % / %',
          checked_role, privilege_name;
      END IF;
    END LOOP;
  END LOOP;
END;
$preflight$;

\ir integration-secrets-cutover-MANUAL.sql

DO $post_cutover$
BEGIN
  IF (SELECT count(*) FROM public.integration_secrets) <> 3 THEN
    RAISE EXCEPTION 'joint ACL: private credentials were lost';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.app_settings
    WHERE openrouter_api_key IS NOT NULL OR volt220_api_token IS NOT NULL
       OR google_api_key IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'joint ACL: legacy credentials remain after cutover';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.app_settings'::regclass
      AND tgname = 'reject_app_settings_legacy_integration_secret_write'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'joint ACL: legacy write guard was not installed';
  END IF;
END;
$post_cutover$;

-- A logged-in non-admin must see no settings and have no private-store route.
BEGIN;
SET LOCAL qa.is_admin = 'off';
SET LOCAL ROLE authenticated;
DO $non_admin$
DECLARE
  changed_rows integer;
BEGIN
  IF (SELECT count(*) FROM public.app_settings) <> 0 THEN
    RAISE EXCEPTION 'joint ACL: non-admin can read settings';
  END IF;
  UPDATE public.app_settings SET ai_model = 'ci-non-admin-write';
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 0 THEN
    RAISE EXCEPTION 'joint ACL: non-admin can update settings';
  END IF;
  BEGIN
    PERFORM 1 FROM public.integration_secrets;
    RAISE EXCEPTION 'joint ACL: non-admin can read private credentials';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$non_admin$;
ROLLBACK;

-- An admin retains ordinary settings editing, but neither reads the private
-- store nor reinstates any of the legacy columns after cutover.
BEGIN;
SET LOCAL qa.is_admin = 'on';
SET LOCAL ROLE authenticated;
DO $admin$
DECLARE
  changed_rows integer;
  rejection text;
BEGIN
  IF (SELECT count(*) FROM public.app_settings) <> 1 THEN
    RAISE EXCEPTION 'joint ACL: admin cannot read settings';
  END IF;
  UPDATE public.app_settings SET ai_model = 'ci-model-after';
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'joint ACL: admin cannot edit non-secret setting';
  END IF;
  BEGIN
    PERFORM 1 FROM public.integration_secrets;
    RAISE EXCEPTION 'joint ACL: admin can read private credentials';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    UPDATE public.app_settings
       SET openrouter_api_key = 'ci-forbidden-legacy-restoration';
    RAISE EXCEPTION 'joint ACL: admin restored legacy credential';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS rejection = MESSAGE_TEXT;
    IF rejection <> 'Legacy integration secret columns are read-only after cutover' THEN
      RAISE;
    END IF;
  END;
END;
$admin$;
COMMIT;

-- The service role keeps server-only access to both tables and cannot bypass
-- the legacy-write trigger merely by bypassing RLS.
BEGIN;
SET LOCAL ROLE service_role;
DO $service$
DECLARE
  rejection text;
BEGIN
  IF (SELECT count(*) FROM public.app_settings) <> 1
     OR (SELECT count(*) FROM public.integration_secrets) <> 3 THEN
    RAISE EXCEPTION 'joint ACL: service role lost required read access';
  END IF;
  BEGIN
    UPDATE public.app_settings
       SET volt220_api_token = 'ci-forbidden-service-restoration';
    RAISE EXCEPTION 'joint ACL: service role restored legacy credential';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS rejection = MESSAGE_TEXT;
    IF rejection <> 'Legacy integration secret columns are read-only after cutover' THEN
      RAISE;
    END IF;
  END;
END;
$service$;
ROLLBACK;

-- Anonymous browser clients must not even receive table SELECT permission.
BEGIN;
SET LOCAL ROLE anon;
DO $anon$
BEGIN
  BEGIN
    PERFORM 1 FROM public.app_settings;
    RAISE EXCEPTION 'joint ACL: anon can read app_settings';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.integration_secrets;
    RAISE EXCEPTION 'joint ACL: anon can read private credentials';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$anon$;
ROLLBACK;

DO $final$
BEGIN
  IF (SELECT ai_model FROM public.app_settings) <> 'ci-model-after' THEN
    RAISE EXCEPTION 'joint ACL: non-secret settings edit did not persist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.app_settings
    WHERE openrouter_api_key IS NOT NULL OR volt220_api_token IS NOT NULL
       OR google_api_key IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'joint ACL: legacy credentials were reinstated';
  END IF;
END;
$final$;
