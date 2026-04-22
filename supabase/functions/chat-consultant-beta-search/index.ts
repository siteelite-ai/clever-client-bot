import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY')!;

// Module-level mirror of categories cache for this isolated function
let localCategoriesCache: { categories: string[]; fetchedAt: number } | null = null;
const LOCAL_TTL_MS = 60 * 60 * 1000;

interface Trace { stage: string; ms: number; info?: unknown }

function now() { return Date.now(); }

async function callSearchProducts(payload: Record<string, unknown>) {
  const url = `${SUPABASE_URL}/functions/v1/search-products`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'apikey': SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`search-products ${res.status}: ${t}`);
  }
  return await res.json();
}

async function getCategoriesCache(): Promise<string[]> {
  const t = now();
  if (localCategoriesCache && (t - localCategoriesCache.fetchedAt) < LOCAL_TTL_MS) {
    return localCategoriesCache.categories;
  }
  const data = await callSearchProducts({ action: 'list_categories' });
  const cats = Array.isArray(data?.categories) ? data.categories : [];
  localCategoriesCache = { categories: cats, fetchedAt: t };
  return cats;
}

async function matchCategoriesWithLLM(queryWord: string, catalog: string[]): Promise<{ matches: string[]; raw?: unknown }> {
  const systemPrompt = `Ты сопоставляешь нормализованный запрос пользователя с категориями каталога электротоваров. Тебе даётся слово запроса и полный список существующих категорий каталога. Верни массив pagetitle категорий, в которых пользователь действительно ожидает увидеть искомый товар как самостоятельную позицию.

Правила:
1. Категория релевантна, если её товары — это тот самый предмет, который запрашивает пользователь, а не аксессуар, комплектующая, замена или сопутствующий товар.
2. Учитывай морфологию русского языка: запрос даётся в нормализованной форме, в каталоге названия могут быть в любом числе, падеже, с уточнениями.
3. Если в каталоге несколько подкатегорий одного семейства — включай все, которые семантически подходят.
4. Если ни одна категория не подходит — верни пустой массив. Не подбирай "похожее".

Каждая строка в matches — точное pagetitle из переданного списка, без изменений.`;

  const userMsg = JSON.stringify({ query_word: queryWord, catalog });

  const body = {
    model: 'google/gemini-2.5-flash',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMsg },
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'select_categories',
        description: 'Выбор подходящих категорий каталога для запроса пользователя.',
        parameters: {
          type: 'object',
          properties: {
            matches: {
              type: 'array',
              items: { type: 'string' },
              description: 'Точные pagetitle категорий из переданного списка.',
            },
          },
          required: ['matches'],
          additionalProperties: false,
        },
      },
    }],
    tool_choice: { type: 'function', function: { name: 'select_categories' } },
  };

  const res = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LOVABLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text();
    console.error('[matcher] gateway error', res.status, t);
    throw new Error(`AI gateway ${res.status}`);
  }
  const data = await res.json();
  const call = data?.choices?.[0]?.message?.tool_calls?.[0];
  const args = call?.function?.arguments;
  let parsed: { matches?: unknown } = {};
  try { parsed = JSON.parse(args ?? '{}'); } catch { /* ignore */ }
  const allowed = new Set(catalog);
  const matches = Array.isArray(parsed.matches)
    ? parsed.matches.filter((m): m is string => typeof m === 'string' && allowed.has(m))
    : [];
  return { matches, raw: data };
}

async function searchByCategoriesParallel(categories: string[], options?: Record<string, string>) {
  const all: any[] = [];
  const perCat = await Promise.all(categories.map(async (cat) => {
    try {
      const payload: Record<string, unknown> = { category: cat, perPage: 20 };
      if (options) {
        for (const [k, v] of Object.entries(options)) {
          payload[`option_${k}`] = v;
        }
      }
      const data = await callSearchProducts(payload);
      return Array.isArray(data?.results) ? data.results : [];
    } catch (e) {
      console.error('[search] cat failed', cat, e);
      return [];
    }
  }));
  for (const list of perCat) all.push(...list);
  // dedupe by id
  const seen = new Set<string | number>();
  const dedup: any[] = [];
  for (const it of all) {
    const id = it?.id ?? it?.product_id ?? JSON.stringify(it).slice(0, 64);
    if (!seen.has(id)) { seen.add(id); dedup.push(it); }
  }
  return dedup;
}

