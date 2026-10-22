# Closed legacy/search route smoke

`scripts/qa/run-route-closure-smoke.mjs` is a free, routing-only check for the
three **separate closure-preview** functions. It does not test the live public
functions and does not prove catalog or AI behavior.

The only permitted destination is the canonical Supabase project
`yngoixmvmxdfxokuafjp`, and the only function paths are:

- `chat-consultant-closure-preview`
- `chat-consultant-v2-closure-preview`
- `search-products-closure-preview`

For each path the runner expects: 403 with no QA secret, 403 with a wrong QA
secret, **401 for an invalid Bearer JWT despite a valid QA secret**, 405 for an
authenticated `GET`, and 400 for an authenticated `POST` containing only the
malformed JSON byte `{`. The invalid-JWT probe sends no `apikey`: Supabase may
otherwise accept a valid API key in that header as a substitute for the JWT
gateway check. [Supabase's authorization-header reference](https://supabase.com/docs/guides/functions/auth-headers)
states that a malformed JWT is rejected with 401 before handler execution.
If the closure were deployed with `verify_jwt = false`, the valid secret would
allow this `GET` through to the handler and it would return 405, failing the
smoke. It never sends a valid chat/search
request. Its output has only allowlisted check names and HTTP statuses; remote
bodies, credentials, and exception text are never printed or read. Redirects
are forbidden and each request is aborted after five seconds at most.

The preview functions must already be deployed with `verify_jwt = true` and
configured to validate the `x-volt220-route-qa-secret` header against the
server-side `VOLT220_ROUTE_QA_SECRET` **before** calling the underlying
handler. An anon JWT alone is not sufficient. Generate the server-side QA
secret independently, retain it only for the short QA window, and rotate or
delete it immediately afterward. Keep it out of shell history, chat, issue
comments, screenshots, and the repository. The runner
reads the public `anon` JWT from `public/widget.js`; it rejects a non-anon JWT.

After securely placing the matching QA secret in the process environment:

```sh
node scripts/qa/run-route-closure-smoke.mjs --project-ref=yngoixmvmxdfxokuafjp
```

Do not pass a URL or secret as a CLI argument. Exit 0 means all 15 expected
statuses matched; exit 1 means a failed route/transport check; exit 2 means
invalid local configuration and **no requests were sent**. A failure is a
release gate, not a reason to point the older V3 security smoke at these
routes: that smoke sends a valid message and can invoke paid AI on V1/V2.

Offline regression:

```sh
node --test scripts/qa/run-route-closure-smoke.test.mjs
```

This check does not verify that the exact deployed source matches a PR, that
public traffic is protected against abuse, that the catalog works, or that the
browser's fallback path is safe. Legacy/public-route budget controls remain
separate and must be assessed independently. Those remain separate release
evidence.
