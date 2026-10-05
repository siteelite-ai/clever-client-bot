# Preview audit — 2026-10-05

## Prerequisite and classification checkpoint (current work)

Candidate `333be94e` is deployed to preview only. Production remains 448.
No production merge/deploy; PR #67 remains DRAFT / NOT READY.

- `c2fef9bb`: the existing reasoning declaration can explicitly return
  `clarification_question` instead of an incomplete selection contract.
  It preserves the original selection/category scope, skips premature numeric
  correction/search, and supports bounded novice assistance on the new slot.
  Removed the contradictory instruction that prohibited any question even
  when an essential condition was missing. Empty question preserves ready
  selection. This enables clarification; it does NOT prove reliable model use.
- `4f4aadd2`: numeric inequality/range labels no longer bypass physical-unit
  ownership through punctuation-stripped lexical matching. Reproduction:
  customer length 10 m exposed nominal-voltage value ≤ 10 kV.
- `333be94e`: a customer-owned classification family needs its complete
  shared qualifier, not any coincident word. Reproduction: generic installation
  “line” incorrectly selected “overhead transmission lines”. Existing household
  surface/suspended family behavior remains covered and passing.
- Local verification: 861 shared tests and Edge type-check pass. 36 acceptance
  harness/matrix tests and 4 loader tests pass. Widget session suite initially
  could not load jsdom; reused the already installed dependency via an ignored
  node_modules symlink, then **37/37 session tests passed**. No production
  dependencies or lockfiles changed.

### Actual results before the final family correction

- Preview 658 (`c2fef9bb`), prerequisite dialogue 2×: incomplete. One initial
  turn asked about supply (f9564e3e-82f3-4682-a8e8-3d4f2239cb10), the other
  assumed supply and rendered products (14d1fcf4-001d-4e35-b1b2-1b129b20094b).
  Neither follow-up produced a valid selection. Explicit-input tests also
  failed: false nominal-voltage constraint ≤ 10 kV; one request took 50 s.
  CI 37323088132 passed, which did not establish customer acceptance.
- Preview 659 (`4f4aadd2`): initial original question returned four exact
  3×2.5 cards in 7.5 s (5ef4a0cb-dbea-46fa-add1-2c89577c0aa6), but did NOT
  ask the missing-input question. The subsequent detail message returned empty
  (d559a240-5da4-4251-8520-efcc5c36a7c0).
- Explicit-input response b9baf247-187f-42fe-af56-1d5a0856529c returned in
  5.6 s without the false voltage condition, but included KG and declared an
  overhead-line class from the generic word “line”. Thus the complete
  explicit-input case still failed. The subsequent family fix addresses that
  projection, not yet a claim of full engineering suitability.
- Added `customer-prerequisite-dialogue-cases.json`: asks for missing
  prerequisites, then must finish with multiple matching products; a second
  case supplies conditions immediately and forbids ending without products.
  Original 28-case acceptance suite remains unchanged.

Full 28-case run on `333be94e` / preview **660** finished: **25/28 automated
cases passed**, not customer acceptance. Production **448** and preview **660**
were independently confirmed via the management API after this run.

Failures:

- Living room, `373dd7c1-9298-440d-bd9e-3c39e77f073d`: no products;
  the aggregate gate asks one item vs several after a total-light calculation.
- Yard after area/height, `066d41e7-6adb-414f-92ce-9847543bab0c`: same gate;
  no products. The visible reply also repeats appended contract text.
- Outdoor analog CCTV after conditions,
  `58275527-95eb-466b-9f62-765601efdc9e`: same gate incorrectly treats
  **30 metres of purchased cable** as an unresolved system-capacity allocation.
  The visible reply already states coaxial 75 ohm and outdoor jacket needs.

The shared mechanism is not three independently empty catalog searches:
all three stop at `v3_aggregate_selection_configuration_required`, with no
operational error recorded. Quantity to purchase, application extent and
per-item capacity must remain distinct. Do not simply disable the aggregate
guard: total demand still must not certify under-capacity individual items.

Added `customer-aggregate-completion-cases.json`: two follow-up tests require
finished selections after choosing one item, and the CCTV case rejects the
irrelevant configuration question. Original acceptance assertions unchanged.
Its product-name checks still do not establish full physical suitability.

Follow-up probe completed on the same preview 660 (raw compact evidence:
`aggregate-completion-preview660-20261005.json`):

