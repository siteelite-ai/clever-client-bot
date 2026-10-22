-- Run only against disposable PostgreSQL 16 after creating Supabase-like
-- anon/authenticated/service_role roles and applying the new migration.
-- All values below are nonfunctional CI placeholders, never live credentials.
BEGIN;

DO $test$
DECLARE
  v_role text;
  v_privilege text;
  v_table text;
BEGIN
  FOR v_table IN SELECT unnest(ARRAY[
    'integration_secrets', 'integration_secret_ping_cooldowns'
  ]) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class AS c
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = v_table
        AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION '% must have RLS enabled', v_table;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = v_table
    ) THEN
      RAISE EXCEPTION '% must have no client RLS policies', v_table;
    END IF;

    FOR v_role IN SELECT unnest(ARRAY['anon', 'authenticated']) LOOP
      FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
        IF has_table_privilege(v_role, 'public.' || v_table, v_privilege) THEN
          RAISE EXCEPTION '% unexpectedly has % on %',
            v_role, v_privilege, v_table;
        END IF;
      END LOOP;
    END LOOP;

    IF EXISTS (
      SELECT 1 FROM pg_class AS c
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(
        coalesce(c.relacl, acldefault('r', c.relowner))
      ) AS a
      WHERE n.nspname = 'public' AND c.relname = v_table
        AND a.grantee = 0
    ) THEN
      RAISE EXCEPTION 'PUBLIC must have no % table grants', v_table;
    END IF;
  END LOOP;

  FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT has_table_privilege(
      'service_role', 'public.integration_secrets', v_privilege
    ) THEN
      RAISE EXCEPTION 'service_role missing % on integration_secrets', v_privilege;
    END IF;
  END LOOP;

  FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE'] LOOP
    IF NOT has_table_privilege(
      'service_role', 'public.integration_secret_ping_cooldowns', v_privilege
    ) THEN
      RAISE EXCEPTION 'service_role missing % on ping cooldowns', v_privilege;
    END IF;
  END LOOP;

  FOR v_role IN SELECT unnest(ARRAY['anon', 'authenticated']) LOOP
    IF has_function_privilege(
      v_role, 'public.claim_admin_integration_secret_ping(uuid)', 'EXECUTE'
    ) THEN
      RAISE EXCEPTION '% can execute secret ping claim', v_role;
    END IF;
  END LOOP;
  IF NOT has_function_privilege(
    'service_role', 'public.claim_admin_integration_secret_ping(uuid)', 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'service_role cannot claim ping cooldown';
  END IF;
END
$test$;

SET LOCAL ROLE service_role;

INSERT INTO public.integration_secrets (key, secret_value)
VALUES ('openrouter_api_key', 'ci-placeholder-only');

DO $test$
BEGIN
  IF (SELECT count(*) FROM public.integration_secrets
      WHERE key = 'openrouter_api_key') <> 1 THEN
    RAISE EXCEPTION 'service_role cannot read integration_secrets';
  END IF;

  BEGIN
    INSERT INTO public.integration_secrets (key, secret_value)
    VALUES ('unlisted_key', 'ci-placeholder-only');
    RAISE EXCEPTION 'unlisted key was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  IF public.claim_admin_integration_secret_ping(
    '11111111-1111-4111-8111-111111111111'::uuid
  ) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'first ping cooldown claim failed';
  END IF;
  IF public.claim_admin_integration_secret_ping(
    '11111111-1111-4111-8111-111111111111'::uuid
  ) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'second ping cooldown claim was not blocked';
  END IF;
END
$test$;

UPDATE public.integration_secrets
SET secret_value = 'ci-placeholder-rotated', updated_at = now()
WHERE key = 'openrouter_api_key';

DELETE FROM public.integration_secrets WHERE key = 'openrouter_api_key';

DO $test$
BEGIN
  IF EXISTS (SELECT 1 FROM public.integration_secrets) THEN
    RAISE EXCEPTION 'service_role cannot delete integration_secrets row';
  END IF;
END
$test$;

RESET ROLE;
ROLLBACK;
