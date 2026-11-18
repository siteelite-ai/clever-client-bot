-- Default-off foundation: an opt-in server path may finish a claimed v3 turn
-- only by atomically writing its terminal replay log and conversation state.
-- This migration neither changes the current Edge handler nor invokes this RPC.
-- This does NOT repair the separate claim INSERT -> begin RPC gap: a begin
-- failure can still leave an orphaned in_progress log unless the runtime
-- durably marks/recovers it. Keep the opt-in state path OFF until that and
-- the client protocol have independent proof.
BEGIN;
SET LOCAL lock_timeout = '2s';

ALTER TABLE public.chat_v3_conversation_turns
  ADD COLUMN terminal_payload_digest bytea,
  ADD COLUMN terminal_outcome text;

ALTER TABLE public.chat_v3_conversation_turns
  ADD CONSTRAINT chat_v3_turns_terminal_payload_shape CHECK (
    (terminal_payload_digest IS NULL AND terminal_outcome IS NULL) OR
    (terminal_payload_digest IS NOT NULL AND
      octet_length(terminal_payload_digest) = 32 AND
      terminal_outcome IN ('success', 'failure') AND
      ((terminal_outcome = 'success' AND status = 'finalized') OR
       (terminal_outcome = 'failure' AND status = 'aborted')))
  );