- Living room: three residential ceiling fixtures returned after the one-item
  choice; request `5bca3ce7-500a-4c37-9be9-106e8053b294`. The 3750 lm minimum
  survived, but an unrequested mandatory “Диммирование: Да” appeared with
  `user_explicit` provenance. Automated PASS is therefore not full acceptance.
- Yard: five cards returned, `3ced8516-fcb5-45e6-8bbe-25f5cbe07855`.
  **Semantic FAIL despite automated PASS:** the only new user information was
  “one item”, but the previously visible total changed from 3500 lm / 100 lx
  to 350 lm / 10 lx. No customer-authorized change in use was supplied.
- CCTV: repeated failure `65715eed-c669-41dc-a5fd-26a4bdeb7a6a`, same
  irrelevant one-vs-many question after stating 30 metres of required cable.

Code inspection: `selectionReadinessScope` persists only the original user
token, category and assistance level, not the visible engineering declaration.
`resolveScopedCatalogSelectionContinuation` rebuilds the next selection from
that user token plus the answer. The next reasoning pass can thus recreate,
rather than refine, the prior quantitative plan. This is an evidence-backed
candidate cause of the yard drift; no claim that a prompt tweak alone fixes it.
Next correction must preserve a validated plan across configuration changes,
distinguish purchase quantity from performance demand, and reject invented
customer-owned boolean criteria. Existing aggregate capacity protection stays.

The sensor test remains a **semantic failure despite automated PASS**: it
returns acoustic-sensor titles under a movement-sensor catalog facet. The AC
original case passes but does not prove the stricter prerequisite dialogue
works. No production release is justified by the 25/28 count.

Remaining work includes reliable
use of the clarification outcome, normal detail-only continuation without a
pending question, application suitability, catalog/provider reliability,
aggregate dialogue completion, sensor semantics, and final browser regression.

## Terminal-contract and scalar-evidence checkpoint (historical: preview 657)

Preview 657 = `12ae96ba`; production remains 448 (verified via management API).
PR #67 remains DRAFT / NOT READY.

- `cc67d7a6`: terminal selection now uses the same measured-criteria compiler
  as retrieval and restores frozen mandatory obligations afterward. Diagnostic
  `36c994cf-e303-4189-acf8-a3b3d3f82481` proved that the former raw projector
  reintroduced a weak maximum voltage not present in the retrieval contract,
  rejected every candidate with missing voltage metadata, and entered a
  differently constrained recovery. Catalog core-count/section data were
  present; inventing product traits was neither necessary nor acceptable.
- Exact compound evidence no longer accepts an additive marking fragment.
  `12ae96ba` also extends the shared exact-count contradiction gate to sum
  every component of a visible N×S + M×T construction. This covers derived
  count requirements even when the consultant did not literally write N×S.
- `12ae96ba`: customer-evidence matching preserves decimal scalars instead of
  treating the integer pieces of 3.4 as customer-owned numbers. The old path
  could turn an unrelated 3 kW load into a mandatory live weight of 3.4.
- Acceptance now rejects additive false matches. Repaired the suite metadata
  test (27 source cases plus the existing novice regression) and supplied the
  missing novice wording variation; did not reduce acceptance requirements.
- Local verification: 856 shared tests, 36 acceptance-harness/matrix tests,
  Edge type-check, and diff whitespace check passed.

### Intermediate live failures — not closed by a single successful request

Three runs on `cc67d7a6` (before the decimal/count follow-up):

1. `911969d0-1512-45b0-99e2-359b26492e54`, 14.4 s: automated PASS but
   manual FAIL because 3×2.5+1×1.5 was included. New acceptance gate detects it.
   Terminal diagnostic confirms the unowned voltage maximum is no longer added.
2. `7136f8a8-3cb7-4874-94fe-c9b31c363ffc`, 22.7 s: catalog rate_limited;
   reasoning also acquired the unrelated weight 3.4. Decimal fix addresses
   the latter only; transport failure remains separate.
3. `123a5f4a-ab03-4527-9060-12afc82a8220`, 19.6 s: primary reasoning timeout,
   retry returned an unexpected `google:python_interpreter` call with finish
   `length`, not the required declaration. No usable reasoning was available;
   still an OPEN reliability defect, not a connection/cache diagnosis.

### Latest preview 657 evidence

- Actual widget with explicit new-topic message: four 3×2.5 cable cards,
  no additive extra-core item and no connection error.
  Request `aa22a4c7-b0f1-4020-8ddb-3534640842e3`.
  Screenshot: `/private/tmp/220volt-preview-cable-20261005.png`.
