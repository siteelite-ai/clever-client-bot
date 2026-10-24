#!/usr/bin/env node
/**
 * One bounded positive smoke for the protected legacy/search preview routes.
 * The existing route-secret wrapper creates and removes the temporary secret.
 * No response text, headers, credentials, or Management API body is emitted.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runWithRouteQaSecret } from './with-route-qa-secret.mjs';
import {
  ROUTE_CLOSURE_PROJECT_REF as PROJECT_REF,
  ROUTE_CLOSURE_SECRET_HEADER,
} from './run-route-closure-smoke.mjs';

const ROUTES = Object.freeze([
  { name: 'chat-consultant-v2-closure-preview', kind: 'v2', timeoutMs: 15_000 },
  { name: 'search-products-closure-preview', kind: 'search', timeoutMs: 20_000 },
  { name: 'chat-consultant-closure-preview', kind: 'v1', timeoutMs: 60_000 },
]);
const MAX_RESPONSE_BYTES = 128 * 1024;
const ANON_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SECRET = /^(\d{10})_[a-f0-9]{32}_[A-Za-z0-9_-]{64}$/;
const CLASSIFICATIONS = new Set(['transport', 'unexpected_status', 'response_shape']);
const V1_SHAPE_REASONS = new Set([
  'content_type_mismatch', 'invalid_json', 'missing_content', 'empty_content',
  'error_field', 'duplicate', 'other_shape',
]);

function anonKeyFromWidget(source) {
  const key = typeof source === 'string' ? source.match(/supabaseKey:\s*'([^']+)'/)?.[1] : null;
  if (!key || key.length > 2_000 || !ANON_JWT.test(key)) return null;
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
    return payload?.ref === PROJECT_REF && payload?.role === 'anon' ? key : null;
  } catch { return null; }
}

function validSecret(secret) {
  const match = typeof secret === 'string' ? SECRET.exec(secret) : null;
  if (!match) return false;
  const age = Math.floor(Date.now() / 1_000) - Number(match[1]);
  return age >= 0 && age <= 20 * 60;
}

function requestBody(kind) {
  if (kind === 'search') return { action: 'search', query: 'кабель ВВГ', page: 1, perPage: 1 };
  const sessionId = `route-positive-smoke-${randomUUID()}`;
  if (kind === 'v2') return { conversationId: sessionId, query: 'Здравствуйте' };
  return { message: 'Здравствуйте', stream: false, sessionId };
}

function v1ShapeReason(value) {
  let body;
  try { body = JSON.parse(value); } catch { return 'invalid_json'; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'other_shape';
  if (Object.hasOwn(body, 'error')) return 'error_field';
  if (body.duplicate === true) return 'duplicate';
  if (!Object.hasOwn(body, 'content')) return 'missing_content';
  if (typeof body.content !== 'string') return 'other_shape';
  if (!body.content.trim()) return 'empty_content';
  return null;
}

function v1HeartbeatShapeReason(value) {
  const events = [];
  for (const line of value.split(/\r?\n/)) {
    if (line === '' || line === ': keepalive') continue;
    if (!line.startsWith('data: ')) return 'other_shape';
    events.push(line.slice(6));
    if (events.length > 2) return 'other_shape';
  }
  if (events.length !== 2 || events[1] !== '[DONE]') return 'other_shape';
  // The slow-path heartbeat wraps the original JSON as exactly one data
  // event. Reuse the same success and error criteria as the JSON fast path.
  return v1ShapeReason(events[0]);
}

function responseShape(kind, value) {
  if (kind === 'search') {
    const body = JSON.parse(value);
    const product = body?.results?.[0];
    const title = product?.pagetitle ?? product?.name ?? product?.title;
    const id = product?.id ?? product?.siteId;
    return body && typeof body === 'object' && !Array.isArray(body) &&
      Array.isArray(body.results) && body.results.length > 0 &&
      product && typeof product === 'object' && !Array.isArray(product) &&
      (Number.isSafeInteger(id) || (typeof id === 'string' && id.length > 0 && id.length <= 128)) &&
      typeof title === 'string' && title.trim().length > 0 && title.length <= 1_000 &&
      body.pagination && Number.isSafeInteger(Number(body.pagination.total)) &&
      Number(body.pagination.total) >= 1 && body.error === undefined;
  }
  const events = value.split(/\r?\n/).filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6));
  if (events.at(-1) !== '[DONE]') return false;
  let hasContent = false;
  let hasSuccessMeta = false;
  for (const event of events.slice(0, -1)) {
    const data = JSON.parse(event);
    if (!data || typeof data !== 'object' || data.error !== undefined ||
      data.meta?.error !== undefined) return false;
    if (typeof data.choices?.[0]?.delta?.content === 'string' &&
      data.choices[0].delta.content.trim()) hasContent = true;
    if (data.meta?.pipeline_version === 'v2' && data.meta.route === 'S_GREETING' &&
      data.meta.branch_executed === 'real') hasSuccessMeta = true;
  }
  return hasContent && hasSuccessMeta;
}

async function withinDeadline(promise, controller, deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error('deadline');
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('deadline')); }, remaining);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

async function boundedBody(response, controller, deadlineAt) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('body');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const next = await withinDeadline(reader.read(), controller, deadlineAt);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new Error('body');
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('body');
      chunks.push(next.value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    try { void reader.cancel().catch(() => {}); } catch { /* best effort */ }
  }
}

