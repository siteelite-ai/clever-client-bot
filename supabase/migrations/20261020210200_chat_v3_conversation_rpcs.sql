-- Default-off v3 state, migration 3/3. The log binding column and new
-- service-only tables already exist; this transaction never alters live logs.
BEGIN;

CREATE FUNCTION public.create_chat_v3_conversation(p_token_digest text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_id uuid := gen_random_uuid();
  v_now timestamptz := clock_timestamp();
  v_existing_root uuid;
  v_existing_version bigint;
  v_existing_expiry timestamptz;
BEGIN
  IF p_token_digest IS NULL OR p_token_digest !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('status', 'invalid_digest');
  END IF;

  INSERT INTO public.chat_v3_conversations
    (id, root_id, topic_sequence, token_digest, created_at, updated_at,
      expires_at, idle_expires_at)
  VALUES
    (v_id, v_id, 0, p_token_digest, v_now, v_now,
      v_now + interval '24 hours', v_now + interval '30 minutes')
  ON CONFLICT (token_digest) DO NOTHING;
  IF NOT FOUND THEN
    -- Same digest on retry after an ambiguous HTTP response is safe to
    -- acknowledge; a new random bearer colliding is cryptographically remote.
    SELECT id, root_id, version, expires_at INTO
      v_id, v_existing_root, v_existing_version, v_existing_expiry
    FROM public.chat_v3_conversations
    WHERE token_digest = p_token_digest AND parent_id IS NULL
      AND status = 'active' AND expires_at > clock_timestamp()
      AND idle_expires_at > clock_timestamp();
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'digest_conflict');
    END IF;
    RETURN jsonb_build_object('status', 'created', 'replayed', true,
      'topic_id', v_id, 'root_id', v_existing_root,
      'version', v_existing_version, 'expires_at', v_existing_expiry);
  END IF;

  -- Bounded lazy cleanup. Reads always enforce expires_at independently, so
  -- a missed cleanup never extends the token's validity.
  IF random() < 0.01 THEN
    DELETE FROM public.chat_v3_conversations
    WHERE id IN (
      SELECT id FROM public.chat_v3_conversations
      WHERE parent_id IS NULL AND expires_at <= v_now
      ORDER BY expires_at LIMIT 100
    );
  END IF;

  RETURN jsonb_build_object('status', 'created', 'replayed', false,
    'topic_id', v_id,
    'root_id', v_id, 'version', 0, 'expires_at', v_now + interval '24 hours');
END;
$function$;

