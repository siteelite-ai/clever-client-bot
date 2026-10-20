import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  releasePublicApiAdmission,
  reservePublicApiAdmission,
  type PublicApiAdmissionRpc,
} from '../_shared/public-api-admission.ts';
import { readRequestTextBounded } from '../_shared/v3-tools/request-validation.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const VOLT220_API_URL = 'https://220volt.kz/api/products';
const VOLT220_CATEGORIES_URL = 'https://220volt.kz/api/categories';
const VOLT220_CATEGORY_OPTIONS_URL = 'https://220volt.kz/api/categories/options';
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_PAGE = 1000;
const MAX_PER_PAGE = 200;
const MAX_CATEGORIES_PAGES = 50;
const MAX_CATEGORIES_CONCURRENCY = 4;
const MAX_CATEGORY_TITLES = 10_000;
const MAX_FACETS_CACHE_ENTRIES = 128;
const MAX_FACETS_IN_FLIGHT = 32;
const CATEGORIES_FETCH_TIMEOUT_MS = 20_000;
// The shared admission reservation expires after 450 seconds. Keep all catalog
// work inside a much shorter, request-wide deadline, including every page and
// response body. The release RPC has its own bounded timeout after this work.
const CATALOG_REQUEST_DEADLINE_MS = 90_000;

type SearchBody = Record<string, unknown>;
type RequestDeps = {
  getApiToken?: (signal: AbortSignal) => Promise<string>;
  fetch?: typeof fetch;
  publicAdmissionRpc?: PublicApiAdmissionRpc;
  publicAdmissionReadEnv?: (name: string) => string | undefined;
  catalogDeadlineMs?: number;
  bodyReadTimeoutMs?: number;
};

type SharedLoad<T> = {
  controller: AbortController;
  promise: Promise<T>;
  waiters: number;
};

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Catalog request aborted', 'AbortError');
}

// A shared cache miss can have several request reservations. Abandoning the
// last waiter aborts its actual upstream I/O and drains the promise before that
// waiter may release its reservation. A non-last waiter can leave because the
// remaining waiter still owns the shared I/O and its own reservation.
async function awaitSharedLoad<T>(load: SharedLoad<T>, signal: AbortSignal): Promise<T> {
  load.waiters++;
  let onAbort: (() => void) | undefined;
  let abandoned = false;
  try {
    if (signal.aborted) throw abortReason(signal);
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(abortReason(signal));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([load.promise, aborted]);
  } catch (error) {
    if (signal.aborted) {
      abandoned = true;
      load.waiters--;
      if (load.waiters === 0) {
        load.controller.abort(abortReason(signal));
        await load.promise.catch(() => undefined);
      }
    }
    throw error;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (!abandoned) load.waiters--;
  }
}

function childTimeoutSignal(parent: AbortSignal, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(abortReason(parent));
  if (parent.aborted) onParentAbort();
  else parent.addEventListener('abort', onParentAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('Catalog upstream timed out')), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent.removeEventListener('abort', onParentAbort);
    },
  };
}

function jsonResponse(payload: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function requestError(message: string, status = 400, headers: Record<string, string> = {}): Response {
  return jsonResponse({
    error: message,
    results: [],
    pagination: { page: 1, per_page: 12, pages: 0, total: 0 },
  }, status, headers);
}

const publicAdmissionRpc: PublicApiAdmissionRpc = async (name, args) => {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRoleKey) return { data: null, error: 'service role unavailable' };
  const { data, error } = await createClient(url, serviceRoleKey).rpc(name, args);
  return { data, error };
};

function admissionErrorResponse(
  action: unknown,
  admission: Awaited<ReturnType<typeof reservePublicApiAdmission>>,
): Response {
  const limited = admission.reason === 'limit_exceeded';
  const status = limited ? 429 : 503;
  const message = limited ? 'Too many requests. Please try again later.' : 'Service temporarily unavailable.';
  const headers: Record<string, string> = {};
  if (limited && admission.retryAfterSeconds) {
    headers['Retry-After'] = String(admission.retryAfterSeconds);
  }
  if (action === 'category_facets') {
    return jsonResponse({ error: message, category: null, options: [] }, status, headers);
  }
  if (action === 'list_categories') {
    return jsonResponse({ error: message, categories: [], count: 0 }, status, headers);
  }
  return requestError(message, status, headers);
}

