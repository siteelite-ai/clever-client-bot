# Proof-preserving measurement repair — PR147, 2026-11-05

## Evidence and limits

The four-turn diagnostic preview run at `236258bd` ended in four verified
cards, not a transport failure. Final own request:
`8645772a-9d11-4916-8117-0ad2b3b491cf`.

Before the existing automatic correction, the complete conjunction failed at
clause 3 with `unprojected_measured_clause`. The customer operating point was
already resolved and projected (one domain, zero unresolved). A separate,
deliberately current-only checker flagged voltage in clause 2. The old notice
used that limited checker's units although the complete conjunction decided
the outcome. This explains the misleading voltage attribution.

After correction the declaration had three requirements instead of five, and
the complete conjunction passed. The live 230–690 V domain still covered the
customer's 380 V. Every returned SKU also passed its own numeric and primary
type checks. Raw rejected model clauses were not logged; this does **not**
prove what the omitted clauses said, or that every intermittent failure is
fixed. Evidence is in the workspace's
`outputs/qa-pr147-diagnostic-live-20261105/` directory.

Offline handler experiments additionally reproduced a separate structural
problem: explicit `product_requirements` passed through a legacy narrative
scrubber, which could silently remove an unsupported numeric obligation before
the complete proof. The extra channel-count condition in the regression is
synthetic; it is **not** a reconstruction of the unknown live clause.

## Shared correction

1. Keep the complete structured obligation contract separate from cleaned
   display prose. An explicit requirement cannot disappear merely because a
   narrative cleaner does not recognize it. Malformed structured obligations
   reject the declaration rather than being silently deleted.
2. When the existing correction attempt is needed, provide the actual failed
   clause and fixed reason code as data. Preserve only those previous numeric
   obligations for which the server already compiled an independent check.
   Recompile them with the corrected declaration; they do not authorize cards.
3. Derive the refusal's property from the complete conjunction's actual failed
   clause. If its property is unknown, use the existing generic truthful
   refusal; do not borrow voltage/current from an unrelated limited checker.
   Clear stale failure attribution on success.

The correction may revise an unsupported model assumption, but cannot weaken
the customer's conditions or bypass safety checks. Retained obligations come
only from request-local server proof state, not tool/browser fields. Bounds
remain fail-closed: at most 8 model requirements, 32 retained clauses and 1,600
combined characters; nothing is partially truncated. Original input size is
checked before deduplication.

## Scope and regression risk

This applies to the existing structured measured-selection route with a
server-certified measured relation, regardless of SKU, brand or test phrase.
Legacy non-structured selection, replacements, paired-fit routes, readiness,
models, frontend, MODX and secrets are not changed. It is not a claim that every
possible product property or physical relation is now supported.

No acceptance criterion is waived. Full per-SKU identity and measurement proof
still runs after the repaired contract compiles. A new rejection can expose an
obligation that the previous narrative cleanup incorrectly dropped. That is a
deliberate fail-closed behavior change, and must pass bounded live preview QA
before release. There is no additional model call or retry beyond the existing
correction attempt.

Raw clauses are used only in request-local memory and the existing model
correction exchange. Telemetry adds only bounded indices, allowlisted units,
fixed codes, counts and booleans; no raw clause, arbitrary facet name or secret.

## Offline verification

- Targeted shared helpers: 39 passed, 0 failed.
- Full real-handler fixture suite: 25 passed, 0 failed, including both new
  correction cases (preserved proven conditions and safe unknown-property
  refusal). Fixtures deny external network requests.
- Full offline V3 suite: 2,251 passed, 0 failed (57 seconds). This includes the
  existing context, catalog, measured-filter, replacement and handler tests.
- Closure-preview entrypoint type-check (including the public handler): passed.
- `git diff --check`: passed.
- No paid requests, preview update, QA-secret write, merge or production
  deployment were performed for this correction.

## Release gate

Exact-head CI and a fresh separately authorized bounded preview dialogue are
still required. Do not reuse deleted QA credentials. One success in the prior
diagnostic-only version is not proof that this new correction works live.

## Follow-up: narrow the correction response

The live run of `af40a3c6` did not pass. The first declaration accepted the
customer's inputs; the correction was rejected for exceeding the existing
`required_facet_values` limit. The later missing-readiness diagnostic was a
consequence of discarding that response, not a missing customer input.

When the structured measurement checker identifies a concrete failed clause,
the existing correction attempt receives a tool with only
`product_requirements`. The server retains the accepted readiness, retrieval
and filter fields and all original requirements outside the failed clause.
Only an exact whole-clause match can be replaced; compound entries are not
split or discarded. The merged declaration is still validated and must pass
the original conjunction and per-card checks. Extra fields, oversized lists
and malformed replies fail closed without reattributing the failure to
readiness. There is no new model attempt or change to the original tool limits.

Offline regressions cover the oversized full declaration after the four-turn
dialogue, valid narrow repair, unknown-property refusal, and retention of
unrelated requirements. All 2,253 offline V3 tests and the closure-preview
type-check passed. The live result remains unverified for this follow-up.