CREATE FUNCTION public.resolve_chat_v3_conversation(p_token_digest text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_conversation public.chat_v3_conversations%ROWTYPE;
BEGIN
  IF p_token_digest IS NULL OR p_token_digest !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('status', 'invalid_digest');
  END IF;
  SELECT * INTO v_conversation FROM public.chat_v3_conversations
  WHERE token_digest = p_token_digest;
  IF NOT FOUND OR v_conversation.status <> 'active' OR
    v_conversation.expires_at <= clock_timestamp() OR
    (v_conversation.idle_expires_at <= clock_timestamp() AND NOT (
      v_conversation.active_log_id IS NOT NULL AND
      v_conversation.active_lease_until > clock_timestamp()
    )) THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  -- Only this server-verified topic ID may be written into the new log claim.
  -- No state leaves this pre-claim lookup.
  RETURN jsonb_build_object('status', 'resolved',
    'topic_id', v_conversation.id, 'version', v_conversation.version);
END;
$function$;

CREATE FUNCTION public.begin_chat_v3_conversation_turn(
  p_token_digest text,
  p_log_id uuid,
  p_expected_version bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_conversation public.chat_v3_conversations%ROWTYPE;
  v_turn public.chat_v3_conversation_turns%ROWTYPE;
  v_log record;
  v_now timestamptz;
  v_fence bigint;
BEGIN
  IF p_token_digest IS NULL OR p_token_digest !~ '^[0-9a-f]{64}$'
    OR p_log_id IS NULL OR p_expected_version IS NULL
    OR p_expected_version < 0 OR p_expected_version > 1000000000 THEN
    RETURN jsonb_build_object('status', 'invalid_input');
  END IF;

  SELECT * INTO v_conversation FROM public.chat_v3_conversations
  WHERE token_digest = p_token_digest FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  v_now := clock_timestamp();
  IF v_conversation.status <> 'active' OR
    v_conversation.expires_at <= v_now OR
    (v_conversation.idle_expires_at <= v_now AND NOT (
      v_conversation.active_log_id IS NOT NULL AND
      v_conversation.active_lease_until > v_now
    )) THEN
    RETURN jsonb_build_object('status', 'inactive');
  END IF;

  -- The ledger makes an ambiguous network retry of the same claimed log
  -- idempotent. A completed log can never begin paid work a second time.
  SELECT * INTO v_turn FROM public.chat_v3_conversation_turns
  WHERE log_id = p_log_id;
  IF FOUND THEN
    IF v_turn.conversation_id <> v_conversation.id THEN
      RETURN jsonb_build_object('status', 'log_already_bound');
    END IF;
    IF v_turn.status = 'finalized' THEN
      RETURN jsonb_build_object('status', 'finalized', 'replayed', true,
        'topic_id', v_conversation.id, 'version', v_turn.result_version);
    END IF;
    IF v_turn.status = 'in_progress' AND
      v_conversation.active_log_id = p_log_id AND
      v_conversation.fence = v_turn.fence AND
      v_conversation.active_lease_until > v_now THEN
      -- A repeated RPC result is NOT a fresh right to run the paid pipeline.
      -- The caller must wait/replay the already claimed log, not execute work.
      RETURN jsonb_build_object('status', 'turn_in_progress',
        'replayed', true, 'topic_id', v_conversation.id);
    END IF;
    RETURN jsonb_build_object('status', 'stale_turn');
  END IF;

  IF v_conversation.version <> p_expected_version THEN
    RETURN jsonb_build_object('status', 'stale_version',
      'version', v_conversation.version);
  END IF;
  IF v_conversation.turn_count >= 1000000000 OR
    v_conversation.fence >= 1000000000 THEN
    RETURN jsonb_build_object('status', 'turn_limit');
  END IF;
  IF v_conversation.active_log_id IS NOT NULL AND
    v_conversation.active_lease_until > v_now THEN
    RETURN jsonb_build_object('status', 'busy');
  END IF;

  SELECT message_id, pipeline, error, chat_v3_topic_id INTO v_log
  FROM public.chat_request_logs WHERE id = p_log_id FOR UPDATE;
  IF NOT FOUND OR v_log.message_id IS NULL OR
    v_log.pipeline IS DISTINCT FROM 'v3' OR
    v_log.error IS DISTINCT FROM 'in_progress' THEN
    RETURN jsonb_build_object('status', 'invalid_claim');
  END IF;
  IF v_log.chat_v3_topic_id IS DISTINCT FROM v_conversation.id THEN
    RETURN jsonb_build_object('status', 'unbound_claim');
  END IF;

  -- Recheck after locking the claim: another conversation could have bound
  -- this log while this call was waiting for its row lock.
  SELECT * INTO v_turn FROM public.chat_v3_conversation_turns
  WHERE log_id = p_log_id;
  IF FOUND THEN RETURN jsonb_build_object('status', 'log_already_bound'); END IF;

  IF v_conversation.active_log_id IS NOT NULL THEN
    UPDATE public.chat_v3_conversation_turns
    SET status = 'abandoned', finished_at = v_now
    WHERE log_id = v_conversation.active_log_id AND status = 'in_progress';
  END IF;
  v_fence := v_conversation.fence + 1;
  UPDATE public.chat_v3_conversations
  SET fence = v_fence, turn_count = turn_count + 1,
      active_log_id = p_log_id,
      active_lease_until = v_now + interval '5 minutes',
      updated_at = v_now
  WHERE id = v_conversation.id;
  INSERT INTO public.chat_v3_conversation_turns
    (log_id, conversation_id, fence, expected_version, status, started_at)
  VALUES (p_log_id, v_conversation.id, v_fence,
    v_conversation.version, 'in_progress', v_now);

  RETURN jsonb_build_object('status', 'begun', 'replayed', false,
    'topic_id', v_conversation.id, 'version', v_conversation.version,
    'fence', v_fence, 'state', v_conversation.state);
END;
$function$;

CREATE FUNCTION public.finalize_chat_v3_conversation_turn(
  p_token_digest text,
  p_log_id uuid,
  p_fence bigint,
  p_expected_version bigint,
  p_state jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_conversation public.chat_v3_conversations%ROWTYPE;
  v_turn public.chat_v3_conversation_turns%ROWTYPE;
  v_log record;
  v_digest bytea;
  v_now timestamptz;
BEGIN
  IF p_token_digest IS NULL OR p_token_digest !~ '^[0-9a-f]{64}$'
    OR p_log_id IS NULL OR p_fence IS NULL OR p_fence < 1 OR
    p_fence > 1000000000
    OR p_expected_version IS NULL OR p_expected_version < 0 OR
    p_expected_version >= 1000000000 OR p_state IS NULL OR
    jsonb_typeof(p_state) IS DISTINCT FROM 'object' OR
    p_state->>'source_log_id' IS DISTINCT FROM p_log_id::text OR
    octet_length(p_state::text) > 16384 THEN
    RETURN jsonb_build_object('status', 'invalid_input');
  END IF;
  v_digest := sha256(convert_to(p_state::text, 'UTF8'));

  SELECT * INTO v_conversation FROM public.chat_v3_conversations
  WHERE token_digest = p_token_digest FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  SELECT * INTO v_turn FROM public.chat_v3_conversation_turns
  WHERE log_id = p_log_id;
  IF NOT FOUND OR v_turn.conversation_id <> v_conversation.id THEN
    RETURN jsonb_build_object('status', 'not_begun');
  END IF;
  IF v_turn.status = 'finalized' THEN
    IF v_turn.fence = p_fence AND
      v_turn.expected_version = p_expected_version AND
      v_turn.final_state_digest = v_digest THEN
      RETURN jsonb_build_object('status', 'finalized', 'replayed', true,
        'topic_id', v_conversation.id, 'version', v_turn.result_version);
    END IF;
    RETURN jsonb_build_object('status', 'conflicting_replay');
  END IF;
  v_now := clock_timestamp();
  IF v_turn.status <> 'in_progress' OR
    v_conversation.status <> 'active' OR
    v_conversation.expires_at <= v_now OR
    v_conversation.active_lease_until <= v_now OR
    v_conversation.active_log_id IS DISTINCT FROM p_log_id OR
    v_conversation.fence <> p_fence OR v_turn.fence <> p_fence OR
    v_conversation.version <> p_expected_version OR
    v_turn.expected_version <> p_expected_version THEN
    RETURN jsonb_build_object('status', 'stale_turn');
  END IF;

  -- Only a successful, completed server-owned reply can commit state. A
  -- browser-provided history or an in-progress/failed log is never evidence.
  SELECT message_id, pipeline, error, response_events, chat_v3_topic_id
    INTO v_log FROM public.chat_request_logs
  WHERE id = p_log_id FOR UPDATE;
  IF NOT FOUND OR v_log.message_id IS NULL OR
    v_log.pipeline IS DISTINCT FROM 'v3' OR
    v_log.chat_v3_topic_id IS DISTINCT FROM v_conversation.id OR
    v_log.error IS NOT NULL OR
    jsonb_typeof(v_log.response_events) IS DISTINCT FROM 'array' OR
    jsonb_array_length(v_log.response_events) < 2 OR
    v_log.response_events->-1 <> '{"type":"done"}'::jsonb OR
    (v_log.response_events->-2)->>'type' IS DISTINCT FROM 'diagnostic' OR
    (v_log.response_events->-2)->>'phase' IS DISTINCT FROM 'complete' OR
    (v_log.response_events->-2)->>'log_id' IS DISTINCT FROM p_log_id::text OR
    NOT ((v_log.response_events->-2) ? 'error') OR
    (v_log.response_events->-2)->'error' <> 'null'::jsonb THEN
    RETURN jsonb_build_object('status', 'claim_not_successful');
  END IF;

  UPDATE public.chat_v3_conversations
  SET state = p_state, version = version + 1,
      active_log_id = NULL, active_lease_until = NULL,
      idle_expires_at = least(expires_at, v_now + interval '30 minutes'),
      updated_at = v_now
  WHERE id = v_conversation.id;
  UPDATE public.chat_v3_conversation_turns
  SET status = 'finalized', result_version = p_expected_version + 1,
      final_state_digest = v_digest, finished_at = v_now
  WHERE log_id = p_log_id;
  RETURN jsonb_build_object('status', 'finalized', 'replayed', false,
    'topic_id', v_conversation.id, 'version', p_expected_version + 1);
END;
$function$;

CREATE FUNCTION public.abort_chat_v3_conversation_turn(
  p_token_digest text,
  p_log_id uuid,
  p_fence bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_conversation public.chat_v3_conversations%ROWTYPE;
  v_turn public.chat_v3_conversation_turns%ROWTYPE;
BEGIN
  IF p_token_digest IS NULL OR p_token_digest !~ '^[0-9a-f]{64}$'
    OR p_log_id IS NULL OR p_fence IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_input');
  END IF;
  SELECT * INTO v_conversation FROM public.chat_v3_conversations
  WHERE token_digest = p_token_digest FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  SELECT * INTO v_turn FROM public.chat_v3_conversation_turns
  WHERE log_id = p_log_id;
  IF NOT FOUND OR v_turn.conversation_id <> v_conversation.id THEN
    RETURN jsonb_build_object('status', 'not_begun');
  END IF;
  IF v_turn.fence <> p_fence THEN
    RETURN jsonb_build_object('status', 'stale_turn');
  END IF;
  IF v_turn.status = 'aborted' THEN
    RETURN jsonb_build_object('status', 'aborted', 'replayed', true);
  END IF;
  IF v_turn.status <> 'in_progress' OR
    v_conversation.active_log_id IS DISTINCT FROM p_log_id OR
    v_conversation.fence <> p_fence THEN
    RETURN jsonb_build_object('status', 'stale_turn');
  END IF;
  UPDATE public.chat_v3_conversation_turns
  SET status = 'aborted', finished_at = clock_timestamp()
  WHERE log_id = p_log_id;
  UPDATE public.chat_v3_conversations
  SET active_log_id = NULL, active_lease_until = NULL,
      updated_at = clock_timestamp()
  WHERE id = v_conversation.id;
  RETURN jsonb_build_object('status', 'aborted', 'replayed', false);
END;
$function$;

CREATE FUNCTION public.rotate_chat_v3_conversation_topic(
  p_token_digest text,
  p_new_token_digest text,
  p_expected_version bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_parent public.chat_v3_conversations%ROWTYPE;
  v_child public.chat_v3_conversations%ROWTYPE;
  v_new_id uuid := gen_random_uuid();
  v_now timestamptz;
BEGIN
  IF p_token_digest IS NULL OR p_token_digest !~ '^[0-9a-f]{64}$'
    OR p_new_token_digest IS NULL OR
    p_new_token_digest !~ '^[0-9a-f]{64}$' OR
    p_token_digest = p_new_token_digest OR
    p_expected_version IS NULL OR p_expected_version < 0 OR
    p_expected_version > 1000000000 THEN
    RETURN jsonb_build_object('status', 'invalid_input');
  END IF;
  SELECT * INTO v_parent FROM public.chat_v3_conversations
  WHERE token_digest = p_token_digest FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  v_now := clock_timestamp();
  IF v_parent.status = 'superseded' THEN
    -- Same newly generated digest may be retried after a committed rotation
    -- whose HTTP response was lost. Different digests cannot fork the topic.
    SELECT * INTO v_child FROM public.chat_v3_conversations
    WHERE parent_id = v_parent.id AND token_digest = p_new_token_digest;
    IF FOUND AND v_child.status = 'active' AND
      v_child.expires_at > v_now AND v_child.idle_expires_at > v_now THEN
      RETURN jsonb_build_object('status', 'rotated', 'replayed', true,
        'topic_id', v_child.id, 'root_id', v_child.root_id,
        'parent_topic_id', v_parent.id, 'version', v_child.version,
        'expires_at', v_child.expires_at);
    END IF;
    RETURN jsonb_build_object('status', 'inactive');
  END IF;
  IF v_parent.status <> 'active' OR v_parent.expires_at <= v_now OR
    v_parent.idle_expires_at <= v_now THEN
    RETURN jsonb_build_object('status', 'inactive');
  END IF;
  IF v_parent.version <> p_expected_version THEN
    RETURN jsonb_build_object('status', 'stale_version');
  END IF;
  IF v_parent.active_log_id IS NOT NULL AND
    v_parent.active_lease_until > v_now THEN
    RETURN jsonb_build_object('status', 'busy');
  END IF;
  IF v_parent.topic_sequence >= 1024 THEN
    RETURN jsonb_build_object('status', 'topic_limit');
  END IF;
  IF v_parent.active_log_id IS NOT NULL THEN
    UPDATE public.chat_v3_conversation_turns
    SET status = 'abandoned', finished_at = v_now
    WHERE log_id = v_parent.active_log_id AND status = 'in_progress';
  END IF;
  UPDATE public.chat_v3_conversations
  SET status = 'superseded', active_log_id = NULL,
      active_lease_until = NULL, updated_at = v_now
  WHERE id = v_parent.id;
  INSERT INTO public.chat_v3_conversations
    (id, root_id, parent_id, topic_sequence, token_digest,
      created_at, updated_at, expires_at, idle_expires_at)
  VALUES (v_new_id, v_parent.root_id, v_parent.id,
    v_parent.topic_sequence + 1, p_new_token_digest,
    v_now, v_now, v_parent.expires_at,
    least(v_parent.expires_at, v_now + interval '30 minutes'));
  RETURN jsonb_build_object('status', 'rotated', 'replayed', false,
    'topic_id', v_new_id,
    'root_id', v_parent.root_id, 'parent_topic_id', v_parent.id,
    'version', 0, 'expires_at', v_parent.expires_at);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_chat_v3_conversation(text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.resolve_chat_v3_conversation(text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.begin_chat_v3_conversation_turn(text, uuid, bigint)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.finalize_chat_v3_conversation_turn(text, uuid, bigint, bigint, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.abort_chat_v3_conversation_turn(text, uuid, bigint)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rotate_chat_v3_conversation_topic(text, text, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_chat_v3_conversation(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_chat_v3_conversation(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_chat_v3_conversation_turn(text, uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_chat_v3_conversation_turn(text, uuid, bigint, bigint, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.abort_chat_v3_conversation_turn(text, uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.rotate_chat_v3_conversation_topic(text, text, bigint) TO service_role;
COMMIT;
