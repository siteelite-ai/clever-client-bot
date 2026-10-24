# Private v3 preview gate — deployment and rollback

This protects **both** `chat-consultant-v3-preview` and
`chat-consultant-v3-closure-preview`. Their existing Supabase `verify_jwt = true`
still checks the public anon JWT; that JWT is published in the widget and is
**not** the preview authorization secret.

1. In the Supabase project's secret manager, create a new random, independent
   `VOLT220_V3_PREVIEW_SECRET` (for example, a 32-byte random value encoded as
   64 hex characters). The setting is project-wide, but only the preview
   admission branch reads it. Never reuse an OpenRouter, catalog, or production
   key. Do not put the value in Git, URLs, browser code, CLI arguments, logs,
   screenshots, reports, or this document.
2. Deploy **only** the two preview functions from the protected commit. Do not
   deploy `chat-consultant-v3` as a production function. Record the production
   function's current version/hash before and after; it must be unchanged.
3. With a valid public anon JWT, send a minimal POST to **each** preview URL:
   missing or wrong `x-volt-preview-secret` must return HTTP 403 before any
   chat/SSE activity. With the secret supplied from a private server-side
   environment variable, malformed JSON must return HTTP 400, proving that
   authorized requests reach normal validation. Then run one authorized,
   targeted QA chat turn if needed. The CLI QA runners add this header only
   for the two preview URLs on the exact project origin
   `https://yngoixmvmxdfxokuafjp.supabase.co` when
   `VOLT220_V3_PREVIEW_SECRET` is set in their environment. They reject other
   hosts and redirects while carrying the secret; production requests remain
   unchanged.
4. Browser preview harnesses must **not** embed this secret. Use a trusted
   server-side QA proxy if interactive preview testing is needed.

Before any paid customer-acceptance turns, an authorized project operator can
run the **catalog-only** gate against the exact protected closure-preview
deployment:

```sh
node scripts/qa/with-closure-qa-secrets.mjs --project-ref=yngoixmvmxdfxokuafjp -- node scripts/qa/preflight-only-closure.mjs
```

This requires permission to create and remove two short-lived Edge Function
secrets. The wrapper passes their values only to the trusted child, suppresses
child output, and verifies deletion. The child makes one
`catalog_health_preflight` request, which checks every root taxonomy page
within bounded limits, plus a usable product, representative facets and an
exact article filter. It then exits without a customer chat or OpenRouter
call. A successful exit proves this bounded taxonomy and representative
catalog gate; it does **not** prove every client's exact category, the three
required analogs or the remaining browser acceptance cases. Do not use the
full `run-customer-acceptance.mjs`
example merely to check catalog health: it continues into paid chat turns.

If the secret is absent, weak or invalid, both protected preview functions
fail closed. For an emergency preview shutdown, remove/rotate the preview
secret and verify that the public-anon POST returns 403 on **both** endpoints.
Do **not** roll back to the earlier unprotected preview code: that would reopen
the paid public bypass. Production v3 and the live widget are separate and
must not be changed as part of this preview-only deployment.
