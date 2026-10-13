#!/usr/bin/env bash
set -euo pipefail

# This test deliberately uses only the disposable PostgreSQL service started
# by the CI workflow. It never accepts a remote database URL or credentials.
db_psql() {
  psql -X -h 127.0.0.1 -p 5432 -U postgres -d admission_ci \
    -v ON_ERROR_STOP=1 -qAt "$@"
}

scratch_dir=$(mktemp -d "${TMPDIR:-/tmp}/chat-admission-ci.XXXXXXXX")
a_pid=''
cleanup() {
  if [[ -n "$a_pid" ]] && kill -0 "$a_pid" 2>/dev/null; then
    kill "$a_pid" 2>/dev/null || true
    wait "$a_pid" 2>/dev/null || true
  fi
  rm -f "$scratch_dir/a.out" "$scratch_dir/a.err" "$scratch_dir/lock-held"
  rmdir "$scratch_dir"
}
trap cleanup EXIT

first_log=$(db_psql -c 'SELECT gen_random_uuid();')
second_log=$(db_psql -c 'SELECT gen_random_uuid();')
replay_log=$(db_psql -c 'SELECT gen_random_uuid();')

db_psql -c "
  INSERT INTO public.chat_request_logs
    (id, message_id, session_id, user_query, pipeline, branch, error)
  VALUES
    ('$first_log', 'ci-concurrent-first-$first_log', 'admission-ci', 'first',
      'v3', 'v3_expert', 'in_progress'),
    ('$second_log', 'ci-concurrent-second-$second_log', 'admission-ci', 'second',
      'v3', 'v3_expert', 'in_progress'),
    ('$replay_log', 'ci-concurrent-replay-$replay_log', 'admission-ci', 'replay',
      'v3', 'v3_expert', 'in_progress');
  UPDATE public.chat_v3_admission_buckets
    SET window_started_at = clock_timestamp(), admitted_count = 0
    WHERE mode = 'enforce';
"

wait_for_lock_marker() {
  local attempt
  for ((attempt = 0; attempt < 100; attempt++)); do
    if [[ -f "$scratch_dir/lock-held" ]]; then
      return 0
    fi
    if ! kill -0 "$a_pid" 2>/dev/null; then
      printf 'First PostgreSQL connection exited before acquiring the lock.\n' >&2
      sed -n '1,100p' "$scratch_dir/a.err" >&2
      return 1
    fi
    sleep 0.05
  done
  printf 'Timed out waiting for the first PostgreSQL connection.\n' >&2
  sed -n '1,100p' "$scratch_dir/a.err" >&2
  return 1
}

run_race() {
  local first_claim=$1
  local second_claim=$2
  local expected_second=$3
  local second_result

  rm -f "$scratch_dir/lock-held"

  (
    db_psql <<SQL
BEGIN;
SET LOCAL ROLE service_role;
SELECT public.check_chat_v3_admission('$first_claim'::uuid,
  'enforce', 1, 1)->>'allowed';
\! touch "$scratch_dir/lock-held"
SELECT pg_sleep(4);
COMMIT;
SQL
  ) >"$scratch_dir/a.out" 2>"$scratch_dir/a.err" &
  a_pid=$!

  wait_for_lock_marker

  second_result=$(db_psql <<SQL
SET ROLE service_role;
SELECT (result->>'allowed') || '|' || (result->>'reason') || '|' ||
  (result->>'replayed') || '|' || coalesce(result->>'limit_reason', '-')
FROM (
  SELECT public.check_chat_v3_admission('$second_claim'::uuid,
    'enforce', 1, 1) AS result
) AS decision;
SQL
)

  if ! wait "$a_pid"; then
    printf 'First PostgreSQL connection failed.\n' >&2
    sed -n '1,100p' "$scratch_dir/a.err" >&2
    return 1
  fi
  a_pid=''

  if ! grep -qx 'true' "$scratch_dir/a.out"; then
    printf 'First claim was not admitted.\n' >&2
    sed -n '1,100p' "$scratch_dir/a.out" >&2
    return 1
  fi
  if [[ "$second_result" != "$expected_second" ]]; then
    printf 'Unexpected second claim: %s (expected %s)\n' \
      "$second_result" "$expected_second" >&2
    return 1
  fi
  if [[ $(db_psql -c "SELECT admitted_count FROM public.chat_v3_admission_buckets WHERE mode = 'enforce';") != '1' ]]; then
    printf 'A concurrent request charged the enforce bucket twice.\n' >&2
    return 1
  fi
}

# Separate claims must serialize on the bucket row: one is admitted and the
# other sees both the minute and in-flight limits after the first commits.
run_race "$first_log" "$second_log" \
  'false|limit_exceeded|false|minute_and_in_flight_limit'

if [[ $(db_psql -c "SET ROLE service_role; SELECT public.release_chat_v3_admission('$first_log'::uuid);") != 't' ]]; then
  printf 'Failed to release the first reservation.\n' >&2
  exit 1
fi
db_psql -c "
  UPDATE public.chat_v3_admission_buckets
    SET window_started_at = clock_timestamp(), admitted_count = 0
    WHERE mode = 'enforce';
"

# The second connection racing on the same log_id must replay the first
# decision after its row lock releases, without charging a second slot.
run_race "$replay_log" "$replay_log" 'true|admitted|true|-'

if [[ $(db_psql -c "SELECT count(*) FROM public.chat_v3_admission_decisions WHERE log_id = '$replay_log'::uuid;") != '1' ]]; then
  printf 'Concurrent replay created more than one decision.\n' >&2
  exit 1
fi

printf 'Admission guard two-connection races passed.\n'
