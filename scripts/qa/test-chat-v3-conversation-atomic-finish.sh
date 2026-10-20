#!/usr/bin/env bash
set -euo pipefail

# Disposable PostgreSQL 16 only. Never accepts a DSN, remote host, project ref,
# or production credential. The existing relevant-migrations CI step must have
# prepared conversation_ci before this script is invoked.
if [[ "${GITHUB_ACTIONS:-}" != 'true' ]]; then
  printf 'Atomic-finish rehearsal runs only in disposable GitHub Actions CI.\n' >&2
  exit 2
fi
db_psql() {
  psql -X -h 127.0.0.1 -p 5432 -U postgres -d conversation_ci \
    -v ON_ERROR_STOP=1 -qAt "$@"
}
if [[ "$(db_psql -c "SELECT CASE WHEN current_database() = 'conversation_ci' AND to_regclass('public.chat_v3_conversation_turns') IS NOT NULL AND to_regprocedure('public.finish_chat_v3_conversation_turn(text,uuid,bigint,bigint,text,jsonb,jsonb,jsonb,text,integer,integer,text)') IS NULL THEN 'disposable-ready' ELSE 'unsafe-target' END")" != 'disposable-ready' ]]; then
  printf 'Refusing to apply atomic-finish migration to an unexpected database.\n' >&2
  exit 2
fi

db_psql -f supabase/migrations/20261020210300_chat_v3_atomic_finish.sql

db_psql <<'SQL'
CREATE FUNCTION public.test_atomic_prepare()
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $test$
DECLARE
  v_log uuid := gen_random_uuid();
  v_digest text := encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex');
  v_created jsonb;
  v_begun jsonb;
BEGIN
  v_created := public.create_chat_v3_conversation(v_digest);
  IF v_created->>'status' <> 'created' THEN
    RAISE EXCEPTION 'test setup could not create conversation';
  END IF;
  INSERT INTO public.chat_request_logs
    (id, message_id, pipeline, error, chat_v3_topic_id, user_query)
  VALUES (v_log, 'atomic-ci-' || v_log::text, 'v3', 'in_progress',
    (v_created->>'topic_id')::uuid, 'test request');
  v_begun := public.begin_chat_v3_conversation_turn(v_digest, v_log, 0);
  IF v_begun->>'status' <> 'begun' THEN
    RAISE EXCEPTION 'test setup could not begin turn: %', v_begun;
  END IF;
  RETURN jsonb_build_object('digest', v_digest, 'log_id', v_log,
    'topic_id', v_created->>'topic_id', 'fence', v_begun->'fence');
END;
$test$;

