#!/usr/bin/env bash
set -euo pipefail

# CI-only disposable PostgreSQL 16. Do not add project URL/secret parameters.
db_psql() {
  psql -X -h 127.0.0.1 -p 5432 -U postgres -d admission_ci \
    -v ON_ERROR_STOP=1 -qAt "$@"
}

scratch_dir=$(mktemp -d "${TMPDIR:-/tmp}/public-subject-admission-ci.XXXXXXXX")
first_pid=''
cleanup() {
  if [[ -n "$first_pid" ]] && kill -0 "$first_pid" 2>/dev/null; then
    kill "$first_pid" 2>/dev/null || true
    wait "$first_pid" 2>/dev/null || true
  fi
  rm -f "$scratch_dir/first.out" "$scratch_dir/first.err" \
    "$scratch_dir/lock-held" "$scratch_dir/denied.out" \
    "$scratch_dir/denied.err"
  rmdir "$scratch_dir"
}
trap cleanup EXIT

subject=$(printf '%064d' 9)
first_id=$(db_psql -c 'SELECT gen_random_uuid();')
second_id=$(db_psql -c 'SELECT gen_random_uuid();')

# The first connection holds an uncommitted reservation while the second
# enters a different public route. One shared subject bucket must serialize
# both operations: the search cannot consume an extra slot.
(
  db_psql <<SQL
BEGIN;
SET LOCAL ROLE service_role;
SELECT public.reserve_public_subject_admission(
  '$subject', 'chat-consultant-v2', '$first_id'::uuid,
  'enforce', 60, 1, 1
)->>'allowed';
\! touch "$scratch_dir/lock-held"
SELECT pg_sleep(2);
COMMIT;
SQL
) >"$scratch_dir/first.out" 2>"$scratch_dir/first.err" &
first_pid=$!

for ((attempt = 0; attempt < 100; attempt++)); do
  if [[ -f "$scratch_dir/lock-held" ]]; then break; fi
  if ! kill -0 "$first_pid" 2>/dev/null; then
    printf 'First database connection ended before holding its lock.\n' >&2
    sed -n '1,100p' "$scratch_dir/first.err" >&2
    exit 1
  fi
  sleep 0.05
done
if [[ ! -f "$scratch_dir/lock-held" ]]; then
  printf 'Timed out waiting for first database lock.\n' >&2
  exit 1
fi

second_decision=$(db_psql -c "SET ROLE service_role; SELECT (decision->>'allowed') || '|' || (decision->>'reason') FROM (SELECT public.reserve_public_subject_admission('$subject', 'search-products', '$second_id'::uuid, 'enforce', 60, 1, 1) AS decision) result;")
if ! wait "$first_pid"; then
  printf 'First database connection failed.\n' >&2
  sed -n '1,100p' "$scratch_dir/first.err" >&2
  exit 1
fi
first_pid=''
if ! grep -qx 'true' "$scratch_dir/first.out"; then
  printf 'First reservation was not admitted.\n' >&2
  exit 1
fi
if [[ "$second_decision" != 'false|limit_exceeded' ]]; then
  printf 'Different public route oversubscribed the same subject: %s\n' "$second_decision" >&2
  exit 1
fi
if [[ $(db_psql -c "SELECT admitted_count FROM public.public_subject_admission_buckets WHERE subject_hash = '$subject';") != '1' ]]; then
  printf 'Subject bucket count not atomic across public routes.\n' >&2
  exit 1
fi
if [[ $(db_psql -c "SELECT count(*) FROM public.public_subject_admission_reservations WHERE reservation_id = '$second_id'::uuid;") != '0' ]]; then
  printf 'Rejected request persisted an unbounded reservation row.\n' >&2
  exit 1
fi

# A burst of denials must not create one database row per public attempt.
denied_count=$(db_psql -c "SET ROLE service_role; SELECT count(*) FROM (SELECT public.reserve_public_subject_admission('$subject', 'chat-consultant-v3', gen_random_uuid(), 'enforce', 60, 1, 1) AS decision FROM generate_series(1, 100)) attempts WHERE decision->>'allowed' = 'false';")
if [[ "$denied_count" != '100' ]]; then
  printf 'Denial burst unexpectedly admitted work: %s\n' "$denied_count" >&2
  exit 1
fi
if [[ $(db_psql -c "SELECT count(*) FROM public.public_subject_admission_reservations WHERE subject_hash = '$subject';") != '1' ]]; then
  printf 'Denial burst persisted refused reservation rows.\n' >&2
  exit 1
fi

# Neither anonymous nor authenticated users may invoke either RPC, even if
# they can guess the public function name or an HMAC digest.
if db_psql -c "SET ROLE anon; SELECT public.reserve_public_subject_admission('$subject', 'search-products', gen_random_uuid(), 'enforce', 60, 1, 1);" >"$scratch_dir/denied.out" 2>"$scratch_dir/denied.err"; then
  printf 'Anonymous caller executed protected reserve RPC.\n' >&2
  exit 1
fi
if db_psql -c "SET ROLE authenticated; SELECT public.release_public_subject_admission('$first_id'::uuid);" >"$scratch_dir/denied.out" 2>"$scratch_dir/denied.err"; then
  printf 'Authenticated caller executed protected release RPC.\n' >&2
  exit 1
fi

printf 'PASS: cross-route subject bucket, concurrency, bounded denial, grants.\n'