async function readBoundedBody(
  req: Request,
  readTimeoutMs?: number,
): Promise<{ body?: SearchBody; error?: Response }> {
  const contentLength = req.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_REQUEST_BYTES) {
    return { error: requestError('Request body too large', 413) };
  }

  if (!req.body) return { error: requestError('JSON object body required') };
  const read = await readRequestTextBounded(req, MAX_REQUEST_BYTES, readTimeoutMs);
  if (!read.ok) {
    if (read.reason === 'too_large') return { error: requestError('Request body too large', 413) };
    if (read.reason === 'timeout' || read.reason === 'aborted') {
      return { error: requestError('Request body timed out', 408) };
    }
    return { error: requestError('Invalid JSON body') };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { error: requestError('Invalid JSON body') };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: requestError('JSON object body required') };
  }
  return { body: parsed as SearchBody };
}

function validText(value: unknown, maxLength: number): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= maxLength);
}

function validPage(value: unknown, maximum: number): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const text = String(value);
  return /^\d{1,7}$/.test(text) && Number(text) >= 1 && Number(text) <= maximum;
}

function validCategoryId(value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const text = String(value);
  return /^\d{1,15}$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) >= 1;
}

function validPrice(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const text = String(value);
  return text.length <= 24 && /^\d+(?:\.\d+)?$/.test(text) && Number(text) <= 1_000_000_000;
}

function validateBody(body: SearchBody): string | null {
  const action = body.action;
  if (action !== undefined && action !== 'search' && action !== 'by_sku' &&
    action !== 'list_categories' && action !== 'category_facets') {
    return 'Unsupported action';
  }
  if (action === 'list_categories') return null;
  if (action === 'category_facets') {
    const categoryId = body.categoryId ?? body.category_id;
    if (!validText(body.pagetitle, 256) ||
      (categoryId != null && !validCategoryId(categoryId))) {
      return 'Invalid category selector';
    }
    if (!(typeof body.pagetitle === 'string' && body.pagetitle.trim()) && categoryId == null) {
      return 'category_facets requires pagetitle or categoryId';
    }
    return null;
  }
  if (!validText(body.query, 512) || !validText(body.article, 128) ||
    !validText(body.category, 256) || !validText(body.brand, 128) ||
    !validPage(body.page, MAX_PAGE) || !validPage(body.perPage, MAX_PER_PAGE) ||
    !validPrice(body.minPrice) || !validPrice(body.maxPrice)) {
    return 'Invalid search parameters';
  }
  return null;
}

// =============================================================================
// Module-level cache for category facets (full options schema per category).
// TTL 1h — characteristics for a category change rarely.
// Key: pagetitle (or `id:<n>` if accessed by numeric id).
// =============================================================================
const FACETS_TTL_MS = 60 * 60 * 1000;
const facetsCache: Map<string, { value: any; ts: number }> = new Map();
const facetsInFlight: Map<string, SharedLoad<{ category: any; options: any[] }>> = new Map();

function storeFacetsCache(key: string, value: { category: any; options: any[] }): void {
  const now = Date.now();
  for (const [cachedKey, entry] of facetsCache) {
    if (now - entry.ts >= FACETS_TTL_MS) facetsCache.delete(cachedKey);
  }
  facetsCache.delete(key);
  while (facetsCache.size >= MAX_FACETS_CACHE_ENTRIES) {
    const oldestKey = facetsCache.keys().next().value;
    if (oldestKey === undefined) break;
    facetsCache.delete(oldestKey);
  }
  facetsCache.set(key, { value, ts: now });
}

