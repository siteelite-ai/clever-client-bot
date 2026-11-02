# Product subject across readiness, search and render

Status: candidate for PR145; **live end-to-end acceptance blocked by provider
schema rejection, no public release**. Runtime `0de8791d` checked 2026-11-02.
Base: `ce9121bf` / tested runtime `b14b0282`. Previous live FAIL remains recorded
in `selection-input-contract-20261101.md`.

## Live follow-up of 0de8791d

Exactly four authorized messages: material question PASS, actual live type
chips PASS, selected type restored the full task and all three frozen criteria
(diameter8, SDS Plus, concrete bit), exact cable control PASS (301 ₸/m,98m).
But **no final bit card was verified**: after the primary11.5s attempt the
existing Gemini fallback returned actual HTTP400, schema grammar too complex.
This is not evidence of quota/rate-limit exhaustion and not a product-empty
result. The failing schema's individual offending element is not established.

Request IDs: `124879dd-12cb-4fb5-a29a-150345013f08`,
`06877f35-51f9-4fec-9928-ab0274ae5baf`,
`24377f87-9ca9-4b08-9046-9f205d25f3ed` (schema failure),
`325f528f-28bf-4c42-b5b5-b4168bc90619` (exact cable).
Next: test/simplify provider wire-schema complexity without dropping server
validators or adding paid retries. Reference:
[Gemini structured-output limitations](https://ai.google.dev/gemini-api/docs/structured-output#limitations).
No such code change or paid repeat was made in this live run.

Relay stopped after4 messages. Following the user's separate confirmation,
both temporary secrets ending `1793609771_36dab5d872b0222392eed61b4f7a7ff2`
were permanently deleted on 2026-11-02. UI and management metadata show no
temporary secrets; the removed access key receives HTTP403 without an LLM
call. The local credential file was removed. Permanent-secret metadata and
public/preview code hashes and JWT settings remain unchanged by cleanup.
Public/preview versions became677/286 after secret deletion, not a code deploy.
Full local evidence is in parent workspace
`outputs/qa-pr145-subject-live-20261102/REPORT.md`.

## Root and bounded design

Discovery may receive the complete server-scoped customer request. Its
`resolved_from` is therefore not a product-class label, and a formal category
need not be the customer's class. The previous terminal paths required a
nonempty target which neither source could establish in the drill-bit case.
Do not make the taxonomy self-authorizing or expand Russian prefix matching.

Only in the existing closed-readiness lane, and only when the legacy target
is still missing, the **same existing reasoning call** now also declares
`selection_subject`:

- `customer_phrase`: a bounded literal quote of the original product class;
- `catalog_classification_id`: one opaque ID from the discovered live class
  facet, or empty if the model is extracting a literal title class only.

No product dictionary, synonym rule, category-specific slot, new model or
additional classifier call is introduced.

The controller distinguishes three outcomes:

1. A literal customer class, without a proposed catalog alias: preserve that
   class as the target. All existing title, taxonomy and card gates still apply.
2. A proposed live name is not in the customer's affirmative facts: **ask for
   the type**, offering only actual values from that same live facet. No search
   or cards in that turn. This is a confirmation, not an asserted synonym.
3. The customer explicitly supplied/selected that live class: freeze it as the
   target and retain an independent exact class-facet gate on final cards. The
   original class spelling may use the existing mapped-phrase mechanism only
   with this confirmed facet obligation; numeric/budget/other frozen criteria
   are not removed. A repair cannot replace the frozen subject with another.

Readiness of engineering inputs is checked first. Unknown material still gets
its own question; it is not obscured by a subject-confirmation question. A
customer can therefore see another type question after providing material if
the names still cannot be safely connected. The added dialogue turn costs the
normal next-turn processing; it is not a free, automatic synonym resolver.

## Single-choice and trust boundary

When a live facet has only one value, the server-owned subject exit may issue
one real chip (plus the widget's existing free-text alternative). Ordinary
model tool calls still require 2–5 choices. The shared resolver revalidates
exact live values before enabling the single-choice policy. A request field
does not enable it. No frontend code changes.

Continuation still requires the latest completed server response to have issued
the exact pending slot in the same session. It is not authorized by browser
assistant history, a random UUID or an old question. The whole request is kept;
the existing 500-character scope limit is not silently truncated.

## Checks and limitations

- Real HTTP/SSE fixtures: proposed class → pending question → actual class chip
  → original task/diameter8 preserved → one correct card; sibling class and
  diameter10 do not render. A one-value live facet completes the same roundtrip.
- Literal extraction works when the formal category differs, without forcing
  a synthetic synonym or another question.
- Invalid/unknown IDs, invented quotes, markup, negative class statements and
  embedded-word quote false positives are rejected. Default schema excludes
  the new field; the structured-measurement adapter preserves it when enabled.
- Generic controller unit cases also use other Russian and English terms.
  These are fixture protocols, not evidence of live semantic performance.
- The new HTTP regression fails on the **downloaded previous b14b0282 runtime**,
  through a temporary import map; neither baseline source nor guards changed.
- The unchanged earlier category-intent rejection still blocks a separate
  unmatched synthetic category. The new subject contract does **not** bypass
  that guard and does not solve every category-resolution failure.
- The model still extracts the role of a customer phrase / chooses the class
  facet. Literal ownership does not prove its semantic role. Confirmation and
  downstream checks reduce risk but are not a guarantee for arbitrary language.

Local evidence, 2026-11-02:

- Full Deno regression: **2166 passed, 0 failed** (1m58s). The final additional
  quote-boundary hardening is also covered by the subsequent targeted run.
- Final new subject + real HTTP/SSE handler tests: **22 passed, 0 failed**.
- Final Deno typecheck: PASS; Vite build: PASS (existing size/Browserslist warnings).
- OFF transport SHA256 remains
  `5c457500fd3a9a65a5c917d71ec1ff9a970bc913d816a72944574eeb525dfbba`.
- Node QA full serial run: **449 passed, 2 failed** (wall-clock connection / failover
  timing assertions). Both affected tests passed in one focused rerun (2/2).
  Their widget/test/dependency files are unchanged from the previous candidate;
  no timers or assertions were edited. Do not label the original full run green.

The first expanded regression had one failure: an additional synthetic category
was rejected by the **earlier** category-intent guard, before this contract.
It is now an explicit negative test preserving that guard, not a claim that
the new subject mechanism fixes earlier discovery failures. Another initial
fixture used application material as if it were an exact product attribute;
the final negative checks the customer's independently frozen diameter instead.
No production filter was weakened to satisfy either fixture.

No paid queries, new QA secrets, production updates, model
changes, settings changes, migrations, MODX or server3 operations in this revision.

## Release gate

Keep draft. After CI, deploy only closed preview and verify its downloaded
source matches the candidate. A bounded live check must follow the actual
questions: ambiguous request → material/diameter/tool answer → actual issued
type chip if needed → exact cable control. Obtain a fresh temporary QA-pair
confirmation and the bounded message budget before sending it. Keep the
previous failed acceptance record until this end-to-end path really passes.
