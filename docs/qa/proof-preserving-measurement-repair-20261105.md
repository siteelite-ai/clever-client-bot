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

## Follow-up: isolate the focused repair wire contract

The live run of `bf927b6d` reached readiness with all three answers accepted.
It projected the voltage condition and identified an unprojectable
current-related clause. The repair attempt was rejected before per-card
verification, with the catch-all `invalid_repair_contract` (request
`cdb33315-182c-42e6-b70b-2d11445c6b90`). The response arguments were not
retained. That record does not prove whether the model returned extra fields,
no call, invalid JSON, an empty array, or a result that failed after merging.

Code inspection found a contract conflict independent of the historical
response: the full declaration and one-clause correction shared a tool name,
and the correction inherited instructions to supply full-declaration fields
that its schema forbade. The focused route now has a distinct tool identity
and a dedicated prompt with only the failed clause, bounded schema and
untrusted catalog evidence, and server-owned request context. Legacy
correction routes retain their existing tool and prompt.

The focused parser distinguishes absent, malformed and non-object arguments;
the validator distinguishes wrong/multiple calls, unsupported fields, missing
or invalid requirements, and explicit unresolved responses. An unresolved
response does not replace or delete the failed condition. Telemetry includes
fixed codes, a capped call count and an allowlisted completion status, not
raw arguments, model prose or catalog evidence. No retry, size limit,
materialization requirement or per-card proof is relaxed.

Offline tests exercise the four-turn “6А” scenario with valid, oversized,
malformed and unresolved corrections using fixture responses. The valid
correction yields four checked fixture cards; the invalid cases yield none
without treating customer inputs as missing. All 2,257 offline V3 tests,
the closure-preview type-check and `git diff --check` passed. Live acceptance
for this change has not been run.

## Follow-up: anchor focused repair to the confirmed load

The live run of `a97a7054` accepted the repair wire format and recomputed
the product proof. The failing clause changed from a current quantity of
6 A to 10 A (request `6bdb136e-fe23-4dbe-9d20-6303238dcf6d`). The 6 A
customer value was still present. The final gate rejected the new clause as
`customer_implication_not_proven`, before final product search. Raw wording
was not retained, so the source or comparator of the 10 A cannot be inferred.

Focused repair now receives the server's canonical range requirement and
verified load, not live range endpoints or a private SKU sample. The focused
route skips the unused private product probe; legacy correction still uses
its existing evidence path. A server-side guard rejects current magnitudes
other than the verified load (including a unit-equivalent comparison) before
merging the response. A full range clause can mention catalog endpoints only
if the existing certificate independently proves that entire clause. The
guard never treats a matching number as proof of an independent property.
It never rewrites 10 A to 6 A or removes an unresolved condition. Initial
readiness, the conjunction check, final filters and per-card proof are
unchanged; no retry was added.

The four-message offline regression covers an unsupported 10 A replacement
and the grounded 6 A path against the same synthetic draft. The bad reply is
logged as `unverified_load_point` and triggers no product search. The good
reply retains the two live intervals and verified voltage, yielding only the
four checked fixture cards. All 2,260 offline V3 tests, the closure-preview
type-check and `git diff --check` passed. No live or paid test is part of this change.
