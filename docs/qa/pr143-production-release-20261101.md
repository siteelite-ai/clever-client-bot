# PR143 published release — 2026-11-01

Scope: simplify specification assistance to a direct free-text question and
one manager contact action. Not a claim that all historical acceptance debt
or all possible catalog requests are closed.

This release record supersedes the preparatory “not deployed” status in
specification-prompt-manager-20261101.md.

## Published identity

- PR: https://github.com/siteelite-ai/clever-client-bot/pull/143, merged at
  2026-11-01T10:02:58Z.
- Exact checked head: 4997130e8798140de70532d8af19b471225959bb.
- Main merge: 61673450c556e6d7dcfd8b9991be615a379a05ae. No tree difference
  from the checked PR head. All four GitHub checks succeeded before merge.
- Deployment used a clean detached worktree at that merge.
- Supabase public chat-consultant-v3: v664, verify_jwt=false,
  bundle SHA 8aaeb58df67d6ace28403c1d0c49170e5a0655182c2ecb8ebdc0166c71c1f984.
- Exactly 1 of 15 function code/JWT identities changed; the other 14 did not.
  All 23 existing secret names/digests remained unchanged. No QA secrets created.
- Lovable deployment: 2da1ea61-112b-49fe-b623-3d6691bbfcb1. Its API initially
  returned pending; actual publication was then verified through HTTP 200,
  root bootstrap, both manifests and exact widget bytes.
- Widget: widget-bdc222dbbd5c4e7f.
- Full JS byte SHA: 09bd2ea6d7d4e7c4c2521b3b655eec5a8a993867fb901531c4634e67f0601e06.
- Dashboard app bundle: /assets/index-DAKjnc9u.js, HTTP 200.
- Ordinary testdevops uses the pinned local immutable asset:
  /assets/libs/widget-bdc222dbbd5c4e7f.js.
- Only MODX chunk 25 scripts was switched; resulting SHA:
  25449b55ac814341e1505d60b3bd0ee4698b63f33ea28a61df0bdf37c4009f79.
- Homepage, /dostavka, /kontaktyi/, /novosti/: HTTP 200 and new pinned URL;
  old pinned URL absent. Exact served widget hash matches the release.
- No server3, 220volt.kz deployment, model, catalog filter, schema migration
  or working secret change was part of this release.

## Verification before release

- Shared/public-handler Deno safeguards: 2,121 passed.
- Full Node QA/evaluator suite: 451 passed, including the 90 widget/loader tests.
- React/Vitest: 16 passed; app TypeScript check and production build passed.
- Widget content-hash contract passed.
- Desktop and 390 × 844 mobile local visual checks passed.
- Local reload + reopen retained the question and one manager contact.
- CI's source-shape test initially expected the previous boundary expression.
  It was updated to require the added verified-specification disjunct AND the
  existing entity/class disjuncts. No production routing check was removed.

## Four targeted ordinary-page browser requests

All were sent from https://220volt.testdevops.ru/ with the published widget,
not a special QA page or a local relay.

| Request | Observed result | Log ID | Last logged stage, ms |
|---|---|---|---:|
| Мне нужен кабель для насоса | Direct specification question, public product-contact phone, one manager link; no status/specify/copy buttons | 70a66338-3daa-423b-a89f-020ac34a3cd4 | 2204 |
| ВВГ 3*1,5, typed after a browser reload | Immediately entered the existing exact-compound catalog route; four matching 3×1.5 cables, no confirmation click | ff125316-a76b-4e0d-aa0b-3f1a9233c539 | 2838 |
| Новая тема. Какой кабель подойдет для прокладки в земле? | Same shared direct-question/manager flow; no conditions questionnaire | 626050b0-d447-4101-a61d-7e4a11033b3d | 928 |
| Новая тема. Подберите автомат для асинхронного двигателя 3 кВт | Existing motor clarification retained: 220 В, 1 фаза / 380 В, 3 фазы / Напишу свой вариант | 37206fac-de4f-4a88-bebf-b15817f8a321 | 769 |

Read-only SQL inspected only these four synthetic test log IDs. All have
error=null, and product counts are 0 / 4 / 0 / 0. Steps are deterministic
readiness or exact-compound render, with no LLM calls. Times above are the
last logged server stage, NOT full browser/network wall-clock latency.

The four catalog cards were ВВГ 3*1,5 ГОСТ IK, ВВГ нг 3*1,5 ГОСТ IK,
ВВГ 3*1,5 ГК ГОСТ and ВВГ нг 3*1,5 ГК ГОСТ(зеленый).
This is stock/price lookup by a customer-supplied specification, not an
engineering approval that VVG is suitable for the pump.

Published mobile rendering was visually checked. Browser reload + reopen
preserved the pump question, normal input and exactly one manager link,
tel:+77762206220. No telephone call or manager lead was submitted.
The first Chrome navigation timed out leaving about:blank; after inspecting
that state, a second navigation loaded the ordinary page successfully.

## Backup and rollback

New owner-only archive: work/backups/volt220-pr143-before-20261101.Tcf0Ws.
It contains all-function metadata, secret names/digests, exact baseline
downloaded source, a full detached rollback source tree, HTML/JS snapshots,
the exact old chunk and a separate ROLLBACK.md.

All 108 downloaded baseline TypeScript files match rollback source
658e9f3f4f4145c6540f384eff1c27e8ea839569; its entrypoint typecheck passed.
This is source/build verification, NOT a live rollback rehearsal or DB backup.

Remote backup: /root/volt220-pr143-backup-20261101 on 45.86.39.5.
The prior immutable widget-3a881d860c27f8d0.js remains in place.
Fixed-path CLI operator /root/pr143-modx-widget-release-20261101.php can
restore only the saved chunk if the live content still matches this release.
It refreshes only scripts/default/resource caches under the MODX site owner.
Backend, pinned MODX asset and Lovable/Git rollback are separate operations,
documented in the private archive. No rollback was executed.

The local demo tab and server were closed after QA. The ordinary published
chat was left available to the user. No disposable QA credentials or relay
were used for production checks.