CREATE FUNCTION public.test_atomic_success(p_case jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $test$
DECLARE
  v_log uuid := (p_case->>'log_id')::uuid;
BEGIN
  RETURN public.finish_chat_v3_conversation_turn(
    p_case->>'digest', v_log, (p_case->>'fence')::bigint, 0,
    'success',
    jsonb_build_array(
      jsonb_build_object('type', 'delta', 'content', 'finished'),
      jsonb_build_object('type', 'diagnostic', 'phase', 'complete',
        'log_id', v_log, 'products_count', 0, 'error', NULL),
      jsonb_build_object('type', 'done')),
    jsonb_build_object('source_log_id', v_log, 'topic_id', p_case->>'topic_id',
      'selection', NULL),
    '[]'::jsonb, 'finished', 0, 3, NULL
  );
END;
$test$;

SET ROLE service_role;
DO $test$
DECLARE
  v_first jsonb := public.test_atomic_prepare();
  v_other jsonb := public.test_atomic_prepare();
  v_failure jsonb := public.test_atomic_prepare();
  v_lease jsonb := public.test_atomic_prepare();
  v_log uuid := (v_first->>'log_id')::uuid;
  v_bad_log uuid := (v_other->>'log_id')::uuid;
  v_fence bigint := (v_first->>'fence')::bigint;
  v_events jsonb := jsonb_build_array(
    jsonb_build_object('type', 'diagnostic', 'phase', 'complete',
      'log_id', v_log, 'products_count', 0, 'error', NULL),
    jsonb_build_object('type', 'done'));
  v_state jsonb := jsonb_build_object('source_log_id', v_log,
    'topic_id', v_first->>'topic_id', 'selection', NULL);
  v_result jsonb;
BEGIN
  -- A different bearer cannot finish another topic's log.
  v_result := public.finish_chat_v3_conversation_turn(
    v_other->>'digest', v_log, v_fence, 0, 'success', v_events,
    v_state, '[]'::jsonb, 'finished', 0, 3, NULL);
  IF v_result->>'status' <> 'not_begun' THEN
    RAISE EXCEPTION 'cross-topic finish was admitted: %', v_result;
  END IF;
  v_result := public.finish_chat_v3_conversation_turn(
    v_first->>'digest', v_bad_log, (v_other->>'fence')::bigint, 0,
    'success', v_events, v_state, '[]'::jsonb, 'finished', 0, 3, NULL);
  IF v_result->>'status' <> 'invalid_events' THEN
    RAISE EXCEPTION 'cross-topic event was admitted: %', v_result;
  END IF;

  -- The log is still claimed; malformed completion may not write either row.
  v_result := public.finish_chat_v3_conversation_turn(
    v_first->>'digest', v_log, v_fence, 0, 'success',
    '[{"type":"done"}]'::jsonb, v_state, '[]'::jsonb,
    'finished', 0, 3, NULL);
  IF v_result->>'status' <> 'invalid_input' THEN
    RAISE EXCEPTION 'malformed events were admitted: %', v_result;
  END IF;
  v_result := public.finish_chat_v3_conversation_turn(
    v_first->>'digest', v_log, v_fence, 0, 'success',
    jsonb_build_array(
      jsonb_build_object('type', 'done'),
      jsonb_build_object('type', 'diagnostic', 'phase', 'complete',
        'log_id', v_log, 'products_count', 0, 'error', NULL),
      jsonb_build_object('type', 'done')),
    v_state, '[]'::jsonb, 'finished', 0, 3, NULL);
  IF v_result->>'status' <> 'invalid_events' THEN
    RAISE EXCEPTION 'early done was admitted: %', v_result;
  END IF;
  v_result := public.finish_chat_v3_conversation_turn(
    v_first->>'digest', v_log, v_fence, 0, 'success',
    jsonb_build_array(
      jsonb_build_object('type', 'diagnostic', 'phase', 'complete',
        'log_id', v_log, 'products_count', 0, 'error', NULL),
      jsonb_build_object('type', 'diagnostic', 'phase', 'complete',
        'log_id', v_log, 'products_count', 0, 'error', NULL),
      jsonb_build_object('type', 'done')),
    v_state, '[]'::jsonb, 'finished', 0, 3, NULL);
  IF v_result->>'status' <> 'invalid_events' THEN
    RAISE EXCEPTION 'duplicate terminal diagnostic was admitted: %', v_result;
  END IF;
  v_result := public.finish_chat_v3_conversation_turn(
    v_first->>'digest', v_log, v_fence, 0, 'success', v_events,
    jsonb_build_object('source_log_id', v_log,
      'topic_id', v_first->>'topic_id', 'selection', NULL,
      'history', 'forged browser history'),
    '[]'::jsonb, 'finished', 0, 3, NULL);
  IF v_result->>'status' <> 'invalid_state' THEN
    RAISE EXCEPTION 'extra client-state key was admitted: %', v_result;
  END IF;
  v_result := public.finish_chat_v3_conversation_turn(
    v_first->>'digest', v_log, v_fence, 0, 'success', v_events,
    jsonb_build_object('source_log_id', v_log,
      'topic_id', v_other->>'topic_id', 'selection', NULL),
    '[]'::jsonb, 'finished', 0, 3, NULL);
  IF v_result->>'status' <> 'stale_turn' THEN
    RAISE EXCEPTION 'foreign topic state was admitted: %', v_result;
  END IF;
  v_result := public.finish_chat_v3_conversation_turn(
    v_first->>'digest', v_log, v_fence, 0, 'success',
    jsonb_build_array(
      jsonb_build_object('type', 'diagnostic', 'phase', 'complete',
        'log_id', v_log, 'products_count', 0,
        'error', 'request_timeout'),
      jsonb_build_object('type', 'done')),
    v_state, '[]'::jsonb, 'finished', 0, 3, NULL);
  IF v_result->>'status' <> 'invalid_input' THEN
    RAISE EXCEPTION 'error-bearing success was admitted: %', v_result;
  END IF;
  v_result := public.finish_chat_v3_conversation_turn(
    v_first->>'digest', v_log, v_fence + 1, 0, 'success',
    v_events, v_state, '[]'::jsonb, 'finished', 0, 3, NULL);
  IF v_result->>'status' <> 'stale_turn' THEN
    RAISE EXCEPTION 'wrong fence was admitted: %', v_result;
  END IF;
  v_result := public.finish_chat_v3_conversation_turn(
    v_first->>'digest', v_log, v_fence, 1, 'success',
    v_events, v_state, '[]'::jsonb, 'finished', 0, 3, NULL);
  IF v_result->>'status' <> 'stale_turn' THEN
    RAISE EXCEPTION 'wrong version was admitted: %', v_result;
  END IF;
  UPDATE public.chat_v3_conversations
  SET active_lease_until = clock_timestamp() - interval '1 second'
  WHERE id = (v_lease->>'topic_id')::uuid;
  v_result := public.test_atomic_success(v_lease);
  IF v_result->>'status' <> 'stale_turn' THEN
    RAISE EXCEPTION 'expired lease was admitted: %', v_result;
  END IF;
  -- The schema pairs active_log_id and lease, so a NULL lease requires
  -- clearing both; finish must still refuse the stranded ledger row.
  UPDATE public.chat_v3_conversations
  SET active_log_id = NULL, active_lease_until = NULL
  WHERE id = (v_lease->>'topic_id')::uuid;
  v_result := public.test_atomic_success(v_lease);
  IF v_result->>'status' <> 'stale_turn' THEN
    RAISE EXCEPTION 'missing lease was admitted: %', v_result;
  END IF;

  v_result := public.test_atomic_success(v_first);
  IF v_result->>'status' <> 'finalized' OR v_result->>'replayed' <> 'false' OR
    (v_result->>'version')::bigint <> 1 THEN
    RAISE EXCEPTION 'valid success did not finish atomically: %', v_result;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.chat_request_logs l
      JOIN public.chat_v3_conversations c ON c.id = l.chat_v3_topic_id
      JOIN public.chat_v3_conversation_turns t ON t.log_id = l.id
    WHERE l.id = v_log AND l.error IS NULL AND
      l.final_response = 'finished' AND
      l.response_events->-1 = '{"type":"done"}'::jsonb AND
      c.version = 1 AND c.active_log_id IS NULL AND
      c.state = v_state AND t.status = 'finalized' AND
      t.terminal_payload_digest IS NOT NULL AND
      t.terminal_outcome = 'success'
  ) THEN
    RAISE EXCEPTION 'success log, state and ledger are inconsistent';
  END IF;
  v_result := public.test_atomic_success(v_first);
  IF v_result->>'status' <> 'finalized' OR v_result->>'replayed' <> 'true' OR
    (v_result->>'version')::bigint <> 1 THEN
    RAISE EXCEPTION 'ambiguous identical retry was not replayed: %', v_result;
  END IF;
  v_result := public.finish_chat_v3_conversation_turn(
    v_first->>'digest', v_log, v_fence, 0, 'success',
    jsonb_build_array(
      jsonb_build_object('type', 'delta', 'content', 'finished'),
      jsonb_build_object('type', 'diagnostic', 'phase', 'complete',
        'log_id', v_log, 'products_count', 0, 'error', NULL),
      jsonb_build_object('type', 'done')),
    v_state, '[]'::jsonb, 'changed', 0, 3, NULL);
  IF v_result->>'status' <> 'conflicting_replay' THEN
    RAISE EXCEPTION 'changed retry was accepted: %', v_result;
  END IF;

  v_events := jsonb_build_array(
    jsonb_build_object('type', 'diagnostic', 'phase', 'complete',
      'log_id', (v_failure->>'log_id')::uuid,
      'products_count', 0, 'error', 'request_timeout'),
    jsonb_build_object('type', 'done'));
  v_result := public.finish_chat_v3_conversation_turn(
    v_failure->>'digest', (v_failure->>'log_id')::uuid,
    (v_failure->>'fence')::bigint, 0, 'failure', v_events,
    NULL, '[]'::jsonb, 'request failed', 0, 8, 'internal_timeout');
  IF v_result->>'status' <> 'invalid_input' THEN
    RAISE EXCEPTION 'diagnostic/log failure mismatch was admitted: %', v_result;
  END IF;
  v_result := public.finish_chat_v3_conversation_turn(
    v_failure->>'digest', (v_failure->>'log_id')::uuid,
    (v_failure->>'fence')::bigint, 0, 'failure', v_events,
    NULL, '[]'::jsonb, 'request failed', 0, 8, 'request_timeout');
  IF v_result->>'status' <> 'failed' OR v_result->>'replayed' <> 'false' OR
    (v_result->>'version')::bigint <> 0 THEN
    RAISE EXCEPTION 'failed turn was not durable without bump: %', v_result;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.chat_request_logs l
      JOIN public.chat_v3_conversations c ON c.id = l.chat_v3_topic_id
      JOIN public.chat_v3_conversation_turns t ON t.log_id = l.id
    WHERE l.id = (v_failure->>'log_id')::uuid AND
      l.error = 'request_timeout' AND
      c.version = 0 AND c.state = '{}'::jsonb AND
      c.active_log_id IS NULL AND t.status = 'aborted' AND
      t.terminal_outcome = 'failure' AND
      t.terminal_payload_digest IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'failed log advanced state or did not close lease';
  END IF;
  v_result := public.finish_chat_v3_conversation_turn(
    v_failure->>'digest', (v_failure->>'log_id')::uuid,
    (v_failure->>'fence')::bigint, 0, 'failure', v_events,
    NULL, '[]'::jsonb, 'request failed', 0, 8, 'request_timeout');
  IF v_result->>'status' <> 'failed' OR v_result->>'replayed' <> 'true' THEN
    RAISE EXCEPTION 'failed terminal replay not idempotent: %', v_result;
  END IF;
  v_result := public.finish_chat_v3_conversation_turn(
    v_failure->>'digest', (v_failure->>'log_id')::uuid,
    (v_failure->>'fence')::bigint, 0, 'failure', v_events,
    NULL, '[]'::jsonb, 'changed request failed', 0, 8, 'request_timeout');
  IF v_result->>'status' <> 'conflicting_replay' THEN
    RAISE EXCEPTION 'changed failed retry was accepted: %', v_result;
  END IF;
