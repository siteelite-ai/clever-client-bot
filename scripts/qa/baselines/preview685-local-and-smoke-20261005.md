# Preview 685 checkpoint — 2026-10-05

Draft PR #67 HEAD `f2f2bb22`. Changes since preview684: a provenance-aware
motion-sensor contradiction veto; server-issued pending-clarification recovery;
fail-closed aggregate continuation when a total is unverified or changes;
and independent boolean gating on the paired-compatibility recovery route.
These are not accepted customer outcomes yet.

Local verification: 903 shared tests passed, 0 failed; Edge `deno check`
passed; `git diff --check` passed. Supabase management API confirms isolated
preview version **685** and production function version **448** (unchanged).

One no-model preview smoke test submitted a forged browser
`pending_clarification` for a fresh session. Preview returned HTTP 200,
cleared the unverified slot, and asked for a full current request. It did not
search or recommend a product. Request log:
`d9599c7d-efe2-43d2-90c6-2b47425d0b88`.

Live product acceptance remains **unverified** because the provider returned
HTTP 402 `Not enough credits` during preview684 probes. Do not call the cable,
sensor, parking, living-room or outdoor-CCTV cases closed. The last completed
unchanged full matrix was **23/28** on preview681. Next: restore model credit;
run targeted scenarios and the full 28-case matrix on preview685; then browser
tests, inspect semantic outputs and only afterward consider a production merge.
