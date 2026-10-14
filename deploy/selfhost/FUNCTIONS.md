# Isolated test Edge Function source bundle

`export-test-functions.mjs` creates a **local staging bundle**, not a deployment.
It reads exactly these application source trees:

- `chat-consultant-v3`
- `admin-users`
- `knowledge-process`
- `_shared` (all non-test `.ts` modules needed by the three functions)

It excludes `*_test.ts`, other Edge Functions including preview/closure routes,
local `.env` files, and the official self-hosted `functions/main` router. It
rejects non-TypeScript files and symlinks in selected source trees, known
production project/credential literals, and any source mutation during copy.
The output is a new `0700` directory containing only `functions/` and a
SHA-256 `manifest.json`; files are `0600`. It will not overwrite an existing
directory or stage inside the Git repository.

From the repository checkout, use Node 18+:

```sh
node deploy/selfhost/export-test-functions.mjs --check
node deploy/selfhost/export-test-functions.mjs --out /absolute/private/new-bundle-directory
node deploy/selfhost/export-test-functions.mjs --verify /absolute/private/new-bundle-directory
node --test deploy/selfhost/export-test-functions.test.mjs
```

After any change to `admin-users` or the other selected sources, create a
**new** bundle and verify it again. Do not reuse a stale bundle. A separate
reviewed deployment step may install only these three function directories and
`_shared` into the isolated Supabase `volumes/functions` tree, while preserving
its official `main` router. Inspect and remove only the official sample
`hello` function before opening the isolated API. Keep both new HTTP sites on
maintenance until authentication, schema, secrets, TLS, and endpoint tests
pass. This tool never changes the old cabinet, production Supabase, or live
widget.
