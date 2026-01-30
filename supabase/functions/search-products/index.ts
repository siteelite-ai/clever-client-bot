import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const VOLT220_API_URL = 'https://220volt.testdevops.ru/api/products';

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { query, page = 1, perPage = 12, category, minPrice, maxPrice, brand } = await req.json();
    
    const apiToken = Deno.env.get('VOLT220_API_TOKEN');
    if (!apiToken) {
      throw new Error('VOLT220_API_TOKEN is not configured');
    }

    // Формируем параметры запроса согласно документации
    const params = new URLSearchParams();
    
    if (query) params.append('query', query);
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