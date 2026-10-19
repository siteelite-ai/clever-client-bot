/** Private preview authorization for server-side QA only; never import in a browser. */
const previewFunctions = new Set([
  'chat-consultant-v3-preview',
  'chat-consultant-v3-closure-preview',
]);
const previewOrigin = 'https://yngoixmvmxdfxokuafjp.supabase.co';

export const PREVIEW_SECRET_ENV = 'VOLT220_V3_PREVIEW_SECRET';
export const PREVIEW_SECRET_HEADER = 'x-volt-preview-secret';

export function isPrivatePreviewEndpoint(endpoint) {
  const functionName = new URL(endpoint).pathname.match(/\/functions\/v1\/([^/]+)\/?$/)?.[1];
  return previewFunctions.has(functionName);
}

function assertCanonicalPreviewEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (url.origin !== previewOrigin || url.username || url.password || url.search || url.hash) {
    throw new Error('Private preview QA requires the canonical Supabase project HTTPS endpoint');
  }
}

export function previewAuthHeaders(endpoint, env = process.env) {
  if (!isPrivatePreviewEndpoint(endpoint)) return {};
  assertCanonicalPreviewEndpoint(endpoint);
  const secret = env[PREVIEW_SECRET_ENV];
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
    throw new Error(`Private preview QA requires a 32–256 character ${PREVIEW_SECRET_ENV} environment secret`);
  }
  return { [PREVIEW_SECRET_HEADER]: secret };
}

export function previewRedirectPolicy(endpoint) {
  if (!isPrivatePreviewEndpoint(endpoint)) return {};
  assertCanonicalPreviewEndpoint(endpoint);
  // Fetch redirects are never followed while carrying the private header.
  return { redirect: 'error' };
}

export function redactPreviewSecret(value, headers) {
  const secret = headers[PREVIEW_SECRET_HEADER];
  return typeof value === 'string' && secret
    ? value.replaceAll(secret, '[redacted-preview-secret]')
    : value;
}
