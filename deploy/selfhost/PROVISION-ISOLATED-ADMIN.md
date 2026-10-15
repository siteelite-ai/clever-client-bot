# Real administrator on the isolated server3 cabinet

This optional helper creates **one** administrator in `volt220test`, not in
the existing Lovable/production project. The customer explicitly confirmed
`info@st-lt.ru` as the login email on 2026-10-15; the earlier use of that
address for HTTPS certificate notices alone would not have authorized it.

The helper is deliberately separate from `bootstrap-test-admin.mjs`: the
synthetic QA user already exists, and the bootstrap refuses a nonempty Auth
store. The new helper accepts either an empty isolated Auth store or exactly
that one QA account with one `admin` role. Any other existing user, duplicate
email, unexpected role, different Compose project, public gateway, open DB
port, non-root execution, or non-interactive terminal makes it stop before
creating an account.

## Before running

1. Review the exact script commit and install
   `provision-isolated-admin.mjs` **and** `validate-compose.mjs` together in a
   root-owned directory outside the webroot, such as
   `/var/lib/volt220-test-supabase/operator/`. Do not deploy a rewritten copy.
2. Keep the two new public hosts behind their maintenance gate until the
   isolated functions, secret-column grants, Nginx allowlists, and cabinet
   build have passed their release checks. Account creation is not a reason
   to open either gate early.
3. Confirm the customer explicitly selected the exact email. Connect to
   server3 through an interactive SSH terminal (`-tt`), and run the command
   below **on server3**, substituting only the chosen email. The email is not
   secret; the password is never a command argument or environment variable.

```sh
sudo /usr/bin/node /var/lib/volt220-test-supabase/operator/provision-isolated-admin.mjs \
  --email info@st-lt.ru \
  --mode selfhost-test \
  --confirm create-one-isolated-server3-admin
```

The helper prompts to retype the email and then asks twice for a user-chosen
password of 20–128 characters. Echo is disabled during these prompts and
restored afterward. Use a password manager; do not paste the password into
chat, shell history, SSH command arguments, URLs, or support tickets. If the
process is forcibly killed and the terminal remains hidden, run `stty sane`
in that terminal. No password file is created and successful output contains
only the email and new Auth UUID.

The helper reads only the root-owned isolated `.env` in memory, uses the
loopback Kong gateway, checks its Docker/Compose labels and port binding,
creates the exact Auth user with a confirmed email, verifies the trigger made
one profile and one `viewer` role, updates **that one row** to `admin`, and
verifies a password login plus `admin-users` authorization. It makes no bot
or paid AI request and never accesses the old production database.

## Failure handling

If a step after Auth returns the new UUID fails, the helper attempts to
delete **only that newly created Auth UUID**; the Auth foreign keys then
cascade to its profile and role. It never deletes the pre-existing QA user or
any unrelated account. `ROLLBACK_REQUIRED` means the exact new UUID needs
manual reconciliation before retrying. `CREATE_OUTCOME_UNKNOWN` means a
timeout/error may have happened after Auth committed but before the helper
received a UUID: **do not rerun**. Inspect the exact chosen email via the
isolated local Auth Admin API first. Do not reset the database or issue broad
DELETE statements.

The prior synthetic QA account should be revoked separately after the real
administrator has logged in and access has been verified. That operation is
not part of this helper and must target the exact QA email and UUID only.
