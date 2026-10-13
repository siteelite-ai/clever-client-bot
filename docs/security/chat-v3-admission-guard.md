# Chat v3 admission guard: database contract and rollout gate

This is an **optional global emergency cost guard**, not per-user rate limiting.
The public widget has no authenticated user identity. Browser-provided
`sessionId`, `messageId`, `User-Agent`, and forwarded IP headers are not trusted
identities, so none is used as a limiter key. A global cap can protect aggregate
LLM/catalog spend, but an attacker can exhaust it and reject legitimate users.

The additive migration is
[`20261009150000_chat_v3_admission_guard.sql`](../../supabase/migrations/20261009150000_chat_v3_admission_guard.sql)
in a separate security release from the functional widget changes. It is
applied as one transaction and has passed the disposable PostgreSQL 16 SQL,
privilege, and two-connection concurrency checks in
[`chat-v3-admission-postgres.yml`](../../.github/workflows/chat-v3-admission-postgres.yml).
It creates two
new RLS-enabled tables with no client policies and two `SECURITY INVOKER` RPCs.
It does not alter any existing table, policy, log row, or function. `anon` and
`authenticated` have neither table access nor RPC `EXECUTE`; only
`service_role` is granted the required access. The Edge Function must keep the
service-role key server-side.

Production v3 already contains the off-by-default guard. It calls the guard
only after a new log claim and releases an admitted reservation before SSE
completion. With the Edge mode unset/`off`, it performs no admission RPC.
Both preview wrappers force admission off via a server-owned isolate marker;
their provider policy is independent of this admission scope. As of the
13 October 2026 read-only preflight, the migration had not yet been applied
to the shared project. The real database/RPC path still requires an `observe`
rollout before enforcement.

## Call sequence

1. Keep the existing `chat_request_logs` unique-`message_id` claim and replay
   path unchanged. `resumeOnly` and existing-message requests read/replay the
   log and **do not call admission**.
2. Only after the unique log insert returns `created`, call
   `check_chat_v3_admission` with that row's `id`, before paid work. The RPC
   verifies an `in_progress` v3 log with a non-null `message_id`. The existing
   log index owns message-ID uniqueness; the decision is keyed by that log's
   unique ID. Retrying an ambiguous RPC response does not consume a second
   token. No request text, message ID, or browser identity is copied into the
   decision table.
3. If `allowed=false`, emit a bounded unavailable/overload response and
   finalize the existing log. If `allowed=true`, continue the normal pipeline.
   In every terminal path for a newly claimed log, await
   `release_chat_v3_admission` before closing the SSE stream. The release is
   idempotent and a denied/off decision simply returns `false`.

RPC arguments and result:

```text
check_chat_v3_admission(
  p_log_id uuid,
  p_mode text DEFAULT 'off',
  p_limit_per_minute integer DEFAULT NULL,
  p_limit_in_flight integer DEFAULT NULL
) -> jsonb

{ allowed, reason, mode, replayed, would_reject, limit_reason,
  window_count_before, in_flight_before, retry_after_seconds }

release_chat_v3_admission(p_log_id uuid) -> boolean
```

`off` is the database default and writes no admission state. `observe` always
allows but records whether the supplied limits *would* reject. `enforce`
requires **both** positive limits; missing limits return
`allowed=false, reason="configuration_missing"`. No traffic threshold is
assumed by the migration. Limits must be chosen from measured production and
QA concurrency/arrival rates before enforcement, not from preview traffic.
The mode and limits are controlled by server-side Edge configuration, never by
the browser. An unexpected RPC failure should not silently proceed to paid
work in enforce mode.

The one-minute counter is a fixed window, serialized by a row lock. Separate
observe/enforce buckets prevent observation traffic from filling a newly
enabled enforcement window. Active reservations are also checked while holding
that lock. A reservation is released on completion or expires after three
minutes if the worker dies; current v3 accepted work is bounded to about 40
seconds. Expiry prevents permanent lockout but means this is not an absolute
concurrency guarantee if paid work outlives the TTL. Fixed-window boundaries
can allow a short burst approaching twice the per-minute setting. Decisions
become eligible for deletion after 24 hours; a bounded lazy cleanup removes
expired rows from the **new** decision table only when a later admission check
runs. Switching admission off does not itself delete them.

## Shared-project preflight and rollout gate

Preview and production functions use the same Supabase project. Project-level
Edge secrets are shared, but the preview wrappers explicitly keep their
admission mode off. Before applying the migration or switching modes, a
targeted read-only preflight must confirm:

- `chat_request_logs` exists with `id`, `message_id`, `pipeline`, and `error`,
  and the unique partial `message_id` index is present and valid;
- neither new table nor either RPC signature already exists, and the
  migration history has no conflicting version;
- `anon`, `authenticated`, and `service_role` roles exist with expected grants;
- a disposable PostgreSQL database has passed the SQL transaction test in
  [chat-v3-admission-guard-local-test.sql](chat-v3-admission-guard-local-test.sql),
  including a two-connection concurrency check;
- real production/QA request rates, concurrent accepted work, error rates,
  and database RPC latency have been measured to select safe initial limits.

Suggested read-only preflight queries:

```sql
SELECT to_regclass('public.chat_request_logs') AS logs,
       to_regclass('public.chat_v3_admission_buckets') AS bucket_collision,
       to_regclass('public.chat_v3_admission_decisions') AS decision_collision;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'chat_request_logs'
  AND indexname = 'idx_chat_request_logs_message_id';

SELECT p.oid::regprocedure AS collision
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('check_chat_v3_admission', 'release_chat_v3_admission');
```

The 13 October read-only preflight found no colliding admission tables/RPC, a
valid unique message-ID index, the required roles, and service-role log access.
For v3, the trailing seven days contained 375 logged turns, with a peak of 27
in one minute and an estimated peak of three overlapping turns. The last 24
hours contained 100 turns, one terminal error, and a peak of six per minute.
These figures justify only an initial observation threshold, not immediate
enforcement.

After a tested migration, start with `off`; then use `observe` while reviewing
`observed_limit`, RPC latency, release failures, and decision counts. A slow
or failed observation RPC must not turn into a customer-facing connection
error. Before changing the project-wide Edge secret, deploy and verify **both**
preview wrappers and production v3 from this commit. Older preview deployments
do not have the isolate-local admission marker and would otherwise consume the
shared production bucket. Turn on `enforce` only after measured thresholds and
the operational impact of a global cap have been reviewed. In particular,
confirm that observation RPC timeouts and reservation-release failures are
negligible: an RPC that commits after its Edge deadline can temporarily leave
an in-flight reservation until the three-minute expiry. The immediate
non-destructive rollback
is to set the Edge mode to `off` (or deploy the prior Edge version); leave the
new tables and their telemetry intact. A later schema removal would require a
separately reviewed data-retention/export decision and is **not** part of this
migration.
