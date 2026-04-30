// ВРЕМЕННЫЙ симулятор: имитирует V1-пайплайн, но первый hop /products
// идёт через ?query= вместо ?category=. После теста удалить.
//
// Шаги:
//   1) probe: GET /products?query=<userCategory>&per_page=30
//   2) bootstrap фасетов из Product.options[] (агрегация по key+value_ru)
//   3) blacklist шумных ключей (как в V1 §FACET_BLACKLIST)
//   4) LLM (Gemini через OpenRouter) — выбирает relevant фасеты под полную
//      фразу пользователя
//   5) если есть выбранные опции — второй hop /products?query=...&options[k][]=v
//   6) возврат: тайминги, фасет-схема, выбор LLM, финальный список товаров

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

const API_BASE = "https://220volt.kz/api";

// Те же шумные ключи, что мы зафиксировали в ТЗ для API-команды.
const FACET_BLACKLIST = new Set([
  "kodnomenklatury",
  "identifikator_sayta__sayt_identifikatory",
  "soputstvuyuschiytovar",
  "tovar_internet_magazina",
  "poiskovyy_zapros",
  "naimenovanie_na_kazahskom_yazyke",
  "opisanie_na_kazahskom_yazyke",
  "fayl",
  "opisaniefayla",
  "ogranichennyy_prosmotr",
  "novinka__ghaңa",
  "populyarnyy__dәrіptі",
  "prodaetsya_tolyko_v_gruppovoy_upakovke__toptyқ_ghiyntyғynda_ghana_satylady",
  "prodaetsya_tolyko_v_gruppovoy_upakovke__toptyқ_ghiyntyғynda_ғana_satylady",
  "edinica_izmereniya__Өlsheu_bіrlіgі",
  "ves__salmaғy",
  "obyem__kөlemі",
  "kod_tn_ved__seҚ_tn_kody",
]);

interface AggValue { value: string; count: number }
interface AggKey { key: string; caption_ru: string; values: AggValue[] }

function aggregateOptions(results: any[]): AggKey[] {
  const map = new Map<string, { caption_ru: string; vals: Map<string, number> }>();
  for (const p of results) {
    for (const o of p?.options ?? []) {
      if (!o?.key) continue;
      if (FACET_BLACKLIST.has(o.key)) continue;
      let bucket = map.get(o.key);
      if (!bucket) {
        bucket = { caption_ru: o.caption_ru ?? o.key, vals: new Map() };
        map.set(o.key, bucket);
      }
      const v = (o.value_ru ?? "").toString();
      if (!v) continue;
      bucket.vals.set(v, (bucket.vals.get(v) ?? 0) + 1);
    }
  }
  return Array.from(map.entries())
    .map(([key, b]) => ({
      key,
      caption_ru: b.caption_ru,
      values: Array.from(b.vals.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([value, count]) => ({ value, count })),
    }))
    .sort((a, b) =>
      b.values.reduce((s, x) => s + x.count, 0) -
      a.values.reduce((s, x) => s + x.count, 0)
    );
}

