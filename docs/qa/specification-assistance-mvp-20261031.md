# Specification / specialist assistance MVP, 2026-10-31

User selected the bounded catalog MVP, then approved the proposed help flow. This supersedes the pending-scope decision in [the earlier audit](cable-engineering-evidence-audit-20261031.md). Automatic cable sizing remains out of scope; the MVP must not claim installation compatibility or successful lead submission.

## Implemented workflow

- Only readiness profiles explicitly tagged for specification assistance enter this flow (currently pump and underground cable). No SKU exceptions, cable-family alias dictionary, model-based sizing or automatic relaxation was added.
- Opening choice: «Да, укажу» / «Нет, нужна помощь».
- A known specification uses a bounded syntax parser. Family and compound size are separated by whitespace; decimals and core counts remain atomic. Ambiguous attached digits are not guessed. The bot confirms an explicit new-topic catalog query; existing exact-marking, catalog, stock, visibility and per-card gates own the actual search. A separate complete request can carry extra price/brand requirements rather than having those silently discarded by a partial parser.
- Help reuses the existing readiness profiles and the shared owned-length rule. Previously supplied inputs are not requested again. «Не знаю» defers only the current server-issued axis for a **human handoff**; it is labelled unknown, not promoted to a proven engineering input. Deferral is an internal collection-only option and is never passed to the expert/catalog selection route.
- The deterministic help result contains the customer's scoped conditions, an explicit statement that cable specification remains unconfirmed and that no request was automatically submitted. It issues no product cards and calls neither the model nor catalog.
- Three UI actions: copy exactly the summary locally, open the fixed official contacts page without query data, and focus the specification editor without deleting a draft. Clipboard denial displays a manual-copy explanation, not a false success.
- The summary actions are tied to the active completed visible turn/slot. Existing expiry, topic-change, partial/error and reload controls remain in force. React dashboard actions attach only after a successful terminal diagnostic and an exact matching question. Contact URLs are not taken from payloads.
- The full assistance request is bounded and comes from the immediately preceding completed server log, not arbitrary browser slot metadata. Overflow is not silently truncated into a false summary. Browser-provided assistance flags cannot upgrade an ordinary issued slot.

## Files / activation

- Shared server controller: `_shared/v3-tools/specification-assistance.ts`; readiness profiles remain the source of axes/labels. It is called before the ordinary readiness route, not inside numeric measurement proof cleanup.
- The branch enables it independently of closure QA authentication. A server-only `VOLT220_SPECIFICATION_ASSISTANCE_ENABLED=false` restores the previous readiness route. No environment/secret value was created or changed for this work.
- Local legacy integration fixtures explicitly keep the feature off to preserve their old contracts; separate real HTTP/SSE handler scenarios enable it and verify both help paths, all-unknown input and specification confirmation with zero external requests.
- Embedded widget and React dashboard both implement local actions using their existing button styles. The mobile review caught a dark status label and corrected it with existing light foreground styling; button/link layout and scroll-to-feedback were checked at 390×844.
- Content-hash version **`widget-3a881d860c27f8d0`** is aligned across `widget.js`, JS/JSON manifests and root HTML bootstrap. No published asset or loader was updated by this draft.

## Verification

- Full server regression: 2,118 offline Deno tests passed on the implementation before the final atomic family/size grammar guard; the final candidate's full rerun is recorded below. Real handler tests include pump, underground, unknown inputs and specification confirmation. These are mocked HTTP/SSE integration tests, not live Supabase acceptance.
- Final candidate after the family/size guard: **2,118/2,118** full offline Deno tests passed in 37 s; public/closure entrypoint checks passed again. No runtime source edit followed this run.
- Eight pure assistance-controller tests plus thirteen existing/new real-handler tests passed in the targeted run. The final grammar guard additionally covers 12-core values and a numeric family suffix without changing customer-owned numbers.
- Embedded widget/session plus loader: **90/90** Node tests passed, including local copy, rejection, fixed contact URL, reload, incomplete-event denial and existing transport/choice controls.
- Frontend Vitest: **16/16** tests across three files passed, including three new action-component tests.
- TypeScript app check, public/closure Deno checks, content-hash release contract and `git diff --check` passed. Production Vite build passed; its existing large-chunk warning remains, not a new build failure.
- External Chrome local UI fixture: opening choice, help on already known conditions, real clipboard success feedback, return to editing, specification confirmation and matching reload were exercised. At 390 px, action-group bounds were 29–353 px and there was no horizontal overflow. After the status label changed height, scroll position was adjusted so the last action remains reachable.
- Screenshots: `/private/tmp/volt-assistance-mobile-final-20261031.png`, `/private/tmp/volt-assistance-desktop-final-20261031.png`. The mobile result was embedded in the user update and explicitly labelled local, not production. Temporary viewport override was reset.