END;
$test$;
RESET ROLE;
SQL

# Grant inspection plus an actual anonymous invocation both need to fail.
privilege_result=$(db_psql -c "SELECT CASE WHEN has_function_privilege('anon', 'public.finish_chat_v3_conversation_turn(text,uuid,bigint,bigint,text,jsonb,jsonb,jsonb,text,integer,integer,text)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.finish_chat_v3_conversation_turn(text,uuid,bigint,bigint,text,jsonb,jsonb,jsonb,text,integer,integer,text)', 'EXECUTE') THEN 'unsafe' ELSE 'service-only' END")
if [[ "$privilege_result" != 'service-only' ]]; then
  printf 'Public/client roles can execute atomic finish.\n' >&2
  exit 1
fi
if db_psql -c "SET ROLE anon; SELECT public.finish_chat_v3_conversation_turn(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);" >/dev/null 2>&1; then
  printf 'Anonymous RPC invocation unexpectedly succeeded.\n' >&2
  exit 1
fi
if db_psql -c "SET ROLE authenticated; SELECT public.finish_chat_v3_conversation_turn(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);" >/dev/null 2>&1; then
  printf 'Authenticated RPC invocation unexpectedly succeeded.\n' >&2
  exit 1
fi

# Fail the middle write and verify PostgreSQL rolled back the preceding log
# UPDATE. The test trigger exists only inside this disposable transaction.
fault_case=$(db_psql -F '|' -c "SET ROLE service_role; SELECT c->>'digest', c->>'topic_id', c->>'log_id', c->>'fence' FROM (SELECT public.test_atomic_prepare() AS c) AS q;")
IFS='|' read -r fault_digest fault_topic fault_log fault_fence <<<"$fault_case"
db_psql <<SQL
BEGIN;
CREATE FUNCTION public.test_atomic_forced_write_failure()
RETURNS trigger LANGUAGE plpgsql AS \$test\$
BEGIN
  RAISE EXCEPTION 'injected_finish_state_write_failure';
