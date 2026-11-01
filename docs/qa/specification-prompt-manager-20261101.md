# Direct specification prompt and manager contact

Status: implemented locally and automated checks passed; not deployed.

## Requested flow

- Ask for cable family, core count and cross-section directly in chat.
- Customer types an answer into the normal input; no “Указать” button.
- One contact action remains: “Связаться с менеджером”.
- Remove the preliminary known/help status choice, condition questionnaire,
  summary/copy action and second catalog-search confirmation.
- Do not change other clarification chips, catalog filters or engineering gates.

## Implementation boundary

The common specification-assistance controller issues a free-text clarification.
A bare specification is accepted only against a server-verified pending
specification slot. It enters the existing exact-compound catalog selector with
its existing class, literal and compound-size checks. This is catalog lookup,
not approval that the specified cable is suitable for the installation.
Explicit topic changes, disabled feature and unrelated slots cannot activate
this shortcut. Legacy assistance slots transition to the simpler prompt.

Both embedded and React widgets show one existing-style contact anchor.
The phone comes from the existing labelled product/retail KB contacts, with a
1.5-second bounded read. Only canonical +7 numbers are accepted. The official
contacts page is a fixed fallback if the lookup fails; client-provided URLs
are not used. The number was compared read-only with
https://220volt.kz/kontaktyi/ (+7 776 220-62-20 for product questions).

The demo is local-only and uses no model, catalog or working credentials.
No secrets, database settings or production assets were modified.

## Verification

- Deno shared-tools and public-handler suite: 2,121 passed, 0 failed.
- Embedded widget/session and loader contracts: 90 passed, 0 failed.
- Full Node QA/evaluator suite: 451 passed, 0 failed. Its source-shape
  assertion now explicitly requires the additional verified-specification
  boundary alongside the unchanged entity/class boundaries.
- React/Vitest: 16 passed, 0 failed.
- TypeScript app check: passed.
- Vite production build: passed (existing bundle-size warning).
- Widget hash/release contract: passed, widget-bdc222dbbd5c4e7f.
- Public Edge entrypoint typecheck: passed.
- Real-handler offline multi-turn test: pump request → free-text prompt →
  “ВВГ 3*1,5” → existing catalog route → exact-size card; the deliberately
  wrong-core-count candidate is excluded. Zero model requests.
- Other readiness/motor scenarios remain in the full suite.
- Local Chrome desktop and mobile (390 × 844) visual checks: passed; one
  manager contact link and no specification/copy buttons. Reload + reopen
  restores the question and the same contact link. No call was initiated.

The first new catalog fixture used a three-segment category-like URL, which the
existing deep-card URL policy correctly excluded. Fixed the fixture to a deep
product URL; no catalog policy was relaxed.

## Still required before calling this published

- PR CI on the exact committed head.
- Merge/deploy and actual pinned MODX asset publication, with a new backup of
  current public v663 / widget-3a881d860c27f8d0 before replacement.
- Targeted verification on ordinary 220volt.testdevops.ru after publication.

Lovable publication alone does not update the pinned local MODX widget URL.
Do not touch server3 or the main 220volt.kz deployment for this change.
