# Production release: verified load and structured product obligations

## Scope and authorization

User authorized production publication on 2026-10-31 after the targeted closed-preview motor continuation passed. This is a bounded corrective release, not a declaration that the complete customer acceptance matrix has passed. No database migration, secret change, model switch, widget asset change, MODX change or server3 operation is included.

The structured declaration is now selected by a server-compiled measured-point/range certificate, not the closure-preview authentication marker. Replacement, paired-fit and paths without that certificate retain the previous declaration format. Existing catalog, measurement, price, visibility and per-card gates remain mandatory. Production does not receive closure QA access.

## Pre-release evidence

- Full offline server suite after the production-boundary change: **2,096 passed, zero failed**. Real production-entrypoint tests assert the structured tool schema, successful exact-choice/freeform continuation, rejection of an incompatible setting range, rejection of a separate unproven voltage obligation and correction of a malformed declaration.
- Three targeted local widget DOM tests passed (exact choice, restored choice, freeform input). These are not a deployed browser test.
- Deno type checks passed for public and closed-preview entrypoints; `git diff --check` passed.
- Prior live closed-preview continuation: [four turns passed](reports/motor-clarification-continuation-20261031-notes.md), including a catalog card after `6 А` (14.472 s). Structured behavior within the preview is unchanged by removing its deployment-marker dependency.

## Rollback baseline

- Previous main: `f9b3b58994c2791275c66d5046b72dba3d1d323b`.
- Previous public `chat-consultant-v3`: v658, `verify_jwt=false`, bundle SHA-256 `0dbe89ff568a467b0b0d6fb12e226f312ba3bb7742fee154cf58a50597d281de`.
- Owner-only archive: `work/backups/volt220-production-before-20261031.ZN69Tg` (relative to the project root). The **104/104** downloaded TypeScript source files exactly match the baseline main. A full detached `rollback-source` worktree additionally preserves type-only imports and deployment configuration omitted by the download.
- Rollback command, from this repository: `../tools/supabase-2.114.0/supabase functions deploy chat-consultant-v3 --project-ref yngoixmvmxdfxokuafjp --use-api --workdir ../backups/volt220-production-before-20261031.ZN69Tg/rollback-source`.
- This archive is code/configuration, not a database backup. No schema/data changes are included. A successful archive comparison is not a live rollback rehearsal.

## Publication and post-release checks

Pending exact-head CI, merge, deployment and targeted smoke on the ordinary `https://220volt.testdevops.ru/` widget. Record actual results below; do not infer release from a merge alone. Backend-only changes do not require publishing new Lovable frontend assets.

## Remaining debt outside this release

The available catalog does not yet establish all per-SKU current-capacity/voltage-drop facts needed to promise a fully engineered pump/underground cable selection. Missing evidence must produce a safe clarification/refusal, not fabricated suitability. Three confirmed DN027B analogs and a full repeat of the customer matrix are not claimed here. Targeted PASS does not imply zero production regressions.
