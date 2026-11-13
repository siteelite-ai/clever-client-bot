#!/usr/bin/env bash
set -euo pipefail

# This is an opt-in SQL foundation test, not a live Edge or Supabase test.
# Fixed disposable PostgreSQL 16 CI target only: no DSN, remote host, project
# ref, or user-supplied credential can be passed to this script.
if [[ "${GITHUB_ACTIONS:-}" != 'true' ]]; then
  printf 'Atomic claim+begin rehearsal runs only in disposable CI.\n' >&2
  exit 2
fi
db_psql() {
  psql -X -h 127.0.0.1 -p 5432 -U postgres -d conversation_ci \
    -v ON_ERROR_STOP=1 -qAt "$@"
}
ready=$(db_psql -c "SELECT CASE WHEN current_database() = 'conversation_ci' AND to_regclass('public.chat_request_logs') IS NOT NULL AND to_regclass('public.chat_v3_conversation_turns') IS NOT NULL AND to_regprocedure('public.finish_chat_v3_conversation_turn(text,uuid,bigint,bigint,text,jsonb,jsonb,jsonb,text,integer,integer,text)') IS NOT NULL AND to_regprocedure('public.claim_and_begin_chat_v3_conversation_turn(text,uuid,bigint,text,text,text,jsonb)') IS NULL THEN 'disposable-ready' ELSE 'unsafe-target' END")
if [[ "$ready" != 'disposable-ready' ]]; then
  printf 'Refusing atomic claim+begin migration on an unexpected database.\n' >&2
  exit 2
fi

db_psql -f supabase/migrations/20261020210400_chat_v3_atomic_claim_begin.sql

db_psql <<'SQL'
CREATE FUNCTION public.test_claim_case()
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $test$
DECLARE
  v_digest text := encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex');
  v_created jsonb;
BEGIN
  v_created := public.create_chat_v3_conversation(v_digest);
  IF v_created->>'status' <> 'created' THEN
    RAISE EXCEPTION 'claim setup could not create conversation: %', v_created;
  END IF;
  RETURN jsonb_build_object('digest', v_digest,
    'topic_id', v_created->>'topic_id');
END;
$test$;

CREATE FUNCTION public.test_claim_call(
  p_case jsonb, p_log_id uuid, p_message_id text,
  p_session_id text DEFAULT 'atomic-claim-ci',
  p_user_query text DEFAULT 'test request',
  p_expected_version bigint DEFAULT 0
)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $test$
  SELECT public.claim_and_begin_chat_v3_conversation_turn(
    p_case->>'digest', p_log_id, p_expected_version,
    p_session_id, p_message_id, p_user_query,
    '[{"step":"claim_ci"}]'::jsonb);
$test$;

SET ROLE service_role;
DO $test$
DECLARE
  v_case jsonb := public.test_claim_case();
  v_other jsonb := public.test_claim_case();
  v_stale jsonb := public.test_claim_case();
  v_inactive jsonb := public.test_claim_case();
  v_idle jsonb := public.test_claim_case();
  v_limit jsonb := public.test_claim_case();
  v_lease jsonb := public.test_claim_case();
  v_failure jsonb := public.test_claim_case();
  v_log uuid := gen_random_uuid();
  v_message text := gen_random_uuid()::text;
  v_lease_log uuid := gen_random_uuid();
  v_lease_message text := gen_random_uuid()::text;
  v_failure_log uuid := gen_random_uuid();
  v_failure_message text := gen_random_uuid()::text;
  v_denied_message text;
  v_result jsonb;
  v_events jsonb;
