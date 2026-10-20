#!/usr/bin/env bash
set -euo pipefail

# CI-only: hard-coded disposable PostgreSQL 16 on localhost. Never accepts a
# project URL, Supabase key, database password, or production connection.
db_psql() {
  psql -X -h 127.0.0.1 -p 5432 -U postgres -d admission_ci \
    -v ON_ERROR_STOP=1 -qAt "$@"
}

scratch_dir=$(mktemp -d "${TMPDIR:-/tmp}/public-admission-ci.XXXXXXXX")
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

chat_id=$(db_psql -c 'SELECT gen_random_uuid();')
search_id=$(db_psql -c 'SELECT gen_random_uuid();')
v1_id=$(db_psql -c 'SELECT gen_random_uuid();')
v3_id=$(db_psql -c 'SELECT gen_random_uuid();')
replay_id=$(db_psql -c 'SELECT gen_random_uuid();')
reserve_first_id=$(db_psql -c 'SELECT gen_random_uuid();')
release_first_id=$(db_psql -c 'SELECT gen_random_uuid();')

wait_for_lock_marker() {
  local attempt
  for ((attempt = 0; attempt < 100; attempt++)); do
    if [[ -f "$scratch_dir/lock-held" ]]; then return 0; fi
    if ! kill -0 "$a_pid" 2>/dev/null; then
      printf 'First PostgreSQL connection exited before acquiring lock.\n' >&2
      sed -n '1,100p' "$scratch_dir/a.err" >&2
      return 1
    fi
    sleep 0.05
  done
  printf 'Timed out waiting for the first PostgreSQL connection.\n' >&2
  sed -n '1,100p' "$scratch_dir/a.err" >&2
  return 1
}

race() {
  local first_id=$1 first_route=$2 first_lanes=$3
  local second_id=$4 second_route=$5 second_lanes=$6
  local model_limit=$7 catalog_limit=$8 expected=$9 second_result
  rm -f "$scratch_dir/lock-held"
  (
    db_psql <<SQL
BEGIN;
SET LOCAL ROLE service_role;
SELECT public.reserve_public_api_admission(
  '$first_id'::uuid, '$first_route', 'enforce', '$first_lanes'::text[],
  $model_limit, 1, $catalog_limit, 1
)->>'allowed';
\! touch "$scratch_dir/lock-held"
SELECT pg_sleep(2);
COMMIT;
SQL
  ) >"$scratch_dir/a.out" 2>"$scratch_dir/a.err" &
  a_pid=$!
  wait_for_lock_marker
  second_result=$(db_psql <<SQL
SET ROLE service_role;
SELECT (decision->>'allowed') || '|' || (decision->>'reason') || '|' ||
  (decision->>'replayed') || '|' || coalesce(decision->>'limit_reason', '-')
FROM (
  SELECT public.reserve_public_api_admission(
    '$second_id'::uuid, '$second_route', 'enforce', '$second_lanes'::text[],
    $model_limit, 1, $catalog_limit, 1
  ) AS decision
) AS result;
SQL
)
  if ! wait "$a_pid"; then
    printf 'First PostgreSQL connection failed.\n' >&2
    sed -n '1,100p' "$scratch_dir/a.err" >&2
    return 1
  fi
  a_pid=''
  if ! grep -qx 'true' "$scratch_dir/a.out"; then
    printf 'First reservation was not admitted.\n' >&2
    sed -n '1,100p' "$scratch_dir/a.out" >&2
    return 1
  fi
  if [[ "$second_result" != "$expected" ]]; then
    printf 'Unexpected concurrent decision: %s (expected %s)\n' \
      "$second_result" "$expected" >&2
    return 1
  fi
}

# Chat and direct catalog search share a single catalog lane. The second
# request must see the first request's committed minute and in-flight usage.
race "$chat_id" 'chat-consultant-v2' '{catalog,model}' \
  "$search_id" 'search-products' '{catalog}' 10 1 \
  'false|limit_exceeded|false|minute_and_in_flight_limit'
if [[ $(db_psql -c "SELECT admitted_count FROM public.public_api_admission_buckets WHERE mode = 'enforce' AND lane = 'catalog';") != '1' ]]; then
  printf 'Concurrent catalog search oversubscribed shared lane.\n' >&2
  exit 1
fi
if [[ $(db_psql -c "SELECT extract(epoch FROM reservation_expires_at - created_at)::integer FROM public.public_api_admission_reservations WHERE reservation_id = '$chat_id'::uuid;") != '450' ]]; then
  printf 'Reservation expiry must exceed the hosted Edge worker lifetime.\n' >&2
  exit 1
