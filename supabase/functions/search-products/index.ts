import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const VOLT220_API_URL = 'https://220volt.kz/api/products';
const VOLT220_CATEGORIES_URL = 'https://220volt.kz/api/categories';
const VOLT220_CATEGORY_OPTIONS_URL = 'https://220volt.kz/api/categories/options';

// =============================================================================
// Module-level cache for category facets (full options schema per category).
// TTL 1h — characteristics for a category change rarely.
// Key: pagetitle (or `id:<n>` if accessed by numeric id).
// =============================================================================
const FACETS_TTL_MS = 60 * 60 * 1000;
const facetsCache: Map<string, { value: any; ts: number }> = new Map();

async function fetchCategoryFacets(
  token: string,
  opts: { pagetitle?: string; categoryId?: number | string }
): Promise<{ category: any; options: any[]; cacheHit: boolean }> {
  const cacheKey = opts.categoryId != null ? `id:${opts.categoryId}` : `pt:${opts.pagetitle}`;
  const cached = facetsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < FACETS_TTL_MS) {
    console.log(`[Facets] cache HIT ${cacheKey} (age=${Math.round((Date.now() - cached.ts) / 1000)}s)`);
    return { ...cached.value, cacheHit: true };
  }

  const t0 = Date.now();
  const url = opts.categoryId != null
    ? `${VOLT220_CATEGORIES_URL}/${encodeURIComponent(String(opts.categoryId))}/options`
    : `${VOLT220_CATEGORY_OPTIONS_URL}?pagetitle=${encodeURIComponent(opts.pagetitle || '')}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
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
    facetsCache.set(cacheKey, { value, ts: Date.now() });
    console.log(`[Facets] cache MISS ${cacheKey} → ${value.options.length} option-keys, total_products=${value.category?.total_products ?? '?'}, ${Date.now() - t0}ms`);
    return { ...value, cacheHit: false };
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

// =============================================================================
// Module-level cache for flattened category list (pagetitle[]).
// TTL 1h — categories change rarely, fallback bucket-logic catches any drift.
// =============================================================================
const CATEGORIES_TTL_MS = 60 * 60 * 1000;
let categoriesCache: { value: string[]; ts: number } | null = null;
let categoriesLoggedRawOnce = false;

async function getApiToken(): Promise<string> {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { data } = await supabase
        .from('app_settings')
        .select('volt220_api_token')
        .limit(1)
        .single();
      if (data?.volt220_api_token) return data.volt220_api_token;
    } catch (e) {
      console.log('[API Token] DB read failed, falling back to env var');
    }
  }
  
  const envToken = Deno.env.get('VOLT220_API_TOKEN');
  if (!envToken) throw new Error('VOLT220_API_TOKEN is not configured');
  return envToken;
}

// Recursively walk MsCategory tree, collect every `pagetitle` into the set.
function collectPagetitles(nodes: any[], acc: Set<string>): void {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (node && typeof node.pagetitle === 'string' && node.pagetitle.trim()) {
      acc.add(node.pagetitle.trim());
    }
    if (node && Array.isArray(node.children) && node.children.length > 0) {
      collectPagetitles(node.children, acc);
    }
  }
}

async function fetchCategoriesPage(token: string, page: number): Promise<{ results: any[]; pagination: any }> {
  const params = new URLSearchParams({
    parent: '0',
    depth: '10',
    per_page: '200',
    page: page.toString(),
  });
  const res = await fetch(`${VOLT220_CATEGORIES_URL}?${params}`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Categories API ${res.status}: ${errText.slice(0, 200)}`);
  }
  const raw = await res.json();
  if (!categoriesLoggedRawOnce) {
    categoriesLoggedRawOnce = true;
    console.log(`[Categories] Raw page ${page} sample: ${JSON.stringify(raw).slice(0, 600)}`);
  }
  const data = raw.data || raw;
  return {
    results: data.results || [],
    pagination: data.pagination || { page, per_page: 200, pages: 1, total: 0 },
  };
}

async function listCategories(token: string): Promise<string[]> {
  // Cache hit
  if (categoriesCache && Date.now() - categoriesCache.ts < CATEGORIES_TTL_MS) {
    console.log(`[Categories] cache HIT (${categoriesCache.value.length} items, age=${Math.round((Date.now() - categoriesCache.ts) / 1000)}s)`);
    return categoriesCache.value;
  }

  console.log('[Categories] cache MISS, fetching from /api/categories');
  const t0 = Date.now();
  const acc = new Set<string>();

  const first = await fetchCategoriesPage(token, 1);
  collectPagetitles(first.results, acc);

  const totalPages = Math.max(1, Number(first.pagination?.pages) || 1);
  if (totalPages > 1) {
    const promises: Promise<{ results: any[] }>[] = [];
    for (let p = 2; p <= totalPages; p++) promises.push(fetchCategoriesPage(token, p));
    const rest = await Promise.all(promises);
    for (const r of rest) collectPagetitles(r.results, acc);
  }

  const flat = Array.from(acc).sort();
  categoriesCache = { value: flat, ts: Date.now() };
  console.log(`[Categories] cache STORED ${flat.length} pagetitles in ${Date.now() - t0}ms (pages=${totalPages})`);
  return flat;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));

    // ===== Branch: list categories (flat array of pagetitle) =====
    if (body && body.action === 'list_categories') {
      const apiToken = await getApiToken();
      const categories = await listCategories(apiToken);
      return new Response(
        JSON.stringify({ categories, count: categories.length }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ===== Branch: search products (existing behavior) =====
    const { query, page = 1, perPage = 12, category, minPrice, maxPrice, brand, article } = body;
    
    const apiToken = await getApiToken();

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

    const response = await fetch(`${VOLT220_API_URL}?${params}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`220volt API error [${response.status}]:`, errorText);
      throw new Error(`API error: ${response.status}`);
    }

    const rawData = await response.json();
    
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

  } catch (error) {
    console.error('Search products error:', error);
    return new Response(
      JSON.stringify({ 
        error: error instanceof Error ? error.message : 'Failed to search products',
        results: [],
        pagination: { page: 1, per_page: 12, pages: 0, total: 0 }
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