END;
\$test\$;
CREATE TRIGGER test_atomic_forced_write_failure
BEFORE UPDATE ON public.chat_v3_conversations
FOR EACH ROW EXECUTE FUNCTION public.test_atomic_forced_write_failure();
SET LOCAL ROLE service_role;
DO \$test\$
DECLARE
  v_case jsonb := jsonb_build_object('digest', '$fault_digest',
    'topic_id', '$fault_topic', 'log_id', '$fault_log',
    'fence', $fault_fence);
BEGIN
  BEGIN
    PERFORM public.test_atomic_success(v_case);
    RAISE EXCEPTION 'expected_forced_failure_missing';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'injected_finish_state_write_failure' THEN
      RAISE;
    END IF;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM public.chat_request_logs l
      JOIN public.chat_v3_conversations c ON c.id = l.chat_v3_topic_id
      JOIN public.chat_v3_conversation_turns t ON t.log_id = l.id
    WHERE l.id = '$fault_log'::uuid AND l.error = 'in_progress' AND
      l.response_events = '[]'::jsonb AND c.version = 0 AND
      c.state = '{}'::jsonb AND c.active_log_id = l.id AND
      t.status = 'in_progress' AND t.terminal_payload_digest IS NULL
  ) THEN
    RAISE EXCEPTION 'forced middle-write failure left a partial commit';
  END IF;
