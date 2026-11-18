#!/usr/bin/env bash
set -euo pipefail

# Only the fixed disposable GitHub Actions PostgreSQL service is supported.
# Do not accept connection URLs, remote hosts or production credentials.
if [[ "${GITHUB_ACTIONS:-}" != 'true' ]]; then
  printf 'This migration rehearsal runs only in disposable GitHub Actions CI.\n' >&2
  exit 2
fi
db_psql() {
  psql -X -h 127.0.0.1 -p 5432 -U postgres -d conversation_ci \
    -v ON_ERROR_STOP=1 "$@"
}

if [[ "$(db_psql -qAt -c "SELECT CASE WHEN current_database() = 'conversation_ci' AND to_regclass('public.chat_request_logs') IS NULL THEN 'empty-disposable' ELSE 'unsafe-target' END")" != 'empty-disposable' ]]; then
  printf 'Refusing to apply migrations to a nonempty or unexpected database.\n' >&2
  exit 2
fi

db_psql -f scripts/qa/chat-v3-conversation-state-relevant-bootstrap.sql
db_psql -f supabase/migrations/20260507081101_30c91ff9-9f7a-4048-b5bb-a3f62497ee17.sql
db_psql -f supabase/migrations/20260903120000_chat_request_idempotency.sql

# The upstream Supabase project supplies default service_role grants. This
# disposable plain PostgreSQL service does not; bridge only that difference.
db_psql -c 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_request_logs TO service_role;'
db_psql -c "INSERT INTO public.chat_request_logs (message_id, pipeline, error) VALUES ('pre-migration-v3-log', 'v3', 'in_progress');"

db_psql -f supabase/migrations/20261009150000_chat_v3_admission_guard.sql
db_psql -f supabase/migrations/20261020120000_public_api_admission.sql
db_psql -f supabase/migrations/20261020210000_chat_v3_conversation_state.sql
db_psql -f supabase/migrations/20261020210100_chat_v3_claim_binding.sql
db_psql -f supabase/migrations/20261020210200_chat_v3_conversation_rpcs.sql

db_psql -f scripts/qa/chat-v3-conversation-state-relevant-compat.sql
