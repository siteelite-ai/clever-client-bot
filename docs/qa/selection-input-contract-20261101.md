# Shared customer-input clarification contract

> **DO NOT MERGE: live acceptance failed on 2026-11-01.** The controller can
> honor a declared clarification, but the model can still omit it and choose
> an application-critical classification without customer evidence. A live
> drill-bit query and its continuation both failed; exact VVG control passed.
> Offline results below are not semantic live acceptance. Production unchanged.

## Live acceptance follow-up

Four messages were sent in the approved closed-preview budget. Initial head
`19283c30`: clarification delivery failed. Head `eb069a59`: API facet keys are
now exposed and constrained in the derived schema, with rejection diagnostics,
but the model selected an advisory concrete bit without knowing wall material.
The subsequent concrete/8 mm/SDS-plus reply was classified as continuation,
yet no server-issued task question existed, so discovery lost the original
product noun. Do not bypass the noun/source guard to make that test green.

Request IDs: `8f5a00f4-e5a3-4392-a6ee-dfce5586774a` (initial failure),
`69edd1c2-6556-414c-871a-debac304aa2e` (no question),
`b3f2383a-d57e-454f-9e49-fcbd94cf6079` (continuation failure),
`75099ad9-40cc-4478-a1ca-267cf66a4cff` (exact cable control).

Required next design: mandatory readiness decision in the existing reasoning
step; explicit separation of customer facts versus assumptions; server-owned
task context before first render; preserve exact/browse paths and all product
proof gates. This is not yet implemented or live-verified. Do not claim the
current optional extension enforces clarification universally.

The full local report and artifacts are in the parent workspace under
`outputs/qa-pr145-preview-20261101/`. Cleanup of the expired QA secret records
remains pending (Management DELETE 403 and disconnected browser). Local relay
is stopped, expired access is independently denied, and local credential file
is removed. User has explicitly authorized deletion of that exact pair.

Base: `bc85aadbbe6d390043efe1fb5e555c493995d7f7` (released PR144).
Branch: `feat/selection-uncertainty-contract-20261101`.

## Purpose and boundaries

Make missing customer information a terminal outcome of the existing planning
call, rather than forcing the model to invent a selection criterion or treating
a question as malformed engineering reasoning. This is not another product
profile, category allowlist, or special-case customer-query match.

Both ordinary `propose_clarification` and forced
`declare_selection_reasoning.clarification` use one parser and one controller
exit. The optional extension preserves existing declaration payloads. No new
LLM classifier, database migration, model/settings change, widget build, or
server3 operation is included.

## Controller guarantees

- A declared blocking input has a bounded reason, parameter, impact and one
  question. Reasons are missing customer input, ambiguous goal, conflicting
  inputs or an unresolved reference. These are NOT product evidence.
- Only actual values of the discovered live facet may become chips. Other
  questions use the widget's existing freeform pending-slot format.
- A validated question terminates the turn. Sibling search/render calls and
  unverified model co-text are discarded before execution/streaming.
- Invalid question declarations fail closed, without repairing an engineering
  calculation or falling through to a guessed search.
- A previously observed transient catalog failure uses the existing technical
  failure notice instead of asking the customer for missing data.
- The existing optional-preference suppression is retained. A new reason label
  does not override it. Replacement questions retain the existing source/live
  facet validation; this change supplies no replacement compatibility proof.
- Pending state reuses `selection_readiness`: original request and subsequent
  reply are linked only after the existing latest-completed-server-log proof.
  Client-added fields, forged/stale slots and other sessions provide no authority.
- The new path refuses requests longer than the existing 500-character scope
  limit rather than silently losing constraints. Broader state-format migration
  is outside this change.

## Existing mechanisms preserved

Deterministic exact SKU, category browsing, grounded jargon, engineering
profiles, active-selection continuation, price completeness, strict paired fit,
measurement ownership, catalog filters and final product proof remain in place.
The new path does not relax a filter or certify any product. Ordinary callers
of `executeProposeClarification` still require 2–5 options; only the validated
server controller may enable freeform delivery.

## Verification and release gate

Offline tests cover both real HTTP handler entry points, an unseen category,
conflicting sibling search, invalid questions, live-value chip validation,
server-owned continuation, forged/cross-session state, new topics, optional
preferences and unchanged measurement proof rejection.

Run:

```sh
deno check --no-lock supabase/functions/chat-consultant-v3/index.ts
deno test --no-check --cached-only --no-lock --allow-read \
  supabase/functions/_shared/v3-tools/*_test.ts \
  supabase/functions/chat-consultant-v3/*_test.ts
node --test --test-concurrency=1 scripts/qa/*.test.mjs
```

Offline handler tests use deterministic model responses. They prove controller
and protocol behaviour, not that the live model will recognize every ambiguous
phrase. Before merge/deploy, perform a bounded closed-preview check: one new
ambiguous task and answer, one fully specified control, and a technical-failure
control if available. Record source revision and actual function identity.
Do not claim a universal absence of regressions or mark production updated
from offline results alone.

### Local evidence, 2026-11-01

- Full Deno regression run: **2,131 passed, 0 failed** (2m31s).
- Two subsequent added handler cases also pass: mixed blocking-question/search
  batch, and catalog outage versus missing-input question. Final handler file:
  **10 passed, 0 failed**; shared contract file: **4 passed, 0 failed**.
- Deno typecheck of handler and changed test files passes.
- Node suite, serial: **449 passed, 2 failed** out of 451. Both are unchanged
  wall-clock widget timing assertions (idle timeout and late-header failover).
  The same two failures reproduce on clean released baseline `bc85aadb`, using
  the same Node and jsdom, without this backend feature. Do not label this run
  completely green or change transport timers/test thresholds in this PR.
- Widget test file Git blob is unchanged:
  `88db7c9a66b062395b90125d950631775759ca2b`.
- Widget runtime Git blob is unchanged:
  `808e1c7d3dbe56f3856462709899b23ebeb9a319`.
- No paid provider queries or production modifications were performed.

The initial parallel Node run also failed timing assertions under load; the
serial run and clean-baseline reproduction above are the relevant comparison.
The baseline worktree had no local jsdom dependency, so a temporary Node
resolver hook pointed only that import to the candidate worktree's existing
jsdom installation. Neither baseline source nor dependencies were edited.

Rollback: revert the isolated feature commit and redeploy the previous verified
V3 bundle. There are no data migrations or permanent secret changes to undo.