BEGIN
  v_denied_message := gen_random_uuid()::text;
  v_result := public.test_claim_call(v_stale, gen_random_uuid(),
    v_denied_message, 'bad session');
  IF v_result->>'status' <> 'invalid_input' THEN
    RAISE EXCEPTION 'invalid session was accepted: %', v_result;
  END IF;
  v_result := public.claim_and_begin_chat_v3_conversation_turn(
    v_stale->>'digest', gen_random_uuid(), 0, 'atomic-claim-ci',
    v_denied_message, 'test request', '{}'::jsonb);
  IF v_result->>'status' <> 'invalid_input' THEN
    RAISE EXCEPTION 'invalid steps were accepted: %', v_result;
  END IF;
  v_result := public.test_claim_call(v_stale, gen_random_uuid(),
    v_denied_message, 'atomic-claim-ci', ' test request');
  IF v_result->>'status' <> 'invalid_input' OR EXISTS (
    SELECT 1 FROM public.chat_request_logs WHERE message_id = v_denied_message
  ) THEN
    RAISE EXCEPTION 'invalid input reserved a message ID: %', v_result;
  END IF;

  v_result := public.test_claim_call(v_case, v_log, v_message);
  IF v_result->>'status' <> 'begun' OR
    v_result->>'recovered' <> 'false' OR
    v_result->>'log_id' <> v_log::text OR
    (v_result->>'fence')::bigint <> 1 THEN
    RAISE EXCEPTION 'fresh atomic claim failed: %', v_result;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.chat_request_logs l
    JOIN public.chat_v3_conversation_turns t ON t.log_id = l.id
    JOIN public.chat_v3_conversations c ON c.id = t.conversation_id
    WHERE l.id = v_log AND l.message_id = v_message AND
      l.chat_v3_topic_id = (v_case->>'topic_id')::uuid AND
      l.error = 'in_progress' AND t.status = 'in_progress' AND
      c.active_log_id = l.id AND c.fence = 1 AND c.turn_count = 1
  ) THEN
    RAISE EXCEPTION 'claim, lease and ledger were not committed together';
  END IF;
  -- An ambiguous SQL/HTTP response can be retried with the same server-only
  -- log ID in that one serialized Edge attempt. A different ID cannot become
  -- a second worker, even when message/session/query are identical.
  v_result := public.test_claim_call(v_case, v_log, v_message);
  IF v_result->>'status' <> 'begun' OR v_result->>'recovered' <> 'true' OR
    (v_result->>'fence')::bigint <> 1 THEN
    RAISE EXCEPTION 'same-attempt lost response could not recover: %', v_result;
  END IF;
  v_result := public.test_claim_call(v_case, gen_random_uuid(), v_message);
  IF v_result->>'status' <> 'turn_in_progress' OR
    v_result->>'log_id' <> v_log::text THEN
    RAISE EXCEPTION 'competing duplicate was allowed to work: %', v_result;
  END IF;
  v_result := public.test_claim_call(v_case, gen_random_uuid(), v_message,
    'different-session');
  IF v_result->>'status' <> 'message_conflict' THEN
    RAISE EXCEPTION 'different session reused message ID: %', v_result;
  END IF;
  v_result := public.test_claim_call(v_case, gen_random_uuid(), v_message,
    'atomic-claim-ci', 'different query');
  IF v_result->>'status' <> 'message_conflict' THEN
    RAISE EXCEPTION 'different query reused message ID: %', v_result;
  END IF;
  v_result := public.test_claim_call(v_other, gen_random_uuid(), v_message);
  IF v_result->>'status' <> 'message_conflict' THEN
    RAISE EXCEPTION 'foreign topic reused message ID: %', v_result;
  END IF;
  IF (SELECT count(*) FROM public.chat_request_logs
      WHERE message_id = v_message) <> 1 THEN
    RAISE EXCEPTION 'duplicate attempt inserted another replay log';
  END IF;

  -- Busy/stale/inactive/idle/limit denial must not reserve the message ID.
  v_denied_message := gen_random_uuid()::text;
  v_result := public.test_claim_call(v_case, gen_random_uuid(), v_denied_message);
  IF v_result->>'status' <> 'busy' OR EXISTS (
    SELECT 1 FROM public.chat_request_logs WHERE message_id = v_denied_message
  ) THEN
    RAISE EXCEPTION 'busy denial left an orphan log: %', v_result;
  END IF;
  v_denied_message := gen_random_uuid()::text;
  v_result := public.test_claim_call(v_stale, gen_random_uuid(),
    v_denied_message, 'atomic-claim-ci', 'test request', 1);
  IF v_result->>'status' <> 'stale_version' OR EXISTS (
    SELECT 1 FROM public.chat_request_logs WHERE message_id = v_denied_message
  ) THEN
    RAISE EXCEPTION 'stale denial left an orphan log: %', v_result;
  END IF;
  UPDATE public.chat_v3_conversations SET status = 'superseded'
  WHERE id = (v_inactive->>'topic_id')::uuid;
  v_denied_message := gen_random_uuid()::text;
  v_result := public.test_claim_call(v_inactive, gen_random_uuid(),
    v_denied_message);
  IF v_result->>'status' <> 'inactive' OR EXISTS (
    SELECT 1 FROM public.chat_request_logs WHERE message_id = v_denied_message
  ) THEN
    RAISE EXCEPTION 'inactive denial left an orphan log: %', v_result;
  END IF;
  UPDATE public.chat_v3_conversations
  SET created_at = statement_timestamp() - interval '2 hours',
    expires_at = statement_timestamp() + interval '22 hours',
    idle_expires_at = statement_timestamp() - interval '1 second',
    active_log_id = NULL, active_lease_until = NULL
  WHERE id = (v_idle->>'topic_id')::uuid;
  v_denied_message := gen_random_uuid()::text;
  v_result := public.test_claim_call(v_idle, gen_random_uuid(),
    v_denied_message);
  IF v_result->>'status' <> 'inactive' OR EXISTS (
    SELECT 1 FROM public.chat_request_logs WHERE message_id = v_denied_message
  ) THEN
    RAISE EXCEPTION 'idle-expired denial left an orphan log: %', v_result;
  END IF;
  UPDATE public.chat_v3_conversations SET turn_count = 1000000000
  WHERE id = (v_limit->>'topic_id')::uuid;
  v_denied_message := gen_random_uuid()::text;
  v_result := public.test_claim_call(v_limit, gen_random_uuid(),
    v_denied_message);
  IF v_result->>'status' <> 'turn_limit' OR EXISTS (
    SELECT 1 FROM public.chat_request_logs WHERE message_id = v_denied_message
  ) THEN
    RAISE EXCEPTION 'limit denial left an orphan log: %', v_result;
  END IF;
  v_denied_message := gen_random_uuid()::text;
  v_result := public.test_claim_call(v_stale, gen_random_uuid(),
    v_denied_message, 'atomic-claim-ci', 'test request', 0);
  IF v_result->>'status' <> 'begun' THEN
    RAISE EXCEPTION 'denied message ID could not be retried: %', v_result;
  END IF;

  -- An expired owner is fenced off and its replay log becomes terminal in
  -- the same new-claim transaction; it must not strand an in_progress row.
  v_result := public.test_claim_call(v_lease, v_lease_log, v_lease_message);
  IF v_result->>'status' <> 'begun' THEN
    RAISE EXCEPTION 'lease setup failed: %', v_result;
  END IF;
  UPDATE public.chat_v3_conversations
  SET active_lease_until = clock_timestamp() - interval '1 second'
  WHERE id = (v_lease->>'topic_id')::uuid;
  v_result := public.test_claim_call(v_lease, gen_random_uuid(),
    gen_random_uuid()::text);
  IF v_result->>'status' <> 'begun' OR
    (v_result->>'fence')::bigint <> 2 OR NOT EXISTS (
      SELECT 1 FROM public.chat_request_logs l
      JOIN public.chat_v3_conversation_turns t ON t.log_id = l.id
      WHERE l.id = v_lease_log AND l.error = 'request_timeout' AND
        l.response_events->-1 = '{"type":"done"}'::jsonb AND
        t.status = 'abandoned'
    ) THEN
    RAISE EXCEPTION 'expired owner was not fenced/terminalized: %', v_result;
  END IF;
  v_result := public.test_claim_call(v_lease, gen_random_uuid(),
    v_lease_message);
  IF v_result->>'status' <> 'failed' OR
    v_result->>'replayed' <> 'true' OR
    v_result->>'log_id' <> v_lease_log::text OR
    (SELECT count(*) FROM public.chat_request_logs
      WHERE message_id = v_lease_message) <> 1 THEN
    RAISE EXCEPTION 'expired owner replay restarted work: %', v_result;
  END IF;

  -- The finish RPC and claim RPC must agree on terminal replay and version.
  v_events := jsonb_build_array(
    jsonb_build_object('type', 'diagnostic', 'phase', 'complete',
      'log_id', v_log, 'products_count', 0, 'error', NULL),
    jsonb_build_object('type', 'done'));
  v_result := public.finish_chat_v3_conversation_turn(
    v_case->>'digest', v_log, 1, 0, 'success', v_events,
    jsonb_build_object('source_log_id', v_log,
      'topic_id', v_case->>'topic_id', 'selection', NULL),
    '[]'::jsonb, 'finished', 0, 3, NULL);
  IF v_result->>'status' <> 'finalized' THEN
    RAISE EXCEPTION 'claim could not be atomically finished: %', v_result;
  END IF;
  v_result := public.test_claim_call(v_case, gen_random_uuid(), v_message);
  IF v_result->>'status' <> 'finalized' OR
    (v_result->>'version')::bigint <> 1 OR
    v_result->>'log_id' <> v_log::text THEN
    RAISE EXCEPTION 'terminal duplicate restarted work: %', v_result;
  END IF;

  v_result := public.test_claim_call(v_failure,
    v_failure_log, v_failure_message);
  IF v_result->>'status' <> 'begun' THEN
    RAISE EXCEPTION 'failure setup failed: %', v_result;
  END IF;
  v_events := jsonb_build_array(
    jsonb_build_object('type', 'diagnostic', 'phase', 'complete',
      'log_id', v_failure_log, 'products_count', 0,
      'error', 'request_timeout'),
    jsonb_build_object('type', 'done'));
  v_result := public.finish_chat_v3_conversation_turn(
    v_failure->>'digest', v_failure_log, 1, 0, 'failure', v_events,
    NULL, '[]'::jsonb, 'request failed', 0, 5, 'request_timeout');
  IF v_result->>'status' <> 'failed' THEN
    RAISE EXCEPTION 'failure finish setup failed: %', v_result;
  END IF;
  v_result := public.test_claim_call(v_failure, gen_random_uuid(),
    v_failure_message);
  IF v_result->>'status' <> 'failed' OR
    (v_result->>'version')::bigint <> 0 THEN
    RAISE EXCEPTION 'failed duplicate restarted work: %', v_result;
  END IF;
