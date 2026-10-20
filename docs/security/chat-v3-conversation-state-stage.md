# V3 server-owned conversation state: default-off stage

This stage adds no live handler or widget behavior. Five migrations are
ordered: service-only tables, nullable log binding, lifecycle RPCs, atomic
terminal commit, and atomic claim plus begin. The live v3 handler does not
import `conversation-state.ts`; its new atomic methods are default-off.

## Trust and lifecycle contract for a later feature-on change

1. Generate a fresh 32-byte bearer with Web Crypto. Send only
   `SHA-256(raw bearer bytes)` to the service-role RPCs; never log, persist in
   `chat_request_logs`, or expose the raw bearer in operational diagnostics.
2. Resolve the presented bearer on the server, then use
   `claim_and_begin_chat_v3_conversation_turn` with one server-generated log ID.
   It inserts the unique `message_id` log with the resolved topic binding and
   acquires the turn lease in one transaction. Never accept a browser-provided
   topic or log ID. A transport retry may use only the **same** generated ID.
   Legacy log inserts remain unchanged while the opt-in path is off.
3. Only `status="begun"` (including a recovered response for that exact log ID)
   authorizes paid work. `turn_in_progress`, `finalized`, busy, stale,
   unavailable and every other result must not start a second worker.
4. Construct a typed, allowlisted snapshot from **server-owned** catalog,
   tool, selection and completed-turn evidence. The generic size checker is
   not a provenance validator. Do not copy browser history, slots, message
   text presented as assistant output, or raw API responses into state.
   `source_log_id` must match the claimed log. For the opt-in path, build the
   proposed terminal replay events and snapshot **before** calling
   `finish_chat_v3_conversation_turn`; that RPC commits log and state together.
   Public success and `done` must wait for its confirmed terminal result.
5. On failure, atomically persist a replayable failure without advancing state;
   on an explicit new topic, mint a new bearer and rotate. The old topic's
   token then becomes inactive. Retry a lost RPC response with its identical
   generated bearer/log ID and identical terminal payload, never a new one.

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

- Run all existing migrations plus these five in order on a disposable clone
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
