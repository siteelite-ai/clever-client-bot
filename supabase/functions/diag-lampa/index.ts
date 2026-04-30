// Diagnostic: query-first для слова «лампа» (без «настольная»)
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
};

const API = "https://api.220volt.kz/api";
const TOKEN = Deno.env.get("CATALOG_API_TOKEN") || "";

const BLACKLIST = new Set([
  "kodnomenklatury","poiskovyy_zapros","opisaniefayla","artikul",
  "shtrikhkod","ves","gabarity","upakovka","sertifikat",
  "garantiyaproizvoditelya","stranaproizvoditely","proizvoditel_kod",
  "sayt_proizvoditelya","instruktsiya","video","foto_dop",
  "data_postupleniya","ostatok_sklad","rezerv",
  "opisanie_kz","naimenovanie_kz","harakteristiki_kz"
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const t0 = Date.now();
  const r = await fetch(`${API}/products?query=лампа&perPage=30`, {
    headers: { "Authorization": `Bearer ${TOKEN}` }
  });
  const data = await r.json();
  const probeMs = Date.now() - t0;

  const total = data?.data?.pagination?.total ?? 0;
  const items = data?.data?.results ?? [];

  const facetMap = new Map<string, { caption: string; values: Map<string, number> }>();
  for (const p of items) {
    for (const opt of (p.options ?? [])) {
      if (BLACKLIST.has(opt.key)) continue;
      if (!facetMap.has(opt.key)) {
        facetMap.set(opt.key, { caption: opt.caption_ru || opt.key, values: new Map() });
      }
      const f = facetMap.get(opt.key)!;
      const v = opt.value_ru || "";
      if (!v) continue;
      f.values.set(v, (f.values.get(v) ?? 0) + 1);
    }
  }

  const facetsTop = [...facetMap.entries()]
    .map(([k, v]) => ({
      key: k,
      caption: v.caption,
      valueCount: v.values.size,
      totalHits: [...v.values.values()].reduce((a, b) => a + b, 0),
      top5: [...v.values.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([val, cnt]) => ({ val, cnt }))
    }))
    .sort((a, b) => b.totalHits - a.totalHits);

  // Где встречается «настольн*»?
  const nastolniyMatches: { key: string; caption: string; value: string; count: number }[] = [];
  for (const [key, f] of facetMap.entries()) {
    for (const [val, cnt] of f.values.entries()) {
      if (/настольн/i.test(val)) nastolniyMatches.push({ key, caption: f.caption, value: val, count: cnt });
    }
  }

  // Категории
  const cats = new Map<string, number>();
  for (const p of items) {
    const c = p.category?.pagetitle || p.category?.name || "?";
    cats.set(c, (cats.get(c) ?? 0) + 1);
  }
  const catsTop = [...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  const samples = items.slice(0, 8).map((p: any) => ({
    name: p.pagetitle, price: p.price, category: p.category?.pagetitle
  }));

  return new Response(JSON.stringify({
    probeMs, total, itemsReturned: items.length,
    uniqueFacetKeys: facetMap.size,
    facetsTop15: facetsTop.slice(0, 15),
    nastolniyMatches,
    catsTop, samples
  }, null, 2), {
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
});
