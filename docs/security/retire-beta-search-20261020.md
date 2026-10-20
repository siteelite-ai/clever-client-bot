# Retire the orphan beta-search Edge Function

`chat-consultant-beta-search` is an independently deployed public Edge Function,
not a widget route. On 2026-10-20, the Supabase function inventory reported it
as `ACTIVE`, version `48`, with `verify_jwt=false`. A source search of the current
repository found no runtime caller. The Supabase Dashboard showed zero
invocations in the preceding five days, but those metrics may lag by up to
24 hours and cannot rule out external or infrequent clients. Recheck immediately
before deployment. Do not call this endpoint unused as a proven fact.

The exact deployed v48 bundle was downloaded before preparing this change. Its
embedded source map yielded the function's TypeScript source. That source reads
the request body without authentication, can call `search-products`, and can
make two requests to `ai.gateway.lovable.dev` using a server-side key. The
public route is therefore a distinct cost/abuse surface even though it has no
known current consumer. The source map-derived TypeScript passed `deno check`
on 2026-10-20; it has **not** been redeployed as a rollback drill.

This branch does **not** deploy or delete the route. It adds a source-controlled,
inert replacement at the same URL. Browser preflight receives `204`; every other
method receives JSON `410 BETA_SEARCH_RETIRED`. The handler does not read the
request body, secrets, database, catalog, or AI gateway. The `no-store` header
avoids caching the retirement response across a rollback.

## Release gate

1. Recheck current invocations and consumers. If a real caller exists, migrate it
   explicitly before retirement. Do not redirect this endpoint to paid search.
   Zero recent invocations alone are not proof that there is no external client.
2. **Verify the private v48 rollback artifacts remain available to the release
   operator before deployment.** They are deliberately outside Git at
   `work/private-backups/chat-consultant-beta-search-v48-20261020.eszip`
   (SHA-256 `f7e4f878aaf8b0f7dafe1f8916e4b625b4d07a8e91e1408e26a5122393619aff`)
   and `work/private-backups/chat-consultant-beta-search-v48-20261020.ts`
   (SHA-256 `e43e8ec2288d68c1e674dd5448429ac0396851ee71c9182d675222b066010429`).
   Both are mode `0600`. The CLI's `functions download` currently fails with
   `InvalidFunctionDownloadResponseError: expected multipart response, got application/octet-stream`;
   the bundle was recovered separately from the deployed function. Do not put
   either artifact in a public repository or paste secrets into release logs.
3. Deploy only `chat-consultant-beta-search` with `verify_jwt=false`; never use a
   no-name bulk functions deploy for this change. Confirm the deployed version
   increments beyond v48. No widget, V3, catalog, or admin route should change.
4. Send a harmless `OPTIONS` preflight and `POST` with an inert payload. Expect
   `204` and `410` respectively, with CORS and `no-store`. Check function logs
   for errors and gateway logs for no model/catalog calls from this route.

If the release must be reversed, verify the private TS file against the SHA-256
above, place it as `supabase/functions/chat-consultant-beta-search/index.ts` in
an isolated temporary Supabase project directory, and deploy **only that slug**
to the same project with `verify_jwt=false`. Confirm the new deployed version,
the function's expected behavior, and that other function bundle hashes remain
unchanged. The `.eszip` is the exact deployed bundle for forensic verification;
the Supabase CLI deploys source, not this bundle directly. A redeploy of the
source may not be byte-identical because its remote imports are version-ranged.
Merely reverting this Git branch does not change a deployed Edge Function.
Supabase's Dashboard editor does not provide version rollback. If the private
source file is missing or a real caller cannot be safely migrated, **do not
deploy this retirement**.
