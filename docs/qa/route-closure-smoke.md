# Closed legacy/search route smoke

`scripts/qa/run-route-closure-smoke.mjs` is a free, routing-only check for the
three **separate closure-preview** functions. It does not test the live public
functions and does not prove catalog or AI behavior.

The only permitted destination is the canonical Supabase project
`yngoixmvmxdfxokuafjp`, and the only function paths are:

- `chat-consultant-closure-preview`
- `chat-consultant-v2-closure-preview`
- `search-products-closure-preview`

Before requesting the private QA credential, run the read-only
`scripts/qa/verify-preview-bundles.mjs` against
`docs/qa/preview-bundles-candidate-20261022.json` with the Management PAT in a
protected environment. It checks the four closed preview versions/hashes,
their `verify_jwt` flags, the four unchanged public baselines and the local
runtime source. A mismatch is a hard stop; update the manifest only after a
deliberate, independently recorded deployment and a fresh public baseline.
This attestation does not replace the routing smoke or prove catalog/AI behavior.

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
handler. An anon JWT alone is not sufficient. Generate a new, independent
QA secret for each run in this exact wire format:
`<10-digit Unix epoch seconds>_<32 lowercase hex random digits>_<64 base64url random characters>`.
Use a cryptographic random source for the 16-byte run ID and 48-byte value;
the latter must be base64url without padding. Static 32–256-character secrets
from the earlier draft are no longer accepted. Both the server and runner
reject a credential more than 20 minutes old or dated over 120 seconds in the
future. The server compares the whole credential with its configured secret;
the timestamp alone never grants access. Allow for clock skew and finish the
15-probe run within that window.

Retain the matching secret only for the short QA window, and rotate or delete
it immediately afterward. Expiry **does not remove** a lingering Supabase
secret; verify deletion or rotation separately. Keep it out of shell history,
chat, issue comments, screenshots, and the repository. The runner
reads the public `anon` JWT from `public/widget.js`; it rejects a non-anon JWT.

For a one-run server-side setup, use the wrapper below. It reads the existing
Supabase Management PAT from `SUPABASE_ACCESS_TOKEN` or the Supabase CLI's
local access-token file, checks that `VOLT220_ROUTE_QA_SECRET` is absent,
creates a fresh credential, invokes only this fixed 15-probe runner, then
deletes that exact name and independently verifies its absence. Before DELETE,
it compares the Management GET `value` (a SHA-256 hex digest, **not** the raw
secret) with the SHA-256 of its own freshly generated value. If the digest is
absent or differs, it does not delete the name and reports uncertain ownership.
An explicit POST 4xx similarly triggers only a read-only absence check, never
a DELETE. The PAT never reaches the runner. Neither secret values nor the runner's raw output are
printed; on success, the wrapper prints only a bounded, strictly validated
JSON matrix of 15 names/statuses plus `secret_cleanup: "verified"`. A
pre-existing route secret is a hard stop and is not removed.

```sh
node scripts/qa/with-route-qa-secret.mjs --project-ref=yngoixmvmxdfxokuafjp
```

Do not run this wrapper concurrently with another administrator changing the
same project secret. Supabase's Management secrets API has no conditional
create; its GET-before-POST preflight cannot eliminate a remote writer's
race between those calls. A timed-out POST is also uncertain: the wrapper
checks again at 2, 5, and 15 seconds, deleting a late appearance **only if its
digest proves ownership**, and exits with a manual-inspection warning rather
than claiming success. SIGKILL,
machine failure, a still later server write, or another writer racing between
the ownership GET and DELETE can bypass these guarantees: the API has no
conditional delete. In such a case inspect the Management secrets list and
coordinate with the project owner before manually deleting **only**
`VOLT220_ROUTE_QA_SECRET`; do not delete if ownership remains unknown.

Alternatively, after securely placing the matching QA secret in the process
environment yourself:

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
node --test scripts/qa/with-route-qa-secret.test.mjs
```

This check does not verify that the exact deployed source matches a PR, that
public traffic is protected against abuse, that the catalog works, or that the
browser's fallback path is safe. Legacy/public-route budget controls remain
separate and must be assessed independently. Those remain separate release
evidence.
