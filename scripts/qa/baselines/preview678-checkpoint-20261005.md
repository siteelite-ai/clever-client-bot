# Preview 678 checkpoint — 2026-10-05

## Verified baseline
- Full customer matrix: **22 PASS / 6 FAIL**, 28 cases, one run each.
- Preview deployed code: 60c14bbe. The matrix did not run against the later local scope change.
- Saved complete matrix: preview678-full-matrix-20261005.json.
- Failed-case server evidence: preview678-failed-case-diagnostics-20261005.json.
- No production deployment or merge performed in this work.

## Failures and evidence
| Case | Evidence / next work |
| --- | --- |
| 02, cable → motion light | Server emitted new_task on the second turn. The run then asked an extra prerequisite question; repeated request returned 5 cards, including acoustic sensors. Do not mislabel this as proven missing new-task detection. Clarification consistency, test turn accounting and product-source contradiction remain open. |
| 03, living room | a94e42fa-5e9f-41e9-b268-dc72b8a178c6: derived_selection_reasoning_contract_invalid. Total room demand was declared per_product. |
| 09b, novice breaker | 14d1dfc9-b160-4d27-b5cf-da836f9d23f4: same contract rejection, necessity_not_established for nominal current 25 A. Customer-owned evidence across the conversation and schema label matching require diagnosis. |
| 12, AC cable | 432af30c-3d58-4704-a290-44e639428e68: key_not_grounded for cable cross-section. Also review unconfirmed engineering assumptions; do not relax proof merely to get cards. |
| 15, outdoor analog CCTV | 378a8582-6393-49a7-804e-9dc776febbf8: no internal error; retrieved PVC-sheathed cables rejected against outdoor-shell requirement. Missing 75-ohm requirement and contradictory mandatory/advisory text remain. Need catalog evidence, not forced cards. |
| 17, parking | 67d5dd57-264a-4065-b0b3-fae4a4550d0e: total 10000 lm declared per_product and rejected before configuration clarification. |

Four failures are server contract rejection, not demonstrated connection loss.

## Local scope correction (not deployed)
- Reproduce aggregate/per-item conflict with a red test before implementation.
- If visible aggregate demand lacks validated per-item evidence, route to configuration clarification before freezing an invalid product plan.
- Freeze no provisional properties or classification IDs on this path; it cannot search or render products.
- Arbitrary system_total labels without visible aggregate proof do not excuse invalid obligations.
- Existing strict per-item obligation rejection preserved.
- Regression: 892 passed, 0 failed; type check and diff check passed.
- This is **not** closure of cases 03/17. Full follow-up after choosing one/multiple items is still required. In particular, the malformed declaration is not checkpointed as a valid plan; continuation must rederive and validate it.

## Release gate
Do not merge/deploy production. Finish remaining mechanisms, verify configuration continuations end to end, then repeat the unchanged full suite and browser acceptance. Unit success and clarification replacing an error do not equal successful product selection.

