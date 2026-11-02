# Nonempty application inputs on the provider wire

Follow-up to runtime551b live QA: request03f7a84e-38fe-4a91-a408-8eefef160418.
Context and frozen diameter/SDS/type were retained. Primary reasoning timed
out after11.5s; Gemini returned a declaration without the previous HTTP400,
but supplied critical_inputs=[] and failed application_inputs_omitted.
No search/cards followed. Control cable301KZT/m still passed.

## Consistent contract, not a product exception

The existing server predicate already requires nonempty critical inputs for
application/measurement selection. The old provider schema nevertheless allowed
an empty array, and its generic policy also legitimately allowed [] for plain
browse. The wire now represents a REQUIRED first object plus the remaining
array only when that same server predicate holds. Both initial and alternate
provider calls use the same schema and decoder. No product/material lists,
fact inference, new classifier, extra retry, source-role bypass or guard removal.

The category-neutral tool adapter restores representation without inventing,
dropping or truncating inputs. Canonical arrays remain accepted only by the
same old semantic validator (which still rejects application []). Malformed
head/rest objects are rejected. All item required fields, source/quote,
readiness/subject, engineering and final-card checks remain in place.

The existing array-bound adapter still removes provider grammar bounds and
enforces rest cardinality on the server. A required first object is what rules
out the empty case on the wire; no unsupported nested minItems added to Gemini.
Ordinary browse, replacements and default-OFF wire are unchanged. The generic
readiness model can still omit an axis or misassign quote roles; this does not
claim complete semantic coverage.

Also defer opt-in fallback recovery diagnostics until contract validation.
Malformed declarations log contract_unverified, not recovered merely for200.
Existing model choices, deadlines, provider attempts and token cap unchanged.

## Evidence and boundaries

- Revised real HTTP test fails against551b before the correction: the actual
  fallback schema allowed [] rather than requiring its first object.
- Same test follows the new wire shape and asserts timeout→Gemini→decoded
  readiness→subject→verified card, with exactly2 declarations on that turn.
- Negative HTTP fixture omits first and asserts no catalog search, no third
  call and no false recovered event.
- Pure adapter tests cover nonmutation, all-item retention, missing/wrong/extra
  fields, overflow, canonical empty/absent state, invalid path/schema.
- Live551b results and cleanup evidence are retained in the parent workspace
  outputs/qa-pr145-role-handoff-live-20261102/. Exactly4 paid messages used.
  Both temporary secrets1793625729 were verified removed; relay stopped.

Full regression/typecheck and final runtime identity are appended below after
execution. This correction has **no new live-provider acceptance** and must not
be described as a production release or a guaranteed solution to model errors.

Local result: **2190 passed, 0 failed (3m2s)**; final typecheck passed.
OFF transport SHA256 remains
`5c457500fd3a9a65a5c917d71ec1ff9a970bc913d816a72944574eeb525dfbba`.
Neither a local mock schema check nor these regression counts prove the actual
Gemini grammar compiler accepts the new first/rest representation. That needs
a bounded live compatibility check; no additional paid message has been sent.

Before preview deployment public686/preview298 were ACTIVE, JWTfalse/true;
both temporary secrets removed, permanent metadata unchanged. Public bundle
remains522237f2a785aee9adbcacf3a54ca6954c05f1d78904ceb9707840b68e7a6f69.
Preview rollback is runtime551b5329 (or docs-onlyd927c08b with identical code),
deploying only chat-consultant-v3-closure-preview with JWT verification kept on.
Do not deploy the public function or restore/delete unrelated secrets.

## Closed deployment verified

Runtime27d4bb0d, closed preview299 ACTIVE, JWT=true; bundle
6208922b2681e98414d3a9f6a9788e53364ba0dac9b6b6577d81215148fc0b5e.
Downloaded116 TypeScript files match this worktree byte for byte. All4 CI
checks for the runtime commit pass (2 Edge,2 widget-contract/Vite).
Private boot/admission probe returns403 without a QA key, without paid calls.
Public686 remains ACTIVE with the same522237f2… bundle/JWTfalse; permanent
secret metadata unchanged, temporary names empty. These are deployment and
access-control facts, not live selection acceptance of27d4bb0d.

## Subsequent two-message live control: not a readiness PASS

Exactly2 additionally approved messages were sent to runtime27d4bb0d:

- Full request for a bore for a concrete wall,8mm,SDS-plus: FAIL,
  request9507888e-28b4-472a-811d-33571624199b,7.4s. Initial live category
  «Материалы для сверления» was rejected by the category/target guard. Model
  rediscovery noun«бур» was then rejected as ungrounded, despite its literal
  occurrence in the request. No product lookup or readiness declaration ran.
- New-topic exact cable: PASS301KZT/m,98m,
  request9fb80dd3-c1a7-4634-bc74-7587121c71f0,5.1s; complete18-match price proof.

The lexical category guard ignores substantive words shorter than4 except
uppercase acronyms; its parent-category relation is also lexical. That code
was unchanged in27d4, and the new wire was never reached. Do not claim the
first/rest representation or actual Gemini grammar compiler passed live QA.
Do not call the generic no-products text proof that no products exist.

Next design work must distinguish literal customer ownership, a live category
candidate for clarification and an approved search/render class; use live type
facets plus verified customer confirmation, not product alias lists or a broad
lowering of guards. Application-object mentions must not authorize sibling
types (cable for pump must not become pump search). No such additional code
change has been made in this two-message test turn.

Pair1793627698 was approved and both exact names verified removed. Old access
returns403, local key file removed, relay stopped after2. Public689/preview302
retain their previous code hashes/JWT; permanent secret metadata unchanged.
Persistent live evidence: parent outputs/qa-pr145-two-controls-20261102/.
