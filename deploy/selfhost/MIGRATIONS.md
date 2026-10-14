# Isolated test migration bundle

`export-test-migrations.mjs` prepares an **offline** SQL history for the new,
empty server3 Supabase project. It does not connect to Supabase, run SQL, or
change the repository's `supabase/migrations` and `supabase/config.toml`.

The exporter pins the exact filenames and SHA-256 of all 48 reviewed source
migrations. It copies 45 files byte-for-byte. Three historical **data-only**
updates (`20260218095324_*`, `20260302152518_*`, `20260330105800_*`) become
`SELECT 1;` under their original migration filenames in the test bundle. They
carry production-specific settings/data and are not needed to create schema.
Their omission is limited to this bundle; the production migration history is
untouched. A changed, added, removed, or symlinked SQL file fails closed and
requires a new review of the manifest.

The exporter appends two **test-only** final migrations after the 48 reviewed
source migrations:

- `20261014182000_selfhost_limit_role_lookup.sql` narrows the `has_role` RPC
  so an authenticated viewer can only check their own role, while trusted
  `service_role` calls and existing RLS checks continue to work.
- `20261014183000_selfhost_revoke_client_table_grants.sql` revokes all default
  table privileges from `anon` and the RLS-bypassing `TRUNCATE` privilege from
  `authenticated` on exactly the 13 application tables. It does not revoke
  authenticated SELECT/INSERT/UPDATE/DELETE, service-role, sequence, or RPC
  privileges.

Both source files live under `deploy/selfhost`, not `supabase/migrations`;
the production database and its migration history are unchanged. Their
SHA-256 values are pinned and the exported files are checked on `--verify`.
The resulting bundle contains **50 migrations: 45 unchanged source SQL files,
three isolated no-op replacements, and two isolated hardening files**.

From the reviewed repository checkout, use an absolute new output path
**outside the repository**, in a private directory:

```sh
node deploy/selfhost/export-test-migrations.mjs --check
node deploy/selfhost/export-test-migrations.mjs \
  --out /var/lib/volt220-test-supabase/migration-export-20261014
node deploy/selfhost/export-test-migrations.mjs \
  --verify /var/lib/volt220-test-supabase/migration-export-20261014
```

`--check` is a read-only dry run. `--out` refuses an existing output directory.
It reserves that directory with private permissions, writes to a private
`.staging` child, and atomically publishes the completed `supabase` child.
Only `/var/lib/volt220-test-supabase/migration-export-20261014/supabase`
is a ready bundle. If a process stops before publication, do not treat an
incomplete `.staging` as ready; use a **new** output name after diagnosing the
failure. `--verify` checks every exported hash, exact filename/count, the
test-only config and private file permissions after copying to the target
host. No SQL body or secret appears in normal command output.

The generated `supabase/config.toml` contains only the isolated test project
name, never the repository's production Supabase project ID. The generated
`migration-manifest.json` records hashes, the three omissions, and the two
test-only hardening files, not SQL contents. Keep the whole bundle root-only
and out of Git.

Applying SQL is a **separate** release step after verifying the target database
is the isolated empty test Postgres. From the *bundle parent* (the directory
containing its `supabase` child), use a pinned official Supabase CLI and pass an
explicit test-only `--db-url` for both dry run and apply. Never rely on
`supabase/config.toml` or a linked project's default target, never run an
implicit `supabase db push`, and never use `db reset` against any existing
project. First inspect the CLI dry-run plan and confirm the destination is
the server3 test database; only then run the same command without `--dry-run`.

The exporter does not create test users, secrets, catalog tokens, OpenRouter
keys, Storage objects, or knowledge-base rows. Those require separate test
data and explicit isolated credentials before public traffic is enabled.

Before opening the Nginx maintenance gate, inspect the **applied** test DB's
`pg_policies`, `has_table_privilege` and `has_function_privilege` results. Probe
the REST API with both the publishable key alone and a viewer session: neither
may read settings, knowledge, logs or classifier test data, mutate staff data,
or call knowledge-search RPCs. A viewer may inspect their own profile/role but
`has_role` must not reveal another user's role. This runtime check matters
because the source SQL audit cannot prove the fresh self-hosted Supabase image's
default grants.
