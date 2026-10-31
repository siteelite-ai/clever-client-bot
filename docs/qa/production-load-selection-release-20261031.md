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

- Exact-head CI for `d268061ce755dc24faa21c1bf9aab0d97410ea30`: both server jobs and both widget build jobs passed.
- PR #141 merged at 2026-10-31 06:43:25 UTC; merge commit `ad2773a93b0c9daefc814af940a4f86e53922228`. Runtime/config/public trees of the merged commit were compared with the tested head, with no difference.
- Deployed **only public `chat-consultant-v3`**, from the clean detached merged-main worktree `work/clever-client-bot-production-release-20261031`.
- Published version **659**, `verify_jwt=false`, bundle SHA-256 **`2d6d7e35271487fd34da3d637087f8c84253223be1396b3e0fb53f025164369b`**.
- Closed preview remains v263, JWT-protected, original SHA `f16a12ff71e95e3c9cede60d90044941217142c952dadc556cff8a3d0a018b1d`.
- Backend-only release: no Lovable frontend publication was needed/performed. The ordinary testdevops widget still loads `widget-48cf7f8e6bd967b3`; unchanged widget version is not evidence that the backend fix failed to publish.

### Actual browser smoke on the ordinary testdevops homepage

External Chrome, not the QA HTML page; actual rendered buttons were clicked. All five recorded backend requests completed with `error=null`.

| User action | Visible outcome | Backend time | Request ID |
| --- | --- | --- | --- |
| Ask for breaker for asynchronous 3 kW motor | Supply-choice buttons, no premature card | 2,544 ms | `6298604c-1322-45f3-9ca9-5c88ad379477` |
| Click `380 В, 3 фазы` | Start-method buttons, verified continuation | 1,102 ms | `858c11c2-28c3-4c2c-af93-12dd338622be` |
| Click `Прямой пуск` | Freeform nameplate-current question, verified continuation | 997 ms | `570c9b61-eaa3-4634-98fe-2c3113c2f44f` |
| Click freeform action; enter `6 А` | DEKraft ВА-431 3P 4.0–6.3 A /21228DEK/, 5,895 KZT, Astana one unit | 12,971 ms | `c8928690-7fe4-42f3-b6e3-6cfe0dd93d29` |
| `Новая тема. Найди кабель ВВГ 2*1,5 самый дешевый` | New topic; exact ВВГ 2×1.5 ГК ГОСТ, 309 KZT/m; no motor criteria carried over | 3,984 ms | `7d17759a-46f2-4135-a6f4-ca6da870fcc6` |

Motor logs independently confirm structured declarations were active on public production, both certified setting-range alternatives were enforced, terminal measurement gap is null and coverage is `covered`. As in the preview, a first draft mixed source quantities into product coverage; the existing bounded correction recovered. This is not a first-draft/no-correction pass. See [motor diagnostic excerpt](reports/production-motor-browser-20261031-steps.json) and [cable diagnostic excerpt](reports/production-vvg-browser-20261031-steps.json).

Reloading and reopening the widget retained the active cable topic and its card without a new paid message. It did not restore the previous motor topic, which was intentionally superseded by `Новая тема`.

Screenshots saved locally: `/private/tmp/volt-production-motor-20261031.png`, `/private/tmp/volt-production-cable-20261031.png`; motor screenshot shown to the user. The full external browser path has now been checked, unlike the preceding HTTP-only preview dialogue.

### Remaining transport warning (do not hide)

The browser logged one `stream proxy failed: proxy: connect_timeout` during the supply-choice turn; the request subsequently completed via the existing fallback. The 1,102 ms figure above is **backend processing**, not the longer visible wait before fallback. The proxy was not changed by this backend release, but this remains a user-visible latency issue, not a clean transport PASS. No proxy/config/worker change was attempted within this release. A separate page-level `miniShop2 is not defined` error was already present before deployment and is not a widget regression introduced here.

The automated cable runner was attempted but sent no customer/model request: first its explicit-endpoint guard rejected invocation, then catalog-health preflight reported missing local configuration (`not_run`), preserved in [runner report](reports/production-vvg-control-20261031.json). The actual cable smoke above was instead completed in the browser. Do not count the runner as a passed automatic acceptance test or claim a separately verified global minimum price from this smoke.

Post-release secret metadata: 23 pre-existing secrets, zero `V3_CLOSURE_*`. No secret creation or deletion was necessary for production smoke. Rollback code remains available; rollback was not executed because the targeted functional checks passed.

## Remaining debt outside this release

The available catalog does not yet establish all per-SKU current-capacity/voltage-drop facts needed to promise a fully engineered pump/underground cable selection. Missing evidence must produce a safe clarification/refusal, not fabricated suitability. Three confirmed DN027B analogs and a full repeat of the customer matrix are not claimed here. Targeted PASS does not imply zero production regressions.
