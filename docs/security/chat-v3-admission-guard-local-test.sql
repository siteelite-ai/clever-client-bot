-- Run only against a disposable local/staging database after applying the
-- migration. This transaction rolls back all fixtures and bucket changes.
-- Example: psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 \
--   -f docs/security/chat-v3-admission-guard-local-test.sql
-- Do not run against the shared production project: bucket row locks may
-- briefly block live requests even though the fixture transaction rolls back.

BEGIN;
SET LOCAL ROLE service_role;

DO $test$
DECLARE
  v_prefix text := 'admission-sql-test-' || gen_random_uuid()::text;
  v_off uuid;
  v_obs1 uuid;
  v_obs2 uuid;
  v_enf1 uuid;
  v_enf2 uuid;
  v_enf3 uuid;
  v_enf_unconfigured uuid;
  v_bad uuid;
  v_result jsonb;
  v_count integer;
  v_first_release boolean;
  v_second_release boolean;
BEGIN
  IF has_function_privilege('anon',
    'public.check_chat_v3_admission(uuid,text,integer,integer)', 'EXECUTE')
    OR has_function_privilege('authenticated',
    'public.check_chat_v3_admission(uuid,text,integer,integer)', 'EXECUTE')
    OR has_function_privilege('anon',
    'public.release_chat_v3_admission(uuid)', 'EXECUTE')
    OR has_function_privilege('authenticated',
    'public.release_chat_v3_admission(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'client EXECUTE grant is open';
  END IF;
  IF NOT has_function_privilege('service_role',
    'public.check_chat_v3_admission(uuid,text,integer,integer)', 'EXECUTE')
    OR NOT has_function_privilege('service_role',
    'public.release_chat_v3_admission(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role RPC grant is missing';
  END IF;
  IF has_table_privilege('anon', 'public.chat_v3_admission_buckets', 'SELECT')
    OR has_table_privilege('authenticated',
      'public.chat_v3_admission_buckets', 'SELECT')
    OR has_table_privilege('anon',
      'public.chat_v3_admission_decisions', 'SELECT')
    OR has_table_privilege('authenticated',
      'public.chat_v3_admission_decisions', 'SELECT') THEN
    RAISE EXCEPTION 'client admission table grant is open';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('chat_v3_admission_buckets',
                        'chat_v3_admission_decisions')
  ) THEN
    RAISE EXCEPTION 'new admission table unexpectedly has client policies';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('check_chat_v3_admission',
                       'release_chat_v3_admission')
      AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'admission RPC must remain SECURITY INVOKER';
  END IF;

  UPDATE public.chat_v3_admission_buckets
  SET window_started_at = clock_timestamp(), admitted_count = 0
  WHERE mode IN ('observe', 'enforce');

  INSERT INTO public.chat_request_logs
    (message_id, session_id, user_query, pipeline, branch, error)
  VALUES (v_prefix || '-off', 'sql-test', 'off', 'v3', 'v3_expert',
    'in_progress') RETURNING id INTO v_off;
  v_result := public.check_chat_v3_admission(v_off);
  IF v_result->>'allowed' IS DISTINCT FROM 'true'
    OR v_result->>'reason' IS DISTINCT FROM 'off' THEN
    RAISE EXCEPTION 'off did not allow: %', v_result;
  END IF;
  IF EXISTS (SELECT 1 FROM public.chat_v3_admission_decisions
             WHERE log_id = v_off) THEN
    RAISE EXCEPTION 'off wrote a decision row';
  END IF;

  INSERT INTO public.chat_request_logs
    (message_id, session_id, user_query, pipeline, branch, error)
  VALUES (v_prefix || '-obs1', 'sql-test', 'observe 1', 'v3', 'v3_expert',
    'in_progress') RETURNING id INTO v_obs1;
  v_result := public.check_chat_v3_admission(v_obs1, 'observe', 1, 1);
  IF v_result->>'allowed' IS DISTINCT FROM 'true'
    OR v_result->>'would_reject' IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'first observe admission incorrect: %', v_result;
  END IF;

  INSERT INTO public.chat_request_logs
    (message_id, session_id, user_query, pipeline, branch, error)
  VALUES (v_prefix || '-obs2', 'sql-test', 'observe 2', 'v3', 'v3_expert',
    'in_progress') RETURNING id INTO v_obs2;
  v_result := public.check_chat_v3_admission(v_obs2, 'observe', 1, 1);
  IF v_result->>'allowed' IS DISTINCT FROM 'true'
    OR v_result->>'reason' IS DISTINCT FROM 'observed_limit'
    OR v_result->>'would_reject' IS DISTINCT FROM 'true'
    OR v_result->>'limit_reason' IS DISTINCT FROM
      'minute_and_in_flight_limit' THEN
    RAISE EXCEPTION 'observe did not record both limits: %', v_result;
  END IF;
  v_result := public.check_chat_v3_admission(v_obs2, 'observe', 1, 1);
  IF v_result->>'replayed' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'ambiguous RPC retry was not idempotent: %', v_result;
  END IF;
  SELECT admitted_count INTO v_count FROM public.chat_v3_admission_buckets
  WHERE mode = 'observe';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'observe retry charged bucket twice: %', v_count;
  END IF;
  v_first_release := public.release_chat_v3_admission(v_obs1);
  v_second_release := public.release_chat_v3_admission(v_obs1);
  IF v_first_release IS DISTINCT FROM true
    OR v_second_release IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'release is not idempotent';
  END IF;
  PERFORM public.release_chat_v3_admission(v_obs2);

  INSERT INTO public.chat_request_logs
    (message_id, session_id, user_query, pipeline, branch, error)
  VALUES (v_prefix || '-enf1', 'sql-test', 'enforce 1', 'v3', 'v3_expert',
    'in_progress') RETURNING id INTO v_enf1;
  v_result := public.check_chat_v3_admission(v_enf1, 'enforce', 1, 1);
  IF v_result->>'allowed' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'first enforce admission incorrect: %', v_result;
  END IF;

  INSERT INTO public.chat_request_logs
    (message_id, session_id, user_query, pipeline, branch, error)
  VALUES (v_prefix || '-enf2', 'sql-test', 'enforce 2', 'v3', 'v3_expert',
    'in_progress') RETURNING id INTO v_enf2;
  v_result := public.check_chat_v3_admission(v_enf2, 'enforce', 1, 1);
  IF v_result->>'allowed' IS DISTINCT FROM 'false'
    OR v_result->>'reason' IS DISTINCT FROM 'limit_exceeded'
    OR v_result->>'limit_reason' IS DISTINCT FROM
      'minute_and_in_flight_limit' THEN
    RAISE EXCEPTION 'enforce did not reject second claim: %', v_result;
  END IF;
  PERFORM public.release_chat_v3_admission(v_enf1);

  INSERT INTO public.chat_request_logs
    (message_id, session_id, user_query, pipeline, branch, error)
  VALUES (v_prefix || '-enf3', 'sql-test', 'enforce 3', 'v3', 'v3_expert',
    'in_progress') RETURNING id INTO v_enf3;
  v_result := public.check_chat_v3_admission(v_enf3, 'enforce', 1, 1);
  IF v_result->>'allowed' IS DISTINCT FROM 'false'
    OR v_result->>'limit_reason' IS DISTINCT FROM 'minute_limit' THEN
    RAISE EXCEPTION 'release incorrectly reset minute bucket: %', v_result;
  END IF;
  SELECT admitted_count INTO v_count FROM public.chat_v3_admission_buckets
  WHERE mode = 'enforce';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'denied claims charged enforce bucket: %', v_count;
  END IF;

  INSERT INTO public.chat_request_logs
    (message_id, session_id, user_query, pipeline, branch, error)
  VALUES (v_prefix || '-enf-unconfigured', 'sql-test', 'unset limits',
    'v3', 'v3_expert', 'in_progress')
  RETURNING id INTO v_enf_unconfigured;
  v_result := public.check_chat_v3_admission(v_enf_unconfigured, 'enforce');
  IF v_result->>'allowed' IS DISTINCT FROM 'false'
    OR v_result->>'reason' IS DISTINCT FROM 'configuration_missing' THEN
    RAISE EXCEPTION 'enforce without limits did not fail closed: %', v_result;
  END IF;

  INSERT INTO public.chat_request_logs
    (message_id, session_id, user_query, pipeline, branch, error)
  VALUES (v_prefix || '-bad', 'sql-test', 'not v3', 'v2', 'v3_expert',
    'in_progress') RETURNING id INTO v_bad;
  v_result := public.check_chat_v3_admission(v_bad);
  IF v_result->>'allowed' IS DISTINCT FROM 'false'
    OR v_result->>'reason' IS DISTINCT FROM 'claim_not_in_progress' THEN
    RAISE EXCEPTION 'non-v3 claim was accepted: %', v_result;
  END IF;

  BEGIN
    INSERT INTO public.chat_request_logs
      (message_id, session_id, user_query, pipeline, branch, error)
    VALUES (v_prefix || '-obs1', 'sql-test', 'duplicate', 'v3',
      'v3_expert', 'in_progress');
    RAISE EXCEPTION 'existing message_id uniqueness is missing';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END;
$test$;

ROLLBACK;
