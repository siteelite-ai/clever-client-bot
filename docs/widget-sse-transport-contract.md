# Widget SSE transport contract

The public widget uses one logical request across two network routes. Product
selection and replay must never be re-executed merely because delivery failed.

## Time budgets

- Connection: 15 seconds per route. This covers DNS/TLS/headers and enables a
  quick fallback when one hostname is unreachable from the customer's network.
- Protocol acceptance: 15 seconds per route. SSE comments prove byte-level
  liveness but do not prove that the backend durably claimed the logical turn.
  This timer begins after HTTP response headers, not at request start. A
  diagnostic carrying the request log id is the durable acceptance signal.
- Inactivity: 30 seconds, refreshed by every response byte, including SSE
  comments. The v3 backend sends a heartbeat every 10 seconds, so a healthy
  long-running request is not aborted.
- Whole turn: 155 seconds by default for initial delivery, fallback and replay.
  Only when the proxy times out before acceptance may the direct fallback
  receive a fresh 155-second budget, capped at 185 seconds from the start of
  the logical turn (15 seconds proxy connection + 15 seconds proxy acceptance
  + 155 seconds backend/transport). HTTP failures and direct-first fallback do
  not extend that deadline. Replay keeps the same logical `messageId`.

The Cloudflare proxy is the primary route because it is intended for networks
where the Supabase project hostname is unavailable. Direct Supabase is the
fallback. If the proxy connection times out but the direct route completes a
turn, that open widget instance prefers direct for three minutes; the proxy
remains its fallback and automatically becomes primary again after expiry.
This route preference is not persisted across reloads.

## Completion and recovery

- `diagnostic phase=complete` is the authoritative server completion record and
  includes the expected product count.
- `[DONE]` is the logical SSE terminator. The browser stops immediately at this
  event and must not wait for an intermediary to close a keep-alive socket.
- A completed diagnostic with missing product markup is still incomplete
  delivery and must be recovered.
- Once a diagnostic log id has been received, retry is always `resumeOnly` with
  the same `messageId`. It replays persisted events and must not execute catalog
  search or the model again.
- When a second route finds that same `messageId` already in progress, it emits
  a non-persisted diagnostic acceptance before waiting for completion. This
  keeps the replay connection alive without creating a second execution or
  changing the canonical stored response.
- The claiming `sessionId` is immutable for every transport attempt of that
  message, even if a conversation-boundary event rotates the visible session
  for the next user turn.
- A replay diagnostic with `error=request_pending` is recoverable, not a
  successful terminal answer. Recovery continues on the remaining route while
  the shared deadline permits it.
- Recovery applies both before and after visible intro text. A partial intro is
  not evidence of a complete response.
- Replay attempts render off-screen. The complete canonical replay is committed
  atomically; if none completes, the most informative partial replay is kept
  without duplicating cards.

## Regression gate

`scripts/qa/widget-session-state.test.mjs` covers:

- interruption before the first answer token;
- interruption after intro but before product cards;
- two sequential partial replay routes without duplicate product cards;
- best-partial preservation when the final resume route is unavailable;
- `request_pending` recovery on the remaining route;
- immutable request session across a conversation-boundary replay;
- a healthy stream lasting longer than one idle interval via heartbeats;
- heartbeat delivery when a proxy rewrites SSE as `text/plain`;
- idle abort when no response bytes arrive;
- `[DONE]` on a transport that remains physically open;
- fast proxy-to-direct failover;
- slow response headers followed by a full application-acceptance window;
- a proxy pre-acceptance timeout followed by a long valid direct response;
- temporary direct-first preference, proxy recovery and same-`messageId`
  partial replay in direct-first mode;
- an existing in-progress request accepting the replay connection before its
  potentially long completion wait;
- one shared deadline when both routes are unavailable;
- SSE bodies whose content type was rewritten by an intermediary.
