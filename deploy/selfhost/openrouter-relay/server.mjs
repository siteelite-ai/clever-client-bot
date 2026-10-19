import http from 'node:http';
import https from 'node:https';
import { Transform, pipeline } from 'node:stream';
import { pathToFileURL } from 'node:url';

// Deliberately not configurable through environment variables or request data.
// The Docker container holds no OpenRouter credential: callers send their own
// Authorization header through the private SSH tunnel.
const UPSTREAM_HOST = 'openrouter.ai';
const UPSTREAM_PORT = 443;
const PORT = 19084;
const ALLOWED_HOSTS = new Set([
  '127.0.0.1:19084',
  'localhost:19084',
  'volt220test-relay-client:19084',
]);
const POST_PATHS = new Set([
  '/api/v1/chat/completions',
  '/api/v1/embeddings',
]);
const HEALTH_PATH = '/api/v1/models/health';
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_CONCURRENT_POSTS = 4;
const BODY_TIMEOUT_MS = 30_000;
const UPSTREAM_IDLE_TIMEOUT_MS = 90_000;
const UPSTREAM_TOTAL_TIMEOUT_MS = 180_000;
const HEALTH_TIMEOUT_MS = 15_000;

class ClientError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, code) {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  const body = JSON.stringify(status < 400 ? { status: code } : { error: code });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function validateHost(req) {
  const host = req.headers.host;
  if (typeof host !== 'string' || !ALLOWED_HOSTS.has(host.toLowerCase())) {
    throw new ClientError(400, 'invalid_host');
  }
}

function validateAuthorization(req) {
  const value = req.headers.authorization;
  if (typeof value !== 'string' || !/^Bearer [^\s]{8,4096}$/.test(value)) {
    throw new ClientError(401, 'bearer_required');
  }
  return value;
}

function validateRequestHeaders(req) {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    throw new ClientError(415, 'json_required');
  }
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    throw new ClientError(415, 'encoding_not_supported');
  }
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) {
    throw new ClientError(413, 'body_too_large');
  }
  // Node normally rejects CL+TE, but fail closed even if parser settings change.
  if (length !== undefined && req.headers['transfer-encoding'] !== undefined) {
    throw new ClientError(400, 'ambiguous_length');
  }
}

function optionalHeader(req, name, maxLength) {
  const value = req.headers[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maxLength || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ClientError(400, 'invalid_header');
  }
  return value;
}

async function readJsonBody(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new ClientError(413, 'body_too_large');
    chunks.push(chunk);
  }
  if (bytes === 0) throw new ClientError(400, 'invalid_json');
  const body = Buffer.concat(chunks, bytes);
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected a JSON object');
    }
  } catch {
    throw new ClientError(400, 'invalid_json');
  }
  return body;
}

function forwardResponse(upstreamRes, res) {
  const contentType = upstreamRes.headers['content-type'];
  const retryAfter = upstreamRes.headers['retry-after'];
  const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  if (typeof contentType === 'string') headers['content-type'] = contentType;
  if (typeof retryAfter === 'string' && /^\d{1,6}$/.test(retryAfter)) {
    headers['retry-after'] = retryAfter;
  }
  res.writeHead(upstreamRes.statusCode || 502, headers);
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) {
        done(new Error('response_limit'));
      } else {
        done(null, chunk);
      }
    },
  });
  // pipeline retains chunk boundaries and backpressure for SSE. No body is logged.
  pipeline(upstreamRes, limiter, res, (error) => {
    if (error) res.destroy();
  });
}

