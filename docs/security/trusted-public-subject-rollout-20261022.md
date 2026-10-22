# Trusted public subject: staged rollout contract

Status: **design and default-OFF code only; not deployed or accepted**. This is
an additional per-network-subject abuse control, not user authentication and
not a replacement for the existing global model/catalog budget gate. It must
not be described as production protection before the Worker, database, Edge,
widget, and live tests below all agree on the same protocol.

## Trust boundary

The public embed widget uses both the Cloudflare proxy and a direct Supabase
fallback. The Lovable dashboard's `ChatWidget` also calls Supabase V3
directly. A WAF or IP limit on the proxy alone leaves these routes open;
enabling Edge enforcement before **both** clients obtain a trusted proof
would break a working dashboard branch.
Browser-owned `sessionId`, `messageId`, `Origin`, `X-Forwarded-For`, and a
caller-supplied `CF-Connecting-IP` are not trusted identities. The four
expense-bearing public functions are `chat-consultant`,
`chat-consultant-v2`, `chat-consultant-v3`, and `search-products`; they must
enforce the **same** proof rule. `verify_jwt=true` with the public anon key
does not establish an individual visitor identity.

The existing Cloudflare Worker source is not in this repository. Its owner
must integrate this protocol into the **actual** deployed proxy; a new
unrelated Worker or a widget-only header cannot close the direct bypass.

## Proposed capability protocol (not live)

1. At the Cloudflare edge, normalize the client address from Cloudflare's
   verified ingress metadata, never a client-supplied forwarding header.
   Compute a pseudonym `sub = hex(HMAC-SHA256(subject_salt, normalized_ip))`.
   Keep both the address and salt out of the browser, Edge logs, and database.
   A shared NAT will share one quota; mobile address changes and distributed
   sources are residual limitations, not evidence of one human identity.
2. Issue `x-volt-subject-proof` as
   `v1.<base64url(UTF-8 JSON)>.<base64url(HMAC-SHA256(proof_key,
   ASCII "v1.<payload>"))>`. The JSON has exactly `v:1`, `kid`,
   `aud:"volt220-public-api"`, the lowercase 64-hex `sub`, Unix-second
   `iat`/`exp` with at most 60 seconds' validity, and a random UUIDv4 `jti`.
   Use independent secrets for the address pseudonym and proof signature.
   Keep the signing key only in trusted Worker and Edge secret stores.
3. The proxy must **remove any incoming browser proof header and replace it**
   with a fresh trusted proof on proxied public requests. The widget's direct
   Supabase fallback also activates when the Worker origin has a DNS, TLS, or
   connection failure. A proof issuer on that **same Worker alone cannot
   preserve the fallback**: a cold browser tab cannot fetch a proof when the
   Worker is unreachable, and a previously fetched proof expires within 60
   seconds. Before enforcement, provide a separately reachable, trusted
   issuance/attestation path that can establish the same server-owned subject
   without browser-owned identity headers, or explicitly redesign and accept
   the loss of that availability path. An unauthenticated Supabase endpoint
   signing arbitrary browser claims is not a trusted issuer. Any direct issuer
   must return no raw address, use `Cache-Control: no-store`, exact allowed
   CORS origins, no credentials, and no public signing secret. A bearer proof
   can be shared within its brief lifetime; the per-subject database bucket
   and global cap remain necessary.
4. The four Edge functions verify signature, key ID, audience, exact shape,
   time bounds, and token length before any catalog/model work. The proof
   verifier never reads naked IP/session headers. A single atomic SQL bucket
   keyed by the proven pseudonym limits **all four routes together** by
   requests per short window and in-flight count; changing slug must not
   multiply allowance. The existing global model/catalog cap remains an
   independent backstop. SQL stores only the pseudonym and bounded
   reservation metadata, never IP, proof, or key.
5. For V3, verify the proof before claiming a turn. Bind the first claimed
   `messageId` to the proven subject in server-owned storage. A duplicate
   request may replay the saved SSE only to the same subject; an old row with
   no binding or a different subject must not reveal the saved response.
   A same-subject resume must not create a second paid reservation.

## Activation sequence and evidence

1. Keep `PUBLIC_SUBJECT_ADMISSION_MODE=off` everywhere. Review the exact
   Worker code and secret ownership, then run disposable SQL privilege/race,
   expiry, cancellation, and cross-route tests. OFF must preserve legacy
   request and SSE behavior byte-for-byte where relevant.
2. Deploy the compatible Worker path first with proof injection, without Edge
   enforcement. Establish and test an independent trusted direct-path proof
   source before relying on one for fallback. Verify the Worker overwrites a
   forged incoming proof and that both direct and proxy use the same
   pseudonym for one client.
3. Publish compatible embed-widget **and Lovable dashboard ChatWidget**
   versions that obtain a proof for direct calls, or route the dashboard
   through the protected proxy. Enumerate other direct public-function
   consumers before enforcement. Exercise a **cold tab with Worker DNS/TLS or
   connection failure**, connection timeout, SSE resume, expired proof, old
   cached tabs, and unavailable issuance endpoint. A warm cached proof is not
   proof of cold-start fallback. Do not remove the currently working direct
   fallback before this behavior is proved. The proof issuer's CORS allowlist
   must include the intended embed and dashboard origins, without using `*` or
   credentials.
4. Move the Edge gate to `observe` on all four public routes. Check actual
   successful model/catalog traffic, rejection projections, SQL failures,
   in-flight peaks, two NAT-like clients, retry/replay, and OpenRouter spend.
   Redact proof and subject values from logs. Choose limits from observed
   headroom, not a guessed per-user number. The SQL's bounded lazy expiry
   runs only while reservations arrive; arrange and verify independent
   retention cleanup before enforcement, including when the gate is off.
5. Only then can `enforce` be considered. Test forged headers/session IDs,
   valid/invalid/expired proofs, all four routes, embed direct+proxy,
   dashboard direct, V3 cross-subject replay, stream completion/cancel,
   and a targeted browser regression of the existing product-selection
   scenarios. Confirm no
   regression in the protected preview before changing production. The
   private preview QA secret belongs in a trusted CLI or a separately
   approved same-origin QA proxy, never in browser JavaScript or a public
   `Access-Control-Allow-Headers` shortcut.

Rollback must be coordinated across Worker, widget, Edge mode, and SQL.
Turning the Edge mode `off` restores anonymous direct access, so it is an
**availability rollback with a documented security tradeoff**, not proof
that abuse protection remains active. Keep exact deployed bundle/Worker
versions and a time-limited rollback path. Do not merge or activate the
feature merely because offline tests are green.