async function resolveFiltersWithLLM(modifiers: string[], schemaSample: any): Promise<Record<string, string> | null> {
  if (!modifiers?.length || !schemaSample) return null;
  const optionsSchema = schemaSample?.options ?? schemaSample;
  if (!optionsSchema || typeof optionsSchema !== 'object') return null;

  const systemPrompt = `Ты сопоставляешь модификаторы пользователя со схемой опций товара.
Дано: список модификаторов на естественном языке и схема options товара (ключи опций и возможные значения).
Верни объект selected: ключи — это имена опций из схемы, значения — конкретное значение из доступных.
Если модификатор не сопоставляется ни с одной опцией — пропусти его. Никаких выдуманных ключей.`;

  const userMsg = JSON.stringify({ modifiers, options_schema: optionsSchema });

  const res = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${LOVABLE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'apply_filters',
          parameters: {
            type: 'object',
            properties: {
              selected: { type: 'object', additionalProperties: { type: 'string' } },
            },
            required: ['selected'],
          },
        },
      }],
      tool_choice: { type: 'function', function: { name: 'apply_filters' } },
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const args = data?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  try {
    const parsed = JSON.parse(args ?? '{}');
    return (parsed?.selected && typeof parsed.selected === 'object') ? parsed.selected : null;
  } catch { return null; }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const trace: Trace[] = [];
  const t0 = now();

  try {
    const body = await req.json();
    const queryWord: string = String(body?.query_word ?? '').trim();
    const modifiers: string[] = Array.isArray(body?.modifiers) ? body.modifiers.map((x: unknown) => String(x)) : [];

    if (!queryWord && modifiers.length === 0) {
      return new Response(JSON.stringify({ error: 'query_word or modifiers required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // STAGE 1: cache
    const t1 = now();
    const catalog = await getCategoriesCache();
    trace.push({ stage: 'cache', ms: now() - t1, info: { count: catalog.length } });

    if (catalog.length === 0) {
      return new Response(JSON.stringify({
        matched_categories: [], raw_results_count: 0, filtered_results_count: 0,
        results: [], timings: { total_ms: now() - t0 }, trace,
        warning: 'category catalog is empty',
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // STAGE 2: matcher
    let matches: string[] = [];
    if (queryWord) {
      const t2 = now();
      try {
        const r = await matchCategoriesWithLLM(queryWord, catalog);
        matches = r.matches;
        trace.push({ stage: 'matcher', ms: now() - t2, info: { matches } });
      } catch (e) {
        trace.push({ stage: 'matcher', ms: now() - t2, info: { error: String(e) } });
      }
    } else {
      trace.push({ stage: 'matcher', ms: 0, info: { skipped: 'no query_word' } });
    }

    // STAGE 3: parallel category search (raw)
    let rawResults: any[] = [];
    if (matches.length > 0) {
      const t3 = now();
      rawResults = await searchByCategoriesParallel(matches);
      trace.push({ stage: 'search_raw', ms: now() - t3, info: { count: rawResults.length } });
    } else {
      trace.push({ stage: 'search_raw', ms: 0, info: { skipped: 'no matches' } });
    }

    // STAGE 4: filter via LLM (1 call on schema sample)
    let appliedFilters: Record<string, string> | null = null;
    if (rawResults.length > 0 && modifiers.length > 0) {
      const t4 = now();
      const sample = rawResults.find(r => r?.options) || rawResults[0];
      appliedFilters = await resolveFiltersWithLLM(modifiers, sample);
      trace.push({ stage: 'filter_llm', ms: now() - t4, info: { appliedFilters } });
    }

    // STAGE 5: filtered search (client-side filter on rawResults to keep beta isolated)
    let filtered: any[] = rawResults;
    if (appliedFilters && Object.keys(appliedFilters).length > 0) {
      const t5 = now();
      filtered = rawResults.filter(item => {
        const opts = item?.options ?? {};
        return Object.entries(appliedFilters!).every(([k, v]) => {
          const val = opts?.[k];
          if (val == null) return false;
          return String(val).toLowerCase().includes(String(v).toLowerCase());
        });
      });
      trace.push({ stage: 'filter_apply', ms: now() - t5, info: { before: rawResults.length, after: filtered.length } });

      // STAGE 6: relaxed fallback
      if (filtered.length === 0) {
        const tR = now();
        // Drop one filter at a time
        const keys = Object.keys(appliedFilters);
        for (let i = 0; i < keys.length && filtered.length === 0; i++) {
          const relaxed = { ...appliedFilters };
          delete relaxed[keys[i]];
          filtered = rawResults.filter(item => {
            const opts = item?.options ?? {};
            return Object.entries(relaxed).every(([k, v]) => {
              const val = opts?.[k];
              if (val == null) return false;
              return String(val).toLowerCase().includes(String(v).toLowerCase());
            });
          });
          if (filtered.length > 0) {
            trace.push({ stage: 'relaxed', ms: now() - tR, info: { dropped: keys[i], count: filtered.length } });
            break;
          }
        }
        if (filtered.length === 0) {
          trace.push({ stage: 'relaxed', ms: now() - tR, info: { result: 'still 0' } });
        }
      }
    }

    return new Response(JSON.stringify({
      matched_categories: matches,
      raw_results_count: rawResults.length,
      filtered_results_count: filtered.length,
      applied_filters: appliedFilters,
      results: filtered.slice(0, 30),
      timings: { total_ms: now() - t0 },
      trace,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[beta-search] error', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'unknown error',
      trace, timings: { total_ms: now() - t0 },
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
