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
- Edge and new test type checks PASS. Final full offline regression:2173
  passed,0 failed (3m6s). The first broad run had2172 PASS and one source-text
  assertion referencing the old local variable name. That assertion was
  updated to the new shared wire variable and strengthened with checks for
  the OFF passthrough and bound guard, then the entire suite reran green.
- Default-OFF transport fingerprint is unchanged:
  `5c457500fd3a9a65a5c917d71ec1ff9a970bc913d816a72944574eeb525dfbba`.
- All four GitHub CI checks for runtime84fa0e82 passed: Edge checks and
  widget-contract/production Vite builds on both branch/PR events.

## Closed deployment, not live acceptance

Only closed preview was deployed: version287, JWT=true, ACTIVE,
SHA256 `4148b2ae1180a3e162698745829cc03f87398398fb636867b64df1f5bd206c06`.
Downloaded114/114 TypeScript files match runtime84fa0e82 exactly.
Management attestation: permanent-secret metadata unchanged, no temporary
QA keys present, public code/JWT unchanged (public version677, ACTIVE).

## Subsequent authorized live check

After separate user approval a fresh20-minute pair was created. Exactly3
backend messages were sent (within the max4 budget), with no repeats. The
actual type-choice step was skipped because no type question was issued.

- `f6dda1cb-f0e5-43b5-b971-a794ca63c63c`: initial wall/drill query FAIL.
  Primary model accepted the wire schema but declared ready/known1 without
  asking. Subject became the whole phrase «сверло для стены»;15 search
  candidates,0 passed target gate, empty answer.
- `d783bcdc-4252-401d-8aca-c1aeee21346e`: explicit material/diameter/tool
  reply FAIL. Classifier correctly said continuation, but discover received
  only the latest parameter reply. The earlier noun was then rejected as
  ungrounded. There was no verified pending slot to restore the original task.
- `822d0148-5cbd-4e37-bb6e-54d52e916e5d`: exact new-topic VVG control PASS,
 301₸/m,98m; complete price proof retained.

No real Gemini fallback was reached: live closure of its earlier HTTP400 is
still UNVERIFIED. Do not substitute the mocked compiler test for that fact.
General readiness/subject/context acceptance remains FAIL; no public release.

The user's additional meter-chip attempt `e30d237a-1d2b-42d9-a5df-ea53e4672b36`
was locally blocked by the QA relay's completed-sequence guard (browser log
proxy HTTP403 at127.0.0.1:8768; no backend row), not a production outage.
Separate observed UX debt: unit alternatives include the already active unit.
No unit-transition implementation/testing change or product-specific rule was
made in this run. Relay stopped after3 messages. Only temporary pair suffix
`1793616584_70430f2886b0efff253b4c4bca249e67` remains pending separately requested
deletion approval. Permanent metadata and public code/JWT unchanged.
Full own SSE, logs and screenshots in parent workspace
`outputs/qa-pr145-wire-live-20261102/REPORT.md`.

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