fi
if [[ $(db_psql -c "SELECT count(*) FROM public.public_api_admission_reservations WHERE reservation_id = '$search_id'::uuid;") != '0' ]]; then
  printf 'A denied request created an unbounded reservation row.\n' >&2
  exit 1
fi
denied_burst=$(db_psql -c "SET ROLE service_role; SELECT count(*) FROM (SELECT public.reserve_public_api_admission(gen_random_uuid(), 'search-products', 'enforce', ARRAY['catalog'], NULL, NULL, 10, 1) AS decision FROM generate_series(1, 200)) AS attempts WHERE decision->>'allowed' = 'false';")
if [[ "$denied_burst" != '200' ]]; then
  printf 'Denial burst unexpectedly admitted catalog work: %s\n' "$denied_burst" >&2
  exit 1
fi
if [[ $(db_psql -c "SELECT count(*) FROM public.public_api_admission_reservations WHERE NOT allowed;") != '0' ]]; then
  printf 'Denial burst persisted refusal rows.\n' >&2
  exit 1
fi
if [[ $(db_psql -c "SELECT admitted_count FROM public.public_api_admission_buckets WHERE mode = 'enforce' AND lane = 'catalog';") != '1' ]]; then
  printf 'Denial burst altered the admitted catalog counter.\n' >&2
  exit 1
fi
if [[ $(db_psql -c "SET ROLE service_role; SELECT public.release_public_api_admission('$chat_id'::uuid);") != 't' ]]; then
  printf 'Failed to release chat reservation.\n' >&2
  exit 1
fi
if [[ $(db_psql -c "SET ROLE service_role; SELECT public.release_public_api_admission('$chat_id'::uuid);") != 't' ]]; then
  printf 'Repeated release was not idempotent.\n' >&2
  exit 1
fi
db_psql -c "UPDATE public.public_api_admission_buckets SET window_started_at = clock_timestamp(), admitted_count = 0 WHERE mode = 'enforce';"

# Distinct v1 and v3 routes share model capacity even though their existing
# route-specific guards are independent. Catalog budget is intentionally high.
race "$v1_id" 'chat-consultant' '{catalog,model}' \
  "$v3_id" 'chat-consultant-v3' '{catalog,model}' 1 10 \
  'false|limit_exceeded|false|minute_and_in_flight_limit'
db_psql -c "SET ROLE service_role; SELECT public.release_public_api_admission('$v1_id'::uuid);" >/dev/null
db_psql -c "UPDATE public.public_api_admission_buckets SET window_started_at = clock_timestamp(), admitted_count = 0 WHERE mode = 'enforce';"

# Two concurrent requests carrying the same *server-generated* UUID replay
# one committed decision without charging the buckets twice.
race "$replay_id" 'chat-consultant-v3' '{catalog,model}' \
  "$replay_id" 'chat-consultant-v3' '{catalog,model}' 1 1 \
  'true|admitted|true|-'
if [[ $(db_psql -c "SELECT count(*) FROM public.public_api_admission_reservations WHERE reservation_id = '$replay_id'::uuid;") != '1' ]]; then
  printf 'Concurrent replay inserted more than one reservation.\n' >&2
  exit 1
fi

# Reserve wins the advisory lock, but its transaction has not committed when
# release arrives. Release waits, then marks the committed reservation closed.
db_psql -c "SET ROLE service_role; SELECT public.release_public_api_admission('$replay_id'::uuid);" >/dev/null
db_psql -c "UPDATE public.public_api_admission_buckets SET window_started_at = clock_timestamp(), admitted_count = 0 WHERE mode = 'enforce';"
rm -f "$scratch_dir/lock-held"
(
  db_psql <<SQL
BEGIN;
SET LOCAL ROLE service_role;
SELECT public.reserve_public_api_admission(
  '$reserve_first_id'::uuid, 'search-products', 'enforce',
  ARRAY['catalog'], NULL, NULL, 10, 1
)->>'allowed';
\! touch "$scratch_dir/lock-held"
SELECT pg_sleep(2);
COMMIT;
SQL
) >"$scratch_dir/a.out" 2>"$scratch_dir/a.err" &
a_pid=$!
wait_for_lock_marker
if [[ $(db_psql -c "SET ROLE service_role; SELECT public.release_public_api_admission('$reserve_first_id'::uuid);") != 't' ]]; then
  printf 'Release-after-reserve failed.\n' >&2
  exit 1
