// Временная diagnostic edge function. После анализа удалить.
// Цель: probe /products?query=<q> напрямую, без Category Resolver,
// чтобы оценить facet schema из Product.options[] (§4.10.1 Self-Bootstrap).

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const url = new URL(req.url);
  const q = url.searchParams.get("query") ?? "лампа";
  const perPage = Number(url.searchParams.get("per_page") ?? "30");

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: settings, error } = await supabase
    .from("app_settings")
    .select("volt220_api_token")
    .limit(1)
    .maybeSingle();
  if (error || !settings?.volt220_api_token) {
    return new Response(
      JSON.stringify({ error: "no_token", details: error?.message }),
      { status: 500, headers: { ...cors, "content-type": "application/json" } },
    );
  }

  const apiBase = "https://220volt.kz/api";
  const target = `${apiBase}/products?query=${encodeURIComponent(q)}&per_page=${perPage}`;

  const t0 = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      headers: { Authorization: `Bearer ${settings.volt220_api_token}` },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "fetch_failed", message: String(e) }),
      { status: 502, headers: { ...cors, "content-type": "application/json" } },
    );
  }
  const elapsedMs = Date.now() - t0;
  const status = upstream.status;
  const text = await upstream.text();

  let json: any = null;
  try { json = JSON.parse(text); } catch { /* keep as text */ }

  // Aggregate facet schema from per-item Product.options[] (§4.10.1 logic).
  type Agg = Map<string, { caption_ru?: string; values: Map<string, number> }>;
  const agg: Agg = new Map();
  const results: any[] = json?.data?.results ?? json?.results ?? [];
  for (const p of results) {
    const opts: any[] = p?.options ?? [];
    for (const o of opts) {
      if (!o?.key) continue;
      let bucket = agg.get(o.key);
      if (!bucket) {
        bucket = { caption_ru: o.caption_ru, values: new Map() };
        agg.set(o.key, bucket);
      }
      const v = o.value_ru ?? "";
      bucket.values.set(v, (bucket.values.get(v) ?? 0) + 1);
    }
  }
  const facetSchema = Array.from(agg.entries())
    .map(([key, b]) => ({
      key,
      caption_ru: b.caption_ru,
      values_count: b.values.size,
      total_occurrences: Array.from(b.values.values()).reduce((a, x) => a + x, 0),
      top_values: Array.from(b.values.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([v, c]) => ({ value: v, count: c })),
    }))
    .sort((a, b) => b.total_occurrences - a.total_occurrences);

  // Sample 3 products (head) with key fields only
  const sampleProducts = results.slice(0, 3).map((p) => ({
    id: p?.id,
    pagetitle: p?.pagetitle,
    name: p?.name,
    price: p?.price,
    vendor: p?.vendor,
    url: p?.url,
    options_count: (p?.options ?? []).length,
  }));

  const total =
    json?.data?.pagination?.total ??
    json?.pagination?.total ??
    null;

  return new Response(
    JSON.stringify({
      query: q,
      target_url: target,
      upstream_status: status,
      elapsed_ms: elapsedMs,
      total_in_pagination: total,
      results_count: results.length,
      sample_products: sampleProducts,
      facet_schema_keys_count: facetSchema.length,
      facet_schema: facetSchema,
      raw_body_preview: text.slice(0, 400),
    }, null, 2),
    { headers: { ...cors, "content-type": "application/json" } },
  );
});