- Three independent audit-12 repetitions: **0/3 PASS**, about 13.2 seconds
  each. IDs `922439d5-3e4b-4c63-a4e9-63018aa623a6`,
  `9f9adfeb-a397-4a57-bb3f-9bdc72ae8572`,
  `a1a2f35d-802f-421c-ab6f-911f5c43b448`.
  No transport errors in these three calls, but all include 2-core/4-core
  candidates. Reasoning describes different phase-dependent configurations;
  log 922439d5 confirms only section criteria enter the contract, no core count.
  This is an OPEN ambiguous-branch projection defect. Do not force an
  invented three-core customer constraint from the unrelated 3 kW load.
  Next: retain the conditional branch structure and request the missing
  discriminating input before a definitive selection, or prove a single
  chosen branch. Do not solve by a cable-specific count default.
- Cross-route checks passed: exact VVG cheapest
  `c5d5f364-57cd-49c3-afa3-a49d2a7f1b71` (3.4 s),
  1P C16 under 1000 `be29a9b0-6d97-40b5-9e3d-61b7a97575b4` (12.3 s),
  CORN E14 `9e00311c-5a05-46f8-8a73-d0f19853d672` (21.8 s).
- CI 37321617410 passed for `12ae96ba`.
- Earlier 24/28 result is historical, not a claim that the latest candidate
  passed the complete suite. Full suite, free-form aggregate continuation,
  sensor subtype and outdoor application evidence remain open.

## Measurement-scope continuation (historical)

Candidate `5555fc2d` is deployed to preview only; production unchanged.
This section supersedes older numerical-scope status below. NOT READY.

- `237049da`: add a literal per-product evidence span to the reasoning schema.
  It must be visible in the explanation, explicitly per-item, contain a physical
  quantity and exclude aggregate calculations. Only that span may constrain
  cards when the explanation also calculates total demand.
- `e86af3d0`: when only total demand is known, ask configuration before claiming
  cards satisfy it. The exact single-item choice transfers total demand to that
  item. Free-form choices and multi-item configuration still need regression
  coverage; do not claim the whole dialogue family is complete.
- `5555fc2d`: optional numerical correction now sees the previous explanation
  and cannot erase validated required facets or customer-owned classifications.
  Nearest-sufficient ranking preserves alternatives while ordering them by
  distance from the stated minimum, rather than arbitrary API order.
- 851 shared-tool tests passed and Edge type-check passed on the final code.
  A pipeline test proves a visible per-item 4000 lm minimum rejects a 3000 lm
  card even when the aggregate calculation mentions 3000 lm.

### Live evidence and remaining failures

- Browser on e86af3d0: `447a8648-a47c-4e84-a0ca-f541fdf1932e` asks configuration
  without rendering cards. Reply `Одно изделие для всей задачи` continues rather
  than repeating the question (`5394cb60-7766-4192-980d-63700366587d`). The latter
  enforces 18000 lm but exposes poor ranking and loss of an earlier qualitative
  requirement during correction; 5555fc2d addresses those mechanisms, not yet
  proven end-to-end on this same browser sequence.
- Screenshot: `/private/tmp/220volt-preview-measurement-audit-20261005.png`.
- Full 28-case suite on e86af3d0: 24 PASS, 4 FAIL. Living-room, yard and parking
  scenarios ask configuration instead of satisfying the expected card count;
  these are OPEN, not reclassified as passed. Cable for air conditioner also
  fails. No acceptance assertion was weakened to hide these failures.
- Final 5555fc2d targeted checks: CORN E14 PASS
  (`a8e15805-accd-41d0-b333-482f8b8ef854`), apartment 7 kW breaker guidance PASS
  (`b0fc16df-3ba3-43b0-a9f3-b14b178127a7`), air-conditioner cable FAIL
  (`c32bdb2b-d16b-4167-abed-efeec5fdd00b`).
- Cable diagnostic: reasoning selects 3×2.5 and a 2.5 mm² minimum; four cached
  titles match the compound marking, but none passes the numeric evidence gate.
  A generic later recovery wrongly explores `Провод А, АС` and also returns no
  qualifying products. Next action: inspect real product traits and existing
  compound-dimension evidence mapping; do NOT restore fabricated filter proof.