function proxyPost(req, res, requestUpstream, path, authorization, body, referer, title) {
  const headers = {
    authorization,
    'content-type': 'application/json',
    'content-length': body.length,
    accept: 'application/json, text/event-stream',
    'accept-encoding': 'identity',
  };
  if (referer) headers['http-referer'] = referer;
  if (title) headers['x-title'] = title;

  let finished = false;
  const upstreamReq = requestUpstream({
    hostname: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    path,
    method: 'POST',
    headers,
    rejectUnauthorized: true,
    servername: UPSTREAM_HOST,
  }, (upstreamRes) => {
    finished = true;
    forwardResponse(upstreamRes, res);
  });
  const totalTimer = setTimeout(() => {
    upstreamReq.destroy(Object.assign(new Error('upstream_timeout'), { code: 'ETIMEDOUT' }));
  }, UPSTREAM_TOTAL_TIMEOUT_MS);
  totalTimer.unref?.();
  upstreamReq.setTimeout?.(UPSTREAM_IDLE_TIMEOUT_MS, () => {
    upstreamReq.destroy(Object.assign(new Error('upstream_timeout'), { code: 'ETIMEDOUT' }));
  });
  upstreamReq.on('error', (error) => {
    clearTimeout(totalTimer);
    if (!finished) sendJson(res, error?.code === 'ETIMEDOUT' ? 504 : 502, 'upstream_unavailable');
    else res.destroy();
  });
  res.on('close', () => {
    clearTimeout(totalTimer);
    if (!res.writableFinished) upstreamReq.destroy();
  });
  upstreamReq.end(body);
}

function healthCheck(res, requestUpstream) {
  let finished = false;
  const upstreamReq = requestUpstream({
    hostname: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    path: '/api/v1/models',
    method: 'GET',
    headers: { accept: 'application/json', 'accept-encoding': 'identity' },
    rejectUnauthorized: true,
    servername: UPSTREAM_HOST,
  }, (upstreamRes) => {
    finished = true;
    clearTimeout(timer);
    const healthy = upstreamRes.statusCode === 200;
    upstreamRes.destroy(); // This check needs only HTTP status, not the large model list.
    sendJson(res, healthy ? 200 : 503, healthy ? 'ok' : 'upstream_unavailable');
  });
  const timer = setTimeout(() => {
    upstreamReq.destroy(Object.assign(new Error('health_timeout'), { code: 'ETIMEDOUT' }));
  }, HEALTH_TIMEOUT_MS);
  timer.unref?.();
  upstreamReq.setTimeout?.(HEALTH_TIMEOUT_MS, () => {
    upstreamReq.destroy(Object.assign(new Error('health_timeout'), { code: 'ETIMEDOUT' }));
  });
  upstreamReq.on('error', () => {
    clearTimeout(timer);
    if (!finished) sendJson(res, 503, 'upstream_unavailable');
  });
  res.on('close', () => {
    clearTimeout(timer);
    if (!res.writableFinished) upstreamReq.destroy();
  });
  upstreamReq.end();
}

export function createRelayServer({ requestUpstream = https.request } = {}) {
  if (typeof requestUpstream !== 'function') throw new TypeError('requestUpstream must be a function');
  let activePosts = 0;
  const server = http.createServer({
    maxHeaderSize: 8 * 1024,
    headersTimeout: 20_000,
    requestTimeout: BODY_TIMEOUT_MS,
    keepAliveTimeout: 5_000,
  }, async (req, res) => {
    try {
      validateHost(req);
      const path = req.url;
      if (path !== HEALTH_PATH && !POST_PATHS.has(path)) {
        sendJson(res, 404, 'not_found');
        return;
      }
      if (path === HEALTH_PATH) {
        if (req.method !== 'GET') {
          res.setHeader('allow', 'GET');
          sendJson(res, 405, 'method_not_allowed');
          return;
        }
        if ((req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') ||
            req.headers['transfer-encoding'] !== undefined) {
          sendJson(res, 400, 'body_not_allowed');
          return;
        }
        healthCheck(res, requestUpstream);
        return;
      }
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        sendJson(res, 405, 'method_not_allowed');
        return;
      }
      const authorization = validateAuthorization(req);
      validateRequestHeaders(req);
      const referer = optionalHeader(req, 'http-referer', 1024);
      const title = optionalHeader(req, 'x-title', 256);
      if (activePosts >= MAX_CONCURRENT_POSTS) {
        res.setHeader('retry-after', '1');
        sendJson(res, 429, 'relay_busy');
        return;
      }
      activePosts += 1;
      res.once('close', () => { activePosts -= 1; });
      const body = await readJsonBody(req);
      proxyPost(req, res, requestUpstream, path, authorization, body, referer, title);
    } catch (error) {
      if (error instanceof ClientError) sendJson(res, error.status, error.code);
      else sendJson(res, 500, 'internal_error');
    }
  });
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const server = createRelayServer();
  server.listen(PORT, '0.0.0.0', () => {
    process.stdout.write(`OpenRouter test relay listening on container port ${PORT}\n`);
  });
}
