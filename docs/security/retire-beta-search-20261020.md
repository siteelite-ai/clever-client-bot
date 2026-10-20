# Retire the orphan beta-search Edge Function

`chat-consultant-beta-search` is an independently deployed public Edge Function,
not a widget route. On 2026-10-20, the Supabase function inventory reported it
as `ACTIVE`, version `30`, with `verify_jwt=false`. A source search of `origin/main`
found no runtime caller. The release security audit reported no invocations in
its seven-day log window; recheck this immediately before deployment.

This branch does **not** deploy or delete the route. It adds a source-controlled,
inert replacement at the same URL. Browser preflight receives `204`; every other
method receives JSON `410 BETA_SEARCH_RETIRED`. The handler does not read the
request body, secrets, database, catalog, or AI gateway. The `no-store` header
avoids caching the retirement response across a rollback.

## Release gate

1. Recheck current invocations and consumers. If a real caller exists, migrate it
   explicitly before retirement. Do not redirect this endpoint to paid search.
2. **Save and verify a recoverable copy of deployed v30 source before deployment.**
   The CLI's `functions download` currently fails with
   `InvalidFunctionDownloadResponseError: expected multipart response, got application/octet-stream`
   both with and without `--use-api`; the repository does not contain v30 source.
   Try the Supabase Dashboard's per-function Download action and verify the
   archive. Keep it private; do not commit credentials or a bundled secret.
3. Deploy only `chat-consultant-beta-search` with `verify_jwt=false`; never use a
   no-name bulk functions deploy for this change. Confirm the deployed version
   increments beyond v30. No widget, V3, catalog, or admin route should change.
4. Send a harmless `OPTIONS` preflight and `POST` with an inert payload. Expect
   `204` and `410` respectively, with CORS and `no-store`. Check function logs
   for errors and gateway logs for no model/catalog calls from this route.

If the release must be reversed, redeploy the saved v30 source to the **same
slug**, restoring its original `verify_jwt=false`, then verify version and
behavior. Merely reverting this Git branch does not change a deployed Edge
Function. Supabase's Dashboard editor does not provide version rollback, so a
verified pre-deploy source archive is required. Without that archive, **do not
deploy this retirement**.