CREATE FUNCTION public.finish_chat_v3_conversation_turn(
  p_token_digest text,
  p_log_id uuid,
  p_fence bigint,
  p_expected_version bigint,
  p_outcome text,
  p_response_events jsonb,
  p_state jsonb,
  p_steps jsonb,
  p_final_response text,
  p_final_products_count integer,
  p_total_ms integer,
  p_error text
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
  v_complete jsonb;
  v_payload_digest bytea;
  v_state_digest bytea;
BEGIN
  IF p_token_digest IS NULL OR p_token_digest !~ '^[0-9a-f]{64}$' OR
    p_log_id IS NULL OR p_fence IS NULL OR p_fence < 1 OR
    p_fence > 1000000000 OR p_expected_version IS NULL OR
    p_expected_version < 0 OR p_expected_version >= 1000000000 OR
    p_outcome IS NULL OR p_outcome NOT IN ('success', 'failure') OR
    p_response_events IS NULL OR
    jsonb_typeof(p_response_events) IS DISTINCT FROM 'array' OR
    p_steps IS NULL OR jsonb_typeof(p_steps) IS DISTINCT FROM 'array' OR
    p_final_response IS NULL OR
    p_final_products_count IS NULL OR
    p_final_products_count < 0 OR p_final_products_count > 100 OR
    p_total_ms IS NULL OR p_total_ms < 0 OR p_total_ms > 900000 THEN
    RETURN jsonb_build_object('status', 'invalid_input');
  END IF;
  IF jsonb_array_length(p_response_events) < 2 OR
    jsonb_array_length(p_response_events) > 256 OR
    octet_length(p_response_events::text) > 262144 OR
    jsonb_array_length(p_steps) > 1024 OR
    octet_length(p_steps::text) > 65536 OR
    octet_length(p_final_response) > 65536 OR
    p_response_events->-1 <> '{"type":"done"}'::jsonb THEN
    RETURN jsonb_build_object('status', 'invalid_input');
  END IF;
  v_complete := p_response_events->-2;
  IF jsonb_typeof(v_complete) IS DISTINCT FROM 'object' OR
    v_complete->>'type' IS DISTINCT FROM 'diagnostic' OR
    v_complete->>'phase' IS DISTINCT FROM 'complete' OR
    jsonb_typeof(v_complete->'log_id') IS DISTINCT FROM 'string' OR
    v_complete->>'log_id' IS DISTINCT FROM p_log_id::text OR
    NOT (v_complete ? 'error') OR
    jsonb_typeof(v_complete->'products_count') IS DISTINCT FROM 'number' OR
    v_complete->>'products_count' IS DISTINCT FROM
      p_final_products_count::text THEN
    RETURN jsonb_build_object('status', 'invalid_events');
  END IF;
  -- An early done terminates the widget's stream parser. A second completion
  -- can likewise make live delivery disagree with the durable replay and
  -- must not advance the conversation version.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_response_events) WITH ORDINALITY AS e(event, ordinal)
    WHERE e.ordinal < jsonb_array_length(p_response_events) AND
      (e.event->>'type' = 'done' OR
       (e.ordinal < jsonb_array_length(p_response_events) - 1 AND
        e.event->>'type' = 'diagnostic' AND
        e.event->>'phase' = 'complete'))
  ) THEN
    RETURN jsonb_build_object('status', 'invalid_events');
  END IF;

  IF p_outcome = 'success' THEN
    IF p_error IS NOT NULL OR v_complete->'error' <> 'null'::jsonb OR
      p_state IS NULL OR jsonb_typeof(p_state) IS DISTINCT FROM 'object' THEN
      RETURN jsonb_build_object('status', 'invalid_input');
    END IF;
    -- This RPC is service-role-only. Shape checks are a second boundary, not
    -- a substitute for the caller deriving state exclusively from server
    -- search/evidence and never from browser history or slots.
    IF octet_length(p_state::text) > 16384 OR
      p_state->>'source_log_id' IS DISTINCT FROM p_log_id::text OR
      jsonb_typeof(p_state->'source_log_id') IS DISTINCT FROM 'string' OR
      jsonb_typeof(p_state->'topic_id') IS DISTINCT FROM 'string' OR
      NOT (p_state ? 'selection') OR
      jsonb_typeof(p_state->'selection') NOT IN ('null', 'object') OR
      p_state - 'source_log_id' - 'topic_id' - 'selection' <> '{}'::jsonb THEN
      RETURN jsonb_build_object('status', 'invalid_state');
    END IF;
    IF jsonb_typeof(p_state->'selection') = 'object' THEN
      IF jsonb_typeof(p_state->'selection'->'base_request')
          IS DISTINCT FROM 'string' OR
        length(p_state->'selection'->>'base_request') < 1 OR
        length(p_state->'selection'->>'base_request') > 2000 OR
        jsonb_typeof(p_state->'selection'->'selected_from_log_id')
          IS DISTINCT FROM 'string' OR
        (p_state->'selection'->>'selected_from_log_id') !~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' OR
        jsonb_typeof(p_state->'selection'->'selected_at')
          IS DISTINCT FROM 'string' OR
        length(p_state->'selection'->>'selected_at') < 1 OR
        length(p_state->'selection'->>'selected_at') > 64 OR
        jsonb_typeof(p_state->'selection'->'selection_hash')
          IS DISTINCT FROM 'string' OR
        (p_state->'selection'->>'selection_hash') !~
          '^selection-[0-9a-f]{8}$' OR
        jsonb_typeof(p_state->'selection'->'mandatory_criteria')
          IS DISTINCT FROM 'array' OR
        jsonb_typeof(p_state->'selection'->'shown_product_urls')
          IS DISTINCT FROM 'array' OR
        (p_state->'selection' - 'base_request' -
          'selected_from_log_id' - 'selected_at' - 'selection_hash' -
          'mandatory_criteria' - 'shown_product_urls' -
          'destination_fit_proof') <> '{}'::jsonb THEN
        RETURN jsonb_build_object('status', 'invalid_state');
      END IF;
      IF jsonb_array_length(p_state->'selection'->'mandatory_criteria') > 20 OR
        jsonb_array_length(p_state->'selection'->'shown_product_urls') < 1 OR
        jsonb_array_length(p_state->'selection'->'shown_product_urls') > 40 THEN
        RETURN jsonb_build_object('status', 'invalid_state');
      END IF;
    END IF;
    v_state_digest := sha256(convert_to(p_state::text, 'UTF8'));
  ELSE
    IF p_state IS NOT NULL OR p_error IS NULL OR
      length(p_error) < 1 OR octet_length(p_error) > 2048 OR
      p_error = 'in_progress' OR
      jsonb_typeof(v_complete->'error') IS DISTINCT FROM 'string' OR
      length(v_complete->>'error') < 1 OR
      v_complete->>'error' IS DISTINCT FROM p_error THEN
      RETURN jsonb_build_object('status', 'invalid_input');
    END IF;
  END IF;

  -- A stable digest covers every value this RPC will persist. JSONB has a
  -- canonical representation, so an ambiguous HTTP retry can prove it is
  -- byte-for-byte the same logical terminal write (not merely the same log).
  v_payload_digest := sha256(convert_to(jsonb_build_object(
    'log_id', p_log_id, 'fence', p_fence,
    'expected_version', p_expected_version, 'outcome', p_outcome,
    'response_events', p_response_events, 'state', p_state,
    'steps', p_steps, 'final_response', p_final_response,
    'final_products_count', p_final_products_count, 'total_ms', p_total_ms,
    'error', p_error
  )::text, 'UTF8'));

  -- Lock order is the same as begin/rotate: conversation, then claim log.
  -- A conflicting finish, reset or next turn cannot interleave the writes.
  SELECT * INTO v_conversation FROM public.chat_v3_conversations
  WHERE token_digest = p_token_digest FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  SELECT * INTO v_turn FROM public.chat_v3_conversation_turns
  WHERE log_id = p_log_id;
  IF NOT FOUND OR v_turn.conversation_id <> v_conversation.id THEN
    RETURN jsonb_build_object('status', 'not_begun');
  END IF;
  IF v_turn.status IN ('finalized', 'aborted') AND
    v_turn.terminal_payload_digest IS NOT NULL THEN
    IF v_turn.fence = p_fence AND
      v_turn.expected_version = p_expected_version AND
      v_turn.terminal_outcome = p_outcome AND
      v_turn.terminal_payload_digest = v_payload_digest THEN
      RETURN jsonb_build_object(
        'status', CASE WHEN p_outcome = 'success' THEN 'finalized'
          ELSE 'failed' END,
        'replayed', true, 'topic_id', v_conversation.id,
        'version', CASE WHEN p_outcome = 'success'
          THEN v_turn.result_version ELSE v_turn.expected_version END
      );
    END IF;
    RETURN jsonb_build_object('status', 'conflicting_replay');
  END IF;
  v_now := clock_timestamp();
  IF v_turn.status <> 'in_progress' OR
    v_conversation.status <> 'active' OR
    v_conversation.expires_at <= v_now OR
    v_conversation.active_lease_until IS NULL OR
    v_conversation.active_lease_until <= v_now OR
    v_conversation.active_log_id IS DISTINCT FROM p_log_id OR
    v_conversation.fence <> p_fence OR v_turn.fence <> p_fence OR
    v_conversation.version <> p_expected_version OR
    v_turn.expected_version <> p_expected_version OR
    (p_outcome = 'success' AND
      p_state->>'topic_id' IS DISTINCT FROM v_conversation.id::text) THEN
    RETURN jsonb_build_object('status', 'stale_turn');
  END IF;

  SELECT id, message_id, pipeline, error, chat_v3_topic_id
    INTO v_log FROM public.chat_request_logs
  WHERE id = p_log_id FOR UPDATE;
  IF NOT FOUND OR v_log.message_id IS NULL OR
    v_log.pipeline IS DISTINCT FROM 'v3' OR
    v_log.chat_v3_topic_id IS DISTINCT FROM v_conversation.id OR
    v_log.error IS DISTINCT FROM 'in_progress' THEN
    RETURN jsonb_build_object('status', 'invalid_claim');
  END IF;

  -- One SQL statement call is the transaction boundary. Any exception in the
  -- following writes aborts all of them; do not catch and mask write errors.
  UPDATE public.chat_request_logs
  SET steps = p_steps, final_products_count = p_final_products_count,
      final_response = nullif(p_final_response, ''), total_ms = p_total_ms,
      error = p_error, response_events = p_response_events
  WHERE id = p_log_id;
  IF p_outcome = 'success' THEN
    UPDATE public.chat_v3_conversations
    SET state = p_state, version = version + 1,
        active_log_id = NULL, active_lease_until = NULL,
        idle_expires_at = least(expires_at, v_now + interval '30 minutes'),
        updated_at = v_now
    WHERE id = v_conversation.id;
    UPDATE public.chat_v3_conversation_turns
    SET status = 'finalized', result_version = p_expected_version + 1,
        final_state_digest = v_state_digest,
        terminal_payload_digest = v_payload_digest,
        terminal_outcome = 'success', finished_at = v_now
    WHERE log_id = p_log_id;
    RETURN jsonb_build_object('status', 'finalized', 'replayed', false,
      'topic_id', v_conversation.id, 'version', p_expected_version + 1);
  END IF;

  -- A failed response is durable/replayable, but it never advances state.
  UPDATE public.chat_v3_conversations
  SET active_log_id = NULL, active_lease_until = NULL, updated_at = v_now
  WHERE id = v_conversation.id;
  UPDATE public.chat_v3_conversation_turns
  SET status = 'aborted', terminal_payload_digest = v_payload_digest,
      terminal_outcome = 'failure', finished_at = v_now
  WHERE log_id = p_log_id;
  RETURN jsonb_build_object('status', 'failed', 'replayed', false,
    'topic_id', v_conversation.id, 'version', p_expected_version);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.finish_chat_v3_conversation_turn(
  text, uuid, bigint, bigint, text, jsonb, jsonb, jsonb, text,
  integer, integer, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_chat_v3_conversation_turn(
  text, uuid, bigint, bigint, text, jsonb, jsonb, jsonb, text,
  integer, integer, text
) TO service_role;
COMMIT;
