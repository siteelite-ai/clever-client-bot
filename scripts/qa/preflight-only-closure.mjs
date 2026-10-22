#!/usr/bin/env node
/**
 * One private, free catalog-health check against the closed V3 preview.
 * Designed as the trusted child of with-closure-qa-secrets.mjs. It never
 * starts a customer chat, requests a product page, or calls OpenRouter.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { runCatalogHealthPreflight } from './catalog-health-preflight.mjs';
import { previewAuthHeaders } from './preview-auth.mjs';

export const CLOSURE_PREFLIGHT_ENDPOINT =
  'https://yngoixmvmxdfxokuafjp.supabase.co/functions/v1/chat-consultant-v3-closure-preview';
// Edge settings load, the complete bounded taxonomy crawl, then parallel
// representative facets/article checks all run inside this one private call.
export const CLOSURE_PREFLIGHT_TIMEOUT_MS = 40_000;

const secretPattern = /^[A-Za-z0-9_-]{32,256}$/;
const publicJwtPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function publicWidgetKey(widgetSource) {
  const key = widgetSource.match(/supabaseKey:\s*'([^']+)'/)?.[1];
  return typeof key === 'string' && key.length <= 2_000 && publicJwtPattern.test(key)
    ? key
    : null;
}

/** Only whitelisted, non-sensitive fields leave this process. */
function safeSummary(result) {
  return {
    ok: result.ok === true,
    status: result.ok === true ? 'ready' : 'unavailable',
    ...(typeof result.classification === 'string' &&
        ['auth', 'route', 'rate_limit', 'upstream', 'transport', 'schema_error', 'config']
          .includes(result.classification)
      ? { classification: result.classification }
      : {}),
    ...(Number.isSafeInteger(result.http_status) && result.http_status >= 100 &&
        result.http_status <= 599
      ? { http_status: result.http_status }
      : {}),
  };
}

export async function main({
  env = process.env,
  argv = process.argv.slice(2),
  widgetSource,
  fetchImpl = fetch,
  emit = (summary) => process.stdout.write(`${JSON.stringify(summary)}\n`),
} = {}) {
  const configFailure = () => {
    emit({ ok: false, status: 'not_run', classification: 'config' });
    return 2;
  };
  // No caller-provided endpoint, redirect target, or secret-bearing CLI args.
  if (argv.length !== 0) return configFailure();
  const access = env?.VOLT220_V3_QA_SECRET;
  const catalog = env?.VOLT220_V3_CATALOG_QA_SECRET;
  if (typeof access !== 'string' || !secretPattern.test(access) ||
    typeof catalog !== 'string' || !secretPattern.test(catalog) ||
    access === catalog) return configFailure();

  let anonKey;
  try {
    const source = widgetSource ?? readFileSync(
      new URL('../../public/widget.js', import.meta.url), 'utf8',
    );
    anonKey = typeof source === 'string' ? publicWidgetKey(source) : null;
  } catch {
    return configFailure();
  }
  if (!anonKey) return configFailure();

  let previewHeaders;
  try {
    previewHeaders = previewAuthHeaders(CLOSURE_PREFLIGHT_ENDPOINT, env);
  } catch {
    return configFailure();
  }
  const result = await runCatalogHealthPreflight({
    endpoint: CLOSURE_PREFLIGHT_ENDPOINT,
    anonKey,
    previewHeaders,
    env,
    fetchImpl,
    timeoutMs: CLOSURE_PREFLIGHT_TIMEOUT_MS,
  });
  emit(safeSummary(result));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = await main();
  } catch {
    // Never print a thrown request or provider error: it may contain headers.
    process.stderr.write('{"ok":false,"status":"unavailable","classification":"transport"}\n');
    process.exitCode = 1;
  }
}
