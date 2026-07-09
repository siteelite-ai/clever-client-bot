import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const token = Deno.env.get('VOLT220_API_TOKEN') ?? '';
  const url = new URL(req.url);
  const query = url.searchParams.get('query') ?? 'corn';
  const per_page = url.searchParams.get('per_page') ?? '3';
  const r = await fetch(`https://220volt.kz/api/products?query=${encodeURIComponent(query)}&per_page=${per_page}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json();
  const results = (j?.data?.results ?? []).map((p: Record<string, unknown>) => ({
    id: p.id, pagetitle: p.pagetitle, amount: p.amount, warehouses: p.warehouses,
  }));
  return new Response(JSON.stringify({ status: r.status, results }, null, 2), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
