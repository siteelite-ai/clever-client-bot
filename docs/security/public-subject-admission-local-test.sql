-- Run only against the disposable PostgreSQL 16 admission_ci fixture, after
-- 20261022120000_public_subject_admission.sql. Never use production data.
DO $test$
BEGIN
  IF has_table_privilege('anon',
      'public.public_subject_admission_buckets', 'SELECT') OR
     has_table_privilege('authenticated',
      'public.public_subject_admission_reservations', 'SELECT') OR
     has_table_privilege('anon',
      'public.public_subject_admission_cancellations', 'INSERT') OR
     has_function_privilege('anon',
      'public.reserve_public_subject_admission(text,text,uuid,text,integer,integer,integer)',
      'EXECUTE') OR
     has_function_privilege('authenticated',
      'public.release_public_subject_admission(uuid)', 'EXECUTE') OR
     NOT has_function_privilege('service_role',
      'public.reserve_public_subject_admission(text,text,uuid,text,integer,integer,integer)',
      'EXECUTE') THEN
    RAISE EXCEPTION 'subject admission grants are not service-role only';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'chat_request_logs'
      AND column_name = 'public_subject_hash'
  ) THEN
    RAISE EXCEPTION 'v3 replay subject binding column missing';
  END IF;
END;
$test$;

SET ROLE service_role;

DO $test$
DECLARE
  v_a text := repeat('a', 64);
  v_b text := repeat('b', 64);
  v_c text := repeat('c', 64);
  v_d text := repeat('d', 64);
  v_e text := repeat('e', 64);
  v_id uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_release_first uuid := gen_random_uuid();
  v_result jsonb;