async function callLLM(
  apiKey: string,
  userPhrase: string,
  schema: AggKey[],
): Promise<{ raw: string; chosen: Array<{ key: string; values: string[] }>; ms: number }> {
  // Жёсткое усечение — берём top-12 ключей и top-8 значений на ключ,
  // чтобы не раздуть контекст.
  const compact = schema.slice(0, 12).map((k) => ({
    key: k.key,
    caption: k.caption_ru,
    values: k.values.slice(0, 8).map((v) => v.value),
  }));

  const prompt = `Ты — продакт-фильтр электротоваров.

Запрос пользователя: "${userPhrase}"

Доступные фасеты товара (key, caption, possible values):
${JSON.stringify(compact, null, 2)}

ЗАДАЧА: верни JSON-массив фасетов, которые ОДНОЗНАЧНО соответствуют запросу.
Если ни один фасет не подходит — верни [].

Формат строго:
[{"key": "<facet_key>", "values": ["<value1>", "<value2>"]}]

Только JSON, без комментариев.`;

  const t0 = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    }),
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  let raw = "";
  try {
    const j = JSON.parse(text);
    raw = j?.choices?.[0]?.message?.content ?? "";
  } catch { raw = text; }

  // Попытка извлечь JSON из ответа
  let chosen: Array<{ key: string; values: string[] }> = [];
  try {
    const m = raw.match(/\[[\s\S]*\]/);
    if (m) chosen = JSON.parse(m[0]);
  } catch { /* leave empty */ }

  return { raw, chosen, ms };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const url = new URL(req.url);
  // queryHop — то, что V1 поставил бы в ?category= (короткое имя категории)
  const queryHop = url.searchParams.get("query_hop") ?? "лампы настольные";
  // userPhrase — полная фраза пользователя для LLM-матчинга фасетов
  const userPhrase = url.searchParams.get("user_phrase") ?? "лампа настольная для школьника";

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: settings } = await supabase
    .from("app_settings")
    .select("volt220_api_token, openrouter_api_key")
    .limit(1)
    .maybeSingle();
  if (!settings?.volt220_api_token || !settings?.openrouter_api_key) {
    return new Response(
      JSON.stringify({ error: "missing_credentials" }),
      { status: 500, headers: { ...cors, "content-type": "application/json" } },
    );
  }

  const auth = { Authorization: `Bearer ${settings.volt220_api_token}` };

  // ── 1) PROBE ────────────────────────────────────────────────────────────
  const probeUrl = `${API_BASE}/products?query=${encodeURIComponent(queryHop)}&per_page=30`;
  const t1 = Date.now();
  const probeRes = await fetch(probeUrl, { headers: auth });
  const probeMs = Date.now() - t1;
  const probeJson = await probeRes.json().catch(() => ({}));
  const probeResults: any[] = probeJson?.data?.results ?? [];
  const probeTotal = probeJson?.data?.pagination?.total ?? null;

  // ── 2) AGGREGATE FACETS ─────────────────────────────────────────────────
  const schema = aggregateOptions(probeResults);

  // ── 3) LLM MATCH ────────────────────────────────────────────────────────
  const llm = await callLLM(settings.openrouter_api_key, userPhrase, schema);

  // ── 4) STRICT SECOND HOP (если LLM что-то выбрала) ──────────────────────
  let strictUrl: string | null = null;
  let strictMs = 0;
  let strictTotal: number | null = null;
  let strictResults: any[] = [];
  if (llm.chosen.length > 0) {
    const params = new URLSearchParams();
    params.append("query", queryHop);
    params.append("per_page", "10");
    for (const c of llm.chosen) {
      for (const v of c.values) {
        params.append(`options[${c.key}][]`, v);
      }
    }
    strictUrl = `${API_BASE}/products?${params.toString()}`;
    const t2 = Date.now();
    const sRes = await fetch(strictUrl, { headers: auth });
    strictMs = Date.now() - t2;
    const sJson = await sRes.json().catch(() => ({}));
    strictResults = sJson?.data?.results ?? [];
    strictTotal = sJson?.data?.pagination?.total ?? null;
  }

  // ── 5) BUILD RESPONSE ───────────────────────────────────────────────────
  const productCard = (p: any) => ({
    id: p?.id,
    pagetitle: p?.pagetitle,
    price: p?.price,
    vendor: p?.vendor,
    category: p?.category?.pagetitle,
    url: p?.url,
  });

  return new Response(JSON.stringify({
    inputs: { query_hop: queryHop, user_phrase: userPhrase },
    step1_probe: {
      url: probeUrl,
      elapsed_ms: probeMs,
      http_status: probeRes.status,
      total_in_pagination: probeTotal,
      returned: probeResults.length,
      categories_distribution: Object.entries(
        probeResults.reduce((acc: Record<string, number>, p) => {
          const k = p?.category?.pagetitle ?? "(none)";
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {})
      ).sort((a: any, b: any) => b[1] - a[1]),
      sample: probeResults.slice(0, 5).map(productCard),
    },
    step2_facets: {
      keys_count_after_blacklist: schema.length,
      top12_passed_to_llm: schema.slice(0, 12).map((k) => ({
        key: k.key,
        caption_ru: k.caption_ru,
        values_count: k.values.length,
        top_values: k.values.slice(0, 5),
      })),
    },
    step3_llm_match: {
      elapsed_ms: llm.ms,
      raw_response: llm.raw,
      chosen: llm.chosen,
    },
    step4_strict_search: strictUrl ? {
      url: strictUrl,
      elapsed_ms: strictMs,
      total_in_pagination: strictTotal,
      returned: strictResults.length,
      results: strictResults.slice(0, 10).map(productCard),
    } : { skipped: "llm_chose_no_facets" },
    total_elapsed_ms: probeMs + llm.ms + strictMs,
  }, null, 2), { headers: { ...cors, "content-type": "application/json" } });
});