END;
\$test\$;
ROLLBACK;
SQL

# Two identical finishes race on the same conversation lock. The second must
# wait for the first transaction and return a replay, never bump version twice.
race_case=$(db_psql -F '|' -c "SET ROLE service_role; SELECT c->>'digest', c->>'topic_id', c->>'log_id', c->>'fence' FROM (SELECT public.test_atomic_prepare() AS c) AS q;")
IFS='|' read -r race_digest race_topic race_log race_fence <<<"$race_case"
scratch_dir=$(mktemp -d "${TMPDIR:-/tmp}/atomic-finish-ci.XXXXXXXX")
first_pid=''
cleanup() {
  if [[ -n "$first_pid" ]] && kill -0 "$first_pid" 2>/dev/null; then
    kill "$first_pid" 2>/dev/null || true
    wait "$first_pid" 2>/dev/null || true
  fi
  rm -f "$scratch_dir/first.out" "$scratch_dir/first.err" \
    "$scratch_dir/lock-held"
  rmdir "$scratch_dir"
}
trap cleanup EXIT
(
  db_psql <<SQL
BEGIN;
SET LOCAL ROLE service_role;
SELECT public.test_atomic_success(jsonb_build_object('digest', '$race_digest',
  'topic_id', '$race_topic', 'log_id', '$race_log', 'fence', $race_fence))->>'status';
\! touch "$scratch_dir/lock-held"
SELECT pg_sleep(3);
COMMIT;
SQL
) >"$scratch_dir/first.out" 2>"$scratch_dir/first.err" &
first_pid=$!
for ((attempt = 0; attempt < 100; attempt++)); do
  [[ -f "$scratch_dir/lock-held" ]] && break
  if ! kill -0 "$first_pid" 2>/dev/null; then
    printf 'First finish failed before acquiring the lock.\n' >&2
    sed -n '1,100p' "$scratch_dir/first.err" >&2
    exit 1
  fi
  sleep 0.05
done
if [[ ! -f "$scratch_dir/lock-held" ]]; then
  printf 'Timed out waiting for first finish lock.\n' >&2
  exit 1
fi
second_result=$(db_psql -c "SET ROLE service_role; WITH r AS MATERIALIZED (SELECT public.test_atomic_success(jsonb_build_object('digest', '$race_digest', 'topic_id', '$race_topic', 'log_id', '$race_log', 'fence', $race_fence)) AS value) SELECT value->>'status' || ':' || value->>'replayed' FROM r;")
wait "$first_pid"
first_pid=''
if ! grep -qx 'finalized' "$scratch_dir/first.out"; then
  printf 'First finish did not finalize.\n' >&2
  sed -n '1,100p' "$scratch_dir/first.out" >&2
  exit 1
fi
if [[ "$second_result" != 'finalized:true' ]]; then
  printf 'Concurrent identical finish did not replay: %s\n' "$second_result" >&2
  exit 1
fi
race_version=$(db_psql -c "SELECT version FROM public.chat_v3_conversations WHERE id = '$race_topic'::uuid;")
if [[ "$race_version" != '1' ]]; then
  printf 'Concurrent finish bumped version %s times (expected once).\n' "$race_version" >&2
  exit 1
fi
printf 'Atomic finish: success/failure, replay, privilege, rollback and race checks passed.\n'