fi
if ! wait "$a_pid"; then
  sed -n '1,100p' "$scratch_dir/a.err" >&2
  exit 1
fi
a_pid=''
if [[ $(db_psql -c "SELECT count(*) FROM public.public_api_admission_reservations WHERE reservation_id = '$reserve_first_id'::uuid AND released_at IS NOT NULL;") != '1' ]]; then
  printf 'Release-after-reserve left a ghost in-flight slot.\n' >&2
  exit 1
fi

# Release wins before the delayed reserve even starts its database transaction.
# Its UUID-only tombstone must block the late reserve without changing counters.
db_psql -c "UPDATE public.public_api_admission_buckets SET window_started_at = clock_timestamp(), admitted_count = 0 WHERE mode = 'enforce';"
rm -f "$scratch_dir/lock-held"
(
  db_psql <<SQL
BEGIN;
SET LOCAL ROLE service_role;
SELECT public.release_public_api_admission('$release_first_id'::uuid);
\! touch "$scratch_dir/lock-held"
SELECT pg_sleep(2);
COMMIT;
SQL
) >"$scratch_dir/a.out" 2>"$scratch_dir/a.err" &
a_pid=$!
wait_for_lock_marker
late_result=$(db_psql <<SQL
SET ROLE service_role;
SELECT (decision->>'allowed') || '|' || (decision->>'reason') || '|' ||
  (decision->>'replayed')
FROM (
  SELECT public.reserve_public_api_admission(
    '$release_first_id'::uuid, 'search-products', 'enforce',
    ARRAY['catalog'], NULL, NULL, 1, 1
  ) AS decision
) AS result;
SQL
)
if ! wait "$a_pid"; then
  sed -n '1,100p' "$scratch_dir/a.err" >&2
  exit 1
fi
a_pid=''
if [[ "$late_result" != 'false|cancelled|true' ]]; then
  printf 'Release-before-reserve did not cancel late admission: %s\n' "$late_result" >&2
  exit 1
fi
if [[ $(db_psql -c "SELECT admitted_count FROM public.public_api_admission_buckets WHERE mode = 'enforce' AND lane = 'catalog';") != '0' ]]; then
  printf 'Cancelled late reserve charged the catalog bucket.\n' >&2
  exit 1
fi
if [[ $(db_psql -c "SELECT count(*) FROM public.public_api_admission_reservations WHERE reservation_id = '$release_first_id'::uuid;") != '0' ]]; then
  printf 'Cancelled late reserve created a reservation.\n' >&2
  exit 1
fi
if [[ $(db_psql -c "SELECT extract(epoch FROM expires_at - created_at)::integer FROM public.public_api_admission_cancellations WHERE reservation_id = '$release_first_id'::uuid;") != '86400' ]]; then
  printf 'Cancellation tombstone retention is not bounded to 24 hours.\n' >&2
  exit 1
fi
if [[ $(db_psql -c "SET ROLE service_role; SELECT public.reserve_public_api_admission('$release_first_id'::uuid, 'search-products', 'enforce', ARRAY['catalog'], NULL, NULL, 1, 1)->>'reason';") != 'cancelled' ]]; then
  printf 'Cancelled reservation replay was not idempotent.\n' >&2
  exit 1
fi

# An unauthenticated caller cannot read budget state or execute either RPC.
if db_psql -c "SET ROLE anon; SELECT count(*) FROM public.public_api_admission_reservations;" >"$scratch_dir/a.out" 2>"$scratch_dir/a.err"; then
  printf 'anon could read admission ledger.\n' >&2
  exit 1
fi
if db_psql -c "SET ROLE anon; SELECT count(*) FROM public.public_api_admission_cancellations;" >"$scratch_dir/a.out" 2>"$scratch_dir/a.err"; then
  printf 'anon could read cancellation tombstones.\n' >&2
  exit 1
fi
if db_psql -c "SET ROLE anon; SELECT public.reserve_public_api_admission(gen_random_uuid(), 'search-products', 'enforce', ARRAY['catalog'], NULL, NULL, 1, 1);" >"$scratch_dir/a.out" 2>"$scratch_dir/a.err"; then
  printf 'anon could reserve public budget.\n' >&2
  exit 1
fi
if db_psql -c "SET ROLE anon; SELECT public.release_public_api_admission('$replay_id'::uuid);" >"$scratch_dir/a.out" 2>"$scratch_dir/a.err"; then
  printf 'anon could release public budget.\n' >&2
  exit 1
fi

printf 'Shared public admission races, replay, release and anon denial passed.\n'