BEGIN
  v_result := public.reserve_public_subject_admission(
    v_a, 'chat-consultant', v_id, 'enforce', 60, 1, 1
  );
  IF v_result->>'allowed' <> 'true' OR
     v_result->>'reason' <> 'admitted' OR
     v_result->>'replayed' <> 'false' THEN
    RAISE EXCEPTION 'first reservation failed: %', v_result;
  END IF;
  v_result := public.reserve_public_subject_admission(
    v_a, 'chat-consultant', v_id, 'enforce', 60, 1, 1
  );
  IF v_result->>'allowed' <> 'true' OR
     v_result->>'replayed' <> 'true' THEN
    RAISE EXCEPTION 'idempotent reservation replay failed: %', v_result;
  END IF;
  v_result := public.reserve_public_subject_admission(
    v_b, 'chat-consultant', v_id, 'enforce', 60, 1, 1
  );
  IF v_result->>'allowed' <> 'false' OR
     v_result->>'reason' <> 'reservation_conflict' THEN
    RAISE EXCEPTION 'cross-subject UUID replay accepted: %', v_result;
  END IF;
  v_result := public.reserve_public_subject_admission(
    v_a, 'search-products', v_other, 'enforce', 60, 1, 1
  );
  IF v_result->>'allowed' <> 'false' OR
     v_result->>'reason' <> 'limit_exceeded' OR
     v_result->>'limit_reason' <> 'minute_and_in_flight_limit' THEN
    RAISE EXCEPTION 'cross-route total limit failed: %', v_result;
  END IF;
  IF (SELECT admitted_count
      FROM public.public_subject_admission_buckets
      WHERE subject_hash = v_a) <> 1 OR
     EXISTS (
       SELECT 1 FROM public.public_subject_admission_reservations
       WHERE reservation_id = v_other
     ) THEN
    RAISE EXCEPTION 'denial charged subject or persisted denied UUID';
  END IF;
  IF (SELECT extract(epoch FROM reservation_expires_at - created_at)::integer
      FROM public.public_subject_admission_reservations
      WHERE reservation_id = v_id) <> 450 THEN
    RAISE EXCEPTION 'reservation lease must outlive hosted Edge worker';
  END IF;

  -- A different subject receives independent quota.
  v_result := public.reserve_public_subject_admission(
    v_b, 'chat-consultant-v2', gen_random_uuid(), 'enforce', 60, 1, 1
  );
  IF v_result->>'allowed' <> 'true' THEN
    RAISE EXCEPTION 'other subject was incorrectly throttled: %', v_result;
  END IF;
  -- Mode changes share the same bucket: observe reports a hit but does not
  -- block, and its admission is counted by subsequent enforce calls.
  v_result := public.reserve_public_subject_admission(
    v_a, 'chat-consultant-v3', gen_random_uuid(), 'observe', 60, 1, 1
  );
  IF v_result->>'allowed' <> 'true' OR
     v_result->>'reason' <> 'observed_limit' OR
     v_result->>'would_reject' <> 'true' THEN
    RAISE EXCEPTION 'observe did not measure shared quota: %', v_result;
  END IF;
  v_result := public.reserve_public_subject_admission(
    v_a, 'search-products', gen_random_uuid(), 'enforce', 60, 1, 1
  );
  IF v_result->>'allowed' <> 'false' THEN
    RAISE EXCEPTION 'mode switch reset quota: %', v_result;
  END IF;

  IF NOT public.release_public_subject_admission(v_id) OR
     NOT public.release_public_subject_admission(v_id) THEN
    RAISE EXCEPTION 'terminal release is not idempotent';
  END IF;
  v_result := public.reserve_public_subject_admission(
    v_a, 'chat-consultant', v_id, 'enforce', 60, 1, 1
  );
  IF v_result->>'allowed' <> 'false' OR
     v_result->>'reason' <> 'reservation_conflict' THEN
    RAISE EXCEPTION 'released reservation replayed as live: %', v_result;
  END IF;
  IF NOT public.release_public_subject_admission(v_release_first) THEN
    RAISE EXCEPTION 'release-before-reserve tombstone failed';
  END IF;
  v_result := public.reserve_public_subject_admission(
    v_c, 'search-products', v_release_first, 'enforce', 60, 1, 1
  );
  IF v_result->>'allowed' <> 'false' OR
     v_result->>'reason' <> 'cancelled' OR
     EXISTS (
       SELECT 1 FROM public.public_subject_admission_reservations
       WHERE reservation_id = v_release_first
     ) THEN
    RAISE EXCEPTION 'late reserve consumed a ghost slot: %', v_result;
  END IF;

  v_result := public.reserve_public_subject_admission(
    v_d, 'search-products', gen_random_uuid(), 'enforce', 60, NULL, 1
  );
  IF v_result->>'allowed' <> 'false' OR
     v_result->>'reason' <> 'configuration_missing' THEN
    RAISE EXCEPTION 'missing config was not fail-closed: %', v_result;
  END IF;
  v_result := public.reserve_public_subject_admission(
    v_e, 'chat-consultant-v3', gen_random_uuid(), 'observe', 60, NULL, NULL
  );
  IF v_result->>'allowed' <> 'true' OR
     v_result->>'reason' <> 'observe_unconfigured' THEN
    RAISE EXCEPTION 'observe config parity failed: %', v_result;
  END IF;

  BEGIN
    PERFORM public.reserve_public_subject_admission(
      'raw-ip-192.0.2.1', 'search-products', gen_random_uuid(),
      'enforce', 60, 1, 1
    );
    RAISE EXCEPTION 'raw subject unexpectedly accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.reserve_public_subject_admission(
      v_a, 'search-products', gen_random_uuid(), 'enforce', 30, 1, 1
    );
    RAISE EXCEPTION 'mixed window unexpectedly accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END;
$test$;

RESET ROLE;

-- The replay binding is NULL for old claims and shape-checked on new writes.
DO $test$
BEGIN
  INSERT INTO public.chat_request_logs (id, public_subject_hash)
  VALUES (gen_random_uuid(), NULL);
  INSERT INTO public.chat_request_logs (id, public_subject_hash)
  VALUES (gen_random_uuid(), repeat('f', 64));
  BEGIN
    INSERT INTO public.chat_request_logs (id, public_subject_hash)
    VALUES (gen_random_uuid(), 'raw-address');
    RAISE EXCEPTION 'unsafe replay subject unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$test$;
