# Preview 684 checkpoint — 2026-10-05

Commit `0d5f9c17` changes only classification-sentence cleanup: a different
compound live class must be named in full before the sentence is discarded.
The live `Кабель и провод` taxonomy has both `кабели пожарной сигнализации`
and `Кабели сигнально-блокировочные`. The previously unique-stem check treated
the word `пожарной` in the explanation of cable sizing as the first class,
erased the `2.5 мм²` source sentence, and failed property attribution.

Local red/green regression: `selection-actionability_test.ts` failed before
the fix and passed afterward. Full shared suite: 895 passed, 0 failed.
`deno check supabase/functions/chat-consultant-v3/index.ts` passed.

The preview-only deployment is function version **684**. The production
`chat-consultant-v3` function remains version **448** (management API check).
The draft PR is #67; no merge or production deployment was performed.

Live target and three controls were rerun on preview684, but all stopped
before model reasoning with `upstream_quota_exceeded`:

| Scenario | Request log ID |
| --- | --- |
| audit-05 breaker 1P/16A/C under 1000 | `3373d425-399c-4e0e-ae89-2723e7353208` |
| audit-12 3 kW air-conditioner cable | `f7ac004c-ff03-4428-8d4e-c5d918fd4dc7` |
| audit-16 warm E27 lamps | `d55fa45a-00fe-435a-ba00-ea6ae8821d39` |
| audit-25 black→white concealed sockets | `526ec2f6-8595-4ac5-92ed-4fdda46c4b0f` |

The audit-12 server log contains provider HTTP 402 `payment_required`,
`Not enough credits`, with `requires: top_up`. This is an inconclusive live
test, not a pass and not evidence of a code regression. Do not repeat paid
model probes until the balance is restored. Full 28-case and browser
regression remain pending.
