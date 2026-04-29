/**
 * Stage 2 — Unified Cache Module
 * Источник: спецификация §6 (Caching Strategy)
 *
 * Единая обёртка над таблицей `public.chat_cache_v2`. Используется всеми
 * шагами пайплайна (S2 intent, S4 search, S5 probe/synonyms, S9 knowledge).
 *
 * КОНТРАКТ:
 * - getOrCompute<T>(namespace, rawKey, ttlSec, compute): кеш-aside с
 *   sha256-нормализацией ключа (§6.5).
 * - hashKey(namespace, rawKey): чистая функция, экспортируется для тестов
 *   и для случаев, когда нужен только ключ (например, ручной invalidation).
 * - maybeRunGC(): ленивый GC, вызывается с вероятностью 1% (§6.2).
 *
 * НЕ кэшируем (§6.4): PII, GeoIP, финальный LLM-ответ.
 */

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';

// ─── version_tag (§6.5) ──────────────────────────────────────────────────────
// Инкрементируем при breaking change схемы кэша.
const CACHE_VERSION = 'v2.1';
const DEFAULT_LOCALE = 'ru-KZ';

// ─── Lazy singleton client (service_role) ────────────────────────────────────
let _client: SupabaseClient | null = null;
function getClient(): SupabaseClient {
  if (_client) return _client;
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) {
    throw new Error('[cache] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  }
  _client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

// ─── Normalize (§6.5) ────────────────────────────────────────────────────────
// lowercase + trim + collapse spaces + remove punctuation
export function normalize(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')   // убираем пунктуацию (Unicode-aware)
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── sha256(...).slice(0,16) ────────────────────────────────────────────────
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex;
}

/**
 * Формирует кэш-ключ строго по §6.5:
 *   `<namespace>:<sha256(normalize(query) + locale + version_tag).slice(0,16)>`
 *
 * @param namespace - префикс (`probe`, `intent`, `syn`, `search`, `facets`, `kb`)
 * @param rawKey - сырой ключ (запрос пользователя или иной идентификатор)
 * @param locale - локаль (по умолчанию ru-KZ)
 */
export async function hashKey(
  namespace: string,
  rawKey: string,
  locale: string = DEFAULT_LOCALE,
): Promise<string> {
  const payload = normalize(rawKey) + '|' + locale + '|' + CACHE_VERSION;
  const hex = await sha256Hex(payload);
  return `${namespace}:${hex.slice(0, 16)}`;
}

// ─── Low-level get/set ───────────────────────────────────────────────────────
export async function get<T>(cacheKey: string): Promise<T | null> {
  try {
    const sb = getClient();
    const { data, error } = await sb
      .from('chat_cache_v2')
      .select('cache_value, expires_at')
      .eq('cache_key', cacheKey)
      .maybeSingle();
    if (error || !data) return null;
    if (new Date(data.expires_at).getTime() <= Date.now()) return null;
    // Best-effort hit_count++ (не блокируем, не ждём)
    sb.rpc('noop_inc_hit', { _key: cacheKey }).then(() => {}, () => {});
    return data.cache_value as T;
  } catch (_e) {
    return null;
  }
}

export async function set<T>(
  cacheKey: string,
  value: T,
  ttlSec: number,
): Promise<void> {
  try {
    const sb = getClient();
    const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
    await sb.from('chat_cache_v2').upsert(
      {
        cache_key: cacheKey,
        cache_value: value as unknown as Record<string, unknown>,
        expires_at: expiresAt,
        hit_count: 0,
      },
      { onConflict: 'cache_key' },
    );
  } catch (_e) {
    // Кэш — best-effort, не валим основной flow
  }
}

/**
 * Cache-aside: если есть свежее значение — возвращаем его, иначе вычисляем
 * через `compute()`, кладём в кэш и возвращаем. Ошибки кэша никогда не
 * пробрасываются наружу — `compute()` всегда отрабатывает.
 */
export async function getOrCompute<T>(
  namespace: string,
  rawKey: string,
  ttlSec: number,
  compute: () => Promise<T>,
  locale: string = DEFAULT_LOCALE,
): Promise<{ value: T; cacheHit: boolean; cacheKey: string }> {
  const cacheKey = await hashKey(namespace, rawKey, locale);
  const cached = await get<T>(cacheKey);
  if (cached !== null && cached !== undefined) {
    return { value: cached, cacheHit: true, cacheKey };
  }
  const value = await compute();
  // fire-and-forget set (не блокирует ответ пользователю)
  set(cacheKey, value, ttlSec).catch(() => {});
/**
 * §4.11 Stale-on-error: расширение `getOrCompute`. Двухслойный кэш:
 *
 *   • HOT слой — `cacheKey` со стандартным `ttlSec` (как у getOrCompute).
 *   • STALE слой — `<cacheKey>:stale` с `staleTtlSec >> ttlSec`. Перезаписывается
 *     при КАЖДОМ успешном compute() — там лежит «последний известный успех».
 *
 * Контракт (см. spec §4.11):
 *   1. Свежее значение из HOT → возвращаем `{ source: 'hot' }`.
 *   2. HOT miss → запускаем `compute()`. Если success — пишем в HOT и STALE,
 *      возвращаем `{ source: 'fresh' }`.
 *   3. compute() кинул исключение ИЛИ вернул значение, для которого
 *      `isTransportFailure(value) === true` → пробуем STALE. Если есть —
 *      возвращаем `{ source: 'stale' }`. Иначе — пробрасываем исходный fail
 *      (значение или повторно бросаем ошибку).
 *
 *   STALE НЕ отдаётся при «нормальных» исходах compute (например, API
 *   осознанно вернул `empty`) — только при transport-failure. Это инвариант
 *   §4.11: stale — это страховка от падения upstream, не замена hot miss.
 *
 *   Метрика `facets_stale_served_total` считается вызывающим кодом по
 *   возвращённому `source === 'stale'` (cache.ts data-agnostic, метрики не
 *   эмитим тут — это ответственность caller'а в catalog/api-client.ts).
 */
export type StaleSource = 'hot' | 'fresh' | 'stale';

export interface StaleResult<T> {
  value: T;
  source: StaleSource;
  cacheKey: string;
}

export async function getOrComputeWithStale<T>(
  namespace: string,
  rawKey: string,
  ttlSec: number,
  staleTtlSec: number,
  compute: () => Promise<T>,
  isTransportFailure: (value: T) => boolean,
  locale: string = DEFAULT_LOCALE,
): Promise<StaleResult<T>> {
  const cacheKey = await hashKey(namespace, rawKey, locale);
  const staleKey = `${cacheKey}:stale`;

  // 1. HOT
  const hot = await get<T>(cacheKey);
  if (hot !== null && hot !== undefined) {
    return { value: hot, source: 'hot', cacheKey };
  }

  // 2. compute()
  let computed: T;
  let computeThrew = false;
  let thrown: unknown = null;
  try {
    computed = await compute();
  } catch (e) {
    computeThrew = true;
    thrown = e;
    computed = undefined as unknown as T;
  }

  if (!computeThrew && !isTransportFailure(computed)) {
    // success — пишем оба слоя fire-and-forget
    set(cacheKey, computed, ttlSec).catch(() => {});
    set(staleKey, computed, staleTtlSec).catch(() => {});
    return { value: computed, source: 'fresh', cacheKey };
  }

  // 3. transport-failure → STALE
  const stale = await get<T>(staleKey);
  if (stale !== null && stale !== undefined) {
    return { value: stale, source: 'stale', cacheKey };
  }

  // 4. STALE пуст — пробрасываем оригинальный fail
  if (computeThrew) throw thrown;
  return { value: computed, source: 'fresh', cacheKey };
}

// ─── Lazy GC (§6.2: 1% запросов) ────────────────────────────────────────────
export function maybeRunGC(probability = 0.01): void {
  if (Math.random() >= probability) return;
  try {
    const sb = getClient();
    // fire-and-forget
    sb.rpc('gc_chat_cache_v2').then(() => {}, () => {});
  } catch (_e) {
    // ignore
  }
}

// ─── TTL пресеты (§6.3 + §4.11) ─────────────────────────────────────────────
export const TTL = {
  probe: 60 * 60,          // 1ч
  intent: 24 * 60 * 60,    // 24ч
  syn: 24 * 60 * 60,       // 24ч
  search: 15 * 60,         // 15м
  facets: 60 * 60,         // 1ч (HOT)
  facetsStale: 60 * 60,    // 1ч (§4.11 STALE: согласовано с пользователем 2026-04-29 — «свежее»)
  kb: 60 * 60,             // 1ч
} as const;
