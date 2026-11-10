# Dialogue constraints and compound refinements — candidate only

Base: main `3944bb95b4466a884db7a73270222c5edbce9ba6`. Separate from deferred PR148 and PR149. This change does not publish production, alter models or keys, change frontend/MODX, or migrate the database.

## Shared behavior

- Restore selection obligations only from completed, verified server context. Treat the current customer turn as an axis-specific update, not an OR-union with all historical values. Preserve independent conditions and same-turn alternatives.
- Keep a current authoritative budget across search and final checks. Do not turn price into a nonexistent category facet or invent new product thresholds from historical application measurements.
- Retain the existing monotonic within-turn contract: model correction and recovery cannot resurrect a superseded customer value. Preserve card/class/compatibility/price/availability gates.
- Recognize bounded compound refinements by dialogue syntax, not product/brand/test-case dictionaries. A verified dependent head can carry multiple labelled conditions or a budget. The missing product head still requires server verification.
- Independent tasks and explicit topic changes discard the old scope, including preflight card proof. Unknown/explanatory prose is not forcibly converted into a selection.

Syntax limits: 800 characters, 6 clauses, 180 characters per clause. This is not a guarantee of understanding every possible natural-language sentence.

## Offline verification

Final combined suite: **2290 passed, 0 failed**, no network permission, cached dependencies only. Latest typed targeted run: **70 passed, 0 failed**. Earlier state-only typed run: 72 passed.

A first parallel run reported 2289/2290 because an unchanged exact-leaf timeout test with a 20 ms deadline was preempted before setting its mock signal. That file passed 4/4 in isolation; the final sequential combined suite passed 2290/2290. The timeout implementation and that test were not changed.

Real HTTP/SSE handler fixtures verify shape and budget replacement, preservation of IP65, an additional temperature condition, rejection of wrong-shape/IP/temperature/over-budget cards, rejection of fabricated browser history, and separation of a second independent product request. They are synthetic catalog fixtures, not live customer acceptance.

## One planned closed-preview dialogue

Only after exact-commit CI and preview source attestation:

1. `Нужна круглая люстра для гостиной со степенью защиты IP65, бюджет до 5000 тенге. Покажи варианты.`
2. `А есть овальные? Бюджет до 6000 тенге`.

Exactly two customer messages in one fresh session; no repeats. Confirm continuity, updated shape/budget, preservation of independent conditions, actual catalog retrieval and each card's proof/rejection. A verified empty result is not a successful product recommendation. Do not weaken eligibility to manufacture cards. Stop after this dialogue, inspect logs, remove only its newly created QA pair, and attest unchanged production/other-function source and JWT metadata.

This document records the plan, not a live PASS. Runtime evidence is recorded separately after the one authorized run.

## Local follow-up: old-card rehydration must not own fresh selection

The two-message live run of `399f8efc` stopped at
`v3_recent_product_evidence_unavailable` before condition compilation or a new
search. That observation is not a catalog-empty result.

The local follow-up separates verified attribute changes from questions about
already shown SKUs. A bounded attribute/compound continuation with a completed
server-owned selection restores its base request and mandatory obligations,
but supplies no old SKU facts/cache or fresh-batch scope certificate. It
discovers the live category and retrieves new candidates normally. Its
`v3_rendered_refinement_fresh_search_context` diagnostic explicitly records
that old cards were not rehydrated. Compound changes cannot become a general
information answer just because the old product-evidence array is empty.

Questions about the shown items (price, stock, comparison, show/rank this exact
set) retain complete-batch rehydration and fail closed on incomplete evidence.
The existing additional-options route is deliberately excluded from the new
attribute-refinement decision. Browser-forged/absent proof and a new topic do
not inherit obligations. No card, class, price, stock, restricted-product or
compatibility validator has been disabled.

Offline real-handler fixtures make old-title lookups empty, unavailable or
ambiguous and assert that a changed-condition selection performs no such
lookup, does execute a new search, preserves white/IP65, replaces shape/budget
on live axes, and rejects wrong-shape, wrong-color, wrong-IP, over-budget,
out-of-stock and restricted decoys. Separate fixtures keep old-item factual
questions fail-closed and protect fabricated history and topic changes.

