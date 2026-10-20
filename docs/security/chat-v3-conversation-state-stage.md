# V3 server-owned conversation state: default-off stage

This stage adds no live handler or widget behavior. The three migrations are
ordered: new service-only tables, a short nullable log-binding change, then
RPCs. The live v3 handler does not import `conversation-state.ts`.

## Trust and lifecycle contract for a later feature-on change

1. Generate a fresh 32-byte bearer with Web Crypto. Send only
   `SHA-256(raw bearer bytes)` to the service-role RPCs; never log, persist in
   `chat_request_logs`, or expose the raw bearer in operational diagnostics.
2. Resolve the presented bearer on the server. Only after **winning a new**
   unique `message_id` log insert, set its nullable `chat_v3_topic_id` in that
   INSERT from the resolved server topic. Never use a browser-provided topic ID
   or attach a replayed/pre-existing log. The insert binding is immutable.
  The binding trigger runs only on non-NULL inserts or attempted changes to
  that column; legacy inserts and ordinary terminal log updates bypass it.
3. Call `begin` only for that newly claimed log. Only `status="begun"` with
   `replayed=false` authorizes work. `turn_in_progress`, `finalized`, busy,
   stale, unavailable and every other result must not start paid work.
4. Construct a typed, allowlisted snapshot from **server-owned** catalog,
   tool, selection and completed-turn evidence. The generic size checker is
   not a provenance validator. Do not copy browser history, slots, message
   text presented as assistant output, or raw API responses into state.
   `source_log_id` must match the claimed log. Finalize only after the durable
   log has `error IS NULL` and ends in the matching successful terminal
   diagnostic plus `done`.
5. On failure, abort the fenced turn; on a new topic, mint a new bearer and
   rotate. The old topic's token then becomes inactive. Handle a lost RPC
   response by retrying with the **same** generated bearer, not by minting a
   second one.

Snapshots are limited to 16 KiB, idle validity to 30 minutes since create or
last successful finalize, and absolute lineage lifetime to 24 hours. A turn
admitted before idle expiry may finish within its five-minute lease. Database
fences and counters have a high 1-billion cap (well within JavaScript's safe
integer range); 1024 topic rotations is the separate lineage hard cap. The
browser must be given a clear restart path for an expired bearer or any cap.

## Release gate

The disposable PostgreSQL 16 workflow verifies candidate RPC behavior,
grants and one two-connection begin race on a minimal synthetic log table. It
is **not** proof of compatibility with the complete production migration
chain, all log triggers/GC, other races, or browser behavior. Before applying
any of these migrations:

- Run all existing migrations plus these three in order on a disposable clone
  of the real schema; verify log inserts, terminal updates, GC and old widget
  traffic still work.
- Extend the two-connection test to cover stale finalize/rotate and unique
  `message_id` replay on the real schema clone.
- Rehearse the short log-column migration on a realistic table under load;
  its `lock_timeout=2s` should fail rather than queue traffic. The new log
  column has no index in this stage because no live query uses one.
- Only then wire behind a server-owned flag, test in closed preview, and
  explicitly decide on production migration/deployment and rollback. Reverting
  code is easy; reversing a database migration requires its own plan.