function safeSummary(candidate) {
  if (!candidate || typeof candidate !== 'object' || !Array.isArray(candidate.checks) ||
    typeof candidate.ok !== 'boolean' || !['passed', 'failed'].includes(candidate.status) ||
    candidate.checks.length > ROUTES.length) {
    throw new Error('summary');
  }
  const checks = candidate.checks.map((check, index) => {
    if (check?.function !== ROUTES[index].name ||
      !Number.isSafeInteger(check.http_status) || check.http_status < 100 ||
      check.http_status > 599) throw new Error('summary');
    return { function: ROUTES[index].name, http_status: check.http_status };
  });
  if (candidate.ok && (candidate.status !== 'passed' || checks.length !== ROUTES.length ||
    checks.some((check) => check.http_status !== 200) ||
    candidate.failed_function !== undefined || candidate.shape_reason !== undefined)) throw new Error('summary');
  if (!candidate.ok && (candidate.status !== 'failed' ||
    !CLASSIFICATIONS.has(candidate.classification))) throw new Error('summary');
  if (!candidate.ok) {
    const pending = ROUTES[checks.length]?.name;
    const recorded = checks.length > 0 ? ROUTES[checks.length - 1]?.name : undefined;
    const allowedFunctions = candidate.classification === 'transport' ? [pending]
      : candidate.classification === 'unexpected_status' ? [recorded]
      : [recorded, pending];
    if (!allowedFunctions.includes(candidate.failed_function)) throw new Error('summary');
    if (candidate.classification === 'response_shape' &&
      candidate.failed_function === 'chat-consultant-closure-preview' &&
      !V1_SHAPE_REASONS.has(candidate.shape_reason)) throw new Error('summary');
    if (candidate.shape_reason !== undefined &&
      (candidate.classification !== 'response_shape' ||
        candidate.failed_function !== 'chat-consultant-closure-preview' ||
        !V1_SHAPE_REASONS.has(candidate.shape_reason))) throw new Error('summary');
  }
  return candidate.ok
    ? { ok: true, status: 'passed', checks }
    : {
      ok: false, status: 'failed', classification: candidate.classification,
      failed_function: candidate.failed_function,
      ...(candidate.shape_reason === undefined ? {} : { shape_reason: candidate.shape_reason }),
      checks,
    };
}

