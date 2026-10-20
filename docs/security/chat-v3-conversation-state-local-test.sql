-- Run ONLY on a disposable PostgreSQL 16 database after the candidate
-- migration. Transactional fixtures rollback, but locks still affect traffic.
BEGIN;

DO $test$
DECLARE
  v_signature text;
  v_topic_attnum smallint;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.create_chat_v3_conversation(text)',
    'public.resolve_chat_v3_conversation(text)',
    'public.begin_chat_v3_conversation_turn(text,uuid,bigint)',
    'public.finalize_chat_v3_conversation_turn(text,uuid,bigint,bigint,jsonb)',
    'public.abort_chat_v3_conversation_turn(text,uuid,bigint)',
    'public.rotate_chat_v3_conversation_topic(text,text,bigint)'
  ] LOOP
    IF has_function_privilege('anon', v_signature, 'EXECUTE') OR
      has_function_privilege('authenticated', v_signature, 'EXECUTE') OR
      NOT has_function_privilege('service_role', v_signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'unsafe RPC grant: %', v_signature;
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.chat_v3_conversations', 'SELECT') OR
    has_table_privilege('authenticated', 'public.chat_v3_conversations', 'SELECT') OR
    has_table_privilege('anon', 'public.chat_v3_conversation_turns', 'SELECT') OR
    has_table_privilege('authenticated', 'public.chat_v3_conversation_turns', 'SELECT') THEN
    RAISE EXCEPTION 'browser role can read conversation state';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND
    tablename IN ('chat_v3_conversations', 'chat_v3_conversation_turns')) THEN
    RAISE EXCEPTION 'conversation state has an unexpected client policy';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE '%chat_v3_conversation%'
      AND p.prosecdef) THEN
    RAISE EXCEPTION 'conversation RPC must remain SECURITY INVOKER';
  END IF;
  SELECT attnum INTO v_topic_attnum FROM pg_attribute
  WHERE attrelid = 'public.chat_request_logs'::regclass
    AND attname = 'chat_v3_topic_id';
  IF v_topic_attnum IS NULL OR (
    SELECT count(*) FROM pg_trigger t
    WHERE t.tgrelid = 'public.chat_request_logs'::regclass
      AND t.tgfoid = 'public.guard_chat_v3_topic_binding()'::regprocedure
  ) <> 2 OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.chat_request_logs'::regclass
      AND t.tgname = 'guard_chat_v3_topic_binding_insert'
      AND (t.tgtype & 4) = 4 AND (t.tgtype & 16) = 0
      AND (t.tgtype & 2) = 0
      AND t.tgqual IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.chat_request_logs'::regclass
      AND t.tgname = 'guard_chat_v3_topic_binding_update'
      AND (t.tgtype & 16) = 16 AND (t.tgtype & 4) = 0
      AND (t.tgtype & 2) = 0 AND t.tgattr::text = ''
      AND t.tgqual IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'topic binding trigger touches legacy log writes';
  END IF;
END;
$test$;

SET LOCAL ROLE service_role;