- Outstanding: finish quantitative/application consistency, prevent irrelevant
  recovery, validate free-form/multi-item replies, resolve sensor-type semantics
  and outdoor suitability, then repeat the full suite and actual widget checks.

## Latest checkpoint (supersedes historical status below)

Production remains version 448. Preview 651 was confirmed after deploying
`815cfb68`, which adds bounded supplementary verification. PR #67 remains
DRAFT / NOT READY.

### Implemented since the earlier checkpoint

- `bee8cb26`: explicit `Новая тема` takes precedence over pending clarification
  and clears stale scoped selection inputs. Live transition from underground
  cable to Acti9 passed (`4bf19546-3e82-4d04-9a44-a4abfb3b9be0`). This does
  not claim that every implicit topic switch is solved.
- `bee8cb26`: malformed optional reasoning correction no longer discards the
  prior validated declaration. Live analog-camera request
  `f914c28a-3345-4639-8bdc-2a7e0aa687f9` completed; diagnostic confirms
  `retained_prior_declaration=true`. Outdoor suitability still needs proof.
- `bccffc30`, `ae23dff7`: mandatory requirements are no longer fabricated as
  product traits. Missing traits may be projected only from matching actual
  catalog filters tied to the same result pool, not query words or intentions.
- `815cfb68`: a short verified selection gets at most two supplementary
  catalog searches preserving all mandatory facet filters and all final gates.
  Existing safe candidates are retained. Exact/alias routes and single-result
  requests are not widened. No product-name or category-specific rule added.

### Verification and unresolved findings

- 847 shared-tool tests passed; Edge Function type-check passed on 815cfb68.
- CI 37313727313 passed on ae23dff7.
- CI 37315145905 passed on 815cfb68.
- Preview 651: audit-02 (cable then motion light), audit-18 (Acti9 analogs),
  audit-25 (black sockets then white follow-up) passed automated assertions.
  Sensor-subtype/manual acceptance limitations below still apply.
- Two further audit-02 repetitions passed all six turns: cable in 1.6–1.8 s,
  light replies in 11.4–12.4 s, five cards each. Light request IDs:
  `54ed0c28-5d35-4b9e-9780-0bf6e93b6f7d`,
  `3dad85ff-0041-41a7-aa04-b3ab7acf8c30`,
  `4dc48e81-3062-4937-8e6c-65849a994ca2`,
  `ce8ffa82-2cb0-4996-aeb3-30fd9d8d7ae8`.
  Each still includes the two opto-acoustic models; manual acceptance is red.
  These successful repeats alone do not establish that the new supplementary
  branch was exercised (a zero-result route already had its own recovery).
- Three repetitions of audit-02 on preview 650 completed without a connection
  error. Exact cable selection passed all three times. Of six light responses,
  one returned one Gauss and five returned five cards. This is NOT acceptance:
  the five-card answers included acoustically triggered models.
- Example short response: `211720b0-1f59-495e-8d55-e01a4cc1bcc8`.
  Example five-card response: `acf4822b-5e6d-4409-a2a0-34406fd43b33`.
- Read-only catalog API check with the motion-sensor facet confirmed conflicting
  data: product 20554 (ДПО 1002) and 23306 (ДПО 1001) explicitly say acoustic
  sensor in their names, while both have `С датчиком движения: да`.
  Manufacturer verification identifies these as opto-acoustic models activated
  by sufficient sound in low light, explicitly contrasting the principle with
  infrared/microwave detection: https://www.iek.ru/company/news/6422744/ .
  A broad source boolean cannot justify silently presenting the technologies
  as equivalent. Do not silently change the catalog or add SKU exclusions.
- The current acceptance assertion accepts any sensor keyword; therefore its
  PASS is insufficient. These two items need manual/source-data validation.
- The remaining software blockers are application suitability (outdoor cable),
  total-system versus per-product quantities, and final repeated verification
  of cardinality without admitting unsuitable products.

## Historical checkpoint

## Release decision

NOT READY FOR PRODUCTION. PR #67 remains a draft. Passing automated checks
are not equivalent to acceptance of the customer-visible answers.

Production `chat-consultant-v3` was verified at version 448, unchanged.
Preview 646 tested commit `3f4394ebe694b9ee8ff2473707ea65d2aefd8f4b`.
The subsequent text-only clarification compatibility change is commit
`5de61e4927bfeb27ddf6442c7f84e085b9317459`, deployed only to preview.
The customer's exact failing requests/environment in the latest message are
still unknown; these results concern our independently reproduced cases.

