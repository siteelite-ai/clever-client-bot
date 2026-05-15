/**
 * SSE heartbeat wrapper for long-running edge function responses.
 *
 * Problem: when the pipeline takes >30s to produce its first byte,
 * intermediate proxies (mobile NAT, browser limits, cloudflare) terminate
 * the idle TCP connection → frontend throws `TypeError: Failed to fetch`.
 *
 * Solution: wrap the inner Response promise.
 *  • Fast responses (<FAST_PATH_MS): pass through unchanged (errors,
 *    duplicates, cached short-circuits).
 *  • Slow responses: commit to SSE, send `: keepalive\n\n` immediately and
 *    every HEARTBEAT_INTERVAL_MS until the inner Response resolves; then
 *    pipe the inner SSE body through. Non-SSE inner responses are
 *    surfaced as a single `data: <json>\n\n` event.
 *
 * The `: keepalive` line is a valid SSE comment — every spec-compliant
 * EventSource parser (browser native + our widget) silently ignores it.
 */

export const SSE_HEARTBEAT_INTERVAL_MS = 5000;
export const SSE_HEARTBEAT_FAST_PATH_MS = 200;
export const SSE_HEARTBEAT_LINE = ': keepalive\n\n';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  // Disable buffering at any reverse proxy in front of us.
  'X-Accel-Buffering': 'no',
};

export interface HeartbeatOptions {
  fastPathMs?: number;
  intervalMs?: number;
  corsHeaders?: Record<string, string>;
  /**
   * Hook for tests: returns ms timestamp.
   */
  now?: () => number;
}

/**
 * Wrap an inner Response promise with an SSE heartbeat that fires until the
 * inner pipeline produces its first byte.
 *
 * Contract:
 *  - If inner resolves within `fastPathMs` (default 200ms), the inner
 *    Response is returned unchanged. JSON / non-SSE responses are NEVER
 *    wrapped on the fast path.
 *  - If inner takes longer, we return an SSE Response immediately. The
 *    first `: keepalive` is sent right away, then every `intervalMs`
 *    (default 5000ms) until inner resolves. Inner SSE body is piped
 *    through; inner non-SSE body is wrapped as a single `data:` event +
 *    `[DONE]` so the client receives something parseable.
 *  - On inner rejection (slow path), we emit a `data: {"error":"..."}`
 *    event followed by `[DONE]` and close cleanly. The original error is
 *    NOT re-thrown (we already committed to a 200 SSE response).
 *  - On inner rejection (fast path), the rejection propagates to the
 *    caller unchanged.
 */
export async function wrapWithHeartbeat(
  innerPromise: Promise<Response>,
  options: HeartbeatOptions = {},
): Promise<Response> {
  const fastPathMs = options.fastPathMs ?? SSE_HEARTBEAT_FAST_PATH_MS;
  const intervalMs = options.intervalMs ?? SSE_HEARTBEAT_INTERVAL_MS;
  const corsHeaders = options.corsHeaders ?? {};

  // Race: if inner finishes within fastPathMs, return as-is.
  let settled = false;
  let settledValue: Response | null = null;
  let settledError: unknown = null;
  innerPromise.then(
    (r) => { settled = true; settledValue = r; },
    (e) => { settled = true; settledError = e; },
  );
  await new Promise<void>((r) => setTimeout(r, fastPathMs));
  if (settled) {
    if (settledError !== null) throw settledError;
    return settledValue as unknown as Response;
  }

  // Slow path: wrap with heartbeat-injecting SSE stream.
  const encoder = new TextEncoder();
  let interval: number | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // First heartbeat synchronously: flushes TCP, beats the proxy idle timer.
      try { controller.enqueue(encoder.encode(SSE_HEARTBEAT_LINE)); } catch (_) { /* noop */ }
      interval = setInterval(() => {
        try { controller.enqueue(encoder.encode(SSE_HEARTBEAT_LINE)); } catch (_) { /* noop */ }
      }, intervalMs) as unknown as number;

      try {
        const inner = await innerPromise;
        if (interval !== undefined) clearInterval(interval);

        const ct = inner.headers.get('content-type') ?? '';
        const isSse = ct.includes('text/event-stream');

        if (!isSse) {
          // JSON / text inner — surface as single data event so client sees something.
          const body = inner.body ? await inner.text() : '';
          if (body) controller.enqueue(encoder.encode(`data: ${body}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          try { controller.close(); } catch (_) { /* noop */ }
          return;
        }

        if (inner.body) {
          const reader = inner.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) controller.enqueue(value);
          }
        }
        try { controller.close(); } catch (_) { /* noop */ }
      } catch (e) {
        if (interval !== undefined) clearInterval(interval);
        try {
          const msg = (e instanceof Error ? e.message : String(e)) || 'internal error';
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`),
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } catch (_) { /* noop */ }
        try { controller.close(); } catch (_) { /* noop */ }
      }
    },
    cancel() {
      if (interval !== undefined) clearInterval(interval);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { ...corsHeaders, ...SSE_HEADERS },
  });
}