DO $test$
DECLARE
  v_digest text := repeat('a', 64);
  v_new_digest text := repeat('b', 64);
  v_root uuid;
  v_child uuid;
  v_log uuid;
  v_unbound_log uuid;
  v_cross_log uuid;
  v_limit_log uuid;
  v_other_root uuid;
  v_second_log uuid;
  v_third_log uuid;
  v_result jsonb;
  v_state jsonb;
  v_fence bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.chat_request_logs
    WHERE message_id = 'pre-migration-v3-log' AND
      chat_v3_topic_id IS NULL) THEN
    RAISE EXCEPTION 'migration mutated an existing v3 log';
  END IF;
  v_result := public.create_chat_v3_conversation('weak');
  IF v_result->>'status' <> 'invalid_digest' THEN
    RAISE EXCEPTION 'weak digest accepted: %', v_result;
  END IF;
  v_result := public.create_chat_v3_conversation(v_digest);
  IF v_result->>'status' <> 'created' OR
    v_result->>'replayed' <> 'false' THEN
    RAISE EXCEPTION 'create failed: %', v_result;
  END IF;
  v_root := (v_result->>'topic_id')::uuid;
  v_result := public.create_chat_v3_conversation(v_digest);
  IF v_result->>'replayed' <> 'true' OR
    (v_result->>'topic_id')::uuid <> v_root THEN
    RAISE EXCEPTION 'ambiguous create retry not idempotent: %', v_result;
  END IF;
  IF EXISTS (SELECT 1 FROM public.chat_v3_conversations
    WHERE id = v_root AND (token_digest <> v_digest OR
      expires_at > created_at + interval '24 hours' OR
      octet_length(state::text) > 16384)) THEN
    RAISE EXCEPTION 'root data violated digest/TTL/state bound';
  END IF;
  v_result := public.resolve_chat_v3_conversation(v_digest);
  IF v_result->>'status' <> 'resolved' OR
    (v_result->>'topic_id')::uuid <> v_root THEN
    RAISE EXCEPTION 'bearer did not resolve topic: %', v_result;
  END IF;

  v_result := public.create_chat_v3_conversation(repeat('c', 64));
  v_other_root := (v_result->>'topic_id')::uuid;
  BEGIN
    UPDATE public.chat_v3_conversations
    SET state = jsonb_build_object('payload', repeat('x', 17000))
    WHERE id = v_other_root;
    RAISE EXCEPTION 'oversized state was stored';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  UPDATE public.chat_v3_conversations SET turn_count = 1000000000
    WHERE id = v_other_root;
  INSERT INTO public.chat_request_logs
    (message_id, pipeline, error, chat_v3_topic_id)
  VALUES ('conversation-state-limit', 'v3', 'in_progress', v_other_root)
  RETURNING id INTO v_limit_log;
  v_result := public.begin_chat_v3_conversation_turn(repeat('c', 64),
    v_limit_log, 0);
  IF v_result->>'status' <> 'turn_limit' THEN
    RAISE EXCEPTION 'hard turn cap was not enforced: %', v_result;
  END IF;
  INSERT INTO public.chat_request_logs (message_id, pipeline, error)
  VALUES ('conversation-state-unbound', 'v3', 'in_progress')
  RETURNING id INTO v_unbound_log;
  v_result := public.begin_chat_v3_conversation_turn(v_digest, v_unbound_log, 0);
  IF v_result->>'status' <> 'unbound_claim' THEN
    RAISE EXCEPTION 'unbound legacy claim accepted: %', v_result;
  END IF;
  BEGIN
    UPDATE public.chat_request_logs SET chat_v3_topic_id = v_root
    WHERE id = v_unbound_log;
    RAISE EXCEPTION 'old claim was rebound after insert';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  INSERT INTO public.chat_request_logs
    (message_id, pipeline, error, chat_v3_topic_id)
  VALUES ('conversation-state-cross', 'v3', 'in_progress', v_other_root)
  RETURNING id INTO v_cross_log;
  v_result := public.begin_chat_v3_conversation_turn(v_digest, v_cross_log, 0);
  IF v_result->>'status' <> 'unbound_claim' THEN
    RAISE EXCEPTION 'cross-conversation claim accepted: %', v_result;
  END IF;

  INSERT INTO public.chat_request_logs
    (message_id, pipeline, error, chat_v3_topic_id)
  VALUES ('conversation-state-1', 'v3', 'in_progress', v_root)
  RETURNING id INTO v_log;
  v_state := jsonb_build_object('source_log_id', v_log,
    'criteria', jsonb_build_object('pole_count', 3),
    'product_urls', '[]'::jsonb);
  v_result := public.begin_chat_v3_conversation_turn(v_digest, v_log, 0);
  IF v_result->>'status' <> 'begun' OR
    v_result->>'replayed' <> 'false' THEN
    RAISE EXCEPTION 'begin failed: %', v_result;
  END IF;
  v_fence := (v_result->>'fence')::bigint;
  v_result := public.begin_chat_v3_conversation_turn(v_digest, v_log, 0);
  IF v_result->>'status' <> 'turn_in_progress' OR
    v_result->>'replayed' <> 'true' OR v_result ? 'state' OR
    v_result ? 'fence' THEN
    RAISE EXCEPTION 'begin retry granted a second execution: %', v_result;
  END IF;
  v_result := public.finalize_chat_v3_conversation_turn(
    v_digest, v_log, v_fence, 0, v_state);
  IF v_result->>'status' <> 'claim_not_successful' THEN
    RAISE EXCEPTION 'in-progress claim committed state: %', v_result;
  END IF;
  UPDATE public.chat_request_logs SET error = NULL,
    response_events = '[{"type":"done"}]'::jsonb WHERE id = v_log;
  v_result := public.finalize_chat_v3_conversation_turn(
    v_digest, v_log, v_fence, 0, v_state);
  IF v_result->>'status' <> 'claim_not_successful' THEN
    RAISE EXCEPTION 'partial done marker committed state: %', v_result;
  END IF;
  UPDATE public.chat_request_logs SET response_events = jsonb_build_array(
    jsonb_build_object('type', 'diagnostic', 'phase', 'complete',
      'log_id', gen_random_uuid(), 'error', NULL),
    jsonb_build_object('type', 'done')) WHERE id = v_log;
  v_result := public.finalize_chat_v3_conversation_turn(
    v_digest, v_log, v_fence, 0, v_state);
  IF v_result->>'status' <> 'claim_not_successful' THEN
    RAISE EXCEPTION 'wrong log identity committed state: %', v_result;
  END IF;
  UPDATE public.chat_request_logs SET response_events = jsonb_build_array(
    jsonb_build_object('type', 'diagnostic', 'phase', 'complete',
      'log_id', v_log, 'error', NULL),
    jsonb_build_object('type', 'done')) WHERE id = v_log;
  v_result := public.finalize_chat_v3_conversation_turn(
    v_digest, v_log, v_fence, 0,
    jsonb_build_object('source_log_id', gen_random_uuid()));
  IF v_result->>'status' <> 'invalid_input' THEN
    RAISE EXCEPTION 'foreign source log persisted state: %', v_result;
  END IF;
  v_result := public.finalize_chat_v3_conversation_turn(
    v_digest, v_log, v_fence + 1, 0, v_state);
  IF v_result->>'status' <> 'stale_turn' THEN
    RAISE EXCEPTION 'wrong fence committed state: %', v_result;
  END IF;
  v_result := public.finalize_chat_v3_conversation_turn(
    v_digest, v_log, v_fence, 0, v_state);
  IF v_result->>'status' <> 'finalized' OR
    v_result->>'version' <> '1' THEN
    RAISE EXCEPTION 'successful completion not finalized: %', v_result;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chat_v3_conversations
    WHERE id = v_root AND idle_expires_at > clock_timestamp() +
      interval '29 minutes' AND idle_expires_at <= expires_at) THEN
    RAISE EXCEPTION 'successful turn did not extend 30-minute idle TTL';
  END IF;
  v_result := public.finalize_chat_v3_conversation_turn(
    v_digest, v_log, v_fence, 0, v_state);
  IF v_result->>'replayed' <> 'true' THEN
    RAISE EXCEPTION 'finalize retry not idempotent: %', v_result;
  END IF;
  v_result := public.finalize_chat_v3_conversation_turn(
    v_digest, v_log, v_fence, 0,
    jsonb_build_object('source_log_id', v_log, 'different', true));
  IF v_result->>'status' <> 'conflicting_replay' THEN
    RAISE EXCEPTION 'conflicting finalization accepted: %', v_result;
  END IF;

  INSERT INTO public.chat_request_logs
    (message_id, pipeline, error, chat_v3_topic_id)
  VALUES ('conversation-state-2', 'v3', 'in_progress', v_root)
  RETURNING id INTO v_second_log;
  v_result := public.begin_chat_v3_conversation_turn(v_digest, v_second_log, 0);
  IF v_result->>'status' <> 'stale_version' THEN
    RAISE EXCEPTION 'stale state version accepted: %', v_result;
  END IF;
  v_result := public.begin_chat_v3_conversation_turn(v_digest, v_second_log, 1);
  IF v_result->>'status' <> 'begun' OR
    (v_result->>'fence')::bigint <= v_fence THEN
    RAISE EXCEPTION 'second begin did not advance fence: %', v_result;
  END IF;
  v_result := public.rotate_chat_v3_conversation_topic(v_digest, v_new_digest, 1);
  IF v_result->>'status' <> 'busy' THEN
    RAISE EXCEPTION 'active turn rotated: %', v_result;
  END IF;
  v_result := public.abort_chat_v3_conversation_turn(v_digest,
    v_second_log, 1);
  IF v_result->>'status' <> 'stale_turn' THEN
    RAISE EXCEPTION 'wrong abort fence accepted: %', v_result;
  END IF;
  v_result := public.abort_chat_v3_conversation_turn(v_digest,
    v_second_log, 2);
  IF v_result->>'status' <> 'aborted' THEN
    RAISE EXCEPTION 'abort failed: %', v_result;
  END IF;
  v_result := public.rotate_chat_v3_conversation_topic(v_digest, v_new_digest, 1);
  IF v_result->>'status' <> 'rotated' OR v_result->>'replayed' <> 'false' THEN
    RAISE EXCEPTION 'rotation failed: %', v_result;
  END IF;
  v_child := (v_result->>'topic_id')::uuid;
  v_result := public.rotate_chat_v3_conversation_topic(v_digest, v_new_digest, 1);
  IF v_result->>'status' <> 'rotated' OR v_result->>'replayed' <> 'true' OR
    (v_result->>'topic_id')::uuid <> v_child THEN
    RAISE EXCEPTION 'rotation retry forked topic: %', v_result;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chat_v3_conversations
    WHERE id = v_child AND parent_id = v_root AND root_id = v_root AND
      topic_sequence = 1 AND state = '{}'::jsonb) THEN
    RAISE EXCEPTION 'new topic inherited old state or lost lineage';
  END IF;
  IF (SELECT expires_at FROM public.chat_v3_conversations WHERE id = v_child)
    <> (SELECT expires_at FROM public.chat_v3_conversations WHERE id = v_root) THEN
    RAISE EXCEPTION 'new topic extended root TTL';
  END IF;
  INSERT INTO public.chat_request_logs
    (message_id, pipeline, error, chat_v3_topic_id)
  VALUES ('conversation-state-3', 'v3', 'in_progress', v_child)
  RETURNING id INTO v_third_log;
  v_result := public.begin_chat_v3_conversation_turn(v_digest, v_third_log, 1);
  IF v_result->>'status' <> 'inactive' THEN
    RAISE EXCEPTION 'old topic bearer remained active: %', v_result;
  END IF;
  v_result := public.begin_chat_v3_conversation_turn(v_new_digest, v_third_log, 0);
  IF v_result->>'status' <> 'begun' OR v_result->'state' <> '{}'::jsonb THEN
    RAISE EXCEPTION 'new topic did not start clean: %', v_result;
  END IF;
  UPDATE public.chat_v3_conversations
  SET created_at = now() - interval '25 hours',
      expires_at = now() - interval '1 hour',
      idle_expires_at = now() - interval '1 hour'
  WHERE id = v_other_root;
  v_result := public.resolve_chat_v3_conversation(repeat('c', 64));
  IF v_result->>'status' <> 'not_found' THEN
    RAISE EXCEPTION 'expired bearer remained usable: %', v_result;
  END IF;
  v_result := public.abort_chat_v3_conversation_turn(v_new_digest,
    v_third_log, 1);
  IF v_result->>'status' <> 'aborted' THEN
    RAISE EXCEPTION 'test setup could not end child turn: %', v_result;
  END IF;
  UPDATE public.chat_v3_conversations
  SET created_at = now() - interval '1 hour',
      expires_at = now() + interval '23 hours',
      idle_expires_at = now() - interval '1 minute'
  WHERE id = v_child;
  v_result := public.resolve_chat_v3_conversation(v_new_digest);
  IF v_result->>'status' <> 'not_found' THEN
    RAISE EXCEPTION 'idle-expired bearer remained usable: %', v_result;
  END IF;
END;
$test$;

ROLLBACK;
