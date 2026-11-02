# Provider grammar compatibility without relaxed selection rules

Candidate for draft PR145. Not a public release or live acceptance PASS.
Fixes the transport design behind the observed Gemini HTTP400 after a real
subject chip in runtime0de8791d. The precise offending provider grammar node
was not identified; removing bounded-array expansion is a documented remedy,
not yet proof of acceptance by the real provider.

## Contract

- Canonical schemas remain unchanged. A shared transport adapter moves only
  `minItems`/`maxItems` from the provider grammar to a server check; the counts
  remain instructions in field descriptions, and the server rejects violations.
- Types, required fields, live ID enums, property allowlists and string bounds
  remain in the provider schema. Existing semantic/readiness/subject, ownership,
  measured fit, frozen criteria, catalog, price and per-card checks remain.
- The entire declaration is rejected on overflow, before readiness or search.
  Nothing is sliced, repaired silently or accepted as a partial safety plan.
- Primary, bounded fallback and any existing eligible correction share the
  same compact tool and bound check. No additional attempt, model switch,
  deadline, token budget, permanent key or settings change.
- Applies by schema shape, not by customer wording, product name or category.
  Initially enabled only with the existing operator-owned mandatory-readiness
  lane in closed preview. Released default-OFF transport is unchanged. No
  browser field or QA key can enable the lane on public production.
- Ref/union/conditional schema expansions are rejected by the adapter until
  branch-aware validation exists; it never silently strips unknown semantics.

Google documents `maxItems`, especially nested arrays, among causes of the
observed too-many-states error and recommends lowering/removing these limits:
[Gemini structured-output limitations](https://ai.google.dev/gemini-api/docs/structured-output#limitations).
The application still owns validation of the generated values.

## Offline evidence

- New forced-timeout HTTP/SSE fixture: actual subject question and selected
  live type → primary timeout → fallback schema check → one matching card,
  excluding sibling type and conflicting diameter. Exactly two model attempts
  after the chip, not a third correction. All model/catalog/DB traffic mocked.
- The same new test fails against the downloaded0de8791d handler: fallback
  receives bounded schema and the mock reproduces the provider HTTP400.
  This is a regression reproduction, not an independent provider compiler.
- Overflow fixture rejects seven compatible IDs (canonical maximum six)
  before product search and without another model attempt.
- Adapter tests: immutable canonical schema, retained enums/types/required,
  exact cardinality edges, nested min/max, atomic measurement requirements,
  fail-closed unsupported schema shapes. Initial focused run21/21 PASS.
- Edge and new test type checks PASS. Broader regression and live check are
  recorded separately after completion; do not infer them from these results.

## Release and rollback

Keep PR145 draft. Deploy only `chat-consultant-v3-closure-preview` with
`verify_jwt=true`, download it and compare all source files with the candidate.
Before a bounded live run, obtain the fresh temporary-pair approval and max4
message budget; preserve actual request IDs and failures. Delete only the exact
new pair after separate confirmation. Do not weaken final card checks to pass.

Previous preview source: commit0de8791d, downloaded source retained in the
workspace backup. To roll back use that revision in a proper checkout, deploy
only the closed preview and re-attest its source/JWT. Public code remains at
hash522237f2a785aee9adbcacf3a54ca6954c05f1d78904ceb9707840b68e7a6f69.