END;
$test$;
RESET ROLE;
SQL

rpc='public.claim_and_begin_chat_v3_conversation_turn(text,uuid,bigint,text,text,text,jsonb)'
grants=$(db_psql -c "SELECT CASE WHEN has_function_privilege('anon', '$rpc', 'EXECUTE') OR has_function_privilege('authenticated', '$rpc', 'EXECUTE') THEN 'unsafe' ELSE 'service-only' END")
if [[ "$grants" != 'service-only' ]]; then
  printf 'Client roles can execute atomic claim+begin.\n' >&2
  exit 1
fi
for role in anon authenticated; do
  if db_psql -c "SET ROLE $role; SELECT public.claim_and_begin_chat_v3_conversation_turn(NULL,NULL,NULL,NULL,NULL,NULL,NULL);" >/dev/null 2>&1; then
    printf '%s unexpectedly executed atomic claim+begin.\n' "$role" >&2
    exit 1
  fi
done

# Inject an exception after the log INSERT and conversation UPDATE, while the
# ledger INSERT runs. PostgreSQL must roll back all three writes together.
fault_case=$(db_psql -F '|' -c "SET ROLE service_role; SELECT c->>'digest', c->>'topic_id', gen_random_uuid()::text, gen_random_uuid()::text FROM (SELECT public.test_claim_case() AS c) q;")
IFS='|' read -r fault_digest fault_topic fault_log fault_message <<<"$fault_case"
db_psql <<SQL
BEGIN;
CREATE FUNCTION public.test_claim_forced_ledger_failure()
RETURNS trigger LANGUAGE plpgsql AS \$test\$
BEGIN
  RAISE EXCEPTION 'injected_claim_ledger_failure';
