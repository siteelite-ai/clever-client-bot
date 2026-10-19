# Dedicated service keys for the isolated server3 cabinet

This helper is **not** a way to copy production credentials. Create a separate
OpenRouter key with a hard spending limit and ask the catalog API owner for a
separate, read-only catalog token first. Neither value belongs in chat, Git,
shell history, an SSH command, or a `.env` file. The helper cannot prove how a
key was issued; the operator must confirm both are dedicated to server3.

Keep `chat-volt-next.testdevops.ru` and `api-volt-next.testdevops.ru` behind
their 503 gates until AI routing through the isolated relay and an end-to-end
model-backed test pass. This helper itself makes no paid OpenRouter call and
does not access the production Supabase or old cabinet.

Install reviewed `set-isolated-service-keys.mjs` and `validate-compose.mjs`
side-by-side under a root-owned, non-web directory on server3, for example
`/var/lib/volt220-test-supabase/operator/`. Connect using an interactive SSH
terminal (`ssh -tt`). **On server3**, run:

```sh
sudo /usr/bin/node /var/lib/volt220-test-supabase/operator/set-isolated-service-keys.mjs \
  --mode selfhost-test \
  --confirm set-two-isolated-server3-service-keys
```

Enter `SERVER3` at the visible confirmation, then paste the new OpenRouter
key and new catalog token into the two hidden prompts. Echo is restored even
if validation fails. If a forcibly terminated terminal remains hidden, run
`stty sane`. Successful output confirms only that one isolated settings row
was updated and both fields are non-null; it never echoes either key.

The helper refuses anything other than Linux root, a real TTY, the exact
`volt220test` Docker Compose labels, a DB without public port, a gateway bound
to `127.0.0.1:18081`, and the root-owned 0600 isolated `.env` with the expected
two new domains and test-mode flags. It verifies exactly one settings row and
that both fields are **NULL**, then uses a single conditional REST PATCH with
`Prefer: return=minimal,count=exact`. Follow-up queries select only `id` with
non-null filters; stored credentials are never returned. If either field was
already populated, the helper will **not rotate or overwrite it**.

`WRITE_OUTCOME_UNKNOWN`, `VERIFICATION_OUTCOME_UNKNOWN`, or
`PARTIAL_OR_UNKNOWN_OUTCOME` means **do not rerun blindly**: a request may have
committed before a timeout, or another actor may have changed the row. Inspect
only presence (not values) in the isolated database and reconcile deliberately.
No automatic rollback is attempted, because it could delete a newly active
credential or another operator's change. For rotation, use a separately
reviewed procedure after the new cabinet is live.
