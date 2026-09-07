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
- Recovery applies both before and after visible intro text. A partial intro is
  not evidence of a complete response.

## Regression gate

`scripts/qa/widget-session-state.test.mjs` covers:

- interruption before the first answer token;
- interruption after intro but before product cards;
- a healthy stream lasting longer than one idle interval via heartbeats;
- `[DONE]` on a transport that remains physically open;
- fast proxy-to-direct failover;
- one shared deadline when both routes are unavailable;
- SSE bodies whose content type was rewritten by an intermediary.