END;
\$test\$;
CREATE TRIGGER test_claim_forced_ledger_failure
BEFORE INSERT ON public.chat_v3_conversation_turns
FOR EACH ROW EXECUTE FUNCTION public.test_claim_forced_ledger_failure();
SET LOCAL ROLE service_role;
DO \$test\$
DECLARE
  v_case jsonb := jsonb_build_object('digest', '$fault_digest',
    'topic_id', '$fault_topic');
BEGIN
  BEGIN
    PERFORM public.test_claim_call(v_case, '$fault_log'::uuid,
      '$fault_message');
    RAISE EXCEPTION 'expected_claim_failure_missing';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'injected_claim_ledger_failure' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.chat_request_logs
      WHERE id = '$fault_log'::uuid OR message_id = '$fault_message') OR
    EXISTS (SELECT 1 FROM public.chat_v3_conversation_turns
      WHERE log_id = '$fault_log'::uuid) OR
    NOT EXISTS (SELECT 1 FROM public.chat_v3_conversations
      WHERE id = '$fault_topic'::uuid AND fence = 0 AND turn_count = 0 AND
        active_log_id IS NULL) THEN
    RAISE EXCEPTION 'forced ledger failure left a partial claim';
  END IF;
END;
\$test\$;
ROLLBACK;
SQL
retry_result=$(db_psql -c "SET ROLE service_role; SELECT public.test_claim_call(jsonb_build_object('digest', '$fault_digest', 'topic_id', '$fault_topic'), '$fault_log'::uuid, '$fault_message')->>'status';")
if [[ "$retry_result" != 'begun' ]]; then
  printf 'Fault rollback left message ID unavailable: %s\n' "$retry_result" >&2
  exit 1
