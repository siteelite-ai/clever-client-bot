#!/usr/bin/env bash
set -euo pipefail

# Disposable PostgreSQL 16 ONLY. The CI service has inert fixture strings;
# never point this script at a live Supabase database.
qa_psql=(psql -X -h 127.0.0.1 -p 5432 -U postgres -v ON_ERROR_STOP=1)
qa_migration='supabase/migrations/20261022060000_admin_integration_secrets.sql'
qa_cutover='docs/security/integration-secrets-cutover-MANUAL.sql'
qa_acl_commit='96d69abf926718a39e63ea16d10478204efbd430'
qa_acl_path='supabase/migrations/20261020230000_app_settings_least_privilege.sql'
qa_acl_blob='459d1776d495618373103c6cb7bdf463a7cd1c25'

create_fixture_db() {
  local qa_name="$1"
  "${qa_psql[@]}" -d postgres -c "CREATE DATABASE \"${qa_name}\"" >/dev/null
  "${qa_psql[@]}" -d "$qa_name" -f "$qa_migration" >/dev/null
}

create_fixture_db integration_cutover_positive
"${qa_psql[@]}" -d integration_cutover_positive \
  -f docs/security/integration-secrets-cutover-local-test.sql >/dev/null

create_fixture_db integration_cutover_optional_absent
"${qa_psql[@]}" -d integration_cutover_optional_absent \
  -f docs/security/integration-secrets-cutover-optional-absent-test.sql >/dev/null

# The #122 migration is a separate draft PR, not a file in the #125 tree.
# Test its immutable real bytes, never an independently copied fixture.
if ! git cat-file -e "${qa_acl_commit}^{commit}" 2>/dev/null; then
  echo 'Pinned #122 ACL commit is unavailable; fail closed.' >&2
  exit 1
fi
qa_actual_blob=$(git rev-parse "${qa_acl_commit}:${qa_acl_path}" 2>/dev/null) || {
  echo 'Pinned #122 ACL migration is unavailable; fail closed.' >&2
  exit 1
}
if [[ "$qa_actual_blob" != "$qa_acl_blob" ]]; then
  echo 'Pinned #122 ACL migration blob changed; fail closed.' >&2
  exit 1
fi

qa_joint_db='integration_cutover_joint_acl'
"${qa_psql[@]}" -d postgres -c "CREATE DATABASE \"${qa_joint_db}\"" >/dev/null
"${qa_psql[@]}" -d "$qa_joint_db" \
  -f docs/security/integration-secrets-joint-acl-fixture.sql >/dev/null
git show "${qa_acl_commit}:${qa_acl_path}" | \
  "${qa_psql[@]}" -d "$qa_joint_db" >/dev/null
"${qa_psql[@]}" -d "$qa_joint_db" -f "$qa_migration" >/dev/null
"${qa_psql[@]}" -d "$qa_joint_db" \
  -f docs/security/integration-secrets-joint-acl-test.sql >/dev/null

qa_cases=(
  required-private-missing
  required-private-mismatch
  optional-private-missing
  optional-private-mismatch
  optional-private-only
  required-legacy-missing
  zero-settings
  two-settings
)

for qa_index in "${!qa_cases[@]}"; do
  qa_case="${qa_cases[$qa_index]}"
  qa_db="integration_cutover_negative_${qa_index}"
  create_fixture_db "$qa_db"
  "${qa_psql[@]}" -d "$qa_db" \
    -f docs/security/integration-secrets-cutover-disposable-schema.sql >/dev/null
  "${qa_psql[@]}" -d "$qa_db" -v "cutover_case=$qa_case" \
    -f docs/security/integration-secrets-cutover-negative-case.sql >/dev/null

  if qa_output=$("${qa_psql[@]}" -d "$qa_db" -f "$qa_cutover" 2>&1); then
    echo "Cutover unexpectedly succeeded for case: $qa_case" >&2
    exit 1
  fi
  case "$qa_case" in
    required-private-missing|required-private-mismatch)
      qa_expected='Cutover refused: required private credentials do not match' ;;
    optional-private-missing|optional-private-mismatch)
      qa_expected='Cutover refused: optional private credential does not match' ;;
    optional-private-only)
      qa_expected='Cutover refused: optional credential presence differs' ;;
    required-legacy-missing)
      qa_expected='Cutover refused: required legacy credentials are absent' ;;
    zero-settings|two-settings)
      qa_expected='Cutover refused: app_settings must contain exactly one row' ;;
  esac
  if [[ "$qa_output" != *"$qa_expected"* ]]; then
    echo "Cutover failed for the wrong reason in case: $qa_case" >&2
    exit 1
  fi

  "${qa_psql[@]}" -d "$qa_db" -v "cutover_case=$qa_case" \
    -f docs/security/integration-secrets-cutover-failure-assert.sql >/dev/null
done

echo 'Integration-secret cutover: 3 positive (including pinned #122 ACL) and 8 fail-closed cases passed.'
