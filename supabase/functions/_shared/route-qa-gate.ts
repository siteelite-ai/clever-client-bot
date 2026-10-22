/**
 * Admission for the three isolated legacy-route QA entrypoints. A Supabase
 * anon JWT is public and is not sufficient authorization for paid handlers.
 * Configure a short-lived random secret on the server; never place it in
 * widget code. Expiry protects paid preview routes even if cleanup is delayed.
 */
export const ROUTE_QA_SECRET_ENV = "VOLT220_ROUTE_QA_SECRET";
export const ROUTE_QA_SECRET_HEADER = "x-volt220-route-qa-secret";

// Keep the same per-run timestamp/randomness convention as the V3 closure
// gate. The secret is not a self-authenticating token: the exact value must
// also match the independently configured server-side secret.
const SECRET_PATTERN = /^(\d{10})_[a-f0-9]{32}_[A-Za-z0-9_-]{64}$/;
export const ROUTE_QA_MAX_AGE_SECONDS = 20 * 60;
export const ROUTE_QA_MAX_FUTURE_SECONDS = 120;
const encoder = new TextEncoder();

function validSecret(
  value: string | null | undefined,
  nowSeconds: number,
): value is string {
  if (typeof value !== "string" || !Number.isSafeInteger(nowSeconds)) return false;
  const match = SECRET_PATTERN.exec(value);
  if (!match) return false;
  const issuedSeconds = Number(match[1]);
  return issuedSeconds - nowSeconds <= ROUTE_QA_MAX_FUTURE_SECONDS &&
    nowSeconds - issuedSeconds <= ROUTE_QA_MAX_AGE_SECONDS;
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export async function routeQaSecretAuthorized(
  provided: string | null,
  configured: string | null | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!validSecret(provided, nowSeconds) || !validSecret(configured, nowSeconds)) return false;
  try {
    // Fixed-size digests avoid a prefix- or length-dependent equality check.
    const [actual, expected] = await Promise.all([digest(provided), digest(configured)]);
    let difference = 0;
    for (let i = 0; i < expected.length; i++) difference |= actual[i] ^ expected[i];
    return difference === 0;
  } catch {
    // Missing WebCrypto is an admission failure, never a bypass.
    return false;
  }
}

function denial(status: 403 | 405 | 500, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      ...(status === 405 ? { Allow: "POST" } : {}),
    },
  });
}

/**
 * Gate every method before the original handler (including OPTIONS). A QA
 * caller must have both a valid server-only secret and, at the gateway,
 * verify_jwt=true. This endpoint intentionally has no browser CORS path.
 */
export function createRouteQaHandler(
  handler: (request: Request) => Promise<Response>,
  readEnv: (name: string) => string | undefined = (name) => Deno.env.get(name),
): (request: Request) => Promise<Response> {
  return async (request) => {
    const provided = request.headers.get(ROUTE_QA_SECRET_HEADER);
    let configured: string | undefined;
    try {
      configured = readEnv(ROUTE_QA_SECRET_ENV);
    } catch {
      return denial(403, "forbidden");
    }
    if (!await routeQaSecretAuthorized(provided, configured)) {
      return denial(403, "forbidden");
    }
    if (request.method !== "POST") return denial(405, "method_not_allowed");

    // Keep the QA credential out of the production handler's logging path.
    let forwarded: Request;
    try {
      const headers = new Headers(request.headers);
      headers.delete(ROUTE_QA_SECRET_HEADER);
      forwarded = new Request(request, { headers });
    } catch {
      return denial(500, "request_forwarding_failed");
    }
    return await handler(forwarded);
  };
}
