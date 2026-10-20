# `app_settings`: least-privilege rollout

Status: draft PR #122. The disposable PostgreSQL checks passed; the migration
has not been merged or applied to Supabase, and no production data was changed.

`public.app_settings` contains catalog and AI-provider credentials. Its existing
RLS policies allow only admins to read and update rows, but table-level grants
still include `TRUNCATE`, `REFERENCES`, and `TRIGGER` for public API roles. RLS
does not protect table-wide `TRUNCATE` or `REFERENCES`; the grant boundary must
be narrowed as well. This migration changes no policies, rows, or credentials.

The resulting grants are:

| Database role | Table privileges | Row visibility |
| --- | --- | --- |
| `anon` / `PUBLIC` | None | None |
| `authenticated` | `SELECT`, `UPDATE` | Existing admin-only RLS policies |
| `service_role` | All | Service-role RLS bypass, as before |

Before application, run the disposable PostgreSQL workflow and confirm that
production still has both admin-only RLS policies. After application, verify
`has_table_privilege` for the three roles and smoke-test an admin opening the
settings page plus an Edge Function reading settings. Do not read or log token
values in a diagnostic. If the admin or service-role path fails, stop release;
restore only the minimum privilege needed after identifying the mismatch.

This changes database privileges only; it does not rotate or revoke any
application credential.
