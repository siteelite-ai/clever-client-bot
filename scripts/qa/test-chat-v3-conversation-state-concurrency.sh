#!/usr/bin/env bash
set -euo pipefail

# CI-only two-connection race against the disposable localhost PostgreSQL 16
# service. Never accepts a remote database URL or production credentials.
db_psql() {
  psql -X -h 127.0.0.1 -p 5432 -U postgres -d conversation_ci \
    -v ON_ERROR_STOP=1 -qAt "$@"
}

scratch_dir=$(mktemp -d "${TMPDIR:-/tmp}/chat-state-ci.XXXXXXXX")
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

digest=$(printf 'd%.0s' {1..64})
topic=$(db_psql <<SQL
SET ROLE service_role;
SELECT public.create_chat_v3_conversation('$digest')->>'topic_id';
SQL
)
first_log=$(db_psql -c 'SELECT gen_random_uuid();')
second_log=$(db_psql -c 'SELECT gen_random_uuid();')
db_psql <<SQL
SET ROLE service_role;
INSERT INTO public.chat_request_logs
  (id, message_id, pipeline, error, chat_v3_topic_id)
VALUES
  ('$first_log'::uuid, 'state-race-first-$first_log', 'v3', 'in_progress', '$topic'::uuid),
  ('$second_log'::uuid, 'state-race-second-$second_log', 'v3', 'in_progress', '$topic'::uuid);
SQL

(
  db_psql <<SQL
BEGIN;
SET LOCAL ROLE service_role;
SELECT public.begin_chat_v3_conversation_turn('$digest', '$first_log'::uuid, 0)->>'status';
\! touch "$scratch_dir/lock-held"
SELECT pg_sleep(3);
COMMIT;
SQL
) >"$scratch_dir/first.out" 2>"$scratch_dir/first.err" &
first_pid=$!

for ((attempt = 0; attempt < 100; attempt++)); do
  [[ -f "$scratch_dir/lock-held" ]] && break
  if ! kill -0 "$first_pid" 2>/dev/null; then
    printf 'First connection failed before acquiring the row lock.\n' >&2
    sed -n '1,100p' "$scratch_dir/first.err" >&2
    exit 1
  fi
  sleep 0.05
done
if [[ ! -f "$scratch_dir/lock-held" ]]; then
  printf 'Timed out waiting for first conversation lock.\n' >&2
  exit 1
fi

second_result=$(db_psql <<SQL
SET ROLE service_role;
SELECT public.begin_chat_v3_conversation_turn('$digest', '$second_log'::uuid, 0)->>'status';
SQL
)
wait "$first_pid"
first_pid=''
if ! grep -qx 'begun' "$scratch_dir/first.out"; then
  printf 'First turn was not uniquely begun.\n' >&2
  sed -n '1,100p' "$scratch_dir/first.out" >&2
  exit 1
fi
if [[ "$second_result" != 'busy' ]]; then
  printf 'Concurrent second turn was not blocked: %s\n' "$second_result" >&2
  exit 1
fi

replay_result=$(db_psql <<SQL
SET ROLE service_role;
SELECT public.begin_chat_v3_conversation_turn('$digest', '$first_log'::uuid, 0)->>'status';
SQL
)
if [[ "$replay_result" != 'turn_in_progress' ]]; then
  printf 'Repeated begin was not replay-only: %s\n' "$replay_result" >&2
  exit 1
fi
ledger_count=$(db_psql -c "SELECT count(*) FROM public.chat_v3_conversation_turns WHERE conversation_id = '$topic'::uuid;")
if [[ "$ledger_count" != '1' ]]; then
  printf 'Race created %s turn ledger rows (expected 1).\n' "$ledger_count" >&2
  exit 1
fi
printf 'Conversation CAS race OK: one begin, second busy, replay non-executable.\n'
