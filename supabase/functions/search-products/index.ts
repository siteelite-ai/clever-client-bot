import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const VOLT220_API_URL = 'https://220volt.kz/api/products';

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

// Module-level cache for category catalog
interface CategoriesCache {
  categories: string[];
  fetchedAt: number;
}
let categoriesCache: CategoriesCache | null = null;
const CATEGORIES_TTL_MS = 60 * 60 * 1000; // 1 hour

async function fetchAllCategories(apiToken: string): Promise<string[]> {
  const now = Date.now();
  if (categoriesCache && (now - categoriesCache.fetchedAt) < CATEGORIES_TTL_MS) {
    console.log(`[list_categories] cache hit (${categoriesCache.categories.length})`);
    return categoriesCache.categories;
  }

  console.log('[list_categories] cache miss, paginating products to collect categories...');
  const set = new Set<string>();
  const perPage = 100;
  const maxPages = 30; // hard cap: up to 3000 products scanned for category names

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams();
    params.append('page', page.toString());
    params.append('per_page', perPage.toString());

    const response = await fetch(`${VOLT220_API_URL}?${params}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.error(`[list_categories] page ${page} failed: ${response.status}`);
      break;
    }

    const raw = await response.json();
    const data = raw.data || raw;
    const results = data.results || [];
    if (results.length === 0) break;

    for (const item of results) {
      const cat = item?.category?.pagetitle ?? item?.category_pagetitle ?? item?.category;
      if (typeof cat === 'string' && cat.trim()) set.add(cat.trim());
    }

    const totalPages = data.pagination?.pages ?? 0;
    if (page >= totalPages) break;
  }

  const categories = Array.from(set).sort();
  categoriesCache = { categories, fetchedAt: now };
  console.log(`[list_categories] cached ${categories.length} categories`);
  return categories;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action } = body;

    const apiToken = await getApiToken();

    // ==== action: list_categories ====
    if (action === 'list_categories') {
      const force = body?.force === true;
      if (force) categoriesCache = null;
      const categories = await fetchAllCategories(apiToken);
      return new Response(
        JSON.stringify({
          categories,
          count: categories.length,
          cached_at: categoriesCache?.fetchedAt ?? null,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { query, page = 1, perPage = 12, category, minPrice, maxPrice, brand, article } = body;

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