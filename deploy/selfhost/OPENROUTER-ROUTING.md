# OpenRouter through the isolated server3 relay (test deployment only)

`route-test-openrouter.mjs` creates a **new private Edge Function bundle** from an already reviewed `export-test-functions.mjs` bundle. It never edits `supabase/functions`, the reviewed bundle, the existing Lovable deployment, or production settings. The output is intended only for the isolated Supabase on server3.

The transform replaces exactly 17 reviewed URL literals: 15 `/api/v1/chat/completions` calls and two `/api/v1/embeddings` calls. Both become `http://volt220test-relay-client:19084/api/v1/...`, an internal Docker-network address. Request bodies, headers, streaming code, model choices, fallback branches, and responses are byte-for-byte unchanged. A new or moved OpenRouter URL makes the export fail until it is reviewed and added to the fixed route inventory.

## Build and verify, locally

Run from this repository, using a fresh private directory **outside** the checkout:

```sh
route_workdir=$(mktemp -d /tmp/volt220-edge-route.XXXXXXXX)
node deploy/selfhost/export-test-functions.mjs --out "$route_workdir/reviewed"
node deploy/selfhost/route-test-openrouter.mjs --out "$route_workdir/reviewed" "$route_workdir/routed"
node deploy/selfhost/route-test-openrouter.mjs --verify "$route_workdir/reviewed" "$route_workdir/routed"
```

The source bundle must still match the exact local source files and its manifest; the routed bundle has its own manifest with the source-manifest SHA-256, per-file source/output SHA-256 and byte lengths, and route counts. Both bundles use private `0700` directories and `0600` files. An existing output is never overwritten. Verification rejects added files/directories, symlinks, relaxed permissions, changed source, changed counts, or a modified routed file.

Do not run the original `export-test-functions.mjs --verify` against the *routed* bundle: it correctly expects unchanged source bytes. Verify the reviewed bundle with that tool, and the routed bundle with this one. Preserve both manifests when copying to server3; independently compare their SHA-256 values before installing.

## Release boundary

- Install only into the **new isolated** server3 Supabase functions volume. Never put this routed bundle into the hosted production Supabase or merge generated files into source control.
- The relay client name must resolve only inside the dedicated Docker network. Do not publish port `19084` to the Internet or connect it to existing connector containers/networks. The relay service must allow only the two POST paths above, enforce authentication/network isolation, forward `Authorization` without logging it, and stream the upstream response without buffering or altering it.
- Do not lift the new cabinet/API 503 gates on the basis of compilation alone. First verify the relay path and a bounded model-backed chat response with dedicated, capped OpenRouter and separate read-only catalog credentials. Keep the old chatbot and its secrets untouched.
- If a source branch changes any OpenRouter call, rebuild and review the inventory. Do not bypass the fail-closed check by changing counts without inspecting the call's purpose and route.

This routing step has no credentials and makes no network request. It does not prove that `213.165.41.225` can reach OpenRouter, that a separate key has been issued, or that end-to-end model responses work; those are separate release gates.
