# Isolated viewer-role smoke test

The accompanying Node tests use only mocked HTTP and local in-memory journal
storage. On 14.10.2026, the exact one-time procedure below also passed against
the isolated server3 loopback gateway: both protected function calls returned
`403`, the viewer could not read the non-empty `app_settings` and admission
control rows, and its own/foreign role checks behaved as expected. The test
viewer and journal were removed; one synthetic administrator remains. This is
not a production procedure or proof of browser/public-routing behavior.

The helper creates only `qa-viewer-20261014@volt220.test` in the
`volt220test` self-hosted Supabase, exercises its default `viewer` role, and
deletes **only the exact UUID confirmed from that create operation**. It uses
the loopback gateway, not either public test host. It must not be pointed at
the existing site, production Supabase, a customer account, or a database with
unexpected Auth users. Keep the public maintenance gate in place until this
and the other release checks pass.

## Preconditions and exact invocation

- Run only after the reviewed isolated migrations and the `admin-users` and
  `knowledge-process` Edge functions are deployed. The test-only `has_role`
  restriction and table-grant hardening must be applied and verified first.
- The isolated Auth store must contain the one known synthetic administrator
  `qa-admin-20261014@volt220.test`, and no other user. The helper checks this
  and its one admin role/profile before creating anything. Its existing
  root-only credential file from the separate bootstrap step must be present;
  this smoke test does not create or change that administrator.
- The isolated `knowledge_entries` table must be empty. A successful
  `knowledge-process` list request can schedule orphan self-healing and paid
  embedding calls if entries exist. The helper checks for an empty table
  before its admin positive-control request and refuses a non-empty KB.
  Before the 14.10.2026 run, `app_settings.openrouter_api_key` was also
  confirmed `NULL`; do not repeat this smoke after installing a paid key
  without independently checking for concurrent knowledge writes.
- The Compose project must be `volt220test`, with `volt220test-db` running
  without a host port and the API gateway bound only to `127.0.0.1:18081`.
  The private `.env` must be the root-owned, mode `0600`, isolated test file.
- Run from a restricted root shell on server3 using the reviewed Git commit.
  Never put API keys, JWTs, passwords, or a credential file's contents in
  command arguments, chat, CI logs, or a public URL. The helper reads only the
  isolated test keys from the private `.env` in memory.

```sh
node /path/to/reviewed/repo/deploy/selfhost/smoke-test-viewer.mjs \
  --gateway http://127.0.0.1:18081 \
  --env /var/lib/volt220-test-supabase/upstream/docker/.env \
  --journal /var/lib/volt220-test-supabase/private/qa-viewer-smoke-20261014.json \
  --admin-credentials /var/lib/volt220-test-supabase/private/qa-admin-20261014.json \
  --project volt220test \
  --db-container volt220test-db \
  --admin-email qa-admin-20261014@volt220.test \
  --viewer-email qa-viewer-20261014@volt220.test \
  --mode selfhost-test \
  --confirm probe-isolated-viewer-and-delete
```

Every flag and value is required literally. The helper refuses other
gateways, project names, identities, paths, or modes and checks the local
Docker/file boundary before network requests. This is a **write-capable**
test, even though its probes are read-only: it temporarily creates and then
deletes a synthetic Auth user. Do not run it during an unrelated Auth change.

## What constitutes a pass

The helper checks the known admin's identity, profile, and single admin role;
uses its existing private password to confirm that `knowledge-process`
`{"action":"list"}` succeeds for an administrator on the empty knowledge
base; uses root credentials only for bounded preflight, creation, and cleanup;
creates a new
viewer with a unique smoke nonce; confirms its exact Auth UUID, email, nonce,
profile, and single `viewer` role; and signs in as that viewer. It then checks
that `admin-users` and `knowledge-process` reject the viewer with HTTP 403.
The viewer may read only its own profile/role; it must not see the admin's
profile/role, protected settings/knowledge/log/admission rows, or another
user's role through `has_role`. A successful run deletes the confirmed viewer
UUID and verifies its absence before removing the root-only journal. Empty
protected-table results are meaningful only where the root preflight first
confirmed a representative row exists; an unexpectedly empty root table is
not proof of RLS.

This is a focused permission smoke test, not a full security audit. In
particular it does not prove public Nginx/TLS/CORS routing, browser behavior,
or all PostgreSQL grants and policies. Keep the migration SQL/grant inspection
and public-gate review as separate release checks.

## Failure, rollback, and manual reconciliation

The journal is reserved before the create request in a root-owned private
directory. It records only the synthetic email and nonce, **not the generated
password, API keys, or session token**. The helper attempts to remove a viewer
only when it has confirmed the UUID/email/nonce created by this run. It never
deletes the administrator, another existing user, or users matched merely by
email. If a post-create assertion fails, the same exact-UUID cleanup is
attempted; a failed delete or unverifiable absence leaves the journal in
place and reports that manual rollback is required.

If create times out or its outcome is otherwise unknown, do not rerun blindly.
The helper may reconcile the isolated Auth list by the exact synthetic email
and journal nonce, but if identity is ambiguous it keeps the journal and
reports `CREATE_OUTCOME_UNKNOWN` without guessing which UUID to delete. An
operator should inspect the Auth Admin API **over the loopback gateway** using
the isolated service credentials, match the journal nonce and email to a
single Auth UUID, inspect its profile/role, and delete only that verified UUID.
Then verify that its Auth, profile, and role records are absent and remove
only this journal file. If identity or deletion cannot be proven, stop and
escalate; do not reset the database, issue a broad DELETE, clear the journal
to force a rerun, or touch production/customer accounts.

For local, offline regression checks from the reviewed repository checkout:

```sh
node --test deploy/selfhost/smoke-test-viewer.test.mjs
```