The local fixture `scripts/qa/specification-assistance-demo.ts` uses the same pure server controller and actual widget source with only endpoint/logo origins redirected locally. CSP and Deno permissions exclude external model/catalog access. It is not the deployed Edge handler, and does not perform catalog lookup. Full handler behavior is separately checked by mocked integration tests; this visual fixture is not a live customer acceptance result.

## Rollout boundary / remaining checks

No merge, Supabase deployment, Lovable publication, MODX change, server3 operation, working-token copy or temporary QA-secret write occurred. No paid live chatbot calls were made for this implementation.

Before release: verify exact-head CI, deploy closed preview, exercise the chosen specification through the real catalog and smoke an unaffected motor/exact-cable path. Publish both backend and the frontend that actually serves testdevops: its last observed page loaded a pinned local `assets/libs/widget-48cf7f8e6bd967b3.js`, so a backend deploy or Lovable publish alone must not be assumed to update those buttons. Preserve the old runtime and actual served frontend asset for separate rollback, verify the loaded content hash, then check help/copy/specification continuation on the ordinary site. No user-condition summary may be automatically sent to a manager without a separately implemented and approved integration.

## Closed-preview rollout follow-up

- Exact runtime HEAD `9b269d06833d4081999a54986ffe5761407b054d`: all four GitHub push/PR jobs completed successfully (Edge checks and widget contract/Vite build; runs `41184945772`, `41184942941`, `41184945761`, `41184942875`).
- Only `chat-consultant-v3-closure-preview` was deployed from that worktree. Management metadata confirms v264, JWT verification still enabled, bundle SHA `041cee49745508d3ea5c674c3d72df65f3edebca4ded16209907c1dc2bc03db6`.
- One real HTTP POST with the public anon JWT and no private QA header returned **403**, as required. This verifies admission denial, not a positive customer dialogue, catalog health or the help workflow.
- Independently checked public function remains v659 / `verify_jwt=false`, SHA `2d6d7e35271487fd34da3d637087f8c84253223be1396b3e0fb53f025164369b`. No merge, public backend deployment or frontend publication occurred.
- New bounded live acceptance plan: `scripts/qa/specification-assistance-preview-20261031.json`. Eleven planned turns across pump help → summary → explicit marking lookup, an underground handoff with already supplied conditions, and the unaffected first motor clarification. Only the explicit catalog-search turn is expected to require generation. Suite schema validation passed locally; **the positive live plan has not run**.
- Browser access to the general Supabase Secrets page was rejected by the action reviewer because a broad page snapshot could expose existing secret values. No bypass or repeated attempt was made; no temporary secret was created, copied or removed. A narrowly scoped user confirmation was requested for the temporary-pair form and name-only cleanup checks, excluding disclosure of working values. Positive live testing remains pending that access step.

### First positive live run and regression found

After user confirmation, only form-field labels were inspected (not a general page snapshot or working values). A new disposable pair was created; name-only Management metadata confirmed both. All four real catalog preflight routes returned HTTP 200.

The first live plan recorded **10/11 turns, not a full pass** (`reports/specification-assistance-live-preview-20261031.json`). Pump help, all four answers, honest summary, customer marking confirmation and explicit ordinary catalog lookup passed. The search returned four VVG products with compound size 3×1.5; 2,871 ms, log `1cb5aefe-357e-4bfb-b8ee-71dcbf76290c`. This focused run validates URLs by shape, not independent SKU/page identity, and makes no engineering-fit or global-minimum claim.

The underground request supplied all conditions but repeated the PE question (log `d77d36f5-e612-441a-82c6-faf203930bf3`). The common parser rejected a preceding unrelated question mark and supported «защитная жила» but not the explicit subject–predicate form «жила защитная PE». The live expectation was kept unchanged. A failing regression reproduced this; the shared parser now ignores independent non-grounding questions while retaining grounding questions as unresolved, and recognises explicit core predicates. Negative/unknown, PEN and contradictory statements remain unconfirmed. The same exact live request was added to real-handler regression; full offline server suite now **2,120/2,120 passed**. This is shared customer-fact parsing, not a product/SKU or test-query exception. Recheck the changed runtime in closed preview before any publication.