fi

# Two independent connections race on one message. The second must wait for
# the first transaction's conversation lock, then observe its claim. It must
# not receive a recovered begin because it has a different server log ID.
race_case=$(db_psql -F '|' -c "SET ROLE service_role; SELECT c->>'digest', c->>'topic_id', gen_random_uuid()::text FROM (SELECT public.test_claim_case() AS c) q;")
IFS='|' read -r race_digest race_topic race_message <<<"$race_case"
scratch_dir=$(mktemp -d "${TMPDIR:-/tmp}/atomic-claim-ci.XXXXXXXX")
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
SELECT public.test_claim_call(
  jsonb_build_object('digest', '$race_digest', 'topic_id', '$race_topic'),
  gen_random_uuid(), '$race_message')->>'status';
\! touch "$scratch_dir/lock-held"
SELECT pg_sleep(2);
COMMIT;
SQL
) >"$scratch_dir/first.out" 2>"$scratch_dir/first.err" &
first_pid=$!
for ((attempt = 0; attempt < 100; attempt++)); do
  [[ -f "$scratch_dir/lock-held" ]] && break
  if ! kill -0 "$first_pid" 2>/dev/null; then
    printf 'First claim failed before holding the conversation lock.\n' >&2
    sed -n '1,100p' "$scratch_dir/first.err" >&2
    exit 1
  fi
  sleep 0.05
done
if [[ ! -f "$scratch_dir/lock-held" ]]; then
  printf 'Timed out waiting for first claim lock.\n' >&2
  exit 1
fi
second_result=$(db_psql -c "SET ROLE service_role; SELECT public.test_claim_call(jsonb_build_object('digest', '$race_digest', 'topic_id', '$race_topic'), gen_random_uuid(), '$race_message')->>'status';")
wait "$first_pid"
first_pid=''
if ! grep -qx 'begun' "$scratch_dir/first.out" ||
  [[ "$second_result" != 'turn_in_progress' ]]; then
  printf 'Concurrent claim had more than one owner: %s\n' "$second_result" >&2
  sed -n '1,100p' "$scratch_dir/first.out" >&2
  exit 1
fi
race_rows=$(db_psql -c "SELECT count(*) FROM public.chat_request_logs WHERE message_id = '$race_message';")
race_turns=$(db_psql -c "SELECT count(*) FROM public.chat_v3_conversation_turns WHERE conversation_id = '$race_topic'::uuid;")
if [[ "$race_rows" != '1' || "$race_turns" != '1' ]]; then
  printf 'Concurrent claim wrote %s logs and %s turns (expected 1 each).\n' \
    "$race_rows" "$race_turns" >&2
  exit 1
fi
printf 'Atomic claim+begin: denial, isolation, replay, rollback and race checks passed.\n'
