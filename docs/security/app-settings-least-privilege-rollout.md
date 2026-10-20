# `app_settings`: least-privilege rollout

Status: the privilege change was applied directly to the production Supabase
database through SQL Editor at **2026-10-20 21:32:38 UTC** (2026-10-21
00:32:38 Moscow time). The corresponding migration remains in draft PR #122;
it has **not** been merged. The SQL ran in a single `BEGIN`/`COMMIT`
transaction with `lock_timeout = '3s'` and `statement_timeout = '10s'`.
It changed table privileges only: no rows, application code, policies, or
credential values were changed. The disposable PostgreSQL checks also passed.

`public.app_settings` contains catalog and AI-provider credentials. Its existing
RLS policies allow only admins to read and update rows. Before the change, RLS
was enabled and the two policies were admin-only, using
`has_role(auth.uid(), 'admin')`; however, both `anon` and `authenticated` had
all eight table privileges (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`,
`REFERENCES`, `TRIGGER`, `MAINTAIN`). RLS does not protect table-wide
`TRUNCATE` or `REFERENCES`. The preflight found no explicit column ACLs, no
grant options, and only `anon`, `authenticated`, `postgres`, and `service_role`
as table grantees. This was a table-grant defect, not evidence that non-admins
could read rows through the existing RLS policies.

The resulting grants are:

| Database role | Table privileges | Row visibility |
| --- | --- | --- |
| `anon` / `PUBLIC` | None | None |
| `authenticated` | `SELECT`, `UPDATE` | Existing admin-only RLS policies |
| `service_role` | All | Service-role RLS bypass, as before |

## Production checks and limits

The postcheck confirmed that `anon` has no table privileges and no effective
column privileges; `authenticated` has only `SELECT` and `UPDATE` table
privileges; and `service_role` retains all table privileges. The table ACL
(`relacl`) now names only `authenticated`, `postgres`, and `service_role`.
SQL Editor did not initially record version `20261020230000` in
`supabase_migrations.schema_migrations`. On 2026-10-20 UTC, the official
Supabase CLI v2.114.0 was linked to the exact production project
`yngoixmvmxdfxokuafjp`. Before repair, a read-only query found zero rows for
that version; the local migration SHA-256 was
`8c435f5678755637bff8459bc62ccdbc07472b324853a49565be71acbf1e2d39`.
RLS, both admin-only policies, every table privilege including `MAINTAIN`,
and the absence of explicit column grants matched the already applied SQL.
Only `supabase migration repair 20261020230000 --status applied --linked`
was run. [Supabase documents](https://supabase.com/docs/guides/deployment/database-migrations)
this operation as changing the history table without rerunning migration SQL.
The CLI reported the version as applied; a fresh read-only query
found exactly one row, `migration list --linked` showed that version on both
sides, and the post-repair RLS, policies, table grants and column ACLs were
unchanged. No migration SQL was rerun. Other pre-existing history divergence
was not modified; do not run an unreviewed bulk `supabase db push`.

At 2026-10-20 21:34:41 UTC, the Supabase API Gateway logged an Edge-service
`GET /rest/v1/app_settings?select=volt220_api_token&limit=1` returning HTTP
200. This supports the service-role read path, but is **not** an end-to-end bot
smoke test. The admin UI opened its login page; an authenticated admin settings
smoke test has **not** been completed. Exactly one public `search-products`
probe returned HTTP 500. Its response body was not captured, but the matching
Edge Function log shows a cache miss followed by nginx HTTP 502 from the
external `/api/categories` endpoint; the catalog site/API was also returning
HTTP 502 independently. This does not establish an end-to-end bot pass. Keep
the full release **NO-GO** until those paths and
the separate product acceptance gates are verified. Do not read or log token
values in diagnostics.

## Emergency rollback / mitigation

Do not automatically restore the pre-change `GRANT ALL` for `anon` or
`authenticated`: that would reopen the documented table-level exposure. If a
confirmed regression appears, stop release and identify the exact failing
principal, SQL operation, RLS decision, and time first. If a privilege is truly
missing, use a separately reviewed, time-limited transaction to grant only that
specific privilege to the specific required role, then repeat the ACL and
authenticated-admin/Edge-service smoke tests. Never use `PUBLIC` or `anon` as
a convenience fallback, and do not grant `TRUNCATE`, `REFERENCES`, `TRIGGER`,
or `MAINTAIN` without explicit security-owner justification. If a full ACL
reversion is unavoidable during an incident, require explicit approval of the
renewed exposure, record the exact previous grants, timebox the reversion, and
schedule immediate re-hardening. A failed verification should `ROLLBACK` its
transaction rather than leave a partly changed ACL.

This changes database privileges only; it does not rotate or revoke any
application credential. A historical catalog token exposed in Git is a
separate credential-review issue; its rotation/revocation is unverified.