### Historical limitation after the rehydration-only fix

The real category has no shape facet. An extra offline fixture therefore
tests a title-only shape change with no such axis. The new search does run,
but the caller cannot certify which old literal condition the new adjective
replaces. Current compound modifiers are bound to the live product head for
the visible-card contract; neither a stale round card nor an unproven oval
replacement is shown by dropping a condition. The fixture expects zero cards,
not a successful recommendation. Generic title-only axis replacement remains
unresolved at that stage. The local text-axis follow-up below supersedes this
zero-card expectation; neither stage is a live acceptance PASS.

This follow-up is local only. No push, preview deployment, QA secret changes,
real catalog calls, paid model calls, production changes or browser tests are
part of it. Local run counts are recorded in the accompanying workspace
report and logs after completion, not inferred from the earlier CI.

Final local verification of this follow-up: 2294 combined offline tests passed;
25 real-handler tests and 44 shared-module tests also passed with type-checking;
6 Node route-contract tests passed; `git diff --check` passed. The first full
run's failures (fixture taxonomy-cache leakage plus accidental overlap with
the existing additional-options route) were corrected and its log retained
separately. The final counts do not include it as a successful run.

## Local text-axis follow-up (no publication)

`textual-selection-contract.ts` owns a bounded semantic geometry axis, separate
from API facet names. It recognizes round, oval, square, rectangular,
triangular, hexagonal and semicircular wording across product categories. The
vocabulary describes an attribute, not SKUs, brands or client-question strings;
unrecognized modifiers never authorize erasing an existing condition. An
actual category shape facet remains owned by the existing facet/criteria path.

Customer-owned product shape is projected per verified server turn using the
existing referent/source/negation ownership guards. A new positive family
replaces the old family's OR set; unrelated color/mount/budget changes preserve
it; explicit negatives veto known values. Room geometry, area measurements,
source-item descriptions, browser history and model prose cannot supply the
new shape. This is not arbitrary semantic interpretation of every adjective.

The final visible-card contract retires only literal geometry belonging to
this axis, retains all independent requirements and adds a mandatory text
characteristic. The characteristic is required even if no observed title
contains the desired vocabulary. Only intrinsic title wording or an explicit
first-party body-shape trait may pass. Missing evidence, conflicting fields,
two different intrinsic shapes, negation, geometry of an accessory/room and
model-code substrings do not pass. No synthetic shape option is sent to the
catalog API. `v3_textual_selection_contract_compiled` records the canonical
state and explicitly marks `catalog_filter=false`.

A successful completed refinement's existing server-only linkage now carries
the original condition base forward to the next turn. Exact original/latest
log IDs, continuation boundary, a completed new card batch and the marker's
source/flags are required. Failed/zero-card changes and mismatched linkage do
not gain a certificate; questions about old SKU facts still require refresh.
Historical rows without the new marker keep their previous interpretation.

One additional safety defect was exposed by placing rejected candidates
before the valid one: the legacy stock flag marks active all-zero products as
available. The shared ordinary final-card guard now requires positive live
warehouse evidence when the customer explicitly asks for `в наличии`.
Requests without that requirement keep their existing stock policy.

Offline acceptance now verifies the no-shape-facet oval replacement itself,
not an empty result: the valid oval/white/IP65 card at 5500 survives the updated
6000 cap; stale round, missing/conflicting shape, wrong color/IP, over-budget,
explicit-zero-stock and restricted decoys do not. A third color turn retains
the oval shape and 6000 cap; a pool with no shape proof returns no cards.

Latest combined local result: **2307 passed, 0 failed**. Typed real-handler
suite: **27 passed**; typed shared modules: **55 passed**. Node route contracts:
**6 passed**; `git diff --check` passed. Dependencies were cached, tests had no
network permission and all remote services were fixtures. No commit/push,
preview deployment, QA pair creation, model call or production change occurred.
The user's late cleanup approval was separately checked: the named older pair
was already absent, so no deletion or settings write was needed.