async function fetchCategoryFacets(
  token: string,
  opts: { pagetitle?: string; categoryId?: number | string },
  signal: AbortSignal,
  httpFetch: typeof fetch = fetch,
): Promise<{ category: any; options: any[]; cacheHit: boolean }> {
  signal.throwIfAborted();
  const cacheKey = opts.categoryId != null ? `id:${opts.categoryId}` : `pt:${opts.pagetitle}`;
  const cached = facetsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < FACETS_TTL_MS) {
    facetsCache.delete(cacheKey);
    facetsCache.set(cacheKey, cached);
    console.log(`[Facets] cache HIT ${cacheKey} (age=${Math.round((Date.now() - cached.ts) / 1000)}s)`);
    return { ...cached.value, cacheHit: true };
  }

  const existing = facetsInFlight.get(cacheKey);
  if (existing) return { ...await awaitSharedLoad(existing, signal), cacheHit: false };
  if (facetsInFlight.size >= MAX_FACETS_IN_FLIGHT) {
    throw new Error('Catalog facets busy; retry later');
  }

  const controller = new AbortController();
  const load = (async (): Promise<{ category: any; options: any[] }> => {
    const t0 = Date.now();
    const url = opts.categoryId != null
      ? `${VOLT220_CATEGORIES_URL}/${encodeURIComponent(String(opts.categoryId))}/options`
      : `${VOLT220_CATEGORY_OPTIONS_URL}?pagetitle=${encodeURIComponent(opts.pagetitle || '')}`;

    const upstream = childTimeoutSignal(controller.signal, 15_000);
    try {
      const res = await httpFetch(url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: upstream.signal,
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Facets API ${res.status}: ${errText.slice(0, 200)}`);
      }
      const raw = await res.json();
      // API shape: { success, data: { category: {...}, options: [...] } }
      // Some envelopes nest data twice; handle both.
      let data = raw.data || raw;
      if (data && typeof data === 'object' && 'data' in data && !('options' in data)) data = (data as any).data;
      const value = {
        category: data?.category || null,
        options: Array.isArray(data?.options) ? data.options : [],
      };
      controller.signal.throwIfAborted();
      storeFacetsCache(cacheKey, value);
      console.log(`[Facets] cache MISS ${cacheKey} → ${value.options.length} option-keys, total_products=${value.category?.total_products ?? '?'}, ${Date.now() - t0}ms`);
      return value;
    } finally {
      upstream.cleanup();
    }
  })();
  const shared = { controller, promise: load, waiters: 0 };
  facetsInFlight.set(cacheKey, shared);
  void load.then(() => {
    if (facetsInFlight.get(cacheKey) === shared) facetsInFlight.delete(cacheKey);
  }, () => {
    if (facetsInFlight.get(cacheKey) === shared) facetsInFlight.delete(cacheKey);
  });
  return { ...await awaitSharedLoad(shared, signal), cacheHit: false };
}

// =============================================================================
// Module-level cache for flattened category list (pagetitle[]).
// TTL 1h — categories change rarely, fallback bucket-logic catches any drift.
// =============================================================================
const CATEGORIES_TTL_MS = 60 * 60 * 1000;
let categoriesCache: { value: string[]; ts: number } | null = null;
let categoriesInFlight: SharedLoad<string[]> | null = null;
let categoriesLoggedRawOnce = false;

async function getApiToken(signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { data } = await supabase
        .from('app_settings')
        .select('volt220_api_token')
        .limit(1)
        .abortSignal(signal)
        .single();
      signal.throwIfAborted();
      if (data?.volt220_api_token) return data.volt220_api_token;
    } catch (e) {
      signal.throwIfAborted();
      console.log('[API Token] DB read failed, falling back to env var');
    }
  }
  
  signal.throwIfAborted();
  const envToken = Deno.env.get('VOLT220_API_TOKEN');
  if (!envToken) throw new Error('VOLT220_API_TOKEN is not configured');
  return envToken;
}

// Recursively walk MsCategory tree, collect every `pagetitle` into the set.
function collectPagetitles(nodes: any[], acc: Set<string>, depth = 0): void {
  if (!Array.isArray(nodes)) return;
  if (depth > 10) throw new Error('Category tree exceeds supported depth');
  for (const node of nodes) {
    if (node && typeof node.pagetitle === 'string' && node.pagetitle.trim()) {
      acc.add(node.pagetitle.trim());
      if (acc.size > MAX_CATEGORY_TITLES) throw new Error('Category listing exceeds safe limit');
    }
    if (node && Array.isArray(node.children) && node.children.length > 0) {
      collectPagetitles(node.children, acc, depth + 1);
    }
  }
}

async function fetchCategoriesPage(token: string, page: number, signal: AbortSignal, httpFetch: typeof fetch = fetch): Promise<{ results: any[]; pagination: any }> {
  const params = new URLSearchParams({
    parent: '0',
    depth: '10',
    per_page: '200',
    page: page.toString(),
  });
  const upstream = childTimeoutSignal(signal, CATEGORIES_FETCH_TIMEOUT_MS);
  try {
    const res = await httpFetch(`${VOLT220_CATEGORIES_URL}?${params}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: upstream.signal,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Categories API ${res.status}: ${errText.slice(0, 200)}`);
    }
    const raw = await res.json();
    signal.throwIfAborted();
    if (!categoriesLoggedRawOnce) {
      categoriesLoggedRawOnce = true;
      console.log(`[Categories] Raw page ${page} sample: ${JSON.stringify(raw).slice(0, 600)}`);
    }
    const data = raw.data || raw;
    return {
      results: data.results || [],
      pagination: data.pagination || { page, per_page: 200, pages: 1, total: 0 },
    };
  } finally {
    upstream.cleanup();
  }
}

async function listCategories(token: string, signal: AbortSignal, httpFetch: typeof fetch = fetch): Promise<string[]> {
  signal.throwIfAborted();
  // Cache hit
  if (categoriesCache && Date.now() - categoriesCache.ts < CATEGORIES_TTL_MS) {
    console.log(`[Categories] cache HIT (${categoriesCache.value.length} items, age=${Math.round((Date.now() - categoriesCache.ts) / 1000)}s)`);
    return categoriesCache.value;
  }
  if (categoriesInFlight) return awaitSharedLoad(categoriesInFlight, signal);

  const controller = new AbortController();
  const load = (async (): Promise<string[]> => {
    console.log('[Categories] cache MISS, fetching from /api/categories');
    const t0 = Date.now();
    const acc = new Set<string>();

    const first = await fetchCategoriesPage(token, 1, controller.signal, httpFetch);
    collectPagetitles(first.results, acc);

    const reportedPages = first.pagination?.pages;
    const pages = reportedPages == null ? 1 : Number(reportedPages);
    if (!Number.isSafeInteger(pages) || pages < 0 || pages > MAX_CATEGORIES_PAGES) {
      throw new Error('Category listing exceeds safe page limit');
    }
    const totalPages = Math.max(1, pages);
    for (let start = 2; start <= totalPages; start += MAX_CATEGORIES_CONCURRENCY) {
      const pending: Promise<{ results: any[] }>[] = [];
      for (let page = start; page < Math.min(start + MAX_CATEGORIES_CONCURRENCY, totalPages + 1); page++) {
        pending.push(fetchCategoriesPage(token, page, controller.signal, httpFetch));
      }
      // A page may fail before its siblings have settled. Drain the whole
      // batch before the request releases its global admission reservation.
      const batch = await Promise.allSettled(pending);
      const failed = batch.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      for (const result of batch) {
        if (result.status === 'fulfilled') collectPagetitles(result.value.results, acc);
      }
    }

    controller.signal.throwIfAborted();
    const flat = Array.from(acc).sort();
    categoriesCache = { value: flat, ts: Date.now() };
    console.log(`[Categories] cache STORED ${flat.length} pagetitles in ${Date.now() - t0}ms (pages=${totalPages})`);
    return flat;
  })();
  const shared = { controller, promise: load, waiters: 0 };
  categoriesInFlight = shared;
  void load.then(() => {
    if (categoriesInFlight === shared) categoriesInFlight = null;
  }, () => {
    if (categoriesInFlight === shared) categoriesInFlight = null;
  });
  return await awaitSharedLoad(shared, signal);
}

// Tests exercise cold-cache limits without changing the public request contract.
export function resetCatalogCachesForTest(): void {
  facetsCache.clear();
  facetsInFlight.clear();
  categoriesCache = null;
  categoriesInFlight = null;
}

export async function handleRequest(req: Request, deps: RequestDeps = {}): Promise<Response> {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return requestError('Method not allowed', 405, { Allow: 'POST, OPTIONS' });
  }

  let deadlineExpired = false;
  let requestAction: unknown;
  try {
    const parsed = await readBoundedBody(req, deps.bodyReadTimeoutMs);
    if (parsed.error) return parsed.error;
    const body = parsed.body!;
    const validationError = validateBody(body);
    if (validationError) return requestError(validationError);
    requestAction = body.action;
    const rpc = deps.publicAdmissionRpc ?? publicAdmissionRpc;
    const admission = await reservePublicApiAdmission({
      route: 'search-products',
      lanes: ['catalog'],
      rpc,
      readEnv: deps.publicAdmissionReadEnv,
    });
    const controller = new AbortController();
    const configuredDeadline = deps.catalogDeadlineMs;
    const deadlineMs = configuredDeadline === undefined || !Number.isFinite(configuredDeadline) ? CATALOG_REQUEST_DEADLINE_MS :
      Math.max(1, Math.min(CATALOG_REQUEST_DEADLINE_MS, Math.floor(configuredDeadline)));
    const onRequestAbort = () => controller.abort(abortReason(req.signal));
    if (req.signal.aborted) onRequestAbort();
    else req.signal.addEventListener('abort', onRequestAbort, { once: true });
    const deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      controller.abort(new Error('Catalog request timed out'));
    }, deadlineMs);
    try {
      if (!admission.allowed) return admissionErrorResponse(body.action, admission);
    controller.signal.throwIfAborted();
    const readApiToken = deps.getApiToken ?? getApiToken;
    const httpFetch = deps.fetch ?? fetch;

    // ===== Branch: list categories (flat array of pagetitle) =====
    if (body && body.action === 'list_categories') {
      const apiToken = await readApiToken(controller.signal);
      const categories = await listCategories(apiToken, controller.signal, httpFetch);
      return new Response(
        JSON.stringify({ categories, count: categories.length }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ===== Branch: category facets (full options schema for a category) =====
    if (body && body.action === 'category_facets') {
      const apiToken = await readApiToken(controller.signal);
      const pagetitle = typeof body.pagetitle === 'string' ? body.pagetitle.trim() : undefined;
      const categoryId = body.categoryId ?? body.category_id;
      try {
        const facets = await fetchCategoryFacets(apiToken, { pagetitle, categoryId: categoryId as number | string }, controller.signal, httpFetch);
        return new Response(
          JSON.stringify(facets),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      } catch (e) {
        console.error('[Facets] error:', (e as Error).message);
        if (deadlineExpired) {
          return jsonResponse({ error: 'Catalog request timed out', category: null, options: [] }, 504);
        }
        return new Response(
          JSON.stringify({ error: (e as Error).message, category: null, options: [] }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // ===== Branch: search products (existing behavior) =====
    const { query, page = 1, perPage = 12, category, minPrice, maxPrice, brand, article } = body as {
      query?: string; page?: number | string; perPage?: number | string; category?: string;
      minPrice?: number | string; maxPrice?: number | string; brand?: string; article?: string;
    };
    
    const apiToken = await readApiToken(controller.signal);

    // Формируем параметры запроса согласно документации
    const params = new URLSearchParams();
    
    // article - точный поиск по артикулу товара (приоритет над query)
    if (article) params.append('article', article);
    else if (query) params.append('query', query);
    
    params.append('page', page.toString());
    params.append('per_page', perPage.toString());
    
    // category - фильтр по категории (pagetitle родительского ресурса)
    if (category) params.append('category', category);
    
    // min_price, max_price - фильтр по цене
    if (minPrice) params.append('min_price', minPrice.toString());
    if (maxPrice) params.append('max_price', maxPrice.toString());
    
    // options[brend__brend][] - фильтр по бренду
    if (brand) params.append('options[brend__brend][]', brand);

    console.log(`Searching products: ${params.toString()}`);

    const response = await httpFetch(`${VOLT220_API_URL}?${params}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`220volt API error [${response.status}]:`, errorText);
      throw new Error(`API error: ${response.status}`);
    }

    const rawData = await response.json();
    controller.signal.throwIfAborted();
    
    // API возвращает: { success: true, data: { results: [...], pagination: {...} } }
    const data = rawData.data || rawData;
    
    console.log(`Found ${data.results?.length || 0} products, total: ${data.pagination?.total || 0}`);

    return new Response(
      JSON.stringify({
        results: data.results || [],
        pagination: data.pagination || { page: 1, per_page: perPage, pages: 0, total: 0 }
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

    } finally {
      clearTimeout(deadlineTimer);
      req.signal.removeEventListener('abort', onRequestAbort);
      if (admission.releaseRequired) {
        try {
          const release = await releasePublicApiAdmission({ reservation: admission, rpc });
          if (!release.released) console.error('[search-products] admission release failed', release.failure);
        } catch {
          console.error('[search-products] admission release threw unexpectedly');
        }
      }
    }

  } catch (error) {
    console.error('Search products error:', error);
    if (deadlineExpired) {
      if (requestAction === 'list_categories') {
        return jsonResponse({ error: 'Catalog request timed out', categories: [], count: 0 }, 504);
      }
      if (requestAction === 'category_facets') {
        return jsonResponse({ error: 'Catalog request timed out', category: null, options: [] }, 504);
      }
      return requestError('Catalog request timed out', 504);
    }
    return new Response(
      JSON.stringify({ 
        error: error instanceof Error ? error.message : 'Failed to search products',
        results: [],
        pagination: { page: 1, per_page: 12, pages: 0, total: 0 }
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}

if (import.meta.main) serve((req) => handleRequest(req));
