/** A private, bounded catalog check before any paid customer-acceptance turn. */
export const CATALOG_QA_SECRET_ENV = 'VOLT220_V3_CATALOG_QA_SECRET';
export const CATALOG_QA_SECRET_HEADER = 'x-catalog-qa-secret';
// The Edge probe performs two parallel checks with an 8 s server deadline.
export const CATALOG_PREFLIGHT_TIMEOUT_MS = 12_000;

const projectOrigin = 'https://yngoixmvmxdfxokuafjp.supabase.co';
const functionPaths = new Set([
  '/functions/v1/chat-consultant-v3',
  '/functions/v1/chat-consultant-v3-preview',
  '/functions/v1/chat-consultant-v3-closure-preview',
]);
const classifications = new Set(['auth', 'route', 'rate_limit', 'upstream', 'transport', 'schema_error']);

function isLocalEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return ['localhost', '127.0.0.1'].includes(url.hostname);
  } catch {
    return false;
  }
}

export function catalogPreflightRequired(endpoint, strictFullSuite = false) {
  return strictFullSuite || !isLocalEndpoint(endpoint);
}

export function trustedCatalogPreflightEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash) return false;
    if (isLocalEndpoint(endpoint)) {
      return ['http:', 'https:'].includes(url.protocol) && functionPaths.has(url.pathname);
    }
    return url.origin === projectOrigin && functionPaths.has(url.pathname);
  } catch {
    return false;
  }
}

function classifyStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404 || status === 405) return 'route';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'upstream';
  return 'schema_error';
}

async function readBoundedText(response, maxBytes = 4_096) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Never return response text, request URLs, secrets, or thrown error messages. */
export async function runCatalogHealthPreflight({
  endpoint,
  anonKey,
  previewHeaders = {},
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = CATALOG_PREFLIGHT_TIMEOUT_MS,
} = {}) {
  const started = Date.now();
  const result = (ok, classification = null, httpStatus = null) => ({
    ok,
    status: ok ? 'ready' : 'unavailable',
    ...(classification ? { classification } : {}),
    ...(httpStatus !== null ? { http_status: httpStatus } : {}),
    duration_ms: Date.now() - started,
  });
  // Check the destination before reading or attaching a private credential.
  if (!trustedCatalogPreflightEndpoint(endpoint)) return result(false, 'config');
  const secret = env?.[CATALOG_QA_SECRET_ENV];
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
    return result(false, 'config');
  }
  if (typeof anonKey !== 'string' || !anonKey) return result(false, 'config');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return result(false, 'config');

  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('catalog preflight deadline'));
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${anonKey}`,
          apikey: anonKey,
          ...previewHeaders,
          [CATALOG_QA_SECRET_HEADER]: secret,
        },
        body: JSON.stringify({ type: 'catalog_health_preflight' }),
        signal: controller.signal,
      }),
      deadline,
    ]);
    const status = Number.isSafeInteger(response?.status) ? response.status : null;
    if (status === null) return result(false, 'schema_error');
    const raw = await Promise.race([readBoundedText(response), deadline]);
    if (raw === null) return result(false, 'schema_error', status);
    let body;
    try { body = JSON.parse(raw); } catch { return result(false, 'schema_error', status); }
    if (status === 200 && body?.ok === true && body.status === 'ready' &&
      body.checks?.categories?.status === 'ok' && body.checks?.products?.status === 'ok' &&
      body.checks.categories.http_status === 200 && body.checks.products.http_status === 200) {
      return result(true, null, status);
    }
    const serverClassification = body?.classification;
    return result(false,
      status === 200 ? 'schema_error'
        : classifications.has(serverClassification) ? serverClassification : classifyStatus(status),
      status);
  } catch {
    return result(false, 'transport');
  } finally {
    clearTimeout(timer);
  }
}
