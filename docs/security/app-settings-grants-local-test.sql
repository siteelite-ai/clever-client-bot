-- Run against a disposable database after app-settings-grants-ci-schema.sql
-- and 20261020230000_app_settings_least_privilege.sql. Never run on production.
DO $grants$
DECLARE
  checked_role text;
  privilege_name text;
  allowed boolean;
  expected boolean;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.app_settings'::regclass) THEN
    RAISE EXCEPTION 'app_settings RLS must remain enabled';
  END IF;

  FOREACH checked_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    FOREACH privilege_name IN ARRAY ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ] LOOP
      allowed := has_table_privilege(checked_role, 'public.app_settings', privilege_name);
      expected := checked_role = 'service_role'
        OR (checked_role = 'authenticated' AND privilege_name IN ('SELECT', 'UPDATE'));
      IF allowed IS DISTINCT FROM expected THEN
        RAISE EXCEPTION '% has unexpected % privilege: got %, wanted %',
          checked_role, privilege_name, allowed, expected;
      END IF;
    END LOOP;
  END LOOP;

  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'app_settings'
        AND policyname IN ('Only admins can read settings', 'Only admins can update settings')) <> 2 THEN
    RAISE EXCEPTION 'admin-only RLS policies must be preserved';
  END IF;
END
$grants$;

-- An ordinary authenticated account has table-level SELECT/UPDATE but sees
-- no settings row and cannot alter it through the existing admin-only RLS.
BEGIN;
SET LOCAL qa.is_admin = 'off';
SET LOCAL ROLE authenticated;
DO $non_admin$
DECLARE
  visible_rows integer;
  changed_rows integer;
BEGIN
  SELECT count(*) INTO visible_rows FROM public.app_settings;
  IF visible_rows <> 0 THEN
    RAISE EXCEPTION 'non-admin can read app_settings';
  END IF;
  UPDATE public.app_settings SET ai_model = 'must-not-change';
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 0 THEN
    RAISE EXCEPTION 'non-admin can update app_settings';
  END IF;
END
$non_admin$;
ROLLBACK;

-- The admin path used by the settings UI remains functional.
BEGIN;
SET LOCAL qa.is_admin = 'on';
SET LOCAL ROLE authenticated;
DO $admin$
DECLARE
  visible_rows integer;
  changed_rows integer;
BEGIN
  SELECT count(*) INTO visible_rows FROM public.app_settings;
  IF visible_rows <> 1 THEN
    RAISE EXCEPTION 'admin cannot read app_settings';
  END IF;
  UPDATE public.app_settings SET ai_model = 'admin-updated';
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'admin cannot update app_settings';
  END IF;
END
$admin$;
ROLLBACK;

-- Edge Functions use service_role. Its direct grant and RLS bypass remain.
BEGIN;
SET LOCAL qa.is_admin = 'off';
SET LOCAL ROLE service_role;
DO $service$
DECLARE
  visible_rows integer;
BEGIN
  SELECT count(*) INTO visible_rows FROM public.app_settings;
  IF visible_rows <> 1 THEN
    RAISE EXCEPTION 'service_role cannot read app_settings';
  END IF;
END
$service$;
ROLLBACK;

SELECT 'app_settings least-privilege checks passed' AS result;
