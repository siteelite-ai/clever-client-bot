# One-time synthetic administrator for the isolated QA cabinet

This is **not** a customer account and **not** a production login. The helper
creates only `qa-admin-20261014@volt220.test` in the empty `volt220test`
self-hosted Supabase on server3. It is intentionally unusable against a public
URL, any other Compose project/container, or an Auth store with existing users.
Do not copy a production Auth user, database, password, or service key.

## Before running

1. Apply and verify the isolated test migrations, including the `profiles`
   and `user_roles` Auth trigger. Keep both public test hosts under HTTP 503.
2. Deploy only the reviewed `admin-users` Edge function. Its unauthenticated
   `POST {"action":"list"}` must return 401 on the loopback gateway. The
   helper tests this before creating any account.
3. Keep the dedicated Compose project running with `volt220test-db` and
   `volt220test-api-gw`. Only the gateway may bind `127.0.0.1:18081`; the DB
   must not have a host port. The helper checks Docker labels and bindings.
4. Confirm `/var/lib/volt220-test-supabase/upstream/docker/.env` is root-owned
   mode `0600` with the exact isolated test settings. No Lovable/production
   secrets should be present. The helper reads this file in memory; it never
   prints keys or passes them in process arguments/environment.

Run once on server3 in a restricted root shell. Use the checked-out script
from the reviewed Git commit, not an unreviewed copy. All values below are
required literally; changing even one makes the helper fail closed.

```sh
node /path/to/reviewed/repo/deploy/selfhost/bootstrap-test-admin.mjs \
  --gateway http://127.0.0.1:18081 \
  --env /var/lib/volt220-test-supabase/upstream/docker/.env \
  --credentials /var/lib/volt220-test-supabase/private/qa-admin-20261014.json \
  --project volt220test \
  --db-container volt220test-db \
  --email qa-admin-20261014@volt220.test \
  --mode selfhost-test \
  --confirm create-isolated-synthetic-admin
```

The credential file is created exclusively with mode `0600` inside a
root-owned `0700` directory outside the webroot. The 48-character random
password must be transferred only through an approved secure channel or
password manager; do not put it in chat, a shell command argument, CI logs,
Git, or a browser URL. A rerun refuses to overwrite the file and also refuses
to operate when Auth has any existing user. Output contains only the synthetic
user UUID and private file path, never the password or tokens.

The helper uses the official Auth Admin REST API over loopback with the
isolated `sb_secret_*` API key and asymmetric service-role JWT. Auth's trigger
must insert one `viewer` role. The helper checks the exact user, profile, and
single role row; updates **that same row** to `admin` with an ID/user/viewer
predicate; checks it remains the only role; signs in with the generated
password; then checks that `admin-users` accepts the user JWT (200) and
rejects a call without a JWT (401). It never uses public sign-up or SMTP.

## Failure and rollback

If a step after creation fails, the helper deletes **only the Auth UUID
returned by its own create call** through the Admin API. Auth's foreign keys
cascade-delete that user's profile and role. It then removes the credential
file. It never deletes pre-existing users or roles. If rollback fails, it
returns `ROLLBACK_REQUIRED` and leaves the root-only password file in place
for manual reconciliation. If the create request has an unknown outcome
(such as a timeout before a UUID was returned), it returns
`CREATE_OUTCOME_UNKNOWN`, does not guess which user to delete, and keeps the
credential file. Stop; inspect this exact synthetic email through the local
Auth Admin API before another attempt. Do **not** reset the test database or
run broad DELETE statements as a workaround.

After a successful QA run, deliberately revoke this synthetic account via
the local Auth Admin API only after checking its exact email and UUID from the
helper's success output. Verify that the matching `profiles` and
`user_roles` rows disappeared, then remove only the private credential file.
Do not attempt to delete a real customer or any production account. Creating
a real customer login is a separate review and secure credential-delivery
workflow.

Official references: [Supabase Auth Admin createUser](https://supabase.com/docs/reference/javascript/auth-admin-createuser),
[self-hosted API keys and JWTs](https://supabase.com/docs/guides/self-hosting/self-hosted-auth-keys).
