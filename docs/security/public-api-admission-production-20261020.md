# Public API admission: production observation, 20 October 2026

This is a staged cost/availability control for the existing public
Lovable/Supabase widget, **not** user authentication or a security sign-off.
The browser still has a direct Supabase route as well as the Cloudflare proxy.
Both must be covered before a proxy-only rate limit can be considered useful.

## Immutable release evidence

- Production source baseline: main `f4bdd8126620600a440bfc07b87b9a77366bdd67`.
  The public function versions before the schema release were v1 `1037`
  (`8f56525d4b7de1f58f62b911ffc598f2c1294ac1ab5f45ec718c1cd40645856e`),
  v2 `465` (`d29c59e18d6fc955a33635d42d282e5398bd369243de846aa8d79e165a748abe`),
  v3 `529` (`d51d1308f3425b40438dbc2c225c69c9b5dce9770070b349a05ec0f9ace525f9`),
  and `search-products` `667`
  (`b6b7ffabee5dd15c909bc2b35cd7b7805c992e27d0ef87e46a37b03b1b4ada03`).
  All four had `verify_jwt=false`. A read-only download of their deployed
  sources confirmed shared `reservePublicApiAdmission` calls in each;
  the downloaded shared module SHA-256 matched this repository.
- Production read-only preflight: all three new tables, both RPC names, and
  three new index names were absent. Migration history had no
  `20261020120000` row. `anon`, `authenticated`, and `service_role` existed.
  Last-seven-day v3 logs at the check had 315 turns, five errors, peak seven
  starts/minute, estimated peak two overlapping turns, and 20,052 ms p95.
  These are v3 log aggregates, **not** all-route Edge invocation counts.
- PostgreSQL 16 CI for commit `1bd74120ae442a5fd01ff522f338d0d8b858654b`
  passed the shared-migration, privilege, replay and concurrent-limit tests
  (GitHub Actions run `39350789481`).
- The normal repository's `db push --dry-run --skip-vault` correctly stopped on
  unrelated historical migration drift. No history was repaired or reverted.
  A separate temporary project directory at
  `/private/tmp/volt220-admission-release.VYA9lE` fetched the *already applied*
  remote migration history and staged only the unmodified
  `20261020120000_public_api_admission.sql` (SHA-256
  `0d13326ea9b35fa2f163b08ea7d5b60ed03d3cd38befdcde48b0e719b5b2aa13`).
  Its dry run listed exactly that one file, no roles, seeds or Vault changes.
- `db push --skip-vault` from that temporary directory succeeded. A later
  read-only query confirmed one migration-history row, all three tables,
  both RPC signatures, four initial buckets, `anon` denied table SELECT and
  RPC EXECUTE, and `service_role` granted RPC EXECUTE. The CLI could not cache
  a *local* migration catalog because Docker is absent; this warning did not
  affect the verified remote transaction.

## Current operating mode and checks

Server-side project secrets set candidate observation thresholds of 30 model
turns/minute and eight model in flight; 90 catalog turns/minute and 20 catalog
in flight. `PUBLIC_API_ADMISSION_MODE=observe` records would-reject decisions
but **never blocks** on a limit. Preview wrappers keep their separate server-
owned admission-off marker. No secret value or client identity was copied into
this document.

After enabling observation, a v3 chat request and a `search-products`
category-facet request were admitted and released in the new ledger, each with
`would_reject=false`; the catalog request returned HTTP 200 with 54 facet
options. Five malformed/misrouted v3 security probes returned their expected
405/400/400/413 responses without paid work. At 15:45 UTC, the same
invalid-JSON POST to the direct Supabase v3 URL and the Cloudflare proxy v3 URL
returned HTTP 400 in 1.26 s and 1.38 s, respectively. The handler rejects
invalid JSON before database admission, catalog and model work; this checks
reachability and early validation through both paths, **not** admission
enforcement or a successful chat turn. The first chat request used an
older synthetic prompt without an explicit electrical-socket constraint and
exposed an electrical-vs-computer subtype ambiguity; it is **not** a passing
customer acceptance result. The later exact client prompt, «Найди двойные
черные розетки электрические», passed one targeted production run under
observation: all four returned pages were verified for black colour, two
connectors and electrical subtype (report
`docs/qa/reports/production-v5-black-socket-exact-client-retry-20261020.json`).
An earlier run with the same prompt failed only because two product-page
fetches were transiently unavailable; both pages subsequently verified.

At 14:05 UTC a read-only aggregate of the production ledger showed 69 v3 and
73 `search-products` reservations since observe began at 05:20 UTC; all 142
were released, with zero `would_reject`, active, or expired-unreleased rows.
At 15:43 UTC a further read-only aggregate showed 69 v3 and 127
`search-products` reservations since observation began: 54 additional catalog
reservations and no additional v3 reservation. `would_reject`, active and
expired-unreleased counts remained zero for both routes. These are ledger
counts, not proof of all-route coverage or of a representative day.
Observed per-minute peaks were six model and 19 catalog reservations; p95
release latency was 19.3 s for v3 and 3.4 s for catalog. Targeted Edge-log
filters found no v1/v2 POST in the last 24 hours, but the all-route Logs
Explorer group was incomplete (it omitted catalog calls visible under a
separate filter). The ledger does not distinguish direct Supabase from
Cloudflare-proxied traffic. These data cover **less than nine hours** of
observe mode, not the required representative day; they do not justify
`enforce` or a public-security sign-off.

## Gate before enforcement

Observe real traffic for at least one representative day, including both
direct Supabase and proxy entrypoints and all public function slugs. Check
rate/in-flight peaks, `would_reject`, reservation release/expiry, RPC failures
and latency, 429/5xx, catalog fanout per accepted turn and OpenRouter spend.
The old v1/v2 routes must not be assumed unused from v3 chat logs. A later
read-only inspection of the exact deployed `chat-consultant-beta-search` v80
bundle (`c109f6284c2f75f50ba010d4ff2de915e6a93460d74576deabb2e2eb65e944a6`)
confirmed a retired handler without model/catalog calls; live OPTIONS and GET
returned 204 and 410. This closes the beta paid-surface concern, but does not
establish whether legacy clients still call that retired URL. The current global cap is only
an aggregate spend guard: an attacker may exhaust it and deny legitimate
users, so do not call it per-user abuse protection. Turn on `enforce` only
after those gates and a direct/proxy boundary smoke; choose thresholds from
the observed all-route peak with measured headroom.

The immediate non-destructive rollback for any observation latency/error is
`PUBLIC_API_ADMISSION_MODE=off`. For a future enforcement rollout, the same
mode switch reopens traffic without deleting schema or telemetry. Preserve
the prior function code versions above for a separate code rollback. Do not
run `db push --include-all`, revert the historical migration rows, disable
legacy routes, or remove the additive tables as an emergency response.
