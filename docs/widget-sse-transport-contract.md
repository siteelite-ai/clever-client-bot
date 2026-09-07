# Widget SSE transport contract

The public widget uses one logical request across two network routes. Product
selection and replay must never be re-executed merely because delivery failed.

## Time budgets

- Connection: 15 seconds per route. This covers DNS/TLS/headers and enables a
  quick fallback when one hostname is unreachable from the customer's network.
- Inactivity: 30 seconds, refreshed by every response byte, including SSE
  comments. The v3 backend sends a heartbeat every 10 seconds, so a healthy
  long-running request is not aborted.
- Whole turn: 155 seconds shared by initial delivery, route fallback and replay.
  Routes do not receive independent full-turn budgets.

The Cloudflare proxy is the primary route because it is intended for networks
where the Supabase project hostname is unavailable. Direct Supabase is the
fallback.

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
- one shared deadline when both routes are unavailable;
- SSE bodies whose content type was rewritten by an intermediary.
