# Selection before cards: server task continuity and unresolved product type

Draft PR145 candidate; not a public release or live acceptance PASS.
Previous live failures remain in `provider-array-bounds-20261102.md`.

## Root and changes

The boundary classifier correctly identified the parameter reply as a
continuation, but ordinary discovery still received only that latest reply.
The server-log loader already returned raw prior customer queries, separately
from its deliberately quantity-compacted evidence. Only pending-question and
rendered-product paths used an authoritative base request. The new generic
unrendered path consumes those existing server queries, not browser history.

- Enabled only with the existing mandatory-readiness server opt-in. Ordinary
  public OFF behavior, source replacements and established pending/card/section
  paths are not replaced by this fallback. Even an unverified submitted pending
  slot cannot use it to bypass the old slot checks.
- Requires a high-confidence model continuation decision (>=0.85), same active
  session completed-log evidence and no stronger existing context. This is a
  routing heuristic, not a proof that the model can never misclassify a topic.
- Explicit/new-task boundaries do not inherit earlier queries. Missing or
  failed server reads ask for the complete task instead of guessing a noun.
- Conflicting quantities sharing a unit across turns require explicit
  restatement: the fallback cannot safely infer axes, remove constraints or
  retain a superseded number. Established overrides retain their own engines.
- No text/constraint truncation: reconstructed tasks must fit the existing500
  character readiness scope; bounded source loader<=8 messages,<=3000 chars
  per source. Oversize asks for restatement. No new query, model attempt,
  provider, token/deadline budget, DB schema or table introduced.

Separate identity correction: an omitted model `catalog_classification_id`
must not certify a whole purpose-inclusive phrase as a product class while
a live «Тип/Вид изделия/товара/продукции» facet exists. Ask actual live type
values using the existing confirmation protocol. Exact literal customer/type
equality can bind its live criterion without a synonym assumption. Technical
properties such as «Тип хвостовика» are not identity fallback choices. Other
classification logic and existing card/criteria/price gates are unchanged.
The fallback is schema-role based, not a dictionary of product names.

## Readiness diagnostic, not a claim of complete semantic coverage

`v3_selection_readiness_decision.inputs` records at most8 declared parameters,
their bounded customer quotes, literal-ownership flags and questions. It does
not record private reasoning prose. A quote being literal is NOT proof that
it answers the declared parameter. The model can still omit a necessary axis;
this revision does not pretend deterministic completeness of that list.
The earlier wrong ready/known1 decision must be re-examined in a bounded live
run with this diagnostic. No per-product unknown-parameter patch was added.

## Offline evidence and gate

43 focused tests passed before the final conservative scope-length guard.
Both new HTTP regression tests fail against downloaded runtime84fa0e82:
unrendered parameter continuation, and omitted-ID/purpose-inclusive subject.
On the candidate both reach the intended question/card path. Model/catalog/DB
responses are mocked; this is not real-provider acceptance. Full local run:
2182 PASS/0 FAIL; OFF transport fingerprint unchanged
`5c457500fd3a9a65a5c917d71ec1ff9a970bc913d816a72944574eeb525dfbba`.
Final full regression including the500-character guard:2182/2182 PASS
(2m56s), Edge and new test typechecks PASS; all4 CI checks PASS.
Only closed preview deployed,291/JWT=true/ACTIVE, bundle
`28622621b17b537fcf8aee8363fd60db75f773538781a58f5e20dd9ab651c110`;
115/115 downloaded TS files match runtime8226df37.

## Authorized live follow-up: acceptance still FAIL

Exactly4 messages after fresh pair/max4 approval; no repeat, relay stopped.
QA-secret write moved versions to public681/preview292, not code changes.

-16ce400b-02b6-4365-9c39-8626ea28623c: subject question with actual5 types
  now works. Diagnostic exposes wrong readiness proof: «Материал стены»
  answered by literal quote «стены», known1/ready. Literal ownership does
  not establish that the quote supplies the parameter's value.
-8cf315e0-0be5-4257-abe8-a731431cd0be: real type chip preserves original
  request;4 cards of that type. Model then used «бур по бетону», an answer
  to the product-type question, as the object's material. Type confirmation
  PASS is not complete engineering readiness PASS.
-e5f67330-37a7-49df-8a62-22bc93a82794: explicit material/diameter/tool
  refinement FAIL. Classifier continuation0.95 and full rendered rehydrate
  succeeded, but ordinary discover again received only latest parameters.
  Unrendered fallback intentionally did not replace the stronger rendered
  path; the same context handoff gap remains there beyond the old syntax.
-04b24d48-8a3d-4b93-b779-3859575ee303: exact cable/new-topic PASS301₸/m,98m.

No actual Gemini fallback was called. Live closure of its prior400 and live
coverage of the unrendered fallback itself remain UNVERIFIED. No public
release. Current secret pair suffix1793618813_ccac12a80cd8a1d2e9bc21b195b815cb
is pending separately requested deletion confirmation. Full own evidence in
parent `outputs/qa-pr145-context-live-20261102/REPORT.md`. Old failures retained.

The local bounded QA harness now follows actual issued chips on either middle
turn. An out-of-scenario click is still blocked without upstream work, but
receives an explicit «Закрытая QA-проверка» notice rather than the widget's
generic unavailable error. Its page banner describes the limited sequence.
This changes only the local test harness, not the public widget/proxy policy.

After green checks, deploy only closed preview, download/compare the source,
then obtain a fresh20-minute pair/max4-message approval. Follow actual issued
questions, keep the exact cable control, no mass retry. Gemini fallback error
and universal readiness remain unverified until actually exercised. Keep draft.
Rollback baseline: runtime84fa0e82 (current preview bundle4148b2ae…), in a proper
checkout, deploy only the closed JWT-protected entrypoint and re-attest.