/** Never accepts a caller-selected endpoint or function name. */
export async function runPositiveSmoke({
  secret, projectRef = PROJECT_REF, widgetSource, fetchImpl = fetch,
} = {}) {
  if (projectRef !== PROJECT_REF || !validSecret(secret)) {
    return { ok: false, status: 'not_run', classification: 'config', checks: [] };
  }
  let source;
  try {
    source = widgetSource ?? readFileSync(new URL('../../public/widget.js', import.meta.url), 'utf8');
  } catch {
    return { ok: false, status: 'not_run', classification: 'config', checks: [] };
  }
  const anonKey = anonKeyFromWidget(source);
  if (!anonKey) return { ok: false, status: 'not_run', classification: 'config', checks: [] };

  const checks = [];
  for (const route of ROUTES) {
    const controller = new AbortController();
    const deadlineAt = Date.now() + route.timeoutMs;
    let response;
    try {
      response = await withinDeadline(fetchImpl(
        `https://${PROJECT_REF}.supabase.co/functions/v1/${route.name}`,
        {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: {
            Authorization: `Bearer ${anonKey}`, apikey: anonKey,
            [ROUTE_CLOSURE_SECRET_HEADER]: secret,
            'Content-Type': 'application/json', Accept: route.kind === 'v2'
              ? 'text/event-stream' : 'application/json',
          },
          body: JSON.stringify(requestBody(route.kind)),
        },
      ), controller, deadlineAt);
    } catch {
      controller.abort();
      return { ok: false, status: 'failed', classification: 'transport',
        failed_function: route.name, checks };
    }
    const status = response?.status;
    if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
      controller.abort();
      return { ok: false, status: 'failed', classification: 'response_shape',
        failed_function: route.name,
        ...(route.kind === 'v1' ? { shape_reason: 'other_shape' } : {}), checks };
    }
    checks.push({ function: route.name, http_status: status });
    if (status !== 200) {
      controller.abort();
      try { void response.body?.cancel()?.catch(() => {}); } catch { /* no output */ }
      return { ok: false, status: 'failed', classification: 'unexpected_status',
        failed_function: route.name, checks };
    }
    let shapeReason = route.kind === 'v1' ? 'other_shape' : undefined;
    try {
      const contentType = response.headers?.get?.('content-type') || '';
      const mediaType = contentType.toLowerCase();
      const v1Heartbeat = route.kind === 'v1' && mediaType.includes('text/event-stream');
      const acceptedMediaType = route.kind === 'v1'
        ? v1Heartbeat || mediaType.includes('application/json')
        : mediaType.includes(route.kind === 'v2' ? 'text/event-stream' : 'application/json');
      if (!acceptedMediaType) {
        if (route.kind === 'v1') shapeReason = 'content_type_mismatch';
        throw new Error('content-type');
      }
      const body = await boundedBody(response, controller, deadlineAt);
      if (route.kind === 'v1') {
        shapeReason = (v1Heartbeat ? v1HeartbeatShapeReason(body) : v1ShapeReason(body)) ?? undefined;
        if (shapeReason) throw new Error('shape');
      } else if (!responseShape(route.kind, body)) throw new Error('shape');
    } catch {
      controller.abort();
      return { ok: false, status: 'failed', classification: 'response_shape',
        failed_function: route.name,
        ...(shapeReason === undefined ? {} : { shape_reason: shapeReason }), checks };
    } finally { controller.abort(); }
  }
  return { ok: true, status: 'passed', checks };
}

/** Prints only rebuilt allowlisted status, after the wrapper verifies cleanup. */
export async function main({
  argv = process.argv.slice(2), env = process.env, fetchImpl = fetch,
  widgetSource,
  withSecretImpl = runWithRouteQaSecret,
  emit = (summary) => process.stdout.write(`${JSON.stringify(summary)}\n`),
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 1 ||
    argv[0] !== `--project-ref=${PROJECT_REF}` ||
    typeof env?.SUPABASE_ACCESS_TOKEN !== 'string' ||
    !/^[\x21-\x7e]{20,512}$/.test(env.SUPABASE_ACCESS_TOKEN)) {
    emit({ ok: false, status: 'not_run', classification: 'config' });
    return 2;
  }
  let summary;
  try {
    summary = await withSecretImpl({
      projectRef: PROJECT_REF,
      token: env.SUPABASE_ACCESS_TOKEN,
      runChild: (secret) => runPositiveSmoke({ secret, fetchImpl, widgetSource }),
    });
    summary = safeSummary(summary);
  } catch {
    emit({ ok: false, status: 'not_run', classification: 'orchestration' });
    return 1;
  }
  emit({ ...summary, secret_cleanup: 'verified' });
  return summary.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
