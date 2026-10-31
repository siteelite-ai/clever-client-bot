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
