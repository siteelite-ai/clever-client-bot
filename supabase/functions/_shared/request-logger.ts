/**
 * Request-scoped logger для chat-consultant (V1) и chat-consultant-v2.
 *
 * Использует AsyncLocalStorage, чтобы любой код в pipeline мог писать
 * шаги без проброса контекста через все сигнатуры.
 *
 * Хранение: таблица `chat_request_logs` (TTL 24ч, lazy-GC через trigger).
 * Запись: fire-and-forget через service_role key.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

export interface LogStep {
  step: string;            // 'classify' | 'pagetitle' | 'name-query' | 'qfv2-pool' | 'jargon-fallback' | …
  total?: number;          // сколько товаров вернул шаг
  ms?: number;             // длительность
  meta?: Record<string, unknown>; // произвольные детали
}

export interface RequestLogCtx {
  reqId: string;
  startedAt: number;
  sessionId: string | null;
  clientIp: string | null;
  userAgent: string | null;
  userQuery: string | null;
  pipeline: 'v1' | 'v2';
  classifier: unknown;
  branch: string | null;
  steps: LogStep[];
  finalProductsCount: number;
  finalResponseChunks: string[]; // соберём из SSE-стрима
  error: string | null;
  flushed: boolean;
}

const storage = new AsyncLocalStorage<RequestLogCtx>();

export function createLogCtx(req: Request, pipeline: 'v1' | 'v2'): RequestLogCtx {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('cf-connecting-ip') ||
    null;
  return {
    reqId: crypto.randomUUID(),
    startedAt: Date.now(),
    sessionId: null,
    clientIp: ip,
    userAgent: req.headers.get('user-agent'),
    userQuery: null,
    pipeline,
    classifier: null,
    branch: null,
    steps: [],
    finalProductsCount: 0,
    finalResponseChunks: [],
    error: null,
    flushed: false,
  };
}

export function runWithLogCtx<T>(ctx: RequestLogCtx, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function getLogCtx(): RequestLogCtx | undefined {
  return storage.getStore();
}

// ─── Mutators (no-op если ctx нет) ──────────────────────────────────────────
export function logSetSession(sessionId: string | null) {
  const c = storage.getStore();
  if (c) c.sessionId = sessionId;
}
export function logSetUserQuery(q: string | null) {
  const c = storage.getStore();
  if (c) c.userQuery = q;
}
export function logSetClassifier(payload: unknown) {
  const c = storage.getStore();
  if (c) c.classifier = payload;
}
export function logSetBranch(branch: string) {
  const c = storage.getStore();
  if (c) c.branch = branch;
}
export function logAddStep(step: LogStep) {
  const c = storage.getStore();
  if (c) c.steps.push(step);
}
export function logSetProductsCount(n: number) {
  const c = storage.getStore();
  if (c) c.finalProductsCount = n;
}
export function logSetError(err: unknown) {
  const c = storage.getStore();
  if (c) c.error = String(err && (err as Error).message ? (err as Error).message : err);
}

// ─── Flush ──────────────────────────────────────────────────────────────────
export async function flushLog(ctx: RequestLogCtx): Promise<void> {
  if (ctx.flushed) return;
  ctx.flushed = true;

  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return; // no logging if not configured

  // Собираем финальный текст из чанков (для SSE — это уже извлечённый текст)
  const finalResponse = ctx.finalResponseChunks.join('');

  const row = {
    session_id: ctx.sessionId,
    client_ip: ctx.clientIp,
    user_agent: ctx.userAgent,
    user_query: ctx.userQuery,
    pipeline: ctx.pipeline,
    classifier: ctx.classifier ?? null,
    branch: ctx.branch,
    steps: ctx.steps,
    final_products_count: ctx.finalProductsCount,
    final_response: finalResponse || null,
    total_ms: Date.now() - ctx.startedAt,
    error: ctx.error,
  };

  try {
    const supa = createClient(url, key, { auth: { persistSession: false } });
    const { error } = await supa.from('chat_request_logs').insert(row);
    if (error) console.error('[request-logger] insert failed:', error.message);
  } catch (e) {
    console.error('[request-logger] flush exception:', e);
  }
}

/**
 * Оборачивает Response: для SSE-стримов копит чанки в ctx и flush'ит при close;
 * для обычных JSON/text — читает body, копирует, flush'ит сразу.
 */
export function wrapResponseForLogging(res: Response, ctx: RequestLogCtx): Response {
  // Без body — просто flush
  if (!res.body) {
    flushLog(ctx).catch(() => {});
    return res;
  }

  const decoder = new TextDecoder();

  // Стримовая обёртка: пробрасываем все байты в клиент, параллельно копим текст
  const transformed = res.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        try {
          const text = decoder.decode(chunk, { stream: true });
          // Skip SSE heartbeat comments (lines starting with `:`) — they are
          // transport-level keepalives, not part of the model's response.
          const cleaned = text
            .split('\n')
            .filter((line) => !line.startsWith(':'))
            .join('\n');
          if (cleaned && ctx.finalResponseChunks.join('').length < 8000) {
            ctx.finalResponseChunks.push(cleaned);
          }
        } catch (_) { /* ignore */ }
        controller.enqueue(chunk);
      },
      flush() {
        flushLog(ctx).catch(() => {});
      },
    }),
  );

  return new Response(transformed, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
