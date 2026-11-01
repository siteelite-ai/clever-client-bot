# PR142 production release — 2026-11-01

Status: **published**, bounded specification-lookup / specialist-handoff MVP. Not full customer acceptance or closure of all security/engineering debts. User approved publication after preview and temporary-access cleanup.

## Release identity and delivery

- PR142 merged at 09:07:23 UTC: https://github.com/siteelite-ai/clever-client-bot/pull/142. Approved/CI-green head `0255334aa892291f9a5239f86911cc968f3d5f46`; main merge `658e9f3f4f4145c6540f384eff1c27e8ea839569`. Runtime/public/src/index trees matched exactly; deployment used a clean detached main worktree.
- Public `chat-consultant-v3` **v663**, JWT verification false unchanged, bundle SHA `e248854dd9b1b8628219efa5d50062029dfaf5ce25b4a286176460bf1060acee`.
- Widget **`widget-3a881d860c27f8d0`**, full byte SHA `a068afee184631a8170b6c6b0c0dc1a97083cc06f01969fb91890743470c8782`.
- Lovable deployment `4302ba53-09e8-4cf7-807a-b2bffc84c592` independently verified from live bytes, not only its initial pending receipt. Existing canonical address `chat-volt.testdevops.ru`: root/bootstrap and version JSON reflect the new hash; application bundle `assets/index-BngB7w0K.js` returned 200 (1,256,762 bytes).
- Ordinary testdevops used a pinned local JS, not the Lovable loader. Installed a **new immutable file**, preserved the old one, and replaced exactly one filename in MODX chunk 25 `scripts`, with backup/hash/concurrent-edit checks. Ordinary `/`, `/dostavka`, `/kontaktyi/`, `/novosti/` returned 200 and the new widget URL. Chrome at the ordinary root URL loaded that file and displayed the new version.
- All 15 Edge definitions compared: only public V3 code changed, no JWT changes. Other 14 code SHAs unchanged. Still 23 pre-existing secrets, zero temporary QA names. No migrations, secret/model changes, 220volt.kz page edits, DNS, nginx or server3 operations.

## Actual post-publication checks

Six ordinary-site **browser** requests were visually verified:

| Turn | Observed result | Log ID |
| --- | --- | --- |
| Pump, all conditions supplied | Two specification-status choices, no cards | `cb0532fe-f4e4-4c73-bb28-94f409ae89b6` |
| Help | Honest summary with 220 V / 6 A / 25 m / outdoor conditions, no repeated questions or automatic lead | `d9de9664-5d2d-4094-a8c6-5c8e5c165fc8` |
| Enter VVG 3×1.5 | Separate marking-search confirmation, not installation-fit claim | `3a230666-4615-4254-a59d-9b2064f6a411` |
| Search chip | Explicit new-topic boundary; four VVG 3×1.5 cards, 301/314/453/456 KZT per metre | `bb8295e4-d73d-4769-b284-93a25be85957` |
| New underground topic, all conditions supplied | Specification-status choice, no previous-search context leakage | `246248ff-6bc3-4b38-9f55-a8c471db3397` |
| Help | Immediate summary preserving explicit PE, no repeated PE question | `f9d6c279-6f30-4bb3-af49-42f982651e40` |

Real clipboard success, fixed official contacts link without condition data in URL, and draft-preserving focus worked. No message to a manager was sent. Product cards are not engineering-fit or exhaustive/minimum-price proof; independent detail-page checks were performed in the prior preview iteration, not re-certified at this response time.

Chrome subsequently blocked automation because another extension UI was open during reload. **Post-deploy browser reload/restoration remains NOT_RUN**, not PASS or a proven widget defect; user was asked to dismiss that UI. The same candidate's reload/restoration passed against the real closed backend in preview. Do not bypass the browser block.

Motor control completed as **direct public HTTP/SSE, not browser**: 200, 3,589 ms end-to-end, terminal complete, no premature cards, `supply_phase` with exact 220 V/one-phase and 380 V/three-phase choices. Log `431b8ec0-4fde-46d7-81eb-bfbd5acbfd7f`; evidence `reports/pr142-production-motor-http-20261101.json`.

Exact-ID read-only SQL: **7/7 logs**, no errors, every terminal complete, **zero `v3_llm_call` steps**. Server time 480–3,365 ms is not browser/proxy latency. Evidence `reports/pr142-production-log-audit-20261101.json`. No new model-generation test was needed. Local prior suite: 2,120 server tests passed; see the implementation/preview report for its distinct scope.

Screenshots: `/private/tmp/volt142-production-ground-detail-20261101.png` and full context `/private/tmp/volt142-production-ground-full-20261101.png`. `miniShop2 is not defined` was already recorded before rollout at 09:03:30 and again after at 09:10:29. NewTech branding also existed in saved pre-release HTML. Neither unrelated shop issue was changed.

## MODX cache and rollback

Initial broad MODX refresh returned false while all four pages had switched. Diagnostics: script/default/resource/settings successful, only `menu=false`; menu cache directory absent. Do not call that broad result fully successful. Final operator clears only script/default/resource partitions under site-owner effective UID 1231; **all three returned true**. New root-owned cache paths created by initial CLI invocations were recorded and corrected only inside this site's cache/time window; subsequent owner-mode inspection created none. No repeated chunk save was needed.

Local owner-only archive: outer-workspace `work/backups/volt220-pr142-before-20261101.QK3lq6`, including current public source/HTML/JS, exact chunk JSON, final operator and full detached baseline source. Official download **107/107 TypeScript files** matched prior main `ad2773a9`; Deno baseline check passed. Remote archive: `/root/volt220-pr142-backup-20261101/` on testdevops.

Original asset SHA `07d4709639dde1c00287553f886007646fe302dcbc4da76fa201712b0e38e370`; original chunk SHA `296612f3d12b20979230d883a6ce0c6594ca311b80879be3419cdf2066f9eeb3`; released chunk SHA `f1952735d94233e76ea91a31a3995d86ab697e6e9eda1fac24d409e73be1410f`. Archive `ROLLBACK.md` separates MODX, Edge and Lovable/Git restoration. Old immutable asset remains. Integrity/type checks and operator inspect/targeted-cache actions passed; **no live rollback rehearsal** or database disaster-recovery backup is claimed. An already-open page requires navigation/reload to load the new JS; no hot replacement is claimed.

Existing DN027B three-proven-analogs debt, public subject-abuse controls and the full live customer matrix are not closed by PR142.