## Changes

- Advance past answered readiness facets; retain original request and ask only
  for the remaining inputs, including free-form answers.
- Preserve the product-type query alongside numeric facets instead of letting
  numeric filters erase it. Exact compound marking retains precedence.
- Explain a repeated catalog-selection request in an active clarification,
  preserving the live facet IDs and numeric choices.
- Include the available choices in assistant text. `public/widget.js` consumes
  but does not render `quick_replies`, so a promise of buttons below was unusable.
- Add an exact repeated-answer gate to acceptance checks.

## Verification

- Shared V3 tools: 843 tests passed on 3f4394eb.
- Edge Function type check: passed on 3f4394eb.
- Acceptance evaluator: 30 tests passed.
- Final readiness text change: all 43 readiness tests passed.
- GitHub type-check workflow 37287801851: success on 3f4394eb.
- Customer audit suite: 27 of 28 automated cases passed on preview 646.
  The failing case is `audit-15-analog-cctv-outdoor-cable`.
- Five new progress cases: pump, underground, surveillance class and floodlight
  progress passed their automated checks. Acti9 progressed correctly but failed
  a required wording fragment; final follow-up produced four 1P/16A/C cards.
  These automated checks have the manual limitations below.
- Browser with actual `public/widget.js` and preview harness: underground
  answer advances rather than repeating the installation-method question.
  Request IDs: `c0641b6f-cd63-404f-9e29-4dce04b5ecf0`,
  `1498bcea-a4b2-41b1-92b9-00f5f013587a`.

## Still open / release blockers

### Invalid structured reasoning

`audit-15` request `1ba64fcc-cbbd-4855-a73b-eebc144ed859` failed with
`derived_selection_reasoning_contract_invalid` after about 15 seconds.
The first declaration triggered measurement correction; the correction response
ended with `finish=length`, a `google:python_interpreter` tool call and no
`declare_selection_reasoning`. The server correctly rejected it, but the
customer receives `internal_error`. This is not a browser-cache explanation.
Do not bypass the contract or silently render unverified products.

### Application suitability is not fully proven

Four-turn surveillance request `1dd62965-147c-47ef-aedc-edd22ae2bc6e` now
returns coaxial products instead of UTP. However, the response does not prove
outdoor suitability of both returned products. The test checks product class,
not all application constraints, so its PASS is insufficient for release.

### System totals versus individual-product recommendations

Floodlight request `21cdb77c-6d87-4b56-bbb3-6bef9590c447` states a recommended
4000–5000 lm / 50–70 W product, then appends a system-total disclaimer and
renders a pool including a 10 W product. The automated test only checks that
there are several floodlights. It does not prove agreement with the explanation.
Need a consistent typed contract for aggregate demand and individual-product
requirements, not a product-specific exception or weaker assertion.

### Additional browser blocker: changing topic while clarification is pending

After the underground-cable dialogue, the actual widget was sent
`Новая тема. Есть ли аналог автомату Schneider Electric Acti9 C16?`.
It repeated the underground-cable clarification instead of switching to the
breaker. Request `c744331c-3910-4951-875a-2261cf731554` on the final preview
candidate reproduces this. An explicit new task must take precedence over a
pending readiness scope. This is a release blocker, not a passing browser test.
Resetting the local test chat was denied by the tool's approval gate; the reset
was cancelled, the history was preserved, and no alternate deletion was used.

### Final isolated Acti9 check

After the text compatibility change, all three turns passed: initial question,
plain-language explanation with visible choices, then four matching 1P/16A/C
cards. Request IDs: `d12ebba3-c994-40d8-a316-f9e326cd4552`,
`788907bc-ec3c-459a-a64d-d36f4629c911`,
`c14fc3fb-52b5-4b19-b2bc-fed963555107`. This is an API-dialogue pass, not a
successful browser topic-switch test.

## Next gates

1. Obtain the customer's failed transcripts and request IDs; verify the endpoint.
2. Add assertions for suitability evidence and explanation/card consistency.
3. Diagnose the structured-reasoning correction contract and total/per-item
   conversion on the recorded cases, without broadening unrelated routes.
4. Re-run targeted dialogs repeatedly and then the cross-category suite.
5. Repeat actual-widget browser checks before requesting production approval.

Ordinary Lovable preview currently targets the production function. The local
`scripts/qa/widget-preview-harness.html` explicitly routes chat requests to the
preview function. Do not identify a test environment from widget version alone.
