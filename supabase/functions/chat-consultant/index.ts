// chat-consultant v4.0 — Micro-LLM intent classifier + latency optimization
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const VOLT220_API_URL = 'https://220volt.kz/api/products';

// Module-scope constants (visible to all branches: category-first, replacement, etc.)
const MAX_BUCKETS_TO_CHECK = 5;

// ============================================================================
// SUPPRESS RESOLVED TOKENS FROM LITERAL QUERY
// ----------------------------------------------------------------------------
// Single source of truth used by all 4 search branches (CategoryMatcher,
// Bucket-N Stage 2, Slot refinement, Replacement / alt-bucket).
//
// Goal: when FilterLLM resolved a modifier (e.g. "чёрный" → cvet=чёрный//қара),
// the same word must NOT also appear in the literal `query=` part of the API
// call — otherwise API gets a contradictory "options + literal" pair and
// returns 0.
//
// Hard rules (consilium decisions):
//   1. Suppress ONLY tokens that the Micro-LLM explicitly returned in
//      `search_modifiers` for THIS turn. Never blindly scrub the whole query
//      against resolved values (would over-suppress product-name words).
//   2. `query = null` is allowed only when the caller explicitly opts in
//      (`allowEmptyQuery: true`). Bucket-N + Matcher → true. Replacement /
//      alt-bucket → false (those branches are less confident; keep at least
//      the original literal as a signal).
//   3. Bilingual filter values like "чёрный//қара" MUST be split on `//`
//      before stemming, so both halves participate in the comparison.
//   4. If `modifierTokens` is empty → SKIP entirely. An empty list means
//      "this turn brought no modifiers" (filters likely came from an old
//      slot), so suppressing here would mutate text we have no claim to.
// ============================================================================
function suppressResolvedFromQuery(
  query: string | null,
  resolvedValues: string[],
  modifierTokens: string[],
  opts: { allowEmptyQuery: boolean; path: string },
): string | null {
  const { allowEmptyQuery, path } = opts;

  // Local stem identical to the one inside resolveFiltersWithLLM (4-char prefix).
  const normWord = (s: string) => s.replace(/ё/g, 'е').toLowerCase().replace(/[^а-яa-z0-9]/g, '');
  const stem4 = (s: string) => { const t = normWord(s); return t.length >= 4 ? t.slice(0, 4) : t; };

  if (!query || !query.trim()) {
    console.log(`[SuppressQuery] path=${path} SKIP reason=empty_query_in`);
    return query;
  }
  if (!modifierTokens || modifierTokens.length === 0) {
    console.log(`[SuppressQuery] path=${path} SKIP reason=no_modifiers`);
    return query;
  }
  if (!resolvedValues || resolvedValues.length === 0) {
    console.log(`[SuppressQuery] path=${path} SKIP reason=no_resolved_values`);
    return query;
  }

  // Build modifier-stem set (the ONLY tokens we are allowed to drop).
  const modifierStems = new Set<string>();
  for (const m of modifierTokens) {
    for (const w of normWord(m).split(/\s+/).filter(Boolean)) {
      const s = stem4(w);
      if (s) modifierStems.add(s);
    }
  }

  // Build resolved-value stem set — split bilingual `ru//kz` into halves.
  const resolvedStems = new Set<string>();
  for (const v of resolvedValues) {
    if (!v) continue;
    const halves = String(v).split('//').map(h => h.trim()).filter(Boolean);
    for (const half of halves) {
      for (const w of normWord(half).split(/\s+/).filter(Boolean)) {
        const s = stem4(w);
        if (s) resolvedStems.add(s);
      }
    }
  }

  if (modifierStems.size === 0 || resolvedStems.size === 0) {
    console.log(`[SuppressQuery] path=${path} SKIP reason=empty_stem_sets modStems=${modifierStems.size} resStems=${resolvedStems.size}`);
    return query;
  }

  // Tokenize query, drop tokens that are BOTH in modifier set AND in resolved set.
  const dropped: string[] = [];
  const kept = query.split(/\s+/).filter(rawTok => {
    const tok = rawTok.trim();
    if (!tok) return false;
    const ts = stem4(tok);
    if (!ts) return true;
    if (modifierStems.has(ts) && resolvedStems.has(ts)) {
      dropped.push(tok);
      return false;
    }
    return true;
  });

  const after = kept.join(' ').trim();
  console.log(`[SuppressQuery] path=${path} before="${query}" after="${after}" dropped=[${dropped.join(', ')}] resolvedStems=[${[...resolvedStems].join(', ')}] modStems=[${[...modifierStems].join(', ')}]`);

  if (!after) {
    if (allowEmptyQuery) {
      console.log(`[SuppressQuery] path=${path} → null (allowEmptyQuery=true)`);
      return null;
    }
    console.log(`[SuppressQuery] path=${path} SKIP reason=would_empty_but_disallowed → keep original`);
    return query;
  }
  return after;
}

// Helper: extract resolved string values from a flattened filter map.
// Use ONLY for suppressResolvedFromQuery (do not feed back to API).
function extractResolvedValues(filters: Record<string, string>): string[] {
  return Object.values(filters || {}).filter((v): v is string => typeof v === 'string' && v.length > 0);
}

// ============================================================================
// DISPLAY LIMIT — single source of truth for "how many products go into LLM ctx".
// We MUST distinguish "totalCollected" (real number we gathered from API across
// pages/categories) from "displayed" (truncated subset we hand to the LLM).
// Previous bug: every branch did `.slice(0, 15)` and then reported its length
// as "found N variants", so the bot always claimed exactly 15.
// ============================================================================
const DISPLAY_LIMIT = 15;

function pickDisplayWithTotal<T extends { price?: number }>(
  all: T[],
  limit: number = DISPLAY_LIMIT
): { displayed: T[]; total: number; filteredZeroPrice: number } {
  const input = all || [];
  // Filter out "под заказ" items (price <= 0). They confuse users — never show them.
  const priced = input.filter(p => ((p as any)?.price ?? 0) > 0);
  // Soft fallback: if EVERYTHING is zero-price (rare narrow category), keep original
  // so we don't return an empty list. Better to show "под заказ" than nothing.
  const working = priced.length > 0 ? priced : input;
  const total = working.length;
  const displayed = working.slice(0, limit);
  return { displayed, total, filteredZeroPrice: input.length - priced.length };
}

// ============================================================================
// DETERMINISTIC SAMPLING for OpenRouter / Gemini.
// Per OpenRouter docs: temperature=0 alone is NOT enough for Gemini.
// top_k=1 forces greedy decoding (always pick most likely token).
// seed gives extra reproducibility hint (best-effort for Gemini).
// provider.order locks to a single backend so different users hit the same
// model implementation (Google AI Studio vs Vertex AI can differ slightly).
// ============================================================================
const DETERMINISTIC_SAMPLING = {
  temperature: 0,
  top_p: 1,
  top_k: 1,
  seed: 42,
  provider: { order: ['google-ai-studio'], allow_fallbacks: true },
} as const;

// SHA-256 hex hash for response signatures (used to detect non-determinism in logs).
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

// Numeric semantic validator: ensures e.g. modifier "100W" doesn't get matched
// to filter range "13-20". Returns true if value semantically fits modifier.
// If neither side has clear numbers, returns true (let LLM decision stand).
function semanticNumericFit(modifier: string, value: string): boolean {
  const modNumMatch = modifier.match(/(\d+(?:[.,]\d+)?)/);
  if (!modNumMatch) return true;
  const modNum = parseFloat(modNumMatch[1].replace(',', '.'));
  if (!isFinite(modNum)) return true;

  // Try range "A-B" or "от A до B"
  const rangeMatch = value.match(/(\d+(?:[.,]\d+)?)\s*[-–—]\s*(\d+(?:[.,]\d+)?)/);
  if (rangeMatch) {
    const a = parseFloat(rangeMatch[1].replace(',', '.'));
    const b = parseFloat(rangeMatch[2].replace(',', '.'));
    const lo = Math.min(a, b), hi = Math.max(a, b);
    // Allow 10% tolerance on both ends (e.g. 100W can match 90-110 range)
    return modNum >= lo * 0.9 && modNum <= hi * 1.1;
  }
  // Single number value
  const valNumMatch = value.match(/(\d+(?:[.,]\d+)?)/);
  if (valNumMatch) {
    const valNum = parseFloat(valNumMatch[1].replace(',', '.'));
    if (!isFinite(valNum)) return true;
    // Within 15% — same physical magnitude
    const ratio = Math.max(modNum, valNum) / Math.max(Math.min(modNum, valNum), 0.001);
    return ratio <= 1.5;
  }
  // No numbers in value — can't validate, accept
  return true;
}

// Prioritize buckets whose name matches classifier.category root.
// Returns sorted entries: [name, count] with priority-aware ordering.
function prioritizeBuckets(
  dist: Record<string, number>,
  catKeyword: string
): Array<[string, number]> {
  const kw = (catKeyword || '').toLowerCase().trim();
  // Strip common Russian inflection endings (4+ char root)
  const root = kw.replace(/(ыми|ями|ами|ого|ему|ому|ой|ей|ую|юю|ие|ые|ие|ах|ям|ов|ев|ам|ы|и|а|у|е|о|я)$/, '');
  const useRoot = root.length >= 4 ? root : kw;

  return Object.entries(dist)
    .filter(([name]) => name !== 'unknown')
    .map(([name, count]) => {
      const lower = name.toLowerCase();
      let priority = 0;
      if (kw && lower.includes(kw)) priority = 2;
      else if (useRoot && lower.includes(useRoot)) priority = 2;
      else if (kw) {
        const firstWord = lower.split(/\s+/)[0];
        if (firstWord && firstWord.length >= 4 && kw.includes(firstWord.slice(0, Math.min(5, firstWord.length)))) {
          priority = 1;
        }
      }
      return { name, count, priority };
    })
    .sort((a, b) => b.priority - a.priority || b.count - a.count)
    .map((b) => [b.name, b.count] as [string, number]);
}

// =============================================================================
// CATEGORY CATALOG CACHE + LLM MATCHER (semantic category-first search path)
// =============================================================================
// Module-level cache of flat pagetitle[] from /api/categories. TTL 1h.
// On miss/error → returns []; matcher then returns [] → fallback to bucket-logic.
const CHAT_CATEGORIES_TTL_MS = 60 * 60 * 1000;
let chatCategoriesCache: { value: string[]; ts: number } | null = null;

async function getCategoriesCache(token: string): Promise<string[]> {
  if (chatCategoriesCache && Date.now() - chatCategoriesCache.ts < CHAT_CATEGORIES_TTL_MS) {
    return chatCategoriesCache.value;
  }
  try {
    const t0 = Date.now();
    const acc = new Set<string>();
    let page = 1;
    let totalPages = 1;
    do {
      const params = new URLSearchParams({ parent: '0', depth: '10', per_page: '200', page: String(page) });
      const res = await fetch(`https://220volt.kz/api/categories?${params}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        console.log(`[CategoriesCache] HTTP ${res.status} on page ${page}, aborting`);
        break;
      }
      const raw = await res.json();
      const data = raw.data || raw;
      const walk = (nodes: any[]) => {
        if (!Array.isArray(nodes)) return;
        for (const n of nodes) {
          if (n && typeof n.pagetitle === 'string' && n.pagetitle.trim()) acc.add(n.pagetitle.trim());
          if (n && Array.isArray(n.children) && n.children.length) walk(n.children);
        }
      };
      walk(data.results || []);
      totalPages = Math.max(1, Number(data.pagination?.pages) || 1);
      page++;
    } while (page <= totalPages && page <= 10);

    const flat = Array.from(acc).sort();
    chatCategoriesCache = { value: flat, ts: Date.now() };
    console.log(`[CategoriesCache] MISS → fetched ${flat.length} pagetitles in ${Date.now() - t0}ms (pages=${totalPages})`);
    return flat;
  } catch (e) {
    console.log(`[CategoriesCache] error: ${(e as Error).message} — returning empty list`);
    return [];
  }
}

// Semantic category matcher. Maps query word → exact pagetitle[] from catalog.
// On any failure → returns []; caller falls back to bucket-logic.
async function matchCategoriesWithLLM(
  queryWord: string,
  catalog: string[],
  settings: CachedSettings,
  historyContext?: string
): Promise<string[]> {
  if (!queryWord || !queryWord.trim() || catalog.length === 0) return [];
  if (!settings.openrouter_api_key) {
    console.log('[CategoryMatcher] OpenRouter key missing — skipping (deterministic empty)');
    return [];
  }

  const historyBlock = (historyContext && historyContext.trim())
    ? `\nКОНТЕКСТ ДИАЛОГА (последние реплики пользователя):\n${historyContext.trim()}\n`
    : '';

  const systemPrompt = `Ты определяешь, в каких категориях каталога электротоваров пользователь ожидает найти искомый товар.
${historyBlock}
ЗАПРОС ПОЛЬЗОВАТЕЛЯ: "${queryWord}"

ПОЛНЫЙ СПИСОК КАТЕГОРИЙ КАТАЛОГА (${catalog.length} шт.):
${JSON.stringify(catalog)}

ПРАВИЛА:
1. Категория релевантна, если её товары — это сам искомый предмет как самостоятельная позиция, а не компонент/деталь/аксессуар к нему. Если товары категории нужны для установки/использования искомого предмета, но сами по себе им не являются — категория НЕ релевантна, даже если её название содержит слово из запроса.
2. НЕ включай категории смежных классов товаров, относящихся к другой товарной группе.
3. Учитывай морфологию русского языка: единственное и множественное число, любой род и падеж — формы одного и того же слова.
4. Если в каталоге несколько подкатегорий одного семейства, отличающихся способом исполнения, монтажа или защиты — включай все.
5. Если ни одна категория не подходит — верни пустой массив. Не угадывай и не подбирай похожее по звучанию.
6. Возвращай pagetitle ТОЧНО так, как они написаны в списке (символ-в-символ).
7. Если для одного и того же предмета в каталоге одновременно есть категория общего/бытового назначения и категория узко-специализированная (промышленная, силовая, профессиональная, для высоких номиналов или особых стандартов) — выбирай общую/бытовую. Специализированную включай только если в самом запросе пользователя или в контексте диалога есть явный признак специализированного применения: упоминание промышленности, производства, цеха, трёхфазной сети, конкретного высокого номинала тока или напряжения, специальных стандартов защиты или разъёмов, профессионального класса инструмента. Признак должен присутствовать в словах пользователя или истории — не додумывай его.

Ответь СТРОГО в JSON: {"matches": ["pagetitle1", "pagetitle2", ...]}`;

  const reqBody = {
    model: 'google/gemini-2.5-flash',
    messages: [{ role: 'user', content: systemPrompt }],
    ...DETERMINISTIC_SAMPLING,
    max_tokens: 800,
    response_format: { type: 'json_object' },
    reasoning: { exclude: true },
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const t0 = Date.now();
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${settings.openrouter_api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      console.log(`[CategoryMatcher] HTTP ${response.status} for "${queryWord}"`);
      return [];
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    if (!content.trim()) {
      console.log(`[CategoryMatcher] empty content for "${queryWord}"`);
      return [];
    }
    let parsed: any;
    try { parsed = JSON.parse(content); } catch { return []; }
    const raw = Array.isArray(parsed?.matches) ? parsed.matches : [];
    // Validate: each item must exist in catalog (exact-string defence against hallucinations)
    const catalogSet = new Set(catalog);
    const validated = raw.filter((s: unknown) => typeof s === 'string' && catalogSet.has(s));
    console.log(`[CategoryMatcher] "${queryWord}" → ${JSON.stringify(validated)} (raw=${raw.length}, valid=${validated.length}, ${Date.now() - t0}ms)`);
    return validated;
  } catch (e) {
    console.log(`[CategoryMatcher] error for "${queryWord}": ${(e as Error).message}`);
    return [];
  }
}

/**
 * Plan V7 — Category disambiguation classifier.
 * Decides whether multiple matched buckets represent variants of ONE category (synonyms,
 * narrow subtypes — answer them with all) OR semantically distinct product groups
 * (household vs industrial, indoor vs outdoor, automatic vs manual — must ask user).
 *
 * Returns:
 *   { ambiguous: false } — matches are interchangeable, proceed with normal flow
 *   { ambiguous: true, options: [...] } — ask the user which one they want; options
 *     are short labels suitable for chip buttons.
 *
 * One Flash call, ~200 tokens, ~600ms. Skipped when matches.length < 2.
 */
async function classifyCategoryAmbiguity(
  queryWord: string,
  matches: string[],
  settings: CachedSettings,
  historyContext?: string,
): Promise<{ ambiguous: false } | { ambiguous: true; options: Array<{ label: string; value: string; pagetitle: string }> }> {
  if (matches.length < 2) return { ambiguous: false };
  if (!settings.openrouter_api_key) {
    console.log('[CategoryAmbiguity] OpenRouter key missing — skipping (deterministic non-ambiguous)');
    return { ambiguous: false };
  }

  const historyBlock = (historyContext && historyContext.trim())
    ? `\nКОНТЕКСТ ДИАЛОГА (последние реплики пользователя):\n${historyContext.trim()}\n`
    : '';

  const systemPrompt = `Ты решаешь, нужно ли уточнить у пользователя, какую именно категорию товаров он имеет в виду.
${historyBlock}
ЗАПРОС ПОЛЬЗОВАТЕЛЯ: "${queryWord}"

КАТЕГОРИИ-КАНДИДАТЫ (matcher уже отобрал релевантные):
${matches.map((m, i) => `${i + 1}. ${m}`).join('\n')}

ЗАДАЧА: классифицировать кандидаты по двум типам:
- SYNONYMS — это варианты ОДНОГО и того же типа товара (разные исполнения/монтаж/мощности одной товарной группы). Пользователю не важно различие, можно искать сразу во всех. Пример: "Лампы накаливания" + "Светодиодные лампы" по запросу "лампа".
- DISTINCT — это РАЗНЫЕ товарные группы для разных задач (бытовое vs промышленное, внутреннее vs уличное, ручное vs автоматическое, низкое vs высокое напряжение). Пользователь должен выбрать. Примеры:
  • "Розетки" (бытовые) vs "Розетки силовые" (промышленные, трёхфазные)
  • "Кабель ВВГ" vs "Кабель силовой бронированный"
  • "Выключатели" vs "Выключатели автоматические"
  • "Светильники для дома" vs "Прожекторы уличные"

ВАЖНО:
- Если в запросе или истории УЖЕ есть явный маркер выбора (например "силовые", "промышленные", "уличные", упоминание ампеража 32А/63А, IP44/IP54, трёхфазной сети) — тип SYNONYMS (не нужно переспрашивать, ответ уже виден).
- Если маркера нет, а кандидаты явно разной природы — тип DISTINCT.
- Если кандидатов 2+ и они разной природы → DISTINCT.
- Если все кандидаты — варианты одного — SYNONYMS.

Если DISTINCT, придумай для каждого кандидата КОРОТКУЮ человеческую подпись (label) для кнопки, 2–4 слова, без слова "категория", в женском роде если возможно. Пример: "Бытовые для дома", "Силовые промышленные", "Внутренние", "Уличные", "Автоматические".

Ответь СТРОГО в JSON одной из двух форм:
{"type":"SYNONYMS"}
ИЛИ
{"type":"DISTINCT","options":[{"pagetitle":"...","label":"..."}, ...]}

В DISTINCT pagetitle должны быть СИМВОЛ-В-СИМВОЛ из списка кандидатов.`;

  const reqBody = {
    model: 'google/gemini-2.5-flash',
    messages: [{ role: 'user', content: systemPrompt }],
    ...DETERMINISTIC_SAMPLING,
    max_tokens: 400,
    response_format: { type: 'json_object' },
    reasoning: { exclude: true },
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const t0 = Date.now();
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${settings.openrouter_api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      console.log(`[CategoryAmbiguity] HTTP ${response.status} for "${queryWord}" — defaulting to non-ambiguous`);
      return { ambiguous: false };
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    if (!content.trim()) {
      console.log(`[CategoryAmbiguity] empty content — defaulting to non-ambiguous`);
      return { ambiguous: false };
    }
    let parsed: any;
    try { parsed = JSON.parse(content); } catch { return { ambiguous: false }; }

    if (parsed?.type === 'SYNONYMS') {
      console.log(`[CategoryAmbiguity] "${queryWord}" → SYNONYMS (${matches.length} matches treated as one), ${Date.now() - t0}ms`);
      return { ambiguous: false };
    }
    if (parsed?.type === 'DISTINCT' && Array.isArray(parsed.options)) {
      // Validate: every pagetitle must exist in matches; sanitize labels.
      const matchSet = new Set(matches);
      const cleaned: Array<{ label: string; value: string; pagetitle: string }> = [];
      for (const opt of parsed.options) {
        if (!opt || typeof opt !== 'object') continue;
        const pagetitle = typeof opt.pagetitle === 'string' ? opt.pagetitle : '';
        const label = typeof opt.label === 'string' ? opt.label.trim().slice(0, 60) : '';
        if (!matchSet.has(pagetitle) || !label) continue;
        // value = label for slot resolution (user's "answer" is the label)
        cleaned.push({ label, value: label, pagetitle });
      }
      if (cleaned.length >= 2) {
        console.log(`[CategoryAmbiguity] "${queryWord}" → DISTINCT (${cleaned.length} options): ${cleaned.map(o => o.label).join(' | ')}, ${Date.now() - t0}ms`);
        return { ambiguous: true, options: cleaned };
      }
      console.log(`[CategoryAmbiguity] DISTINCT but only ${cleaned.length} valid options after sanitize → non-ambiguous`);
      return { ambiguous: false };
    }
    console.log(`[CategoryAmbiguity] unexpected response shape → non-ambiguous`);
    return { ambiguous: false };
  } catch (e) {
    console.log(`[CategoryAmbiguity] error: ${(e as Error).message} → non-ambiguous`);
    return { ambiguous: false };
  }
}

// Cached settings from DB
interface CachedSettings {
  volt220_api_token: string | null;
  openrouter_api_key: string | null;
  google_api_key: string | null;
  ai_provider: string;
  ai_model: string;
  system_prompt: string | null;
  classifier_provider: string;
  classifier_model: string;
}

async function getAppSettings(): Promise<CachedSettings> {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.log('[Settings] Supabase not configured, using env vars');
    return {
      volt220_api_token: Deno.env.get('VOLT220_API_TOKEN') || null,
      openrouter_api_key: null,
      google_api_key: null,
      ai_provider: 'openrouter',
      ai_model: 'meta-llama/llama-3.3-70b-instruct:free',
      system_prompt: null,
      classifier_provider: 'auto',
      classifier_model: 'gemini-2.5-flash-lite',
    };
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase
      .from('app_settings')
      .select('volt220_api_token, openrouter_api_key, google_api_key, ai_provider, ai_model, system_prompt, classifier_provider, classifier_model')
      .limit(1)
      .single();

    if (error || !data) {
      console.error('[Settings] Error reading settings:', error);
      return {
        volt220_api_token: Deno.env.get('VOLT220_API_TOKEN') || null,
        openrouter_api_key: null,
        google_api_key: null,
        ai_provider: 'openrouter',
        ai_model: 'meta-llama/llama-3.3-70b-instruct:free',
        system_prompt: null,
        classifier_provider: 'auto',
        classifier_model: 'gemini-2.5-flash-lite',
      };
    }

    // Fallback to env vars if DB values are empty
    return {
      volt220_api_token: data.volt220_api_token || Deno.env.get('VOLT220_API_TOKEN') || null,
      openrouter_api_key: data.openrouter_api_key || null,
      google_api_key: data.google_api_key || null,
      ai_provider: data.ai_provider || 'openrouter',
      ai_model: data.ai_model || 'meta-llama/llama-3.3-70b-instruct:free',
      system_prompt: data.system_prompt || null,
      classifier_provider: data.classifier_provider || 'auto',
      classifier_model: data.classifier_model || 'gemini-2.5-flash-lite',
    };
  } catch (e) {
    console.error('[Settings] Failed to load settings:', e);
      return {
        volt220_api_token: Deno.env.get('VOLT220_API_TOKEN') || null,
        openrouter_api_key: null,
        google_api_key: null,
        ai_provider: 'openrouter',
        ai_model: 'meta-llama/llama-3.3-70b-instruct:free',
        system_prompt: null,
        classifier_provider: 'auto',
        classifier_model: 'gemini-2.5-flash-lite',
      };
  }
}

// AI endpoint — STRICT OpenRouter only.
// Core rule: "Exclusively use OpenRouter (Gemini models). No direct Google keys."
// All other provider branches removed to eliminate non-determinism from cascade fallbacks.
function getAIConfig(settings: CachedSettings): { url: string; apiKeys: string[]; model: string } {
  if (!settings.openrouter_api_key) {
    throw new Error('OpenRouter API key не настроен. Добавьте ключ в Настройках.');
  }

  // Ensure model is in OpenRouter format (must contain "/", e.g. "google/gemini-2.5-pro")
  let model = settings.ai_model || 'google/gemini-2.5-pro';
  if (!model.includes('/')) {
    model = `google/${model}`;
  }

  console.log(`[AIConfig] OpenRouter (strict), model=${model}`);
  return {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    apiKeys: [settings.openrouter_api_key],
    model,
  };
}

// Call AI with automatic key rotation on errors (429, 500, 503, etc.)
async function callAIWithKeyFallback(
  url: string,
  apiKeys: string[],
  body: Record<string, unknown>,
  label: string = 'AI'
): Promise<Response> {
  const RETRY_DELAYS = [2000, 5000]; // retry delays within same key
  
  for (let keyIdx = 0; keyIdx < apiKeys.length; keyIdx++) {
    const apiKey = apiKeys[keyIdx];
    const keyLabel = apiKeys.length > 1 ? `key ${keyIdx + 1}/${apiKeys.length}` : 'key';
    
    // Try this key with retries for 429
    for (let attempt = 0; attempt <= 1; attempt++) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        if (keyIdx > 0) {
          console.log(`[${label}] Success with ${keyLabel} (previous keys exhausted)`);
        }
        return response;
      }

      const isRetryable = response.status === 429 || response.status === 500 || response.status === 503;
      
      if (!isRetryable) {
        // Non-retryable error (400, 401, 402, etc.) — return immediately
        console.error(`[${label}] Non-retryable error ${response.status} with ${keyLabel}`);
        return response;
      }

      // Retryable error
      const hasMoreKeys = keyIdx < apiKeys.length - 1;
      
      if (attempt === 0 && !hasMoreKeys) {
        // Only key — retry once after delay
        const errorBody = await response.text();
        console.log(`[${label}] ${response.status} with ${keyLabel}, retrying in ${RETRY_DELAYS[0]}ms...`, errorBody);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[0]));
        continue;
      }
      
      if (hasMoreKeys) {
        // More keys available — skip to next key immediately
        console.log(`[${label}] ${response.status} with ${keyLabel}, switching to next key`);
        break; // break retry loop, continue key loop
      }
      
      // Last key, last attempt — return the error response
      console.error(`[${label}] All ${apiKeys.length} key(s) exhausted, last status: ${response.status}`);
      return response;
    }
  }

  // Should never reach here, but just in case
  throw new Error(`[${label}] All API keys exhausted`);
}

// Knowledge base entry
interface KnowledgeResult {
  id: string;
  title: string;
  content: string;
  type: string;
  source_url: string | null;
  similarity: number;
}

// Generate query embedding using Google's gemini-embedding-001
async function generateQueryEmbedding(query: string, settings: CachedSettings): Promise<number[] | null> {
  if (!settings.google_api_key) {
    console.log('[Knowledge] No Google API key, skipping vector search');
    return null;
  }

  const keys = settings.google_api_key
    .split(/[,\n]/)
    .map(k => k.trim())
    .filter(k => k.length > 0);

  if (keys.length === 0) return null;

  for (let i = 0; i < keys.length; i++) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${keys[i]}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'models/gemini-embedding-001',
            content: { parts: [{ text: query.substring(0, 2000) }] },
            outputDimensionality: 768,
          }),
        }
      );

      if (response.ok) {
        const data = await response.json();
        const embedding = data.embedding?.values;
        if (embedding?.length > 0) {
          console.log(`[Knowledge] Generated query embedding (${embedding.length} dims)`);
          return embedding;
        }
      }

      if ((response.status === 429 || response.status >= 500) && i < keys.length - 1) continue;
      console.error(`[Knowledge] Embedding API error: ${response.status}`);
      return null;
    } catch (e) {
      if (i < keys.length - 1) continue;
      console.error('[Knowledge] Embedding error:', e);
      return null;
    }
  }
  return null;
}

// Search knowledge base using hybrid search (FTS + vector)
async function searchKnowledgeBase(
  query: string, 
  limit: number = 5,
  settings?: CachedSettings
): Promise<KnowledgeResult[]> {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.log('[Knowledge] Supabase not configured, skipping knowledge search');
    return [];
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    
    console.log(`[Knowledge] Hybrid search for: "${query.substring(0, 50)}..."`);
    
    // Generate query embedding for vector search (parallel-safe, non-blocking)
    let queryEmbedding: number[] | null = null;
    if (settings) {
      queryEmbedding = await generateQueryEmbedding(query, settings);
    }

    // Use hybrid search (FTS + vector via RRF)
    const { data, error } = await supabase.rpc('search_knowledge_hybrid', {
      search_query: query,
      query_embedding: queryEmbedding ? `[${queryEmbedding.join(',')}]` : null,
      match_count: limit,
    });

    if (error) {
      console.error('[Knowledge] Hybrid search error:', error);
      // Fallback to FTS-only
      const { data: ftsData, error: ftsError } = await supabase.rpc('search_knowledge_fulltext', {
        search_query: query,
        match_count: limit,
      });
      if (ftsError) {
        console.error('[Knowledge] FTS fallback error:', ftsError);
        return [];
      }
      console.log(`[Knowledge] FTS fallback found ${ftsData?.length || 0} entries`);
      return (ftsData || []).map((row: any) => ({
        id: row.id, title: row.title, content: row.content,
        type: row.type, source_url: row.source_url, similarity: row.rank,
      }));
    }

    console.log(`[Knowledge] Hybrid search found ${data?.length || 0} entries (vector: ${queryEmbedding ? 'yes' : 'no'})`);
    
    return (data || []).map((row: any) => ({
      id: row.id,
      title: row.title,
      content: row.content,
      type: row.type,
      source_url: row.source_url,
      similarity: row.score,
    }));
  } catch (error) {
    console.error('[Knowledge] Search error:', error);
    return [];
  }
}

/**
 * ARTICLE DETECTION — detects product SKU/article codes in user messages.
 */
function detectArticles(message: string): string[] {
  const exclusions = new Set([
    'ip20', 'ip21', 'ip23', 'ip40', 'ip41', 'ip44', 'ip54', 'ip55', 'ip65', 'ip66', 'ip67', 'ip68',
    'din', 'led', 'usb', 'type', 'wifi', 'hdmi',
  ]);
  
  const articlePattern = /\b([A-ZА-ЯЁa-zа-яё0-9][A-ZА-ЯЁa-zа-яё0-9.\-]{3,}[A-ZА-ЯЁa-zа-яё0-9])\b/g;
  
  const results: string[] = [];
  let match;
  
  const hasKeyword = /артикул|арт\.|код\s*товар|sku/i.test(message);
  
  while ((match = articlePattern.exec(message)) !== null) {
    const candidate = match[1];
    const lower = candidate.toLowerCase();
    
    if (exclusions.has(lower)) continue;
    
    const hasLetter = /[a-zA-ZА-ЯЁa-zа-яё]/.test(candidate);
    const hasDigit = /\d/.test(candidate);
    if (!hasLetter || !hasDigit) continue;
    
    const hasSeparator = /[-.]/.test(candidate);
    const hasContext = /есть в наличии|в наличии|в стоке|остат|наличи|сколько стоит|какая цена/i.test(message);
    const isSiteIdPattern = /^[A-ZА-ЯЁa-zа-яё]{1,3}\d{6,}$/i.test(candidate);
    if (!hasSeparator && !hasKeyword && !hasContext && !isSiteIdPattern) continue;
    
    if (candidate.length < 5) continue;
    
    if (/^\d+\.\d+$/.test(candidate)) continue;
    
    results.push(candidate);
  }
  
  // === SITE IDENTIFIER PATTERN ===
  const siteIdPattern = /(?:^|[\s,;:(]|(?<=\?))([A-ZА-ЯЁa-zа-яё]{1,3}\d{6,})(?=[\s,;:)?.!]|$)/g;
  let siteMatch;
  while ((siteMatch = siteIdPattern.exec(message)) !== null) {
    const code = siteMatch[1];
    if (!results.includes(code)) {
      results.push(code);
      console.log(`[ArticleDetect] Site ID pattern matched: ${code}`);
    }
  }

  // === PURE NUMERIC ARTICLE DETECTION ===
  const hasArticleContext = hasKeyword || /есть в наличии|в наличии|в стоке|остат|наличи|сколько стоит|какая цена/i.test(message);
  const startsWithNumber = /^\s*(\d{4,12})\b/.test(message);
  
  if (hasArticleContext || startsWithNumber) {
    const numericPattern = /\b(\d{4,12})\b/g;
    let numMatch;
    while ((numMatch = numericPattern.exec(message)) !== null) {
      const num = numMatch[1];
      if (/^(2024|2025|2026|2027|1000|2000|3000|5000|10000|50000|100000)$/.test(num)) continue;
      const alreadyCaptured = results.some(r => r.endsWith(num) && r !== num);
      if (alreadyCaptured) continue;
      if (!results.includes(num)) results.push(num);
    }
  }
  
  if (results.length > 0) {
    console.log(`[ArticleDetect] Found ${results.length} article(s): ${results.join(', ')} (keyword=${hasKeyword}, numericContext=${hasArticleContext || startsWithNumber})`);
  }
  
  return results;
}

/**
 * Search products by article parameter (exact match via API)
 */
// Plan V5: timeout-bounded fetch with single retry for catalog API.
// Protects article/siteId fast paths from hanging on slow upstream (was up to 70s in logs).
async function fetchCatalogWithRetry(
  url: string,
  apiToken: string,
  tag: string,
  timeoutMs = 8000
): Promise<Response | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        console.error(`[${tag}] API error: ${resp.status} (attempt ${attempt})`);
        if (attempt === 2) return null;
        continue;
      }
      return resp;
    } catch (err) {
      clearTimeout(timer);
      const isAbort = (err as Error)?.name === 'AbortError';
      if (isAbort) {
        console.warn(`[${tag}] timeout ${timeoutMs}ms (attempt ${attempt})${attempt === 1 ? ', retrying...' : ', giving up'}`);
      } else {
        console.error(`[${tag}] fetch error (attempt ${attempt}):`, err);
      }
      if (attempt === 2) return null;
    }
  }
  return null;
}

async function searchByArticle(article: string, apiToken: string): Promise<Product[]> {
  const params = new URLSearchParams();
  params.append('article', article);
  params.append('per_page', '5');

  console.log(`[ArticleSearch] Searching by article: ${article}`);

  const response = await fetchCatalogWithRetry(
    `${VOLT220_API_URL}?${params}`,
    apiToken,
    'ArticleSearch',
    8000
  );
  if (!response) return [];

  try {
    const rawData = await response.json();
    const data = rawData.data || rawData;
    const results = data.results || [];
    console.log(`[ArticleSearch] Found ${results.length} product(s) for article "${article}"`);
    return results;
  } catch (error) {
    console.error(`[ArticleSearch] Parse error:`, error);
    return [];
  }
}

/**
 * Search products by site identifier
 */
async function searchBySiteId(siteId: string, apiToken: string): Promise<Product[]> {
  const params = new URLSearchParams();
  params.append('options[identifikator_sayta__sayt_identifikatory][]', siteId);
  params.append('per_page', '5');

  console.log(`[SiteIdSearch] Searching by site identifier: ${siteId}`);

  const response = await fetchCatalogWithRetry(
    `${VOLT220_API_URL}?${params}`,
    apiToken,
    'SiteIdSearch',
    8000
  );
  if (!response) return [];

  try {
    const rawData = await response.json();
    const data = rawData.data || rawData;
    const results = data.results || [];
    console.log(`[SiteIdSearch] Found ${results.length} product(s) for site ID "${siteId}"`);
    return results;
  } catch (error) {
    console.error(`[SiteIdSearch] Parse error:`, error);
    return [];
  }
}

interface Product {
  id: number;
  pagetitle: string;
  alias: string;
  url: string;
  article?: string;
  price: number;
  old_price?: number;
  vendor: string;
  image?: string;
  amount: number;
  content?: string;
  category?: {
    id: number;
    pagetitle: string;
  };
  options?: Array<{
    key: string;
    caption: string;
    value: string;
  }>;
  warehouses?: Array<{
    city: string;
    amount: number;
  }>;
}

interface SearchCandidate {
  query: string | null;
  article?: string | null;
  brand: string | null;
  category: string | null;
  min_price: number | null;
  max_price: number | null;
  option_filters?: Record<string, string>;
}

// NO hardcoded option keys! We discover them dynamically from API results.

interface ExtractedIntent {
  intent: 'catalog' | 'brands' | 'info' | 'general';
  candidates: SearchCandidate[];
  originalQuery: string;
  usage_context?: string;
  english_queries?: string[];
}

// ============================================================
// MICRO-LLM INTENT CLASSIFIER — determines if message contains a product name
// ============================================================

/**
 * Lightweight LLM call to classify if user message contains a specific product name.
 * Uses Lovable AI Gateway with gemini-2.5-flash-lite for speed (~0.5-1.5s).
 * Returns extracted product name or null. Timeout: 3 seconds.
 */
interface ClassificationResult {
  intent?: string;
  has_product_name: boolean;
  product_name?: string;
  price_intent?: 'most_expensive' | 'cheapest';
  product_category?: string;
  is_replacement?: boolean;
  search_modifiers?: string[];
  critical_modifiers?: string[];
}

async function classifyProductName(message: string, recentHistory?: Array<{role: string, content: string}>, settings?: CachedSettings | null): Promise<ClassificationResult | null> {
  // STRICT OpenRouter: no cascade, no Google direct, no Lovable Gateway.
  // Cascade fallbacks were a primary source of non-determinism (different users got different providers).
  if (!settings?.openrouter_api_key) {
    console.log('[Classify] OpenRouter key missing — classification skipped (deterministic null)');
    return null;
  }

  // FORCED UPGRADE: flash-lite is non-deterministic for matching tasks (per OpenRouter docs).
  // Hardcoded to flash for classifier — ignores DB setting until determinism proven on flash.
  const model = 'google/gemini-2.5-flash';

  const url = 'https://openrouter.ai/api/v1/chat/completions';
  const apiKeys = [settings.openrouter_api_key];

  console.log(`[Classify] OpenRouter (strict), model=${model} (forced upgrade from flash-lite)`);

  const classifyBody = {
    model: model,
    messages: [
      {
        role: 'system',
        content: `ГЛАВНОЕ ПРАВИЛО: Определяй intent ТОЛЬКО по ТЕКУЩЕМУ сообщению пользователя. История диалога — справочный контекст для коротких уточнений, НЕ для определения интента. Если текущее сообщение содержит любые слова-товары (розетка, кабель, автомат, щит, лампа, выключатель, провод, удлинитель, счётчик, реле, контактор, датчик, трансформатор, рубильник и т.д.) — intent ВСЕГДА "catalog", даже если ВСЕ предыдущие сообщения были про оплату, доставку или прайс.

Ты классификатор сообщений интернет-магазина электротоваров 220volt.kz.

КОНТЕКСТ ДИАЛОГА: Если текущее сообщение — САМОСТОЯТЕЛЬНЫЙ НОВЫЙ ЗАПРОС (содержит категорию товара или название), извлекай ВСЕ поля ТОЛЬКО из текущего сообщения. НЕ переноси category, modifiers, product_name из предыдущих сообщений. Используй историю ТОЛЬКО для коротких ответов-уточнений (1-3 слова: «давай», «телефонную», «да»). Разговорные слова (давай, ладно, хорошо, ну, а, тогда, покажи, найди) не являются частью товара — отбрасывай их.

⚡ ПРИОРИТЕТ №0 — ДЕТЕКЦИЯ ИНТЕНТА "ЗАМЕНА/АНАЛОГ" (проверяй ДО всего остального):
Если в запросе есть слова: "замена", "заменить", "аналог", "альтернатива", "похожий", "похожее", "вместо", "что-то подобное", "близкое по характеристикам", "подбери замену", "подбери аналог", "что взять вместо":
  → is_replacement = true
  → если в запросе есть конкретный товар (бренд+модель / артикул / серия+параметры) — has_product_name=true и product_name=название (нужно для извлечения характеристик оригинала)
  → product_category = категория оригинала (например "светильник", "автомат", "розетка")
  → search_modifiers = характеристики оригинала из запроса (мощность, цвет, IP, и т.д.) если они явно указаны
  → ОБЯЗАТЕЛЬНО при is_replacement=true: бренд, серия и модель/артикул из запроса ВСЕГДА выносятся в search_modifiers как ОТДЕЛЬНЫЕ элементы (даже если они уже есть в product_name). Это нужно, чтобы система могла применить их как фильтры, если оригинал не найдётся в каталоге. Бренд из запроса дополнительно дублируется в critical_modifiers.
ВАЖНО: при is_replacement=true система найдёт оригинал ТОЛЬКО для извлечения характеристик и вернёт пользователю АНАЛОГИ, а не сам оригинал.

Примеры (is_replacement=true):
- "светильник ДКУ-LED-03-100W (ЭТФ) предложи самую близкую замену по характеристикам" → is_replacement=true, has_product_name=true, product_name="ДКУ-LED-03-100W ЭТФ", product_category="светильник", search_modifiers=["ДКУ-LED-03-100W","ЭТФ","100Вт"], critical_modifiers=["ЭТФ"]
- "что взять вместо ABB S201 C16?" → is_replacement=true, has_product_name=true, product_name="ABB S201 C16", product_category="автомат", search_modifiers=["ABB","S201","C16"], critical_modifiers=["ABB"]
- "подбери аналог розетке Werkel Atlas серого цвета" → is_replacement=true, has_product_name=true, product_name="Werkel Atlas розетка", product_category="розетка", search_modifiers=["Werkel","Atlas","серый"], critical_modifiers=["Werkel"]
- "чем заменить розетку Legrand X" → is_replacement=true, has_product_name=true, product_name="Legrand X розетка", product_category="розетка", search_modifiers=["Legrand","X"], critical_modifiers=["Legrand"]

⚡ ПРИОРИТЕТ №1 — ОПРЕДЕЛЕНИЕ КОНКРЕТНОГО ТОВАРА (проверяй ПЕРВЫМ если ПРИОРИТЕТ №0 не сработал):
Если пользователь называет товар так, что его можно найти прямым поиском по названию — это КОНКРЕТНЫЙ ТОВАР, а не категория.

Признаки КОНКРЕТНОГО товара (любой из):
- содержит БРЕНД/ПРОИЗВОДИТЕЛЯ (REXANT, ABB, Schneider, Legrand, IEK, EKF, TDM, Werkel и т.д.)
- содержит МОДЕЛЬ или СЕРИЮ (S201, ЭПСН, ВВГнг, ПВС, Этюд, Atlas)
- содержит АРТИКУЛ (формат типа 12-0292, A9F74116, EKF-001)
- развёрнутое описание с типом + параметрами + брендом/серией одновременно

Если это КОНКРЕТНЫЙ товар:
  → has_product_name = true
  → product_name = ПОЛНОЕ название как поисковый запрос (бренд + серия + ключевые параметры + артикул, без разговорных слов)
  → product_category = базовый тип (для запасного пути)
  → search_modifiers = [] (всё уже в product_name)

Примеры КОНКРЕТНЫХ товаров (has_product_name=true):
- "Паяльник-топор высокомощный, серия ЭПСН, 200Вт, 230В, REXANT, 12-0292" → product_name="Паяльник ЭПСН 200Вт REXANT 12-0292"
- "Кабель ВВГнг 3х2.5" → product_name="Кабель ВВГнг 3х2.5"
- "ABB S201 C16" → product_name="ABB S201 C16"
- "автомат IEK ВА47-29 16А" → product_name="автомат IEK ВА47-29 16А"

Примеры КАТЕГОРИЙ (has_product_name=false):
- "автоматы на 16 ампер" → category="автомат", modifiers=["16А"]
- "розетки с заземлением" → category="розетка", modifiers=["с заземлением"]
- "подбери светильники для ванной" → category="светильник", modifiers=["для ванной"]
- "розетки из коллекции Гармония" → category="розетка", modifiers=["Гармония"] (серия без бренда+модели = категория)

Ключевое отличие: БРЕНД+ТИП или ТИП+СЕРИЯ+ПАРАМЕТРЫ+АРТИКУЛ → конкретный товар. Тип+характеристики без бренда/модели → категория.

Извлеки из сообщения следующие поля:

0. intent ("catalog"|"brands"|"info"|"general"): Определи НАМЕРЕНИЕ пользователя:
- "catalog" — ищет конкретные товары, оборудование, материалы для покупки
- "brands" — спрашивает какие бренды/производители представлены в магазине
- "info" — вопросы о компании, доставке, оплате, оферте, контактах, прайс-листе, гарантии, возврате, графике работы, адресах
- "general" — приветствия, благодарности, шутки, вопросы не связанные с магазином

1. has_product_name (boolean): см. ПРИОРИТЕТ №1 выше.

2. product_name (string|null): Если has_product_name=true — полное название товара без разговорных оборотов. Иначе null.

3. price_intent ("most_expensive"|"cheapest"|null): Заполняй ТОЛЬКО при явном запросе на экстремум цены — самый дорогой, самый дешёвый, самый бюджетный. Обычные вопросы о цене или стоимости конкретного товара — null.

4. product_category (string|null): БАЗОВЫЙ тип товара — максимально общее слово или пара слов, определяющая товарную группу для текстового поиска в каталоге. НЕ включай количество мест/постов, тип монтажа, конструктивные уточнения, серию/коллекцию — всё это выносится в search_modifiers. Category должна быть достаточно общей, чтобы API нашёл товары этой группы.

5. is_replacement (boolean): TRUE если пользователь семантически ищет замену, аналог, альтернативу, что-то похожее, или спрашивает что взять вместо конкретного товара.

6. search_modifiers (string[]): ВСЕ уточняющие характеристики из запроса, не вошедшие в category: количество мест/постов, тип монтажа (накладной, скрытый), цвет, бренд, серия/коллекция, степень защиты IP, материал, размер, количественные параметры (длина, сечение, ток). Если таких нет — пустой массив.

7. critical_modifiers (string[]): ПОДМНОЖЕСТВО search_modifiers, которые пользователь требует КАТЕГОРИЧНО (без них товар не подходит). Определяй по тону запроса:
- Если пользователь просто перечислил характеристики ("чёрная двухместная розетка", "розетка с заземлением") — ВСЕ модификаторы критичные.
- Если пользователь использует смягчающие слова ("примерно", "около", "желательно", "можно", "лучше", "хотелось бы") — соответствующие модификаторы НЕ критичные.
- Если запрос вообще без модификаторов — пустой массив.
Примеры:
- "чёрная двухместная розетка" → search_modifiers=["чёрная","двухместная"], critical_modifiers=["чёрная","двухместная"]
- "лампочка примерно 9 ватт E27" → search_modifiers=["9 ватт","E27"], critical_modifiers=["E27"] (мощность смягчена "примерно")
- "розетка legrand белая, желательно с заземлением" → search_modifiers=["legrand","белая","с заземлением"], critical_modifiers=["legrand","белая"] (заземление смягчено "желательно")

КЛЮЧЕВОЙ ПРИНЦИП: category = базовый тип товара для широкого текстового поиска. Все конкретные характеристики (конструкция, подтип, внешние атрибуты) → modifiers. Система фильтрации сама сопоставит модификаторы с реальными характеристиками товаров. critical_modifiers говорит системе, какие фильтры НЕЛЬЗЯ ослаблять при fallback.

Ответь СТРОГО в JSON: {"intent": "catalog"|"brands"|"info"|"general", "has_product_name": bool, "product_name": "...", "price_intent": "most_expensive"|"cheapest"|null, "product_category": "...", "is_replacement": bool, "search_modifiers": ["...", "..."], "critical_modifiers": ["...", "..."]}`
      },
      ...(recentHistory || []).map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user', content: message }
    ],
    ...DETERMINISTIC_SAMPLING,
    max_tokens: 300,
    reasoning: { exclude: true },
  };
  console.log(`[ExtractIntent] Sampling: top_k=1 seed=42 provider=google-ai-studio`);

  // STRICT OpenRouter: single deterministic attempt, no cascade fallbacks.
  // Fallbacks to other providers caused different users to get different classifier outputs.
  interface ProviderAttempt { url: string; apiKeys: string[]; model: string; label: string; }
  const attempts: ProviderAttempt[] = [{ url, apiKeys, model, label: 'openrouter(strict)' }];

  for (const attempt of attempts) {
    try {
      const body = { ...classifyBody, model: attempt.model };
      const classifyPromise = callAIWithKeyFallback(attempt.url, attempt.apiKeys, body, 'Classify');
      const timeoutPromise = new Promise<Response>((_, reject) => 
        setTimeout(() => reject(new DOMException('Timeout', 'AbortError')), 12000)
      );

      const response = await Promise.race([classifyPromise, timeoutPromise]);

      if (!response.ok) {
        console.error(`[Classify] ${attempt.label} error: ${response.status}, trying next...`);
        continue;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) { console.log(`[Classify] ${attempt.label} empty response, trying next...`); continue; }

      const jsonStr = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (parseErr) {
        // Recovery: try to repair truncated JSON (closing braces/quotes)
        console.warn(`[Classify] ${attempt.label} JSON parse failed, attempting recovery...`);
        let repaired = jsonStr;
        // If last char inside an unterminated string, close it
        const quotes = (repaired.match(/"/g) || []).length;
        if (quotes % 2 !== 0) repaired += '"';
        // Close arrays/objects
        const openBraces = (repaired.match(/\{/g) || []).length - (repaired.match(/\}/g) || []).length;
        const openBrackets = (repaired.match(/\[/g) || []).length - (repaired.match(/\]/g) || []).length;
        for (let i = 0; i < openBrackets; i++) repaired += ']';
        for (let i = 0; i < openBraces; i++) repaired += '}';
        // Strip trailing commas before closing
        repaired = repaired.replace(/,(\s*[}\]])/g, '$1');
        try {
          parsed = JSON.parse(repaired);
          console.log(`[Classify] ${attempt.label} JSON recovered successfully`);
        } catch {
          // Last resort: regex-extract critical fields
          const intentMatch = jsonStr.match(/"intent"\s*:\s*"(\w+)"/);
          const hasNameMatch = jsonStr.match(/"has_product_name"\s*:\s*(true|false)/);
          const productNameMatch = jsonStr.match(/"product_name"\s*:\s*"([^"]*)"/);
          const categoryMatch = jsonStr.match(/"product_category"\s*:\s*"([^"]*)"/);
          if (intentMatch || hasNameMatch) {
            console.log(`[Classify] ${attempt.label} regex-extracted partial result`);
            parsed = {
              intent: intentMatch?.[1],
              has_product_name: hasNameMatch?.[1] === 'true',
              product_name: productNameMatch?.[1],
              product_category: categoryMatch?.[1],
              search_modifiers: [],
            };
          } else {
            throw parseErr;
          }
        }
      }
      const validIntents = ['catalog', 'brands', 'info', 'general'];
      const rawIntent = typeof parsed.intent === 'string' ? parsed.intent.toLowerCase().trim() : null;
      const intent = validIntents.includes(rawIntent!) ? rawIntent : undefined;
      // Safety: if micro-LLM says info/general but product_category is filled, override to catalog
      const finalIntent = ((intent === 'info' || intent === 'general') && parsed.product_category) ? 'catalog' : intent;
      console.log(`[Classify] SUCCESS via ${attempt.label}, intent=${finalIntent}`);
      const rawSearchMods = Array.isArray(parsed.search_modifiers) ? parsed.search_modifiers.filter((m: unknown) => typeof m === 'string' && m.trim().length > 0) : [];
      // Default: if critical_modifiers missing/empty but search_modifiers present, treat ALL as critical (safe behavior)
      let rawCritical = Array.isArray(parsed.critical_modifiers) ? parsed.critical_modifiers.filter((m: unknown) => typeof m === 'string' && m.trim().length > 0) : [];
      if (rawCritical.length === 0 && rawSearchMods.length > 0) rawCritical = [...rawSearchMods];
      console.log(`[Chat] Classifier critical_modifiers: [${rawCritical.join(', ')}] (of search_modifiers: [${rawSearchMods.join(', ')}])`);
      return {
        intent: finalIntent as string | undefined,
        has_product_name: !!parsed.has_product_name,
        product_name: (typeof parsed.product_name === 'string' ? parsed.product_name : '') || undefined,
        price_intent: (parsed.price_intent === 'most_expensive' || parsed.price_intent === 'cheapest') ? parsed.price_intent : undefined,
        product_category: (typeof parsed.product_category === 'string' ? parsed.product_category : '') || undefined,
        is_replacement: !!parsed.is_replacement,
        search_modifiers: rawSearchMods,
        critical_modifiers: rawCritical,
      };
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        console.log(`[Classify] ${attempt.label} timeout (12s), no fallback (strict OpenRouter)`);
      } else {
        console.error(`[Classify] ${attempt.label} error:`, e, ', trying next...');
      }
    }
  }

  console.log('[Classify] All providers failed, returning null');
  return null;
}

// ============================================================
// REPLACEMENT/ALTERNATIVE — extract modifiers from product options
// ============================================================

/**
 * Extract human-readable modifiers from a product's options for category-first search.
 * E.g. product with options {moshchnost: "100 Вт", stepen_zashchity: "IP67"} → ["100Вт", "IP67", "LED"]
 */
function extractModifiersFromProduct(product: Product): string[] {
  const mods: string[] = [];
  if (!product.options) return mods;

  const importantPatterns = [
    /мощность|moshchnost|power|watt/i,
    /напряжение|voltage|napr/i,
    /защит|ip|stepen_zashch/i,
    /цоколь|tsokol|cap/i,
    /тип|vid_|type/i,
    /сечение|sechenie/i,
    /количество|kolichestvo/i,
    /материал|material/i,
    /цвет|color|tsvet/i,
  ];

  for (const opt of product.options) {
    const keyLower = opt.key.toLowerCase();
    const captionLower = opt.caption.toLowerCase();

    if (!importantPatterns.some(p => p.test(keyLower) || p.test(captionLower))) continue;

    const cleanValue = opt.value.split('//')[0].trim();
    if (!cleanValue) continue;

    // Compact only "number space unit" → "numberunit", keep everything else as-is
    const finalValue = cleanValue.replace(/^(\d+)\s+(Вт|В|мм|мм²|кг|м|А)$/i, '$1$2');
    mods.push(finalValue);
    if (mods.length >= 8) break;
  }

  console.log(`[ReplacementMods] Product "${product.pagetitle.substring(0, 50)}" → modifiers: [${mods.join(', ')}]`);
  return mods;
}

// =============================================================================
// CATEGORY OPTIONS SCHEMA CACHE
// =============================================================================
// For each category pagetitle, fetches a wide product sample (up to 5 pages × 200)
// and aggregates a complete map of options keys + all observed values.
// TTL 30m. On error → returns empty Map (caller falls back to per-product schema).
//
// Why: filter-resolver LLM previously saw options union from 30-product sample.
// If e.g. no double sockets were in those 30 → key "kolichestvo_postov" missing
// → LLM physically cannot match "двухгнёздная". Full schema fixes this.
const CATEGORY_OPTIONS_TTL_MS = 30 * 60 * 1000;
const categoryOptionsCache: Map<string, { schema: Map<string, { caption: string; values: Set<string> }>; ts: number; productCount: number }> = new Map();

async function getCategoryOptionsSchema(
  categoryPagetitle: string,
  apiToken: string
): Promise<{ schema: Map<string, { caption: string; values: Set<string> }>; productCount: number; cacheHit: boolean }> {
  const cached = categoryOptionsCache.get(categoryPagetitle);
  if (cached && Date.now() - cached.ts < CATEGORY_OPTIONS_TTL_MS) {
    console.log(`[CategoryOptionsSchema] cache HIT "${categoryPagetitle}" (${cached.schema.size} keys, ${cached.productCount} products, age=${Math.round((Date.now() - cached.ts) / 1000)}s)`);
    return { schema: cached.schema, productCount: cached.productCount, cacheHit: true };
  }

  const t0 = Date.now();
  const schema: Map<string, { caption: string; values: Set<string> }> = new Map();
  let totalProducts = 0;
  const MAX_PAGES = 5;
  const PER_PAGE = 200;

  try {
    let page = 1;
    let totalPages = 1;
    do {
      const params = new URLSearchParams();
      params.append('category', categoryPagetitle);
      params.append('per_page', String(PER_PAGE));
      params.append('page', String(page));

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(`${VOLT220_API_URL}?${params}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        console.log(`[CategoryOptionsSchema] HTTP ${res.status} on page ${page} for "${categoryPagetitle}", aborting`);
        break;
      }
      const raw = await res.json();
      const data = raw.data || raw;
      const results: any[] = data.results || [];
      totalProducts += results.length;

      for (const product of results) {
        if (!product.options || !Array.isArray(product.options)) continue;
        for (const opt of product.options) {
          if (!opt || typeof opt.key !== 'string') continue;
          if (isExcludedOption(opt.key)) continue;
          if (!schema.has(opt.key)) {
            schema.set(opt.key, { caption: opt.caption || opt.key, values: new Set() });
          }
          if (typeof opt.value === 'string' && opt.value.trim()) {
            schema.get(opt.key)!.values.add(opt.value);
          }
        }
      }

      totalPages = Math.max(1, Number(data.pagination?.pages) || 1);
      if (results.length < PER_PAGE) break; // last page
      page++;
    } while (page <= totalPages && page <= MAX_PAGES);

    categoryOptionsCache.set(categoryPagetitle, { schema, ts: Date.now(), productCount: totalProducts });
    const totalValues = Array.from(schema.values()).reduce((s, v) => s + v.values.size, 0);
    console.log(`[CategoryOptionsSchema] "${categoryPagetitle}": ${schema.size} keys, ${totalValues} values (from ${totalProducts} products, ${Date.now() - t0}ms, cached 30m)`);
    return { schema, productCount: totalProducts, cacheHit: false };
  } catch (e) {
    console.log(`[CategoryOptionsSchema] error for "${categoryPagetitle}": ${(e as Error).message} — returning empty schema`);
    return { schema: new Map(), productCount: 0, cacheHit: false };
  }
}

// Union schemas of multiple categories (parallel fetch). Used when CategoryMatcher
// returns several pagetitles for one logical request (e.g. "розетки скрытой" + "накладные").
async function getUnionCategoryOptionsSchema(
  pagetitles: string[],
  apiToken: string
): Promise<Map<string, { caption: string; values: Set<string> }>> {
  if (!pagetitles || pagetitles.length === 0) return new Map();
  const results = await Promise.all(pagetitles.map(pt => getCategoryOptionsSchema(pt, apiToken)));
  const union: Map<string, { caption: string; values: Set<string> }> = new Map();
  let totalProducts = 0;
  for (const r of results) {
    totalProducts += r.productCount;
    for (const [key, info] of r.schema.entries()) {
      if (!union.has(key)) {
        union.set(key, { caption: info.caption, values: new Set() });
      }
      const target = union.get(key)!;
      for (const v of info.values) target.values.add(v);
    }
  }
  const totalValues = Array.from(union.values()).reduce((s, v) => s + v.values.size, 0);
  console.log(`[CategoryOptionsSchema] union ${pagetitles.length} categories → ${union.size} keys, ${totalValues} values (from ${totalProducts} products)`);
  return union;
}



interface PriceIntentResult {
  action: 'answer' | 'clarify' | 'not_found';
  products?: Product[];
  total?: number;
  category?: string;
}

/**
 * Generate synonym queries for a product category for broader price-intent search.
 * E.g. "кемпинговый фонарь" → ["кемпинговый фонарь", "фонарь кемпинговый", "фонарь", "прожектор кемпинговый"]
 */
function generatePriceSynonyms(query: string): string[] {
  const synonyms = new Set<string>();
  synonyms.add(query);
  
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
  
  // Add reversed word order: "кемпинговый фонарь" → "фонарь кемпинговый"
  if (words.length >= 2) {
    synonyms.add(words.reverse().join(' '));
  }
  
  // Add each individual word (if meaningful, ≥3 chars)
  for (const w of words) {
    if (w.length >= 3) synonyms.add(w);
  }
  
  // Common product synonym mappings for electrical store
  const synonymMap: Record<string, string[]> = {
    'фонарь': ['фонарь', 'фонарик', 'прожектор', 'светильник переносной'],
    'фонарик': ['фонарь', 'фонарик', 'прожектор'],
    'автомат': ['автомат', 'автоматический выключатель', 'выключатель автоматический'],
    'кабель': ['кабель', 'провод'],
    'розетка': ['розетка', 'розетки'],
    'лампа': ['лампа', 'лампочка', 'светодиодная лампа'],
    'щиток': ['щиток', 'бокс', 'щит', 'корпус модульный'],
    'удлинитель': ['удлинитель', 'колодка', 'сетевой фильтр'],
    'болгарка': ['УШМ', 'болгарка', 'угловая шлифмашина'],
    'дрель': ['дрель', 'дрели'],
    'перфоратор': ['перфоратор', 'бурильный молоток'],
    'стабилизатор': ['стабилизатор', 'стабилизатор напряжения'],
    'рубильник': ['рубильник', 'выключатель-разъединитель', 'выключатель нагрузки'],
    'светильник': ['светильник', 'светильники', 'люстра'],
    'генератор': ['генератор', 'электростанция'],
  };
  
  for (const w of words) {
    const syns = synonymMap[w];
    if (syns) {
      for (const s of syns) {
        synonyms.add(s);
        // Also add with adjective if original had one: "кемпинговый" + "прожектор"
        const adjectives = words.filter(ww => ww !== w && ww.length >= 3);
        for (const adj of adjectives) {
          synonyms.add(`${adj} ${s}`);
          synonyms.add(`${s} ${adj}`);
        }
      }
    }
  }
  
  const result = Array.from(synonyms).slice(0, 8); // Cap at 8 variants
  console.log(`[PriceSynonyms] "${query}" → ${result.length} variants: ${result.join(', ')}`);
  return result;
}

// ============================================================
// CATEGORY SYNONYMS — generate search variants via micro-LLM
// ============================================================

async function generateCategorySynonyms(
  category: string,
  settings: CachedSettings | null
): Promise<string[]> {
  const fallbackVariants = generatePriceSynonyms(category);
  
  try {
    // Determine provider/key for micro-LLM (same logic as classifyProductName)
    const classifierProvider = settings?.classifier_provider || 'auto';
    const classifierModel = settings?.classifier_model || 'gemini-2.5-flash-lite';
    
    let url: string;
    let apiKeys: string[];
    let model: string = classifierModel;

    if (classifierProvider === 'openrouter' || classifierProvider === 'auto') {
      if (settings?.openrouter_api_key) {
        url = 'https://openrouter.ai/api/v1/chat/completions';
        apiKeys = [settings.openrouter_api_key];
        if (!model.includes('/')) model = `google/${model}`;
      } else {
        console.log('[CategorySynonyms] No OpenRouter key, using fallback');
        return fallbackVariants;
      }
    } else {
      console.log('[CategorySynonyms] Unsupported provider, using fallback');
      return fallbackVariants;
    }

    const body = {
      model,
      messages: [
        {
          role: 'system',
          content: `Ты генератор поисковых вариантов для каталога электротоваров.
Тебе дают категорию товара. Сгенерируй 3-5 вариантов написания для поиска в каталоге.
Учитывай:
- Сокращения числительных: двухместная→2-местная, трёхфазный→3-фазный, двойная→2-я
- Синонимы: розетка двойная = розетка двухместная = розетка 2-местная
- Перестановки слов: "розетка накладная" = "накладная розетка"
- Технические обозначения: если есть

Ответь СТРОГО JSON-массивом строк, без пояснений.
Пример: ["2-местная розетка", "розетка двойная", "розетка 2 поста"]`
        },
        { role: 'user', content: category }
      ],
      ...DETERMINISTIC_SAMPLING,
      max_tokens: 150,
    };
    console.log(`[CategorySynonyms] Sampling: top_k=1 seed=42 provider=google-ai-studio`);

    const fetchPromise = callAIWithKeyFallback(url, apiKeys, body, 'CategorySynonyms');
    const timeoutPromise = new Promise<Response>((_, reject) =>
      setTimeout(() => reject(new DOMException('Timeout', 'AbortError')), 4000)
    );

    const response = await Promise.race([fetchPromise, timeoutPromise]);
    if (!response.ok) {
      console.log(`[CategorySynonyms] API error ${response.status}, using fallback`);
      return fallbackVariants;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      console.log('[CategorySynonyms] Empty response, using fallback');
      return fallbackVariants;
    }

    const jsonStr = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(jsonStr);

    if (!Array.isArray(parsed) || parsed.length === 0) {
      console.log('[CategorySynonyms] Invalid JSON array, using fallback');
      return fallbackVariants;
    }

    // Combine: original category + LLM variants + fallback variants (deduplicated)
    const allVariants = new Set<string>();
    allVariants.add(category);
    for (const v of parsed) {
      if (typeof v === 'string' && v.trim().length >= 2) {
        allVariants.add(v.trim());
      }
    }
    for (const v of fallbackVariants) {
      allVariants.add(v);
    }

    const result = Array.from(allVariants).slice(0, 8);
    console.log(`[CategorySynonyms] "${category}" → ${result.length} variants: ${result.join(', ')}`);
    return result;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      console.log(`[CategorySynonyms] Timeout (4s), using fallback`);
    } else {
      console.error('[CategorySynonyms] Error:', e, ', using fallback');
    }
    return fallbackVariants;
  }
}

/**
 * DEPRECATED: detectPendingPriceIntent is replaced by dialog slots.
 * Kept as ultimate fallback when no slots are provided (e.g. old embed.js).
 */
function detectPendingPriceIntent(
  history: Array<{ role: string; content: string }>
): { priceIntent: 'most_expensive' | 'cheapest'; category: string } | null {
  const recent = history.slice(-6);
  
  for (let i = recent.length - 1; i >= 0; i--) {
    const msg = recent[i];
    if (msg.role !== 'assistant') continue;
    
    const content = typeof msg.content === 'string' ? msg.content : '';
    
    // Strict regex: only capture text inside quotes «...» or "..."
    const clarifyMatch = content.match(/категории\s+[«"]([^»"]+)[»"]\s+(?:найден[оа]?|представлен[оа]?|есть|у нас)\s+(\d+)\s+товар/i);
    const priceMatch = content.match(/сам(?:ый|ое|ую|ая)\s+(дорог|дешёв|бюджетн)/i);
    
    if (clarifyMatch || priceMatch) {
      const isDorogo = /дорог|дороже|дорогостоящ/i.test(content);
      const isDeshevo = /дешёв|дешевл|бюджетн|недорог/i.test(content);
      
      const priceIntent: 'most_expensive' | 'cheapest' = isDorogo ? 'most_expensive' : isDeshevo ? 'cheapest' : 'most_expensive';
      const category = clarifyMatch ? clarifyMatch[1].trim() : '';
      
      if (category || priceMatch) {
        console.log(`[PendingPrice] Detected pending price intent from history: ${priceIntent}, category="${category}"`);
        return { priceIntent, category };
      }
    }
  }
  
  return null;
}

// ============================================================
// DIALOG SLOTS — structured intent memory across turns
// ============================================================

interface DialogSlot {
  intent: 'price_extreme' | 'product_search' | 'category_disambiguation';
  price_dir?: 'most_expensive' | 'cheapest';
  base_category: string;
  refinement?: string;
  status: 'pending' | 'done';
  created_turn: number;
  turns_since_touched: number;
  // product_search filter state (replaces cached_products)
  resolved_filters?: string;   // JSON: {"razem":"2"}
  unresolved_query?: string;   // accumulated text query: "черная"
  plural_category?: string;    // "розетки" (API category param)
  // category_disambiguation state (Plan V7)
  candidate_options?: string;  // JSON: [{"label":"Бытовые","value":"Бытовые","pagetitle":"Розетки"}, ...]
  pending_modifiers?: string;  // saved modifiers from original query: "черные двухместные"
  pending_filters?: string;    // JSON: {"cvet":"чёрный"} — pre-resolved from original query
  original_query?: string;     // user's original message before disambiguation
  // replacement metadata
  isReplacement?: boolean;
  originalName?: string;
}

type DialogSlots = Record<string, DialogSlot>;

const MAX_SLOTS = 3;
const SLOT_FIELD_MAX_LEN = 200;
const SLOT_TIMEOUT_TURNS = 4;

function validateAndSanitizeSlots(raw: unknown): DialogSlots {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  
  const slots: DialogSlots = {};
  let count = 0;
  
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_SLOTS) break;
    if (!val || typeof val !== 'object') continue;
    
    const s = val as Record<string, unknown>;
    
    // Validate intent
    if (s.intent !== 'price_extreme' && s.intent !== 'product_search' && s.intent !== 'category_disambiguation') continue;
    // Validate status
    if (s.status !== 'pending' && s.status !== 'done') continue;
    // Validate base_category
    if (typeof s.base_category !== 'string' || s.base_category.length === 0) continue;

    // Sanitize string fields
    const sanitize = (v: unknown): string => {
      if (typeof v !== 'string') return '';
      return v.replace(/<[^>]*>/g, '').replace(/['"`;\\]/g, '').substring(0, SLOT_FIELD_MAX_LEN).trim();
    };

    slots[key.substring(0, 20)] = {
      intent: s.intent as 'price_extreme' | 'product_search' | 'category_disambiguation',
      price_dir: (s.price_dir === 'most_expensive' || s.price_dir === 'cheapest') ? s.price_dir : undefined,
      base_category: sanitize(s.base_category),
      refinement: s.refinement ? sanitize(s.refinement) : undefined,
      status: s.status as 'pending' | 'done',
      created_turn: typeof s.created_turn === 'number' ? s.created_turn : 0,
      turns_since_touched: typeof s.turns_since_touched === 'number' ? s.turns_since_touched : 0,
      resolved_filters: typeof s.resolved_filters === 'string' ? s.resolved_filters.substring(0, 2000) : undefined,
      unresolved_query: typeof s.unresolved_query === 'string' ? sanitize(s.unresolved_query) : undefined,
      plural_category: typeof s.plural_category === 'string' ? sanitize(s.plural_category) : undefined,
      candidate_options: typeof s.candidate_options === 'string' ? s.candidate_options.substring(0, 2000) : undefined,
      pending_modifiers: typeof s.pending_modifiers === 'string' ? sanitize(s.pending_modifiers) : undefined,
      pending_filters: typeof s.pending_filters === 'string' ? s.pending_filters.substring(0, 2000) : undefined,
      original_query: typeof s.original_query === 'string' ? sanitize(s.original_query) : undefined,
    };
    count++;
  }
  
  return slots;
}

// filterCachedProducts removed — now we re-query API with accumulated filters instead

/**
 * Resolve dialog slots against current user message.
 * Returns: { resolved slot key, combined query, price intent } or null.
 * For product_search slots: returns searchParams for API re-query with accumulated filters.
 */
function resolveSlotRefinement(
  slots: DialogSlots,
  userMessage: string,
  classificationResult: ClassificationResult | null
): { slotKey: string; query: string; priceIntent: 'most_expensive' | 'cheapest'; updatedSlots: DialogSlots } 
 | { slotKey: string; searchParams: { category: string; resolvedFilters: Record<string, string>; refinementText: string; refinementModifiers: string[]; existingUnresolved: string; baseCategory: string }; updatedSlots: DialogSlots }
 | { slotKey: string; disambiguation: { chosenLabel: string; chosenValue: string; chosenPagetitle: string; pendingModifiers: string[]; pendingFilters: Record<string, string>; originalQuery: string; baseCategory: string }; updatedSlots: DialogSlots }
 | null {
  // Plan V7 — category_disambiguation slot resolution.
  // If user replies with one of the offered options (chip click sends value
  // exactly; free-text reply may match label/value/pagetitle case-insensitively),
  // resolve it to the chosen pagetitle and surface the saved modifiers/filters.
  const normCmp = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9]/g, '');
  const userNorm = normCmp(userMessage);
  for (const [key, slot] of Object.entries(slots)) {
    if (slot.status !== 'pending' || slot.intent !== 'category_disambiguation') continue;
    if (!slot.candidate_options) continue;
    let options: Array<{ label: string; value: string; pagetitle?: string }> = [];
    try {
      const parsed = JSON.parse(slot.candidate_options);
      if (Array.isArray(parsed)) options = parsed;
    } catch {
      console.log(`[Slots] category_disambiguation "${key}": malformed candidate_options, skipping`);
      continue;
    }
    if (options.length === 0) continue;

    // Try exact match on value first (chip click), then label, then pagetitle, then substring.
    let chosen = options.find(o => normCmp(o.value) === userNorm)
      || options.find(o => normCmp(o.label) === userNorm)
      || options.find(o => o.pagetitle && normCmp(o.pagetitle) === userNorm);
    if (!chosen && userMessage.length < 60) {
      // Short free-text reply — match by inclusion (e.g. user typed "бытовые" while option is "Бытовые розетки")
      chosen = options.find(o => normCmp(o.label).includes(userNorm) && userNorm.length >= 4)
        || options.find(o => normCmp(o.value).includes(userNorm) && userNorm.length >= 4);
    }
    if (!chosen) {
      console.log(`[Slots] category_disambiguation "${key}": user reply "${userMessage.slice(0, 50)}" doesn't match options=${JSON.stringify(options.map(o => o.label))}, falling through`);
      continue;
    }

    const pendingModifiers = slot.pending_modifiers
      ? slot.pending_modifiers.split(/\s+/).map(s => s.trim()).filter(Boolean)
      : [];
    let pendingFilters: Record<string, string> = {};
    if (slot.pending_filters) {
      try {
        const pf = JSON.parse(slot.pending_filters);
        if (pf && typeof pf === 'object' && !Array.isArray(pf)) {
          for (const [k, v] of Object.entries(pf)) {
            if (typeof v === 'string') pendingFilters[k] = v;
          }
        }
      } catch {
        console.log(`[Slots] category_disambiguation "${key}": malformed pending_filters, ignoring`);
      }
    }

    const updatedSlots = { ...slots };
    updatedSlots[key] = { ...slot, status: 'done', turns_since_touched: 0, refinement: chosen.label };
    console.log(`[Slots] category_disambiguation "${key}" RESOLVED: chosen="${chosen.label}" (pagetitle="${chosen.pagetitle || chosen.value}"), pendingMods=${JSON.stringify(pendingModifiers)}, pendingFilters=${JSON.stringify(pendingFilters)}`);

    return {
      slotKey: key,
      disambiguation: {
        chosenLabel: chosen.label,
        chosenValue: chosen.value,
        chosenPagetitle: chosen.pagetitle || chosen.value,
        pendingModifiers,
        pendingFilters,
        originalQuery: slot.original_query || slot.base_category || '',
        baseCategory: slot.base_category,
      },
      updatedSlots,
    };
  }

  // First: check for pending product_search slot with filter state.
  // GATE PHILOSOPHY: trust Micro-LLM as primary source of truth. Slot branch is ONLY
  // for genuine short follow-ups ("а подешевле?", "а белая есть?"). Any signal that
  // looks like a fresh, fully-formed search must fall through to the main pipeline.
  const normWord = (s: string) => s.replace(/ё/g, 'е').toLowerCase().replace(/[^а-яa-z0-9]/g, '');
  const stem4 = (s: string) => { const t = normWord(s); return t.length >= 4 ? t.slice(0, 4) : t; };

  for (const [key, slot] of Object.entries(slots)) {
    if (slot.status === 'pending' && slot.intent === 'product_search' && slot.plural_category) {
      const isShort = userMessage.length < 100;
      const hasNewCategory = !!(classificationResult?.product_category 
        && classificationResult.product_category !== slot.base_category);

      // Build stem set of everything already known to slot (filters + unresolved)
      const existingFilters = slot.resolved_filters ? JSON.parse(slot.resolved_filters) : {};
      const knownStems = new Set<string>();
      for (const v of Object.values(existingFilters)) {
        const ru = String(v).split('//')[0].toLowerCase().replace(/ё/g, 'е');
        for (const w of ru.split(/\s+/)) { const s = stem4(w); if (s.length >= 4) knownStems.add(s); }
      }
      for (const w of (slot.unresolved_query || '').split(/\s+/)) {
        const s = stem4(w); if (s.length >= 4) knownStems.add(s);
      }

      // Detect "new modifiers" — modifiers from classifier whose stems are NOT in slot state.
      // If user introduces brand-new attributes, that's a fresh search, not a follow-up.
      const classifierMods = classificationResult?.search_modifiers || [];
      const newMods = classifierMods.filter(m => {
        const s = stem4(m);
        return s.length >= 4 && !knownStems.has(s);
      });
      const hasNewModifiers = newMods.length > 0;

      // Treat as fresh search if classifier flagged a complete product expression
      // (has_product_name=true) WITH any new modifier — i.e. user typed full new query.
      const looksLikeFreshSearch = !!classificationResult?.has_product_name && hasNewModifiers;

      // Bypass slot if any of these hold
      const shouldBypass = !isShort || hasNewCategory || hasNewModifiers || looksLikeFreshSearch;

      if (shouldBypass) {
        console.log(`[Slots] BYPASS product_search slot "${key}": isShort=${isShort}, hasNewCategory=${hasNewCategory}, hasNewModifiers=${hasNewModifiers} (newMods=${JSON.stringify(newMods)}), looksLikeFreshSearch=${looksLikeFreshSearch} → routing to main pipeline`);
        continue;
      }

      console.log(`[Slots] product_search slot resolved: refinementText="${userMessage}", existingUnresolved="${slot.unresolved_query || ''}", filters=${JSON.stringify(existingFilters)}`);

      const updatedSlots = { ...slots };
      updatedSlots[key] = { ...slot, refinement: userMessage.trim(), status: 'done', turns_since_touched: 0 };

      return {
        slotKey: key,
        searchParams: {
          category: slot.plural_category,
          resolvedFilters: existingFilters,
          refinementText: userMessage.trim(),
          refinementModifiers: classifierMods.length ? classifierMods : [userMessage.trim()],
          existingUnresolved: slot.unresolved_query || '',
          baseCategory: slot.base_category,
        },
        updatedSlots,
      };
    }
  }

  // Then: check for pending price_extreme slot
  let pendingKey: string | null = null;
  let pendingSlot: DialogSlot | null = null;
  
  for (const [key, slot] of Object.entries(slots)) {
    if (slot.status === 'pending' && slot.intent === 'price_extreme' && slot.price_dir) {
      pendingKey = key;
      pendingSlot = slot;
      break;
    }
  }
  
  if (!pendingKey || !pendingSlot) return null;
  
  // Check if user message is a refinement (short, no explicit new price intent)
  const isShort = userMessage.length < 80;
  const hasNewPriceIntent = classificationResult?.price_intent != null 
    && (classificationResult.price_intent as string) !== 'none';
  
  // If classifier found a new price_intent with a different category, it's a new request
  if (hasNewPriceIntent && classificationResult?.product_category && 
      classificationResult.product_category !== pendingSlot.base_category) {
    return null;
  }
  
  // If message is short and no new price intent → treat as refinement
  if (isShort && !hasNewPriceIntent) {
    // Use LLM classifier's extracted category/product_name as the clean refinement
    // This lets the LLM strip conversational filler ("давай", "ладно", etc.) naturally
    const refinement = classificationResult?.product_category 
      || classificationResult?.product_name 
      || userMessage.trim();
    const combinedQuery = `${refinement} ${pendingSlot.base_category}`.trim();
    
    const updatedSlots = { ...slots };
    updatedSlots[pendingKey] = {
      ...pendingSlot,
      refinement,
      turns_since_touched: 0,
    };
    
    console.log(`[Slots] Resolved refinement: "${refinement}" + base "${pendingSlot.base_category}" → "${combinedQuery}", dir=${pendingSlot.price_dir}`);
    
    return {
      slotKey: pendingKey,
      query: combinedQuery,
      priceIntent: pendingSlot.price_dir!,
      updatedSlots,
    };
  }
  
  return null;
}

/**
 * Age all pending slots by 1 turn. Auto-close expired ones.
 */
function ageSlots(slots: DialogSlots): DialogSlots {
  const updated: DialogSlots = {};
  for (const [key, slot] of Object.entries(slots)) {
    if (slot.status === 'done') continue; // drop done slots
    const aged = { ...slot, turns_since_touched: slot.turns_since_touched + 1 };
    if (aged.turns_since_touched >= SLOT_TIMEOUT_TURNS) {
      console.log(`[Slots] Auto-closing slot "${key}" after ${SLOT_TIMEOUT_TURNS} turns without interaction`);
      continue; // drop expired slot
    }
    updated[key] = aged;
  }
  return updated;
}

async function handlePriceIntent(
  queries: string[],
  priceIntent: 'most_expensive' | 'cheapest',
  apiToken: string
): Promise<PriceIntentResult> {
  const overallStart = Date.now();
  
  // Step 1: Probe with first query to get total count
  const primaryQuery = queries[0];
  try {
    const probeParams = new URLSearchParams();
    probeParams.append('query', primaryQuery);
    probeParams.append('per_page', '1');
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    
    const probeResponse = await fetch(`${VOLT220_API_URL}?${probeParams}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    
    if (!probeResponse.ok) {
      console.error(`[PriceIntent] Probe API error: ${probeResponse.status}`);
      return { action: 'not_found' };
    }
    
    const probeRaw = await probeResponse.json();
    const probeData = probeRaw.data || probeRaw;
    const total = probeData.pagination?.total || 0;
    const probeElapsed = Date.now() - overallStart;
    console.log(`[PriceIntent] Probe: query="${primaryQuery}", total=${total}, ${probeElapsed}ms`);
    
    if (total === 0) {
      // Try other queries before giving up
      for (const altQuery of queries.slice(1, 4)) {
        const altParams = new URLSearchParams();
        altParams.append('query', altQuery);
        altParams.append('per_page', '1');
        const altCtrl = new AbortController();
        const altTimeout = setTimeout(() => altCtrl.abort(), 8000);
        try {
          const altResp = await fetch(`${VOLT220_API_URL}?${altParams}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
            signal: altCtrl.signal,
          });
          clearTimeout(altTimeout);
          if (altResp.ok) {
            const altRaw = await altResp.json();
            const altTotal = (altRaw.data || altRaw).pagination?.total || 0;
            if (altTotal > 0 && altTotal <= 50) {
              console.log(`[PriceIntent] Alt query "${altQuery}" found ${altTotal} products`);
              // Use this query instead
              queries = [altQuery, ...queries.filter(q => q !== altQuery)];
              break;
            } else if (altTotal > 50) {
              return { action: 'clarify', total: altTotal, category: primaryQuery };
            }
          }
        } catch { clearTimeout(altTimeout); }
      }
    }
    
    // Step 2: Decision — fetch all or ask to clarify
    if (total > 0 && total <= 50) {
      // Multi-candidate fetch: search up to 4 query variants in parallel, merge & dedup
      const fetchStart = Date.now();
      const searchQueries = queries.slice(0, 4);
      const candidates: SearchCandidate[] = searchQueries.map(q => ({
        query: q, brand: null, category: null, min_price: null, max_price: null
      }));
      
      const fetchPromises = candidates.map(c => searchProductsByCandidate(c, apiToken, 50));
      const fetchResults = await Promise.all(fetchPromises);
      
      // Merge and deduplicate
      const productMap = new Map<number, Product>();
      for (const products of fetchResults) {
        for (const product of products) {
          if (!productMap.has(product.id)) {
            productMap.set(product.id, product);
          }
        }
      }
      
      const allProducts = Array.from(productMap.values());
      const fetchElapsed = Date.now() - fetchStart;
      console.log(`[PriceIntent] Multi-fetch: ${allProducts.length} unique products from ${searchQueries.length} queries in ${fetchElapsed}ms`);
      
      // Filter zero-price and sort by price intent
      const priced = allProducts.filter(p => p.price > 0);
      const list = priced.length > 0 ? priced : allProducts;
      
      list.sort((a, b) => {
        if (priceIntent === 'most_expensive') return b.price - a.price;
        return a.price - b.price;
      });
      
      const totalElapsed = Date.now() - overallStart;
      console.log(`[PriceIntent] Answer ready: ${list.length} products sorted by ${priceIntent}, total time ${totalElapsed}ms`);
      
      return { action: 'answer', products: list.slice(0, 10), total: list.length };
    } else if (total > 50) {
      console.log(`[PriceIntent] Too many products (${total}), requesting clarification`);
      return { action: 'clarify', total, category: primaryQuery };
    } else {
      // total === 0 and no alt queries found anything
      return { action: 'not_found' };
    }
  } catch (error) {
    console.error(`[PriceIntent] Error:`, error);
    
    // Retry once with simplified query on timeout
    if (error instanceof DOMException && error.name === 'AbortError' && queries.length > 0) {
      console.log(`[PriceIntent] Timeout on multi-query, retrying with simplified query: "${queries[0]}"`);
      try {
        const retryParams = new URLSearchParams();
        retryParams.append('query', queries[0]);
        retryParams.append('per_page', '50');
        
        const retryCtrl = new AbortController();
        const retryTimeout = setTimeout(() => retryCtrl.abort(), 15000);
        
        const retryResp = await fetch(`${VOLT220_API_URL}?${retryParams}`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
          signal: retryCtrl.signal,
        });
        clearTimeout(retryTimeout);
        
        if (retryResp.ok) {
          const retryRaw = await retryResp.json();
          const retryData = retryRaw.data || retryRaw;
          const retryProducts: Product[] = (retryData.results || []).filter((p: Product) => p.price > 0);
          
          if (retryProducts.length > 0) {
            retryProducts.sort((a, b) => priceIntent === 'most_expensive' ? b.price - a.price : a.price - b.price);
            console.log(`[PriceIntent] Retry SUCCESS: ${retryProducts.length} products sorted by ${priceIntent}`);
            return { action: 'answer', products: retryProducts.slice(0, 10), total: retryProducts.length };
          }
        }
      } catch (retryErr) {
        console.error(`[PriceIntent] Retry also failed:`, retryErr);
      }
    }
    
    return { action: 'not_found' };
  }
}

// ============================================================
// TITLE SCORING — compute how well a product matches a query
// ============================================================

/**
 * Extract meaningful tokens from text for scoring.
 * Splits on spaces/punctuation, lowercases, removes short words.
 */
function extractTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);
}

/**
 * Extract technical specs from text: numbers with units (18Вт, 6500К, 230В, 7Вт, 4000К)
 * and model codes (T8, G9, G13, E27, MR16, A60)
 */
function extractSpecs(text: string): string[] {
  const specs: string[] = [];
  // Numbers with units: 18Вт, 6500К, 230В, 12В, 2.5мм
  const unitPattern = /(\d+(?:[.,]\d+)?)\s*(вт|вт\b|w|к|k|в|v|мм|mm|а|a|м|m|квт|kw)/gi;
  let m;
  while ((m = unitPattern.exec(text)) !== null) {
    specs.push((m[1] + m[2]).toLowerCase().replace(',', '.'));
  }
  // Model codes: T8, G9, G13, E27, E14, MR16, A60, GU10, GU5.3
  const codePattern = /\b([TGEAM][URN]?\d{1,3}(?:\.\d)?)\b/gi;
  while ((m = codePattern.exec(text)) !== null) {
    specs.push(m[1].toUpperCase());
  }
  return specs;
}

/**
 * Domain penalty: detects mismatch between user intent (power vs telecom sockets).
 * Returns a penalty value (0, 15, or 30) to subtract from the product score.
 */
const TELECOM_KEYWORDS = ['rj11', 'rj12', 'rj45', 'rj-11', 'rj-12', 'rj-45', 'телефон', 'компьютер', 'интернет', 'lan', 'data', 'ethernet', 'cat5', 'cat6', 'utp', 'ftp'];

function domainPenalty(product: Product, userQuery: string): number {
  const queryLower = userQuery.toLowerCase();
  const titleLower = product.pagetitle.toLowerCase();
  const categoryLower = (product.category?.pagetitle || '').toLowerCase();
  const combined = titleLower + ' ' + categoryLower;
  
  const isSocketQuery = /розетк/i.test(queryLower);
  if (!isSocketQuery) return 0;
  
  const userWantsTelecom = TELECOM_KEYWORDS.some(kw => queryLower.includes(kw));
  const productIsTelecom = TELECOM_KEYWORDS.some(kw => combined.includes(kw));
  
  if (!userWantsTelecom && productIsTelecom) return 30;
  if (userWantsTelecom && !productIsTelecom) return 15;
  
  return 0;
}

/**
 * Score a product against a user query.
 * Returns 0-100. Higher = better match.
 * 
 * Components:
 * - Token overlap (words from query found in product title): 0-50
 * - Spec match (technical specs like 18Вт, 6500К, T8): 0-30
 * - Brand match: 0-20
 * - Domain penalty: 0 to -30
 */
function scoreProductMatch(product: Product, queryTokens: string[], querySpecs: string[], queryBrand?: string, userQuery?: string): number {
  const titleTokens = extractTokens(product.pagetitle);
  const titleText = product.pagetitle.toLowerCase();
  
  // 1. Token overlap score (0-50)
  let matchedTokens = 0;
  for (const qt of queryTokens) {
    if (titleText.includes(qt) || titleTokens.some(tt => tt.includes(qt) || qt.includes(tt))) {
      matchedTokens++;
    }
  }
  const tokenScore = queryTokens.length > 0 
    ? Math.min(50, (matchedTokens / queryTokens.length) * 50) 
    : 0;
  
  // 2. Spec match score (0-30)
  let matchedSpecs = 0;
  const titleSpecs = extractSpecs(product.pagetitle);
  const optionValues = (product.options || []).map(o => o.value.toLowerCase()).join(' ');
  for (const qs of querySpecs) {
    if (titleSpecs.some(ts => ts === qs) || titleText.includes(qs.toLowerCase()) || optionValues.includes(qs.toLowerCase())) {
      matchedSpecs++;
    }
  }
  const specScore = querySpecs.length > 0 
    ? Math.min(30, (matchedSpecs / querySpecs.length) * 30) 
    : 0;
  
  // 3. Brand match (0-20)
  let brandScore = 0;
  if (queryBrand) {
    const qb = queryBrand.toLowerCase();
    const productBrand = (product.vendor || '').toLowerCase();
    const brandOption = product.options?.find(o => o.key === 'brend__brend');
    const optBrand = brandOption ? brandOption.value.split('//')[0].trim().toLowerCase() : '';
    if (productBrand.includes(qb) || optBrand.includes(qb) || qb.includes(productBrand) || qb.includes(optBrand)) {
      brandScore = 20;
    }
  }
  
  // 4. Domain penalty
  const penalty = userQuery ? domainPenalty(product, userQuery) : 0;
  
  return Math.max(0, Math.round(tokenScore + specScore + brandScore - penalty));
}

/**
 * Rerank products by title-score relevance to query.
 * Returns products sorted by score descending.
 */
function rerankProducts(
  products: Product[],
  userQuery: string,
  allowedPagetitles?: Set<string>
): Product[] {
  const queryTokens = extractTokens(userQuery);
  const querySpecs = extractSpecs(userQuery);

  // Domain guard (Plan V4): if the caller knows which categories are relevant for this
  // query (from CategoryMatcher), drop products from any other category before scoring.
  // Prevents black gloves / clamps from polluting "чёрные розетки" results just because
  // their title shares a token. When set is missing or empty — no filter is applied.
  let pool = products;
  if (allowedPagetitles && allowedPagetitles.size > 0) {
    const before = pool.length;
    const dropped: string[] = [];
    pool = pool.filter(p => {
      const cat = (p as any).category?.pagetitle || (p as any).parent_name || '';
      if (allowedPagetitles.has(cat)) return true;
      if (dropped.length < 5) dropped.push(`"${p.pagetitle.substring(0, 40)}" [${cat}]`);
      return false;
    });
    if (before !== pool.length) {
      console.log(`[DomainGuard] dropped ${before - pool.length}/${before} items from non-allowed categories. Sample: ${dropped.join(' | ')}`);
    }
  }

  const scored = pool.map(p => ({
    product: p,
    score: scoreProductMatch(p, queryTokens, querySpecs, undefined, userQuery),
  }));

  scored.sort((a, b) => b.score - a.score);

  if (scored.length > 0) {
    console.log(`[Rerank] Top scores: ${scored.slice(0, 5).map(s => `${s.score}:"${s.product.pagetitle.substring(0, 40)}"`).join(', ')}`);
  }

  return scored.map(s => s.product);
}


function hasGoodMatch(products: Product[], userQuery: string, threshold: number = 35): boolean {
  const queryTokens = extractTokens(userQuery);
  const querySpecs = extractSpecs(userQuery);
  
  for (const p of products) {
    const score = scoreProductMatch(p, queryTokens, querySpecs);
    if (score >= threshold) {
      console.log(`[TitleScore] Good match (${score}≥${threshold}): "${p.pagetitle.substring(0, 60)}"`);
      return true;
    }
  }
  return false;
}

/**
 * Clean user message for direct name search.
 * Removes question words, punctuation, and conversational fluff.
 */
function cleanQueryForDirectSearch(message: string): string {
  return message
    .replace(/\b(есть|в наличии|наличии|сколько стоит|цена|купить|заказать|хочу|нужен|нужна|нужно|подскажите|покажите|найдите|ищу|покажи|найди|подбери|посоветуйте|пожалуйста|можно|мне|какой|какая|какие|подойдет|подойдут)\b/gi, '')
    .replace(/[?!.,;:]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generate a shortened version of the query for broader matching.
 * Keeps brand, model codes, and key product nouns. Drops specs.
 */
function shortenQuery(cleanedQuery: string): string {
  // Remove numeric specs (18Вт, 6500К, 230В) but keep model codes (T8, G9)
  const shortened = cleanedQuery
    .replace(/\d+(?:[.,]\d+)?\s*(?:вт|w|к|k|в|v|мм|mm|а|a|м|m|квт|kw)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  // If too short after stripping, return original
  return shortened.length >= 4 ? shortened : cleanedQuery;
}


/**
 * Извлекает последнюю упомянутую товарную категорию из conversationHistory.
 * Эвристика: ищем в последних 8 репликах ключевые товарные корни.
 * Возвращает корень-маркер (например "розетк") или null.
 */
function extractCategoryFromHistory(history: Array<{ role: string; content: string }>): string | null {
  if (!history || history.length === 0) return null;
  const productRoots = [
    'розетк', 'выключател', 'светильник', 'лампа', 'лампочк', 'кабель', 'провод',
    'автомат', 'щиток', 'щит', 'бокс', 'удлинитель', 'колодк', 'дрель', 'перфоратор',
    'болгарк', 'ушм', 'отвертк', 'отвёртк', 'стабилизатор', 'счётчик', 'счетчик',
    'трансформатор', 'рубильник', 'диммер', 'датчик', 'звонок', 'патрон', 'клемм',
    'гофр', 'короб', 'прожектор', 'фонарь', 'термостат', 'реле', 'узо',
    'дифавтомат', 'вилка', 'разветвитель', 'таймер'
  ];
  for (let i = history.length - 1; i >= Math.max(0, history.length - 8); i--) {
    const msg = history[i];
    if (!msg?.content) continue;
    const lower = msg.content.toLowerCase();
    for (const root of productRoots) {
      if (lower.includes(root)) return root;
    }
  }
  return null;
}

// Генерация поисковых кандидатов через AI с учётом контекста разговора
async function generateSearchCandidates(
  message: string, 
  apiKeys: string[],
  conversationHistory: Array<{ role: string; content: string }> = [],
  aiUrl: string = 'https://openrouter.ai/api/v1/chat/completions',
  aiModel: string = 'meta-llama/llama-3.3-70b-instruct:free',
  classificationCategory?: string | null
): Promise<ExtractedIntent> {
  console.log(`[AI Candidates] Extracting search intent from: "${message}", classificationCategory: ${classificationCategory || 'none'}, model=${aiModel}`);
  
  // Two-factor followup detection (фикс slot-памяти):
  // Уточнение в рамках старого запроса = (a) последняя реплика бота содержала уточняющий вопрос
  // И (b) категория текущего запроса совпадает с категорией предыдущего товарного хода.
  // Только тогда оставляем историю — иначе intent-extractor теряет атрибуты («чёрная двухместная»).
  const lastAssistantMsg = [...conversationHistory].reverse().find(m => m.role === 'assistant')?.content || '';
  const looksLikeClarificationFollowup = 
    /\?|уточни|нужно ли|какой|какая|какие|для каких|с\s+каким|какого|какую|сколько/i.test(lastAssistantMsg.slice(-800));
  
  const previousCategory = extractCategoryFromHistory(conversationHistory);
  const prevCatLower = (previousCategory || '').toLowerCase().trim();
  const currCatLower = (classificationCategory || '').toLowerCase().trim();
  // Корни типа "розетк" должны матчиться к "розетка"/"розетки" — используем взаимный includes.
  const sameCategory = !!(prevCatLower && currCatLower && 
    (currCatLower.includes(prevCatLower) || prevCatLower.includes(currCatLower)));
  
  const isFollowup = looksLikeClarificationFollowup && sameCategory;
  const isNewProductQuery = !!classificationCategory && !isFollowup;
  
  const recentHistory = isNewProductQuery ? [] : conversationHistory.slice(-10);
  let historyContext = '';
  if (recentHistory.length > 0) {
    historyContext = `
КОНТЕКСТ РАЗГОВОРА (учитывай при генерации кандидатов!):
${recentHistory.map(m => `${m.role === 'user' ? 'Клиент' : 'Консультант'}: ${m.content.substring(0, 200)}`).join('\n')}

`;
  }
  
  if (isFollowup) {
    console.log(`[AI Candidates] Followup detected: lastAssistantQ=${looksLikeClarificationFollowup}, sameCategory=${sameCategory} (prev="${previousCategory}", curr="${classificationCategory}") → history KEPT (${recentHistory.length} msgs)`);
  } else if (isNewProductQuery) {
    console.log(`[AI Candidates] Context ISOLATED: new product query detected (category="${classificationCategory}", prevCategory="${previousCategory || 'none'}", lastAssistantQ=${looksLikeClarificationFollowup}), history pruned`);
  }
  
  const extractionPrompt = `Ты — система извлечения поисковых намерений для интернет-магазина электротоваров 220volt.kz. Твоя задача — превратить реплику пользователя в структурированный JSON-вызов через схему extract_search_intent.
${historyContext}
${recentHistory.length > 0 ? 'Анализируй текущее сообщение с учётом контекста разговора: уточняющие реплики и ценовые сравнения опираются на ранее обсуждавшийся товар.' : 'Анализируй текущее сообщение как самостоятельный запрос.'}

ОПРЕДЕЛЕНИЕ INTENT:
- "catalog" — пользователь ищет товар, оборудование, аксессуар, расходник, артикул, либо уточняет/сравнивает уже обсуждавшийся товар.
- "brands" — пользователь спрашивает, какие бренды/производители представлены.
- "info" — вопрос о компании, доставке, оплате, оферте, договоре, юридических данных, обязанностях сторон, возврате, гарантии.
- "general" — приветствие, шутка, нерелевантное; candidates пустые.

УТОЧНЯЮЩИЕ ОТВЕТЫ:
Если текущая реплика — короткое уточнение признака («для встраиваемой», «наружный», «на 12 модулей», «IP44»), восстанови основной товар из истории и сгенерируй полноценный набор кандидатов: основной товар + его синонимы. Уточнение помещай в option_filters. intent при этом всегда "catalog".

ЦЕНОВЫЕ СРАВНЕНИЯ:
Если пользователь говорит «дешевле/подешевле/бюджетнее» или «дороже/подороже/премиальнее» — найди в истории цену обсуждаемого товара и поставь max_price = цена − 1 либо min_price = цена + 1 соответственно. Восстанови основной товар как кандидатов. Если цены в истории нет — не выставляй min/max, ищи по названию.

АРТИКУЛЫ:
Артикул — непрерывный токен длиной от 4 символов из букв (латиница или кириллица), цифр, точек и дефисов, без пробелов внутри. Может быть числовым, буквенным или смешанным. Если пользователь упоминает такой токен в контексте «есть в наличии», «сколько стоит», «артикул», «арт.» — сгенерируй кандидата с полем "article" вместо "query" со значением токена ровно как написано. Не генерируй для него синонимов и не модифицируй значение.

ПАРАМЕТРЫ API КАТАЛОГА:
- query: текстовый поиск по названию и описанию. Включай модельные коды и ключевые числовые характеристики. Не передавай служебные слова («товары», «продукция»).
- article: точный поиск по артикулу.
- brand: фильтр по бренду. Передавай бренд в той форме, как написал пользователь (кириллица или латиница). Не транслитерируй и не «исправляй» — нормализацией занимается серверная сторона.
- category: в этой задаче не используй — категория управляется отдельным шагом.
- min_price / max_price: в тенге.

ФИЛЬТРЫ ПО ХАРАКТЕРИСТИКАМ (option_filters):
Любой описывающий признак товара, упомянутый пользователем, обязан попасть в option_filters. Описывающий признак — это всё, что отвечает на вопросы «какой?», «сколько?», «из чего?», «где работает?» применительно к самому товару:
- визуальные признаки (цвет, форма, материал, фактура);
- количественные (число элементов, постов, полюсов, модулей; размер; объём; мощность; длина; сечение; ток; напряжение);
- функциональные (тип монтажа, степень защиты, наличие/отсутствие функции);
- происхождение (страна, серия, бренд если не вынесен в brand).

Числительные-прилагательные («одинарный», «двойной», «двухместный», «трёхполюсный», «четырёхмодульный») — это количественная характеристика, а не часть названия товара. Их обязательно вынеси в option_filters, не оставляй в query.

Ключ option_filters — краткое русское название признака без пробелов (через подчёркивание). Значение — то, что сказал пользователь, в нормальной форме. Ключи не обязаны совпадать с API: серверная сторона сопоставит их со схемой категории.
Если признак стоит в запросе — пользователь хочет именно его. Не отбрасывай его как «украшение» к названию. Если пользователь не назвал признак — не выдумывай.

КОНТЕКСТ ИСПОЛЬЗОВАНИЯ (usage_context):
Если пользователь описывает не сам товар, а место или условия его применения («для улицы», «в баню», «на производство», «в детскую») — заполни usage_context описанием контекста и одновременно выведи в option_filters предполагаемые технические характеристики, которые этому контексту соответствуют (степень защиты, климатическое исполнение и т.п.). Если пользователь сам назвал конкретную характеристику (IP65, IK10) — это не контекст, а признак: ставь только в option_filters, usage_context оставь пустым.

ИЕРАРХИЯ КАНДИДАТОВ:
1. Первый кандидат — основной товар: то родовое или каталожное имя, которым этот предмет называют в магазине.
2. Остальные кандидаты — основной товар плюс характеристика, либо альтернативные имена того же товара (разговорное / техническое / каталожное). Подумай, как этот предмет может быть записан в каталоге электротоваров: по разговорному имени, по техническому термину, по альтернативному названию.
3. Никогда не делай кандидатом одну характеристику, место или контекст без основного товара.
4. option_filters применяются ко всем кандидатам.

ПОЛНОЕ НАЗВАНИЕ:
Если пользователь ввёл полное или почти полное название товара с модельными кодами и числовыми характеристиками — первый кандидат сохраняет максимально близкую к исходной формулировку (с кодами и числами); второй кандидат — укороченная версия без числовых спецификаций. Не дроби оригинал на слишком общие слова.

БРЕНДЫ:
- Если пользователь спрашивает только о бренде («есть Philips?», «покажи Makita») — используй только фильтр brand, без query.
- Если пользователь ищет товар конкретного бренда («дрель Bosch») — используй и query, и brand.
- Если пользователь спрашивает про бренд в контексте уже обсуждавшейся категории («а от Philips есть?») — сгенерируй минимум двух кандидатов: query=<категория из контекста> + brand=<бренд>, и brand=<бренд> без query (бренд может отсутствовать в этой категории, но быть в другой).

Текущее сообщение пользователя: "${message}"`;

  try {
    const response = await callAIWithKeyFallback(aiUrl, apiKeys, {
      model: aiModel,
      messages: [
        { role: 'system', content: extractionPrompt },
        { role: 'user', content: message }
      ],
      ...DETERMINISTIC_SAMPLING,
      reasoning: { exclude: true },
      tools: [
        {
          type: 'function',
          function: {
            name: 'extract_search_intent',
            description: 'Извлекает намерение и формирует параметры запроса к API каталога 220volt.kz/api/products',
            parameters: {
              type: 'object',
              properties: {
                intent: { 
                  type: 'string', 
                  enum: ['catalog', 'brands', 'info', 'general'],
                  description: 'Тип намерения'
                },
                candidates: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      query: { 
                        type: 'string',
                        nullable: true,
                        description: 'Параметр query для API: текстовый поиск (1-2 слова, технические термины). null если ищем только по бренду/категории'
                      },
                      brand: { 
                        type: 'string',
                        nullable: true,
                        description: 'Параметр options[brend__brend][]: точное название бренда ЛАТИНИЦЕЙ (Philips, Bosch, Makita). null если бренд не указан'
                      },
                      category: {
                        type: 'string', 
                        nullable: true,
                        description: 'НЕ ИСПОЛЬЗУЙ этот параметр! Всегда передавай null. Поиск по категории ненадёжен.'
                      },
                      min_price: {
                        type: 'number',
                        nullable: true,
                        description: 'Параметр min_price: минимальная цена в тенге. null если не указана'
                      },
                      max_price: {
                        type: 'number',
                        nullable: true,
                        description: 'Параметр max_price: максимальная цена в тенге. null если не указана'
                      },
                      option_filters: {
                        type: 'object',
                        nullable: true,
                        description: 'Фильтры по характеристикам товара. Ключ = краткое человекочитаемое название характеристики на русском (страна, цоколь, монтаж, защита, напряжение, длина, сечение, розетки и т.д.). Значение = значение характеристики. Система АВТОМАТИЧЕСКИ найдёт правильные ключи API. null если фильтры не нужны.',
                        additionalProperties: { type: 'string' }
                      }
                    },
                    additionalProperties: false
                  },
                  description: 'Массив вариантов запросов к API (3-6 штук с разными query-вариациями, включая СИНОНИМЫ названий товара)'
                },
                usage_context: {
                  type: 'string',
                  nullable: true,
                  description: 'Абстрактный контекст использования, когда пользователь НЕ указывает конкретную характеристику, а описывает МЕСТО или УСЛОВИЯ (для улицы, в ванную, для детской, на производство). null если пользователь указывает конкретные параметры или контекст не задан.'
                },
                english_queries: {
                  type: 'array',
                  items: { type: 'string' },
                  nullable: true,
                  description: 'Английские переводы поисковых терминов для каталога электротоваров. Переводи ТОЛЬКО названия товаров/категорий (существительные), НЕ переводи общие слова (купить, нужен, для улицы). Примеры: "кукуруза" → "corn", "свеча" → "candle", "груша" → "pear", "удлинитель" → "extension cord". null если все термины уже на английском или перевод не нужен.'
                }
              },
              required: ['intent', 'candidates'],
              additionalProperties: false
            }
          }
        }
      ],
      tool_choice: { type: 'function', function: { name: 'extract_search_intent' } },
    }, 'AI Candidates');

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[AI Candidates] API error: ${response.status}`, errorText);
      return fallbackParseQuery(message);
    }

    const data = await response.json();
    console.log(`[AI Candidates] Raw response:`, JSON.stringify(data, null, 2));

    // Assert: реально использованная модель должна совпадать с запрошенной.
    // Если OpenRouter переключил провайдера/модель — громко логируем (provider lock не должен это допускать).
    if (data?.model && data.model !== aiModel) {
      console.warn(`[AI Candidates] ⚠️ MODEL MISMATCH! requested=${aiModel}, used=${data.model}`);
    } else if (data?.model) {
      console.log(`[AI Candidates] ✓ Model lock OK: ${data.model}`);
    }

    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    if (toolCall?.function?.arguments) {
      const parsed = JSON.parse(toolCall.function.arguments);
      console.log(`[AI Candidates] Extracted:`, JSON.stringify(parsed, null, 2));

      // Сводный лог по извлечённым фильтрам — чтобы по логам сразу видеть, забрала ли модель цвет/количество мест/etc.
      const allFilters: Record<string, string> = {};
      for (const c of (parsed.candidates || [])) {
        if (c.option_filters && typeof c.option_filters === 'object') {
          for (const [k, v] of Object.entries(c.option_filters)) {
            allFilters[k] = String(v);
          }
        }
      }
      console.log(`[AI Candidates] Filters extracted: ${JSON.stringify(allFilters)} (model=${aiModel})`);
      
      const candidates = (parsed.candidates || []).map((c: any) => {
        let humanFilters: Record<string, string> | undefined;
        if (c.option_filters && typeof c.option_filters === 'object') {
          humanFilters = {};
          for (const [filterName, filterValue] of Object.entries(c.option_filters)) {
            humanFilters[filterName] = String(filterValue);
            console.log(`[AI Candidates] Human filter: ${filterName}=${filterValue}`);
          }
          if (Object.keys(humanFilters).length === 0) {
            humanFilters = undefined;
          }
        }
        
        return {
          query: c.query || null,
          brand: c.brand || null,
          category: c.category || null,
          min_price: c.min_price || null,
          max_price: c.max_price || null,
          option_filters: humanFilters,
        };
      });
      
      // SYSTEMIC: Always add broad candidates + original message terms
      const broadened = generateBroadCandidates(candidates, message);
      
      const usageContext = parsed.usage_context || undefined;
      if (usageContext) {
        console.log(`[AI Candidates] Usage context detected: "${usageContext}"`);
      }
      
      const englishQueries = parsed.english_queries || [];
      if (englishQueries.length > 0) {
        console.log(`[AI Candidates] English queries available for fallback: ${englishQueries.join(', ')}`);
      }
      
      // Safety net: для followup'а intent ВСЕГДА должен быть catalog (продолжение поиска товара).
      // Если LLM по ошибке вернул general/info — форсируем catalog.
      let finalIntent: 'catalog' | 'brands' | 'info' | 'general' = parsed.intent || 'general';
      if (isFollowup && finalIntent !== 'catalog') {
        console.log(`[AI Candidates] Followup safety-net: intent="${finalIntent}" → forced to "catalog"`);
        finalIntent = 'catalog';
      }
      
      return {
        intent: finalIntent,
        candidates: broadened,
        originalQuery: message,
        usage_context: usageContext,
        english_queries: englishQueries.length > 0 ? englishQueries : undefined,
      };
    }

    console.log(`[AI Candidates] No tool call found, using fallback`);
    return fallbackParseQuery(message);

  } catch (error) {
    console.error(`[AI Candidates] Error:`, error);
    return fallbackParseQuery(message);
  }
}

/**
 * SYSTEMIC BROAD CANDIDATE GENERATION v3
 */
function generateBroadCandidates(candidates: SearchCandidate[], originalMessage: string): SearchCandidate[] {
  const existingQueries = new Set(
    candidates.map(c => c.query?.toLowerCase().trim()).filter(Boolean)
  );
  
  const broadCandidates: SearchCandidate[] = [...candidates];
  
  // Collect human-readable option_filters from AI candidates
  const sharedOptionFilters = candidates.find(c => c.option_filters)?.option_filters;
  
  // === Layer 1: Strip AI candidates to shorter forms ===
  for (const candidate of candidates) {
    if (!candidate.query) continue;
    const query = candidate.query.trim();
    const words = query.split(/\s+/);
    if (words.length <= 1) continue;
    
    const firstWord = words[0];
    if (firstWord.length >= 3 && !existingQueries.has(firstWord.toLowerCase())) {
      existingQueries.add(firstWord.toLowerCase());
      broadCandidates.push({ query: firstWord, brand: candidate.brand, category: null, min_price: candidate.min_price, max_price: candidate.max_price, option_filters: candidate.option_filters });
      console.log(`[Broad L1] Added "${firstWord}" from "${query}"`);
    }
    
    if (words.length >= 3) {
      const twoWords = words.slice(0, 2).join(' ');
      if (!existingQueries.has(twoWords.toLowerCase())) {
        existingQueries.add(twoWords.toLowerCase());
        broadCandidates.push({ query: twoWords, brand: candidate.brand, category: null, min_price: candidate.min_price, max_price: candidate.max_price, option_filters: candidate.option_filters });
        console.log(`[Broad L1] Added "${twoWords}" from "${query}"`);
      }
    }
  }
  
  // === Layer 2: Extract product nouns from the ORIGINAL user message ===
  const stopWords = new Set([
    'подбери', 'покажи', 'найди', 'есть', 'нужен', 'нужна', 'нужно', 'хочу', 'дай', 'какие', 'какой', 'какая',
    'мне', 'для', 'под', 'над', 'при', 'без', 'или', 'что', 'как', 'где', 'все', 'вся', 'это',
    'пожалуйста', 'можно', 'будет', 'если', 'еще', 'уже', 'тоже', 'только', 'очень', 'самый',
    'цоколь', 'цоколем', 'мощность', 'мощностью', 'длина', 'длиной', 'ампер', 'метр', 'метров', 'ватт',
    'производства', 'производство', 'происхождения',
    'улица', 'улицы', 'улицу', 'улиц', 'баня', 'бани', 'баню', 'бань', 'ванная', 'ванной', 'ванну', 'ванную',
    'гараж', 'гаража', 'гаражу', 'детская', 'детской', 'детскую', 'кухня', 'кухни', 'кухню',
    'производство', 'подвал', 'подвала', 'двор', 'двора', 'сад', 'сада',
    'подойдут', 'подойдет', 'подходит', 'подходят', 'посоветуй', 'посоветуйте', 'порекомендуй',
  ]);
  
  const normalized = originalMessage.toLowerCase()
    .replace(/[-–—]/g, ' ')
    .replace(/[?!.,;:()«»""]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  // Propagate option_filters to all candidates
  if (sharedOptionFilters && Object.keys(sharedOptionFilters).length > 0) {
    for (const candidate of broadCandidates) {
      if (!candidate.option_filters) {
        candidate.option_filters = { ...sharedOptionFilters };
      } else {
        for (const [k, v] of Object.entries(sharedOptionFilters)) {
          if (!candidate.option_filters[k]) {
            candidate.option_filters[k] = v;
          }
        }
      }
    }
  }
  
  // Extract meaningful words
  const specPattern = /^[a-zA-Z]?\d+[а-яa-z]*$/;
  const adjectivePattern = /^(белорус|росси|кита|казахстан|туре|неме|итальян|польск|японск|накладн|встраив|подвесн|потолочн|настенн)/i;
  const msgWords = normalized.split(' ')
    .filter(w => w.length >= 3 && !stopWords.has(w) && !specPattern.test(w) && !adjectivePattern.test(w));
  
  const lemmatize = (word: string): string => {
    return word
      .replace(/(ку|чку|цу)$/, (m) => m === 'ку' ? 'ка' : m === 'чку' ? 'чка' : 'ца')
      .replace(/у$/, 'а')
      .replace(/ой$/, 'ый')
      .replace(/ей$/, 'ь')
      .replace(/ы$/, '')
      .replace(/и$/, 'ь');
  };
  
  const lemmatized = msgWords.map(lemmatize);
  const hasFilters = sharedOptionFilters && Object.keys(sharedOptionFilters).length > 0;
  
  if (lemmatized.length >= 2) {
    for (let i = 0; i < lemmatized.length - 1; i++) {
      const pair = `${lemmatized[i]} ${lemmatized[i + 1]}`;
      if (!existingQueries.has(pair)) {
        existingQueries.add(pair);
        broadCandidates.push({ query: pair, brand: null, category: null, min_price: null, max_price: null, option_filters: hasFilters ? { ...sharedOptionFilters } : undefined });
        console.log(`[Broad L2] Added pair "${pair}" from original message`);
      }
    }
  }
  
  for (const word of lemmatized) {
    if (word.length >= 3 && !existingQueries.has(word)) {
      existingQueries.add(word);
      broadCandidates.push({ query: word, brand: null, category: null, min_price: null, max_price: null, option_filters: hasFilters ? { ...sharedOptionFilters } : undefined });
      console.log(`[Broad L2] Added word "${word}" from original message`);
    }
  }
  
  console.log(`[Broad Candidates] ${candidates.length} original → ${broadCandidates.length} total candidates`);
  return broadCandidates;
}

/**
 * DYNAMIC OPTION KEY DISCOVERY
 */
function discoverOptionKeys(
  products: Product[], 
  humanFilters: Record<string, string>
): Record<string, string> {
  if (!humanFilters || Object.keys(humanFilters).length === 0) return {};
  
  const optionIndex: Map<string, { key: string; caption: string; values: Set<string> }> = new Map();
  
  for (const product of products) {
    if (!product.options) continue;
    for (const opt of product.options) {
      if (isExcludedOption(opt.key)) continue;
      if (!optionIndex.has(opt.key)) {
        optionIndex.set(opt.key, { key: opt.key, caption: opt.caption, values: new Set() });
      }
      optionIndex.get(opt.key)!.values.add(opt.value);
    }
  }
  
  const resolved: Record<string, string> = {};
  
  for (const [humanKey, humanValue] of Object.entries(humanFilters)) {
    const normalizedKey = humanKey.toLowerCase().replace(/[_\s]+/g, '');
    const normalizedValue = humanValue.toLowerCase().trim();
    
    let bestMatch: { apiKey: string; matchedValue: string; score: number } | null = null;
    
    for (const [apiKey, info] of optionIndex.entries()) {
      const cleanCaption = (info.caption.split('//')[0] || '').toLowerCase().trim().replace(/[_\s]+/g, '');
      
      let score = 0;
      if (cleanCaption === normalizedKey) {
        score = 100;
      } else if (cleanCaption.includes(normalizedKey) || normalizedKey.includes(cleanCaption)) {
        score = 80;
      } else {
        const keyWords = normalizedKey.split(/[^а-яёa-z0-9]/i).filter(w => w.length >= 3);
        for (const kw of keyWords) {
          if (cleanCaption.includes(kw)) score += 30;
        }
        const apiKeyLower = apiKey.toLowerCase();
        for (const kw of keyWords) {
          const translitPrefix = kw.substring(0, 4);
          if (apiKeyLower.includes(translitPrefix)) score += 15;
        }
      }
      
      if (score < 20) continue;
      
      // Find closest matching value
      let matchedValue = '';
      let valueScore = 0;
      
      for (const val of info.values) {
        const cleanVal = val.split('//')[0].trim().toLowerCase();
        
        if (cleanVal === normalizedValue) {
          matchedValue = val.split('//')[0].trim();
          valueScore = 100;
          break;
        }
        
        if (cleanVal.includes(normalizedValue) || normalizedValue.includes(cleanVal)) {
          if (valueScore < 80) {
            matchedValue = val.split('//')[0].trim();
            valueScore = 80;
          }
        }
        
        // Numeric match: "32" matches "32 А" or "32А"
        if (/^\d+$/.test(normalizedValue)) {
          const numInVal = cleanVal.replace(/[^\d.,]/g, '');
          if (numInVal === normalizedValue) {
            if (valueScore < 70) {
              matchedValue = val.split('//')[0].trim();
              valueScore = 70;
            }
          }
        }
      }
      
      const totalScore = score + valueScore;
      if (matchedValue && (!bestMatch || totalScore > bestMatch.score)) {
        bestMatch = { apiKey, matchedValue, score: totalScore };
      }
    }
    
    // Value-first fallback: if caption matching failed, search by VALUE across all options
    if (!bestMatch) {
      for (const [apiKey, info] of optionIndex.entries()) {
        for (const val of info.values) {
          const cleanVal = (val.split('//')[0] || '').trim().toLowerCase();
          if (cleanVal === normalizedValue || cleanVal.includes(normalizedValue) || normalizedValue.includes(cleanVal)) {
            bestMatch = { apiKey, matchedValue: val.split('//')[0].trim(), score: 50 };
            console.log(`[OptionKeys] Value-first fallback: "${humanValue}" found in values of "${info.caption}" (key: ${apiKey})`);
            break;
          }
        }
        if (bestMatch) break;
      }
    }
    
    if (bestMatch) {
      resolved[bestMatch.apiKey] = bestMatch.matchedValue;
      console.log(`[OptionKeys] Resolved: "${humanKey}=${humanValue}" → "${bestMatch.apiKey}=${bestMatch.matchedValue}" (score: ${bestMatch.score})`);
    } else {
      console.log(`[OptionKeys] Could not resolve: "${humanKey}=${humanValue}"`);
    }
  }
  
  return resolved;
}

/**
 * LLM-driven filter resolution: uses micro-LLM to match modifiers to real option schema
 */
interface ResolvedFilter {
  value: string;
  is_critical: boolean;
  source_modifier?: string;
}

// Backward-compat helper: flatten { key: {value, is_critical, ...} } → { key: value }
// Tolerates legacy string values too (defensive against any stale callers).
function flattenResolvedFilters(resolved: Record<string, ResolvedFilter | string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(resolved)) {
    out[k] = typeof v === 'object' && v !== null ? (v as ResolvedFilter).value : (v as string);
  }
  return out;
}

async function resolveFiltersWithLLM(
  products: Product[],
  modifiers: string[],
  settings: CachedSettings,
  criticalModifiers?: string[],
  prebuiltSchema?: Map<string, { caption: string; values: Set<string> }>
): Promise<{ resolved: Record<string, ResolvedFilter>; unresolved: string[] }> {
  if (!modifiers || modifiers.length === 0) return { resolved: {}, unresolved: [] };
  // Default critical = all modifiers (safe behavior)
  const criticalSet = new Set<string>((criticalModifiers && criticalModifiers.length > 0 ? criticalModifiers : modifiers).map(m => m.toLowerCase().trim()));
  const isCritical = (mod: string) => criticalSet.has(mod.toLowerCase().trim());

  // Build option schema. Prefer prebuilt full-category schema when provided
  // (covers all products in category, not just a 30-item sample).
  let optionIndex: Map<string, { caption: string; values: Set<string> }>;
  if (prebuiltSchema && prebuiltSchema.size > 0) {
    optionIndex = prebuiltSchema;
    console.log(`[FilterLLM] Using prebuilt category schema (${optionIndex.size} keys)`);
  } else {
    optionIndex = new Map();
    for (const product of products) {
      if (!product.options) continue;
      for (const opt of product.options) {
        if (isExcludedOption(opt.key)) continue;
        if (!optionIndex.has(opt.key)) {
          optionIndex.set(opt.key, { caption: opt.caption, values: new Set() });
        }
        optionIndex.get(opt.key)!.values.add(opt.value);
      }
    }
  }

  if (optionIndex.size === 0) {
    console.log('[FilterLLM] No options found in products, skipping');
    return { resolved: {}, unresolved: [...modifiers] };
  }

  // Format schema for prompt — structured format to prevent LLM from mixing key with caption
  const schemaLines: string[] = [];
  const schemaDebug: string[] = [];
  for (const [apiKey, info] of optionIndex.entries()) {
    const caption = info.caption.split('//')[0].trim();
    const allVals = [...info.values].map(v => v.split('//')[0].trim());
    const vals = allVals.join(', ');
    schemaLines.push(`KEY="${apiKey}" | ${caption} | values: ${vals}`);
    schemaDebug.push(`  ${apiKey} (${caption}): ${allVals.slice(0, 5).join(', ')}${allVals.length > 5 ? ` ... +${allVals.length - 5}` : ''}`);
  }
  const schemaText = schemaLines.join('\n');
  console.log(`[FilterLLM] Schema (${optionIndex.size} keys):\n${schemaDebug.join('\n')}`);

  const systemPrompt = `Ты резолвер фильтров товаров интернет-магазина электротоваров.

ЗАДАЧА: Сопоставь модификаторы из запроса пользователя с реальными характеристиками товаров и подбери точные значения фильтров.

СХЕМА ХАРАКТЕРИСТИК КАТЕГОРИИ:
${schemaText}

МОДИФИКАТОРЫ ПОЛЬЗОВАТЕЛЯ:
${JSON.stringify(modifiers)}

АЛГОРИТМ ДЕЙСТВИЙ:
1. Прочитай модификаторы пользователя. Каждый модификатор — это намерение: пользователь хочет товар с определённым свойством, но не знает, как именно это свойство называется в каталоге.
2. Для каждого модификатора сначала определи, какое физическое свойство товара он описывает: внешний признак (цвет, материал, форма), количественный признак (число элементов, размер, мощность, длина, сечение, ток), функциональный признак (тип монтажа, степень защиты, наличие функции), либо принадлежность (бренд, серия, страна). Числительное-прилагательное («одинарный», «двойной», «трёхполюсный», «четырёхместная») описывает количество — ищи характеристику с количественной семантикой.
3. Пройдись по каждой характеристике в схеме. Смотри на её caption и на природу её значений (числа, слова, единицы измерения). Определи, какое физическое свойство она описывает в контексте данной категории товаров.
4. Сопоставь модификатор с характеристикой, описывающей то же физическое свойство. Учитывай единицы измерения, синонимы и сокращения. Одна характеристика может выражаться по-разному (числом, словом, аббревиатурой) — это всё ещё то же свойство.
5. Найдя характеристику, посмотри на формат её значений и выбери из списка ровно то значение, которое соответствует намерению пользователя. Возвращай значение в точности как в схеме.
6. КРИТИЧЕСКИ ВАЖНО: если нужного значения нет в списке доступных значений — не подставляй ближайшее или похожее. Оставь модификатор без сопоставления. Например, пользователь хочет «1 полюс», а в схеме есть только «2, 3, 4» — пропусти модификатор, не выбирай «2».
7. Если модификатор не соответствует ни одной характеристике — не включай его в результат. Не угадывай.

ВАЖНО: В ответе используй ТОЛЬКО значение из KEY="..." — без описания, без скобок, без лишнего текста.
Ответь СТРОГО в JSON: {"filters": {"KEY_VALUE": "exact_value", ...}}
Если ни один модификатор не удалось сопоставить — верни {"filters": {}}`;

  // STRICT OpenRouter only — no cascade fallback (deterministic for all users).
  if (!settings.openrouter_api_key) {
    console.log('[FilterLLM] OpenRouter key missing — skipping (deterministic empty)');
    return { resolved: {}, unresolved: [...modifiers] };
  }
  // FORCED UPGRADE: flash-lite is non-deterministic for filter resolution (per OpenRouter docs).
  // Hardcoded to flash — ignores DB setting until determinism proven on flash.
  const model = 'google/gemini-2.5-flash';
  const url = 'https://openrouter.ai/api/v1/chat/completions';
  const apiKeys = [settings.openrouter_api_key];
  console.log(`[FilterLLM] OpenRouter (strict), model=${model} (forced upgrade from flash-lite)`);

  const reqBody = {
    model,
    messages: [{ role: 'user', content: systemPrompt }],
    ...DETERMINISTIC_SAMPLING,
    max_tokens: 500,
    response_format: { type: 'json_object' },
    reasoning: { exclude: true },
  };
  console.log(`[FilterLLM] Sampling: top_k=1 seed=42 provider=google-ai-studio model=${model}`);

  try {
    console.log(`[FilterLLM] Resolving ${modifiers.length} modifier(s) against ${optionIndex.size} option(s)`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKeys[0]}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[FilterLLM] API error: ${response.status}`);
      return { resolved: {}, unresolved: [...modifiers] };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const usage = data.usage;
    if (usage) {
      console.log(`[FilterLLM] Tokens used: prompt=${usage.prompt_tokens || 0} completion=${usage.completion_tokens || 0}`);
    }
    console.log(`[FilterLLM] Raw response: ${content}`);

    if (!content || !content.trim()) {
      console.log('[FilterLLM] Empty content (likely reasoning consumed all tokens)');
      return { resolved: {}, unresolved: [...modifiers] };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      console.log(`[FilterLLM] JSON parse failed: ${(e as Error).message}`);
      return { resolved: {}, unresolved: [...modifiers] };
    }
    const filters = parsed.filters || parsed;

    if (typeof filters !== 'object' || Array.isArray(filters)) {
      console.log('[FilterLLM] Invalid response format');
      return { resolved: {}, unresolved: [...modifiers] };
    }

    // Validate that returned keys AND values exist in schema
    const validated: Record<string, ResolvedFilter> = {};
    const matchedModifiers = new Set<string>();
    const sourceModifierForKey: Record<string, string> = {};
    const failedModifiers = new Set<string>();
    const norm = (s: string) => s.replace(/ё/g, 'е').toLowerCase().trim();

    for (const [rawKey, value] of Object.entries(filters)) {
      if (typeof value !== 'string') continue;
      // Try exact match first, then strip caption suffix like " (Цвет)"
      let resolvedKey = rawKey;
      if (!optionIndex.has(resolvedKey)) {
        const stripped = resolvedKey.split(' (')[0].trim();
        if (optionIndex.has(stripped)) {
          resolvedKey = stripped;
        }
      }
      if (optionIndex.has(resolvedKey)) {
        // KEY exists — now validate VALUE against known values in schema
        const knownValues = optionIndex.get(resolvedKey)!.values;
       const matchedValue = [...knownValues].find(v => {
         const nv = norm(v);
         const nval = norm(value);
         if (nv === nval) return true;
         // Bilingual values: "накладной//бетіне орнатылған" — match Russian part before "//"
         const ruPart = nv.split('//')[0].trim();
         return ruPart === nval;
       });
        
        // SEMANTIC NUMERIC VALIDATOR (safety net beyond LLM strict-match):
        // catch e.g. "100W" → "13-20" hallucination by checking number fits range.
        const fitsNumerically = matchedValue ? semanticNumericFit(value, matchedValue) : false;
        if (matchedValue && !fitsNumerically) {
          console.log(`[FilterLLM] Numeric validator REJECTED: "${resolvedKey}"="${matchedValue}" doesn't fit modifier "${value}"`);
          for (const mod of modifiers) {
            if (norm(mod).includes(norm(value)) || norm(value).includes(norm(mod))) failedModifiers.add(mod);
          }
          continue;
        }
        if (matchedValue) {
          // Track which modifier this resolved from
          const caption = optionIndex.get(resolvedKey)!.caption.toLowerCase();
          const keyLower = resolvedKey.toLowerCase();
          // Russian numeral roots → digit mapping
          const numeralMap: Record<string, string> = {
            'одн': '1', 'одно': '1', 'один': '1',
            'два': '2', 'двух': '2', 'двуx': '2', 'дву': '2',
            'три': '3', 'трех': '3', 'трёх': '3',
            'четыр': '4', 'четырех': '4', 'четырёх': '4',
            'пят': '5', 'пяти': '5',
            'шест': '6', 'шести': '6',
          };
          // Strip bilingual suffix from value for matching: "чёрный//қара" → "чёрный"
          const nvalRu = norm(value).split('//')[0].trim();
          // Russian stem helper: take first N letters (4-5) — collapses gender/case forms
          // (черная/чёрный → черн, накладная/накладной → накла)
          const stem = (s: string, n = 5) => {
            const t = s.replace(/[^а-яa-z0-9]/g, '');
            return t.length >= n ? t.slice(0, n) : t;
          };
          for (const mod of modifiers) {
            const nmod = norm(mod);
            const nval = nvalRu;
            let matched = false;
            // 1. Direct match
            if (nmod === nval) matched = true;
            // 2. Caption contains modifier
            else if (caption.includes(nmod)) matched = true;
            // 3. Numeric
            else if (/^\d+$/.test(nval)) {
              if (nmod.includes(nval)) matched = true;
              else if (Object.entries(numeralMap).some(([root, digit]) => digit === nval && nmod.startsWith(root))) matched = true;
            }
            // 4. Russian stem match (value↔modifier): "черная"↔"чёрный" both stem→"черн"
            if (!matched) {
              for (const modWord of nmod.split(/\s+/)) {
                if (modWord.length < 4) continue;
                const ms = stem(modWord, 4);
                const vs = stem(nval, 4);
                if (ms.length >= 4 && vs.length >= 4 && (ms === vs || ms.startsWith(vs.slice(0, 4)) || vs.startsWith(ms.slice(0, 4)))) {
                  matched = true; break;
                }
              }
            }
            if (!matched) {
              // 5. Modifier contains root of caption or key
              const captionWords = caption.split(/[\s\-\/,()]+/).filter(w => w.length >= 3);
              const keyWords = keyLower.split(/[\s_\-]+/).filter(w => w.length >= 3);
              const roots = [...captionWords, ...keyWords].map(w => w.slice(0, Math.min(w.length, 4)));
              if (roots.some(root => nmod.includes(root))) matched = true;
            }
            if (!matched) {
              // 6. Multi-word modifier: any word matches value or caption
              const modWords = nmod.split(/\s+/);
              if (modWords.length > 1 && modWords.some(mw => mw === nval || caption.includes(mw))) matched = true;
            }
            if (matched) {
              matchedModifiers.add(mod);
              // Prefer a critical modifier as source if multiple modifiers match the same key
              if (!sourceModifierForKey[resolvedKey] || (isCritical(mod) && !isCritical(sourceModifierForKey[resolvedKey]))) {
                sourceModifierForKey[resolvedKey] = mod;
              }
            }
          }
          const sourceMod = sourceModifierForKey[resolvedKey];
          // is_critical: if any matched modifier was critical, OR no source identified but criticalSet treats it critical by default
          const critical = sourceMod ? isCritical(sourceMod) : true;
          validated[resolvedKey] = { value: matchedValue, is_critical: critical, source_modifier: sourceMod };
          console.log(`[FilterLLM] Resolved (validated): "${resolvedKey}" = "${matchedValue}" [critical=${critical}, src="${sourceMod || 'n/a'}"]`);
        } else {
          console.log(`[FilterLLM] Key "${resolvedKey}" valid, but value "${value}" NOT in schema values [${[...knownValues].slice(0, 5).join(', ')}...] → unresolved`);
          // Find which modifier this came from
          for (const mod of modifiers) {
            if (norm(mod) === norm(value) || norm(value).includes(norm(mod)) || norm(mod).includes(norm(value))) {
              failedModifiers.add(mod); // mark as "attempted but failed" — stays unresolved
            }
          }
        }
      } else {
        console.log(`[FilterLLM] Rejected unknown key: "${rawKey}"`);
      }
    }

    // Unresolved = modifiers NOT matched by successful validation + those that failed validation
    const unresolved = modifiers.filter(m => !matchedModifiers.has(m) || failedModifiers.has(m));

    const criticalitySummary = Object.entries(validated).map(([k, v]) => `${k}=${v.value}(${v.is_critical ? 'crit' : 'opt'})`).join(', ');
    const filterSig = await sha256Hex(JSON.stringify(Object.entries(validated).map(([k, v]) => [k, v.value]).sort()));
    console.log(`[FilterLLM] Resolved with criticality: {${criticalitySummary}}, unresolved=[${unresolved.join(', ')}] | signature=${filterSig}`);
    return { resolved: validated, unresolved };
  } catch (error) {
    console.error(`[FilterLLM] Error:`, error);
    return { resolved: {}, unresolved: [...modifiers] };
  }
}

// Fallback query parser
function fallbackParseQuery(message: string): ExtractedIntent {
  const catalogPatterns = /кабель|провод|автомат|выключател|розетк|щит|лампа|светильник|дрель|перфоратор|шуруповерт|болгарка|ушм|стабилизатор|генератор|насос|удлинитель|рубильник|трансформатор|инструмент|электро/i;
  const infoPatterns = /доставк|оплат|гарант|возврат|контакт|адрес|телефон|филиал|магазин|оферт|бин|обязанност|условия|документ/i;
  const brandPatterns = /бренд|марк|производител|каки[еx]\s+(бренд|марк|фирм)/i;
  
  let intent: 'catalog' | 'brands' | 'info' | 'general' = 'general';
  if (catalogPatterns.test(message)) intent = 'catalog';
  else if (infoPatterns.test(message)) intent = 'info';
  else if (brandPatterns.test(message)) intent = 'brands';
  
  const query = message
    .replace(/[?!.,;:]+/g, '')
    .replace(/\b(покажи|найди|есть|нужен|хочу|подбери|купить|сколько стоит)\b/gi, '')
    .trim()
    .substring(0, 50);
  
  return {
    intent,
    candidates: query ? [{ query, brand: null, category: null, min_price: null, max_price: null }] : [],
    originalQuery: message,
  };
}

/**
 * Convert singular Russian category name to plural with capital letter.
 * розетка → Розетки, выключатель → Выключатели, кабель → Кабели
 */
function toPluralCategory(word: string): string {
  const w = word.toLowerCase().trim();
  // Already plural
  if (/[иы]$/.test(w)) return w.charAt(0).toUpperCase() + w.slice(1);
  // Common endings
  if (w.endsWith('ка')) return w.slice(0, -2) + 'ки';
  if (w.endsWith('ка')) return w.slice(0, -2) + 'ки';
  if (w.endsWith('та')) return w.slice(0, -2) + 'ты';
  if (w.endsWith('да')) return w.slice(0, -2) + 'ды';
  if (w.endsWith('на')) return w.slice(0, -2) + 'ны';
  if (w.endsWith('ла')) return w.slice(0, -2) + 'лы';
  if (w.endsWith('ра')) return w.slice(0, -2) + 'ры';
  if (w.endsWith('па')) return w.slice(0, -2) + 'пы';
  if (w.endsWith('ма')) return w.slice(0, -2) + 'мы';
  if (w.endsWith('а')) return w.slice(0, -1) + 'ы';
  if (w.endsWith('ь')) return w.slice(0, -1) + 'и';
  if (w.endsWith('й')) return w.slice(0, -1) + 'и';
  if (w.endsWith('ор')) return w + 'ы';
  if (w.endsWith('ер')) return w + 'ы';
  // Default: add ы
  const plural = w + 'ы';
  return plural.charAt(0).toUpperCase() + plural.slice(1);
}

/**
 * Extract "quick" filters from modifiers — ones we can match immediately
 * without LLM (e.g., color words). Returns quick filters + remaining modifiers.
 */
const COLOR_WORDS: Record<string, string> = {
  'черн': 'черный', 'чёрн': 'черный', 'бел': 'белый', 'красн': 'красный', 'син': 'синий',
  'зелен': 'зеленый', 'желт': 'желтый', 'серебр': 'серебристый', 'серебрян': 'серебряный',
  'серый': 'серый', 'сер': 'серый', 'золот': 'золотой', 'бежев': 'бежевый',
  'кремов': 'кремовый', 'коричнев': 'коричневый', 'розов': 'розовый',
  'оранжев': 'оранжевый', 'фиолетов': 'фиолетовый',
};

function extractQuickFilters(modifiers: string[]): { quickFilters: Array<{ type: 'color'; value: string }>; remainingModifiers: string[] } {
  const quickFilters: Array<{ type: 'color'; value: string }> = [];
  const remainingModifiers: string[] = [];
  
  for (const mod of modifiers) {
    const modLower = mod.toLowerCase();
    let matched = false;
    for (const [stem, colorName] of Object.entries(COLOR_WORDS)) {
      if (modLower.startsWith(stem) || modLower === colorName) {
        quickFilters.push({ type: 'color', value: colorName });
        matched = true;
        break;
      }
    }
    if (!matched) remainingModifiers.push(mod);
  }
  
  return { quickFilters, remainingModifiers };
}

/**
 * Match a product's options against a quick filter (color).
 */
function matchQuickFilter(product: Product, filter: { type: 'color'; value: string }): boolean {
  if (!product.options) return false;
  if (filter.type === 'color') {
    // Find option whose caption contains "цвет" or key contains "tsvet" or "cvet" or "color"
    const colorOpt = product.options.find(o => {
      const caption = (o.caption || '').toLowerCase();
      const key = (o.key || '').toLowerCase();
      return caption.includes('цвет') || key.includes('tsvet') || key.includes('cvet') || key.includes('color');
    });
    if (!colorOpt) return false;
    const normalize = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
    const optNorm = normalize(colorOpt.value.toString());
    const filterNorm = normalize(filter.value);
    return optNorm.includes(filterNorm) || filterNorm.includes(optNorm);
  }
  return false;
}

/**
 * Search products by a single candidate via API
 */
async function searchProductsByCandidate(
  candidate: SearchCandidate,
  apiToken: string,
  perPage: number = 30,
  resolvedFilters?: Record<string, string>
): Promise<Product[]> {
  try {
    // Validate params against injection
    if (candidate.query && !isSafeApiParam(candidate.query)) {
      console.log(`[Security] Unsafe query param blocked: ${candidate.query.substring(0, 50)}`);
      return [];
    }
    if (candidate.category && !isSafeApiParam(candidate.category)) {
      console.log(`[Security] Unsafe category param blocked: ${candidate.category.substring(0, 50)}`);
      return [];
    }
    
    const params = new URLSearchParams();
    
    if ((candidate as any).article) {
      params.append('article', (candidate as any).article);
    } else if (candidate.query) {
      params.append('query', candidate.query);
    }
    
    params.append('per_page', perPage.toString());
    
    if (candidate.brand) params.append('options[brend__brend][]', candidate.brand);
    if (candidate.category) params.append('category', candidate.category);
    if (candidate.min_price) params.append('min_price', candidate.min_price.toString());
    if (candidate.max_price) params.append('max_price', candidate.max_price.toString());
    
    // Apply resolved option filters from pass 2
    if (resolvedFilters) {
      for (const [key, value] of Object.entries(resolvedFilters)) {
        params.append(`options[${key}][]`, value);
      }
    }
    
    console.log(`[Search] API call: ${params.toString().substring(0, 150)}`);
    
    // AbortController timeout 10s to prevent API hangs
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(`${VOLT220_API_URL}?${params}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Search] API error ${response.status}:`, errorText);
      return [];
    }
    
    const rawData = await response.json();
    const data = rawData.data || rawData;
    const results = data.results || [];
    
    console.log(`[Search] query="${candidate.query || (candidate as any).article || ''}" → ${results.length} results`);
    return results;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      console.error(`[Search] API timeout (10s) for query="${candidate.query || ''}"`);
    } else {
      console.error(`[Search] Error:`, error);
    }
    return [];
  }
}

/**
 * Multi-candidate search with two-pass option key discovery
 */
async function searchProductsMulti(
  candidates: SearchCandidate[],
  limit: number = 10,
  apiToken?: string,
  perPage: number = 30,
  modifiers?: string[],
  settings?: CachedSettings | null
): Promise<Product[]> {
  if (!apiToken) {
    console.error('[Search] No API token configured');
    return [];
  }
  
  // Remove candidates without query AND without brand (useless)
  const cleanedCandidates = candidates.filter(c => c.query || c.brand || (c as any).article);
  if (cleanedCandidates.length === 0) return [];
  
  // Check if any candidate has human-readable option_filters
  const humanFilters: Record<string, string> = {};
  for (const c of cleanedCandidates) {
    if (c.option_filters) {
      for (const [k, v] of Object.entries(c.option_filters)) {
        if (!humanFilters[k]) humanFilters[k] = v;
      }
    }
  }
  const hasHumanFilters = Object.keys(humanFilters).length > 0;

  // === PASS 1: Broad search WITHOUT option filters ===
  const pass1Candidates = cleanedCandidates.map(c => ({ ...c, option_filters: undefined }));
  const seen1 = new Set<string>();
  const uniquePass1 = pass1Candidates.filter(c => {
    const key = `${c.query || ''}|${c.brand || ''}`;
    if (seen1.has(key)) return false;
    seen1.add(key);
    return true;
  });
  
  // === OPTIMIZATION: Limit parallel API calls to max 3 ===
  const pass1Cap = 6;
  const cappedPass1 = uniquePass1.slice(0, pass1Cap);
  if (uniquePass1.length > pass1Cap) {
    console.log(`[Search] Capped Pass 1 candidates from ${uniquePass1.length} to ${pass1Cap}`);
  }
  
  const pass1Promises = cappedPass1.map(candidate => 
    searchProductsByCandidate(candidate, apiToken, perPage)
  );
  const pass1Results = await Promise.all(pass1Promises);
  
  const productMap = new Map<number, Product>();
  for (const products of pass1Results) {
    for (const product of products) {
      if (!productMap.has(product.id)) {
        productMap.set(product.id, product);
      }
    }
  }
  
  console.log(`[Search] Pass 1 (broad): ${productMap.size} unique products`);
  
  // === LOCAL CHARACTERISTIC FILTERING (primary mechanism) ===
  if (modifiers && modifiers.length > 0 && productMap.size > 0 && settings) {
    const allProducts = Array.from(productMap.values());
    const { resolved: resolvedFiltersRaw } = await resolveFiltersWithLLM(allProducts, modifiers, settings);
    const resolvedFilters = flattenResolvedFilters(resolvedFiltersRaw);
    
    if (Object.keys(resolvedFilters).length > 0) {
      console.log(`[Search] Resolved filters: ${JSON.stringify(resolvedFilters)}`);
      
      // Score each product by how many resolved filters match its options
      const scored: { product: Product; matchCount: number }[] = allProducts.map(product => {
        if (!product.options) return { product, matchCount: 0 };
        let matchCount = 0;
        for (const [key, value] of Object.entries(resolvedFilters)) {
          const opt = product.options.find(o => o.key === key);
          if (opt) {
            const pv = opt.value.toString().toLowerCase().trim();
            const fv = value.toString().toLowerCase().trim();
            if (pv === fv || pv.includes(fv) || fv.includes(pv)) {
              matchCount++;
            }
          }
        }
        return { product, matchCount };
      });
      
      const totalFilters = Object.keys(resolvedFilters).length;
      // Products matching ALL filters
      const fullMatch = scored.filter(s => s.matchCount === totalFilters);
      // Products matching at least one filter
      const partialMatch = scored.filter(s => s.matchCount > 0 && s.matchCount < totalFilters);
      
      if (fullMatch.length > 0) {
        productMap.clear();
        fullMatch.forEach(s => productMap.set(s.product.id, s.product));
        console.log(`[Search] Characteristic filter: ${fullMatch.length} products match ALL ${totalFilters} filters`);
      } else if (partialMatch.length > 0) {
        // Sort by match count descending, take best partial matches
        partialMatch.sort((a, b) => b.matchCount - a.matchCount);
        productMap.clear();
        partialMatch.forEach(s => productMap.set(s.product.id, s.product));
        console.log(`[Search] Characteristic filter: ${partialMatch.length} products with partial match (best: ${partialMatch[0].matchCount}/${totalFilters})`);
      } else {
        console.log(`[Search] Characteristic filter: 0 matches among ${allProducts.length} products, keeping Pass 1`);
      }
    } else {
      console.log(`[Search] Could not resolve any filters from modifiers`);
    }
  }
  
  // Fallback: if 0 results and had brand/price filters, try without
  if (productMap.size === 0) {
    const queryOnlyCandidates = cleanedCandidates.filter(c => c.query && (c.brand || c.min_price || c.max_price));
    if (queryOnlyCandidates.length > 0) {
      console.log(`[Search] 0 results with filters, trying fallback with query only...`);
      const fallbackPromises = queryOnlyCandidates.slice(0, 3).map(c => 
        searchProductsByCandidate({ query: c.query, brand: null, category: null, min_price: null, max_price: null }, apiToken, perPage)
      );
      const fallbackResults = await Promise.all(fallbackPromises);
      for (const products of fallbackResults) {
        for (const product of products) {
          if (!productMap.has(product.id)) {
            productMap.set(product.id, product);
          }
        }
      }
    }
  }
  
  // === ARTICLE FALLBACK ===
  if (productMap.size === 0) {
    const numericQueries = cleanedCandidates
      .filter(c => c.query && /^\d{4,12}$/.test(c.query.trim()))
      .map(c => c.query!.trim());
    
    const articleCandidates = cleanedCandidates
      .filter(c => (c as any).article)
      .map(c => (c as any).article as string);
    
    const allArticles = [...new Set([...numericQueries, ...articleCandidates])];
    
    if (allArticles.length > 0) {
      console.log(`[Search] 0 results, trying article fallback for: ${allArticles.join(', ')}`);
      const articlePromises = allArticles.map(article => searchByArticle(article, apiToken));
      const articleResults = await Promise.all(articlePromises);
      for (const products of articleResults) {
        for (const product of products) {
          if (!productMap.has(product.id)) {
            productMap.set(product.id, product);
          }
        }
      }
      if (productMap.size > 0) {
        console.log(`[Search] Article fallback found ${productMap.size} products`);
      } else {
        console.log(`[Search] Article fallback returned 0, trying site ID fallback for: ${allArticles.join(', ')}`);
        const siteIdPromises = allArticles.map(id => searchBySiteId(id, apiToken));
        const siteIdResults = await Promise.all(siteIdPromises);
        for (const products of siteIdResults) {
          for (const product of products) {
            if (!productMap.has(product.id)) {
              productMap.set(product.id, product);
            }
          }
        }
        if (productMap.size > 0) {
          console.log(`[Search] SiteId fallback found ${productMap.size} products`);
        }
      }
    }
  }
  
  const uniqueProducts = Array.from(productMap.values());
  console.log(`[Search] Total unique products: ${uniqueProducts.length}`);
  
  // Filter out products with zero price
  const pricedProducts = uniqueProducts.filter(p => p.price > 0);
  const workingList = pricedProducts.length > 0 ? pricedProducts : uniqueProducts;
  console.log(`[Search] After price>0 filter: ${pricedProducts.length} (using ${workingList === pricedProducts ? 'filtered' : 'original'})`);
  
  // Sort: priority to products with query in title, then availability, then price
  const queryWords = candidates
    .map(c => c.query?.toLowerCase())
    .filter(Boolean) as string[];
  
  workingList.sort((a, b) => {
    const aInTitle = queryWords.some(q => a.pagetitle.toLowerCase().includes(q));
    const bInTitle = queryWords.some(q => b.pagetitle.toLowerCase().includes(q));
    if (aInTitle && !bInTitle) return -1;
    if (!aInTitle && bInTitle) return 1;
    if (a.amount > 0 && b.amount === 0) return -1;
    if (a.amount === 0 && b.amount > 0) return 1;
    return a.price - b.price;
  });
  
  return workingList.slice(0, limit);
}

// Возвращает URL как есть
function toProductionUrl(url: string): string {
  return url;
}

// Prefixes to ALWAYS exclude (service/SEO fields)
const EXCLUDED_OPTION_PREFIXES = [
  'poiskovyy_zapros',
  'kod_tn_ved',
  'ogranichennyy_prosmotr',
  'prodaetsya_to',
  'tovar_internet_magazina',
];

// Extended fields — included only when user query is relevant
const EXTENDED_OPTION_PREFIXES = [
  'fayl',              // PDF documentation links
  'opisaniefayla',     // file descriptions
  'novinka',           // new arrival flag
  'populyarnyy',      // popularity flag
  'soputstvuyuschiy',  // related products
  'garantiynyy',       // warranty
  'naimenovanie_na_kazahskom', // Kazakh name
  'kodnomenklatury',   // nomenclature code
  'identifikator_sayta', // site ID
  'edinica_izmereniya',  // unit of measurement
];

// Keywords that trigger extended fields
const EXTENDED_TRIGGERS = [
  'документ', 'pdf', 'файл', 'инструкция', 'паспорт', 'сертификат',
  'новинк', 'новый поступлени', 'новое поступлени',
  'популярн', 'хит продаж', 'бестселлер',
  'сопутств', 'похож', 'аналог', 'комплект', 'вместе с',
  'гарантия', 'гарантийн',
  'қазақ', 'казахск',
  'номенклатур', 'код товар',
  'единиц измерен',
];

function needsExtendedOptions(userMessage: string): boolean {
  const lower = userMessage.toLowerCase();
  return EXTENDED_TRIGGERS.some(trigger => lower.includes(trigger));
}

function isExcludedOption(key: string, includeExtended: boolean = true): boolean {
  if (EXCLUDED_OPTION_PREFIXES.some(prefix => key.startsWith(prefix))) return true;
  if (!includeExtended && EXTENDED_OPTION_PREFIXES.some(prefix => key.startsWith(prefix))) return true;
  return false;
}

function cleanOptionValue(value: string): string {
  if (!value) return value;
  const parts = value.split('//');
  return parts[0].trim();
}

function cleanOptionCaption(caption: string): string {
  if (!caption) return caption;
  const parts = caption.split('//');
  return parts[0].trim();
}

// Форматирование товаров для AI
function formatProductsForAI(products: Product[], includeExtended: boolean = true): string {
  if (products.length === 0) {
    return 'Товары не найдены в каталоге.';
  }

  return products.map((p, i) => {
    let brand = '';
    if (p.options) {
      const brandOption = p.options.find(o => o.key === 'brend__brend');
      if (brandOption) {
        brand = brandOption.value.split('//')[0].trim();
      }
    }
    if (!brand) {
      brand = p.vendor || '';
    }
    
    const productUrl = toProductionUrl(p.url).replace(/\(/g, '%28').replace(/\)/g, '%29');
    const safeName = p.pagetitle.replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    const nameWithLink = `[${safeName}](${productUrl})`;
    
    const parts = [
      `${i + 1}. **${nameWithLink}**`,
      `   - Цена: ${p.price.toLocaleString('ru-KZ')} ₸${p.old_price && p.old_price > p.price ? ` ~~${p.old_price.toLocaleString('ru-KZ')} ₸~~` : ''}`,
      brand ? `   - Бренд: ${brand}` : '',
      p.article ? `   - Артикул: ${p.article}` : '',
      (() => {
        const available = (p.warehouses || []).filter(w => w.amount > 0);
        if (available.length > 0) {
          const shown = available.slice(0, 5).map(w => `${w.city}: ${w.amount} шт.`).join(', ');
          const extra = available.length > 5 ? ` и ещё в ${available.length - 5} городах` : '';
          return `   - Остатки по городам: ${shown}${extra}`;
        }
        return p.amount > 0 ? `   - В наличии: ${p.amount} шт.` : `   - Под заказ`;
      })(),
      p.category ? `   - Категория: [${p.category.pagetitle}](https://220volt.kz/catalog/${p.category.id})` : '',
    ];
    
    if (p.options && p.options.length > 0) {
      const specs = p.options
        .filter(o => !isExcludedOption(o.key, includeExtended))
        .map(o => `${cleanOptionCaption(o.caption)}: ${cleanOptionValue(o.value)}`);
      
      if (specs.length > 0) {
        parts.push(`   - Характеристики: ${specs.join('; ')}`);
      }
    }
    
    return parts.filter(Boolean).join('\n');
  }).join('\n\n');
}

function describeAppliedFilters(candidates: SearchCandidate[]): string {
  const filters: string[] = [];
  const seen = new Set<string>();
  
  for (const candidate of candidates) {
    if (!candidate.option_filters) continue;
    for (const [key, value] of Object.entries(candidate.option_filters)) {
      const displayKey = cleanOptionCaption(key.replace(/__.*/, '').replace(/_/g, ' '));
      const desc = `${displayKey}=${cleanOptionValue(value)}`;
      if (!seen.has(desc)) {
        seen.add(desc);
        filters.push(desc);
      }
    }
  }
  
  return filters.join(', ');
}

function extractBrandsFromProducts(products: Product[]): string[] {
  const brands = new Set<string>();
  
  for (const product of products) {
    let found = false;
    if (product.options) {
      const brandOption = product.options.find(o => o.key === 'brend__brend');
      if (brandOption && brandOption.value) {
        const brandName = brandOption.value.split('//')[0].trim();
        if (brandName) {
          brands.add(brandName);
          found = true;
        }
      }
    }
    if (!found && product.vendor && product.vendor.trim()) {
      brands.add(product.vendor.trim());
    }
  }
  
  return Array.from(brands).sort();
}

function formatContactsForDisplay(contactsText: string): string | null {
  if (!contactsText || contactsText.trim().length === 0) return null;
  
  const lines: string[] = [];
  const seen = new Set<string>();
  
  const phoneRegex = /(?:\+7|8)[\s\(\)\-]*\d{3}[\s\(\)\-]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/g;
  const phoneMatches = contactsText.match(phoneRegex);
  if (phoneMatches) {
    for (const raw of phoneMatches) {
      const telNumber = raw.replace(/[\s\(\)\-]/g, '');
      if (!seen.has(telNumber)) {
        seen.add(telNumber);
        const formatted = raw.trim();
        lines.push(`📞 [${formatted}](tel:${telNumber})`);
      }
      if (lines.filter(l => l.startsWith('📞')).length >= 2) break;
    }
  }
  
  const waMatch = contactsText.match(/https?:\/\/wa\.me\/\d+/i) 
    || contactsText.match(/WhatsApp[^:]*:\s*([\+\d\s]+)/i);
  if (waMatch) {
    const value = waMatch[0];
    if (value.startsWith('http')) {
      lines.push(`💬 [WhatsApp](${value})`);
    } else {
      const num = waMatch[1]?.replace(/[\s\(\)\-]/g, '') || '';
      if (num) lines.push(`💬 [WhatsApp](https://wa.me/${num})`);
    }
  }
  
  const emailMatch = contactsText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) {
    lines.push(`📧 [${emailMatch[0]}](mailto:${emailMatch[0]})`);
  }
  
  if (lines.length === 0) return null;
  
  return `**Наши контакты:**\n${lines.join('\n')}`;
}

// Simple in-memory rate limiter
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

// Idempotency shield: блокирует дубль-вызовы с тем же messageId в окне 60 сек.
// Защищает от ретраев браузера, гонок fallback в виджете и двойных кликов.
const idempotencyMap = new Map<string, number>();
const IDEMPOTENCY_TTL_MS = 60_000;

function checkIdempotency(messageId: string): boolean {
  if (!messageId) return true; // нет id — нечего проверять, пропускаем
  const now = Date.now();
  // Чистим устаревшие записи (lazy cleanup)
  if (idempotencyMap.size > 500) {
    for (const [k, ts] of idempotencyMap) {
      if (now - ts > IDEMPOTENCY_TTL_MS) idempotencyMap.delete(k);
    }
  }
  const seen = idempotencyMap.get(messageId);
  if (seen && now - seen < IDEMPOTENCY_TTL_MS) {
    return false; // дубль
  }
  idempotencyMap.set(messageId, now);
  return true;
}

function sanitizeUserInput(input: string): string {
  if (!input || typeof input !== 'string') return '';
  
  let sanitized = input;
  
  // Decode URL-encoded characters for pattern detection
  let decoded = sanitized;
  try { decoded = decodeURIComponent(sanitized); } catch (_) { /* ignore */ }
  
  // Detect SQL injection patterns
  const sqlPatterns = /('(\s|%20)*(OR|AND)(\s|%20)*'|1'='1|UNION\s+SELECT|DROP\s+TABLE|;\s*--|\/\*|\*\/|EXEC\s|xp_|%27.*(%4F%52|OR|AND))/i;
  if (sqlPatterns.test(decoded) || sqlPatterns.test(sanitized)) {
    console.log(`[Security] SQL injection pattern detected, input blocked`);
    return '';
  }
  
  // Detect shell injection patterns
  const shellPatterns = /(\$\(|`[^`]+`|&&\s*rm|\|\s*rm|;\s*rm)/i;
  if (shellPatterns.test(decoded) || shellPatterns.test(sanitized)) {
    console.log(`[Security] Shell injection pattern detected, input blocked`);
    return '';
  }
  
  sanitized = sanitized.replace(/<\/?[a-z][^>]*>/gi, '');
  sanitized = sanitized.replace(/\bon\w+\s*=/gi, '');
  sanitized = sanitized.replace(/javascript\s*:/gi, '');
  sanitized = sanitized.replace(/data\s*:\s*text\/html/gi, '');
  sanitized = sanitized.substring(0, 2000);
  sanitized = sanitized.trim();
  
  return sanitized;
}

function isSafeApiParam(value: string): boolean {
  // Allow only letters (any script), digits, spaces, hyphens, dots, commas
  return /^[\p{L}\p{N}\s\-.,()]+$/u.test(value) && value.length <= 200;
}

interface GeoResult {
  city: string | null;
  isVPN: boolean;
  country: string | null;
  countryCode: string | null;
}

async function detectCityByIP(ip: string): Promise<GeoResult> {
  const empty: GeoResult = { city: null, isVPN: false, country: null, countryCode: null };
  if (!ip || ip === 'unknown' || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    return empty;
  }
  try {
    const resp = await fetch(`http://ip-api.com/json/${ip}?fields=status,city,regionName,country,countryCode,proxy,hosting&lang=ru`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return empty;
    const data = await resp.json();
    
    const isVPN = !!(data.proxy || data.hosting);
    
    if (isVPN) {
      console.log(`[GeoIP] VPN/proxy detected for IP ${ip}`);
      return { city: null, isVPN: true, country: data.country || null, countryCode: data.countryCode || null };
    }
    
    if (data.countryCode === 'RU') {
      console.log(`[GeoIP] Russian user detected: ${data.city}, ${data.country}`);
      return { city: data.city || null, isVPN: false, country: data.country, countryCode: 'RU' };
    }
    
    if (data.countryCode && data.countryCode !== 'KZ') {
      console.log(`[GeoIP] Non-KZ/RU country detected: ${data.country}`);
      return { city: null, isVPN: true, country: data.country || null, countryCode: data.countryCode || null };
    }
    
    if (data.status === 'success' && data.city) {
      console.log(`[GeoIP] Detected city: ${data.city}`);
      return { city: data.city, isVPN: false, country: data.country, countryCode: 'KZ' };
    }
    return empty;
  } catch (e) {
    console.warn('[GeoIP] Detection failed:', e);
    return { city: null, isVPN: false, country: null, countryCode: null };
  }
}


function extractRelevantExcerpt(content: string, query: string, maxLen: number = 2000): string {
  if (content.length <= maxLen) return content;

  const stopWords = new Set(['как', 'что', 'где', 'когда', 'почему', 'какой', 'какая', 'какие', 'это', 'для', 'при', 'или', 'так', 'вот', 'можно', 'есть', 'ваш', 'мне', 'вам', 'нас', 'вас', 'они', 'она', 'оно', 'его', 'неё', 'них', 'будет', 'быть', 'если', 'уже', 'ещё', 'еще', 'тоже', 'также', 'только', 'очень', 'просто', 'нужно', 'надо']);
  const words = query.toLowerCase()
    .split(/[^а-яёa-z0-9]+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  if (words.length === 0) return content.substring(0, maxLen);

  const lowerContent = content.toLowerCase();
  const windowSize = 1500;
  const step = 200;
  
  const scoredWindows: { start: number; score: number }[] = [];

  for (let start = 0; start < content.length - step; start += step) {
    const end = Math.min(start + windowSize, content.length);
    const window = lowerContent.substring(start, end);
    
    let score = 0;
    for (const word of words) {
      let idx = 0;
      while ((idx = window.indexOf(word, idx)) !== -1) {
        score += 1;
        idx += word.length;
      }
    }

    if (score > 0) {
      scoredWindows.push({ start, score });
    }
  }

  if (scoredWindows.length === 0) return content.substring(0, maxLen);

  scoredWindows.sort((a, b) => b.score - a.score);

  const numWindows = content.length > 10000 ? 3 : 1;
  const totalBudget = maxLen;
  const perWindowBudget = Math.floor(totalBudget / numWindows);

  const selectedWindows: { start: number; score: number }[] = [];
  
  for (const w of scoredWindows) {
    if (selectedWindows.length >= numWindows) break;
    const overlaps = selectedWindows.some(sel => 
      Math.abs(sel.start - w.start) < perWindowBudget
    );
    if (!overlaps) {
      selectedWindows.push(w);
    }
  }

  selectedWindows.sort((a, b) => a.start - b.start);

  const parts: string[] = [];
  for (const w of selectedWindows) {
    let snapStart = w.start;
    if (snapStart > 0) {
      const lookBack = content.substring(Math.max(0, snapStart - 300), snapStart);
      const tableHeaderMatch = lookBack.lastIndexOf('|---');
      if (tableHeaderMatch >= 0) {
        const beforeTable = lookBack.substring(0, tableHeaderMatch);
        const headerLineStart = beforeTable.lastIndexOf('\n');
        snapStart = Math.max(0, snapStart - 300) + (headerLineStart >= 0 ? headerLineStart + 1 : tableHeaderMatch);
      } else {
        const sectionMatch = lookBack.lastIndexOf('\n\n');
        if (sectionMatch >= 0) {
          snapStart = Math.max(0, snapStart - 300) + sectionMatch + 2;
        }
      }
    }

    const excerpt = content.substring(snapStart, snapStart + perWindowBudget).trim();
    const prefix = snapStart > 0 ? '...' : '';
    const suffix = (snapStart + perWindowBudget) < content.length ? '...' : '';
    parts.push(prefix + excerpt + suffix);
  }

  return parts.join('\n\n---\n\n');
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('cf-connecting-ip')
    || 'unknown';
  if (!checkRateLimit(clientIp)) {
    console.warn(`[RateLimit] Blocked IP: ${clientIp}`);
    return new Response(
      JSON.stringify({ error: 'Слишком много запросов. Подождите минуту.' }),
      { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const body = await req.json();
    const useStreaming = body.stream !== false;

    // Idempotency check: блокируем дубль-вызовы с тем же messageId
    const messageId = typeof body.messageId === 'string' ? body.messageId : '';
    if (messageId && !checkIdempotency(messageId)) {
      console.warn(`[Chat] Duplicate blocked: ${messageId}`);
      return new Response(
        JSON.stringify({ content: '', duplicate: true }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let messages: Array<{ role: string; content: string }>;
    let conversationId: string;
    
    if (body.messages) {
      messages = body.messages;
      conversationId = body.conversationId || Date.now().toString();
    } else if (body.message) {
      const history = body.history || [];
      messages = [...history, { role: 'user', content: body.message }];
      conversationId = body.sessionId || Date.now().toString();
    } else {
      throw new Error('Invalid request format: missing messages or message');
    }
    
    // === DIALOG SLOTS: read and validate ===
    let dialogSlots: DialogSlots = validateAndSanitizeSlots(body.dialogSlots);
    let slotsUpdated = false;
    console.log(`[Chat] Dialog slots received: ${Object.keys(dialogSlots).length} slot(s)`);
    
    // Age all pending slots by 1 turn
    dialogSlots = ageSlots(dialogSlots);
    
    const appSettings = await getAppSettings();
    const aiConfig = getAIConfig(appSettings);
    
    console.log(`[Chat] AI Provider: OpenRouter (strict), Model: ${aiConfig.model}`);

    const lastMessage = messages[messages.length - 1];
    const rawUserMessage = lastMessage?.content || '';
    
    const userMessage = sanitizeUserInput(rawUserMessage);
    
    messages = messages.map(m => ({
      ...m,
      content: m.role === 'user' ? sanitizeUserInput(m.content) : m.content
    }));
    
    console.log(`[Chat] Processing: "${userMessage.substring(0, 100)}"`);
    console.log(`[Chat] Conversation ID: ${conversationId}`);

    const historyForContext = messages.slice(0, -1);

    // Геолокация по IP (параллельно с остальными запросами)
    const detectedCityPromise = detectCityByIP(clientIp);

    // Plan V5 — Pre-warm knowledge & contacts in parallel with article-search / LLM classifier.
    // These don't depend on any LLM result; the sooner we kick them off, the less wall-clock waiting later.
    const earlyKnowledgePromise = searchKnowledgeBase(userMessage, 5, appSettings);
    const earlyContactsPromise = (async () => {
      const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
      const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return '';
      try {
        const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        const { data } = await sb.from('knowledge_entries')
          .select('title, content')
          .or('title.ilike.%контакт%,title.ilike.%филиал%')
          .limit(5);
        if (!data || data.length === 0) return '';
        return data.map(d => `--- ${d.title} ---\n${d.content}`).join('\n\n');
      } catch { return ''; }
    })();

    let productContext = '';
    let foundProducts: Product[] = [];
    // Plan V4 — Domain Guard: pagetitles selected by CategoryMatcher for the current query.
    // Passed into rerankProducts to drop products from unrelated categories.
    const allowedCategoryTitles: Set<string> = new Set();
    // Real number of products we collected from API BEFORE truncating to DISPLAY_LIMIT.
    // Used by the LLM prompt so the bot reports the honest catalog volume,
    // not the truncated 15. Reset to 0 each turn.
    let totalCollected = 0;
    let totalCollectedBranch = '';
    let brandsContext = '';
    let knowledgeContext = '';
    let articleShortCircuit = false;
    // Plan V7 — when set, short-circuits AI streaming entirely and returns a clarification
    // question with quick_reply chips. Used when CategoryMatcher returns ≥2 semantically distinct
    // buckets (e.g. household vs industrial sockets). User picks one chip, next turn the
    // category_disambiguation slot resolves the choice and runs a precise search.
    let disambiguationResponse: { content: string; quick_replies: Array<{ label: string; value: string }> } | null = null;
    // Plan V5 — model used for the FINAL streaming answer.
    // Defaults to user's configured model (usually Pro). Switched to Flash for short-circuit branches
    // (article/siteId hit, price-intent hit) where the answer is a simple "yes, in stock, X tg".
    let responseModel = aiConfig.model;
    let responseModelReason = 'default';
    let replacementMeta: { isReplacement: boolean; original: Product | null; originalName?: string; noResults: boolean } | null = null;

    // === ARTICLE FIRST: Detect SKU/article codes BEFORE LLM 1 ===
    const detectedArticles = detectArticles(userMessage);
    
    if (detectedArticles.length > 0 && appSettings.volt220_api_token) {
      console.log(`[Chat] Article-first: detected ${detectedArticles.length} article(s), searching directly...`);
      
      const articleSearchPromises = detectedArticles.map(art => 
        searchByArticle(art, appSettings.volt220_api_token!)
      );
      const articleResults = await Promise.all(articleSearchPromises);
      
      const articleProducts = new Map<number, Product>();
      for (const products of articleResults) {
        for (const product of products) {
          articleProducts.set(product.id, product);
        }
      }
      
      if (articleProducts.size > 0) {
        foundProducts = Array.from(articleProducts.values());
        articleShortCircuit = true;
        // Plan V5: для article-hit Pro избыточен — берём Flash.
        responseModel = 'google/gemini-2.5-flash';
        responseModelReason = 'article-shortcircuit';
        console.log(`[Chat] Article-first SUCCESS: found ${foundProducts.length} product(s), skipping LLM 1`);
      } else {
        console.log(`[Chat] Article-first: no article results, trying site ID fallback...`);
        const siteIdPromises = detectedArticles.map(art => 
          searchBySiteId(art, appSettings.volt220_api_token!)
        );
        const siteIdResults = await Promise.all(siteIdPromises);
        
        for (const products of siteIdResults) {
          for (const product of products) {
            articleProducts.set(product.id, product);
          }
        }
        
        if (articleProducts.size > 0) {
          foundProducts = Array.from(articleProducts.values());
          articleShortCircuit = true;
          // Plan V5: siteId-hit — тоже точное попадание, Flash хватает.
          responseModel = 'google/gemini-2.5-flash';
          responseModelReason = 'siteid-shortcircuit';
          console.log(`[Chat] SiteId-fallback SUCCESS: found ${foundProducts.length} product(s), skipping LLM 1`);
        } else {
          console.log(`[Chat] Article-first + SiteId: no results, falling back to normal pipeline`);
        }
     }
    }

    // === TITLE-FIRST SHORT-CIRCUIT via Micro-LLM classifier ===
    // AI determines if message contains a product name and/or price intent
    let priceIntentClarify: { total: number; category: string } | null = null;
    let effectivePriceIntent: 'most_expensive' | 'cheapest' | undefined = undefined;
    let effectiveCategory = '';
    let classification: any = null;
    
    if (!articleShortCircuit && appSettings.volt220_api_token) {
      const classifyStart = Date.now();
      try {
        const recentHistoryForClassifier = historyForContext.slice(-4).map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }));
        classification = await classifyProductName(userMessage, recentHistoryForClassifier, appSettings);
        const classifyElapsed = Date.now() - classifyStart;
        console.log(`[Chat] Micro-LLM classify: ${classifyElapsed}ms → intent=${classification?.intent || 'none'}, has_product_name=${classification?.has_product_name}, name="${classification?.product_name || ''}", price_intent=${classification?.price_intent || 'none'}, category="${classification?.product_category || ''}", is_replacement=${classification?.is_replacement || false}`);
        
        // === DIALOG SLOTS: try slot-based resolution FIRST ===
        // Filter out "none" — classifier returns string "none", not null
        effectivePriceIntent = 
          (classification?.price_intent && classification.price_intent !== 'none') 
            ? classification.price_intent 
            : undefined;
        effectiveCategory = classification?.product_category || classification?.product_name || '';
        
        const slotResolution = resolveSlotRefinement(dialogSlots, userMessage, classification);
        
        if (slotResolution && 'searchParams' in slotResolution) {
          // product_search slot resolved — resolve refinement as structured filters, then re-query API
          const sp = slotResolution.searchParams;
          console.log(`[Chat] product_search slot: refinementText="${sp.refinementText}", existingUnresolved="${sp.existingUnresolved}", existingFilters=${JSON.stringify(sp.resolvedFilters)}`);
          
          // Step 1: Fetch FULL category option schema (authoritative — covers all products,
          // not just a 50-item sample). Falls back to sample-based schema inside resolver if empty.
          const slotPrebuiltResult = appSettings.volt220_api_token
            ? await getCategoryOptionsSchema(sp.category, appSettings.volt220_api_token).catch(() => ({ schema: new Map<string, { caption: string; values: Set<string> }>(), productCount: 0, cacheHit: false }))
            : { schema: new Map<string, { caption: string; values: Set<string> }>(), productCount: 0, cacheHit: false };
          const slotPrebuilt = slotPrebuiltResult.schema;
          console.log(`[Chat] Slot prebuilt schema for "${sp.category}": ${slotPrebuilt.size} keys`);
          // Still fetch a small product sample as fallback (in case prebuilt schema is empty)
          const schemaProducts = slotPrebuilt.size > 0 ? [] : await searchProductsByCandidate(
            { query: null, brand: null, category: sp.category, min_price: null, max_price: null },
            appSettings.volt220_api_token!, 50
          );
          if (slotPrebuilt.size === 0) {
            console.log(`[Chat] Fetched ${schemaProducts.length} schema products for category="${sp.category}" (fallback)`);
          }
          
          // Step 2: Resolve the NEW modifier (user's answer) against option schema
          const modifiersToResolve = sp.refinementModifiers || [sp.refinementText];
          console.log(`[Chat] Resolving modifiers: ${JSON.stringify(modifiersToResolve)} (from classifier: ${sp.refinementModifiers ? 'yes' : 'no, fallback'})`);

          // Schema fallback guard (Plan V4): if both prebuilt and sample schema are empty,
          // we cannot meaningfully resolve filters via LLM — skip the call and reuse prior
          // resolved_filters from the open slot to avoid blind hallucinated filters.
          let newFiltersRaw: Record<string, ResolvedFilter> = {};
          let stillUnresolved: string[] = [...modifiersToResolve];
          const hasAnySchema = (slotPrebuilt as any).size > 0 || schemaProducts.length > 0;
          if (!hasAnySchema) {
            console.log(`[Chat] [FilterLLM-skip] schema empty for "${sp.category}" → reusing prior resolved_filters (${Object.keys(sp.resolvedFilters || {}).length} keys), modifiers go to unresolved`);
          } else {
            const r = await resolveFiltersWithLLM(
              schemaProducts, modifiersToResolve, appSettings, classification?.critical_modifiers,
              (slotPrebuilt as any).size > 0 ? slotPrebuilt as any : undefined
            );
            newFiltersRaw = r.resolved;
            stillUnresolved = r.unresolved;
          }
          const newFilters = flattenResolvedFilters(newFiltersRaw);
          console.log(`[Chat] FilterLLM refinement: resolved=${JSON.stringify(newFilters)}, unresolved=${JSON.stringify(stillUnresolved)}`);

          // Step 3: Merge with existing filters from slot
          const mergedFilters = { ...sp.resolvedFilters, ...newFilters };
          
          // Clean existingUnresolved: drop tokens that semantically map to ANY merged filter value
          // (handles word-form garbage like "накладная" left over after tip_montagha was resolved)
          const normTok = (s: string) => s.replace(/ё/g, 'е').toLowerCase().replace(/[^а-яa-z0-9\s]/g, '').trim();
          const stem4 = (s: string) => { const t = s.replace(/[^а-яa-z0-9]/g, ''); return t.length >= 4 ? t.slice(0, 4) : t; };
          const filterValueStems = new Set<string>();
          for (const v of Object.values(mergedFilters)) {
            const ru = normTok(String(v).split('//')[0]);
            for (const w of ru.split(/\s+/)) if (w.length >= 4) filterValueStems.add(stem4(w));
          }
          const cleanExisting = (sp.existingUnresolved || '')
            .split(/\s+/)
            .map(t => t.trim())
            .filter(t => {
              if (!t) return false;
              const nt = normTok(t);
              if (nt.length < 4) return true;
              const ts = stem4(nt);
              if (filterValueStems.has(ts)) {
                console.log(`[Chat] Dropping resolved word "${t}" from existingUnresolved (matches filter stem "${ts}")`);
                return false;
              }
              return true;
            });
          
          // Suppress literal query via unified helper (consilium fix).
          // Build candidate literal from leftover unresolved + cleaned existing,
          // then drop tokens that 1:1 match a resolved-modifier stem AND a
          // resolved-value stem. allowEmptyQuery=true (slot ветка имеет options).
          const slotLiteralRaw = [...cleanExisting, ...stillUnresolved].filter(Boolean).join(' ').trim() || null;
          const mergedQuery = suppressResolvedFromQuery(
            slotLiteralRaw,
            extractResolvedValues(mergedFilters),
            modifiersToResolve,
            { allowEmptyQuery: true, path: 'slot' },
          );
          console.log(`[Chat] Merged filters=${JSON.stringify(mergedFilters)}, mergedQuery="${mergedQuery}"`);
          
          // Step 4: API call with structured filters
          foundProducts = await searchProductsByCandidate(
            { query: mergedQuery, brand: null, category: sp.category, min_price: null, max_price: null },
            appSettings.volt220_api_token!, 50,
            Object.keys(mergedFilters).length > 0 ? mergedFilters : undefined
          );
          { const _r = pickDisplayWithTotal(foundProducts); foundProducts = _r.displayed; totalCollected = _r.total; totalCollectedBranch = 'slot'; console.log(`[Chat] DisplayLimit: collected=${_r.total} displayed=${_r.displayed.length} branch=slot zeroFiltered=${_r.filteredZeroPrice}`); }
          articleShortCircuit = true;
          dialogSlots = slotResolution.updatedSlots;
          slotsUpdated = true;
          console.log(`[Chat] product_search slot resolved via API: ${foundProducts.length} products`);
          
          // If still >7, create new slot with MERGED filters for next refinement
          if (foundProducts.length > 7) {
            const newSlotKey = `ps_${Date.now()}`;
            dialogSlots[newSlotKey] = {
              intent: 'product_search',
              base_category: sp.baseCategory || effectiveCategory,
              plural_category: sp.category,
              resolved_filters: JSON.stringify(mergedFilters),
              unresolved_query: mergedQuery || '',
              status: 'pending',
              created_turn: messages.length,
              turns_since_touched: 0,
            };
            console.log(`[Chat] Re-created product_search slot "${newSlotKey}": mergedQuery="${mergedQuery}", mergedFilters=${JSON.stringify(mergedFilters)}`);
          }
        } else if (slotResolution && 'disambiguation' in slotResolution) {
          // Plan V7 — category_disambiguation slot resolved.
          // User picked a category (chip click or matching reply). Run a
          // direct catalog search using the chosen pagetitle + saved
          // pending modifiers/filters from the original query. Skips the
          // matcher/ambiguity classifier entirely.
          const dis = slotResolution.disambiguation;
          dialogSlots = slotResolution.updatedSlots;
          slotsUpdated = true;
          effectiveCategory = dis.chosenPagetitle;
          // Treat saved modifiers as the search modifiers for downstream
          // ranking/snippet logic (so "чёрные двухместные" still influences
          // bucket selection if more than one bucket comes back).
          if (classification) {
            classification.search_modifiers = [
              ...(classification.search_modifiers || []),
              ...dis.pendingModifiers,
            ];
          }
          // Compose a literal query out of saved modifiers so the API can
          // narrow within the chosen category. If we also have pre-resolved
          // filters from the original turn, pass them through.
          const disQuery = dis.pendingModifiers.length > 0
            ? dis.pendingModifiers.join(' ')
            : (dis.originalQuery || null);
          const hasPF = Object.keys(dis.pendingFilters).length > 0;

          if (appSettings.volt220_api_token) {
            const disProducts = await searchProductsByCandidate(
              { query: disQuery, brand: null, category: dis.chosenPagetitle, min_price: null, max_price: null },
              appSettings.volt220_api_token, 50,
              hasPF ? dis.pendingFilters : undefined
            );
            console.log(`[Chat] Disambiguation search: category="${dis.chosenPagetitle}", query="${disQuery}", filters=${JSON.stringify(dis.pendingFilters)} → ${disProducts.length} products`);

            if (disProducts.length > 0) {
              const _r = pickDisplayWithTotal(disProducts);
              foundProducts = _r.displayed;
              totalCollected = _r.total;
              totalCollectedBranch = 'disambiguation';
              articleShortCircuit = true;
              console.log(`[Chat] DisplayLimit: collected=${_r.total} displayed=${_r.displayed.length} branch=disambiguation zeroFiltered=${_r.filteredZeroPrice}`);

              // If still many results, open a product_search slot so the
              // user can keep refining inside the chosen category.
              if (foundProducts.length > 7) {
                const newSlotKey = `ps_${Date.now()}`;
                dialogSlots[newSlotKey] = {
                  intent: 'product_search',
                  base_category: dis.baseCategory || dis.chosenLabel,
                  plural_category: dis.chosenPagetitle,
                  resolved_filters: JSON.stringify(dis.pendingFilters),
                  unresolved_query: disQuery || '',
                  status: 'pending',
                  created_turn: messages.length,
                  turns_since_touched: 0,
                };
                console.log(`[Chat] Disambiguation: opened product_search slot "${newSlotKey}" for further refinement`);
              }
            } else {
              // No results in chosen category — fall through to main pipeline
              // with effectiveCategory set to the chosen pagetitle, so the
              // matcher/cascade can attempt a broader search.
              console.log(`[Chat] Disambiguation: 0 products for "${dis.chosenPagetitle}", falling through to main pipeline`);
            }
          }
        } else if (slotResolution && 'priceIntent' in slotResolution) {
          // Price slot resolved! Use slot's price intent and combined query
          effectivePriceIntent = slotResolution.priceIntent;
          effectiveCategory = slotResolution.query;
          dialogSlots = slotResolution.updatedSlots;
          slotsUpdated = true;
          console.log(`[Chat] Slot-resolved: intent=${effectivePriceIntent}, query="${effectiveCategory}"`);
        } else if (!effectivePriceIntent) {
          // Fallback: legacy detectPendingPriceIntent for clients without slots
          const hasSlots = Object.keys(body.dialogSlots || {}).length > 0;
          if (!hasSlots) {
            const pending = detectPendingPriceIntent(recentHistoryForClassifier);
            if (pending) {
              effectivePriceIntent = pending.priceIntent;
              if (pending.category && userMessage.length < 50) {
                effectiveCategory = `${userMessage} ${pending.category}`.trim();
              } else {
                effectiveCategory = userMessage;
              }
              console.log(`[Chat] Legacy restored pending price intent: ${effectivePriceIntent}, combined category="${effectiveCategory}"`);
            }
          }
        }
        
        // === PRICE INTENT HANDLING ===
        if (effectivePriceIntent && appSettings.volt220_api_token) {
          const priceQuery = effectiveCategory || classification?.product_name || '';
          if (priceQuery) {
            console.log(`[Chat] Price intent detected: ${effectivePriceIntent} for "${priceQuery}"`);
            
            const synonymQueries = generatePriceSynonyms(priceQuery);
            const priceResult = await handlePriceIntent(synonymQueries, effectivePriceIntent, appSettings.volt220_api_token!);
            
            if (priceResult.action === 'answer' && priceResult.products && priceResult.products.length > 0) {
              foundProducts = priceResult.products;
              articleShortCircuit = true;
              // Plan V5: ответ "самая дорогая X — это Y, цена Z" — простой формат, Flash справится.
              responseModel = 'google/gemini-2.5-flash';
              responseModelReason = 'price-shortcircuit';
              console.log(`[Chat] PriceIntent SUCCESS: ${foundProducts.length} products sorted by ${effectivePriceIntent} (total ${priceResult.total})`);
              
              // Mark slot as done
              if (slotResolution) {
                dialogSlots[slotResolution.slotKey] = { ...dialogSlots[slotResolution.slotKey], status: 'done' };
                slotsUpdated = true;
              }
            } else if (priceResult.action === 'clarify') {
              priceIntentClarify = { total: priceResult.total!, category: priceResult.category! };
              articleShortCircuit = true;
              // Уточняющий вопрос — короткий, Flash хватает.
              responseModel = 'google/gemini-2.5-flash';
              responseModelReason = 'price-clarify';
              foundProducts = [];
              console.log(`[Chat] PriceIntent CLARIFY: ${priceResult.total} products in "${priceResult.category}", asking user to narrow down`);
              
              // Create a new pending slot for this clarification
              if (!slotResolution) {
                const slotKey = `slot_${Date.now()}`;
                dialogSlots[slotKey] = {
                  intent: 'price_extreme',
                  price_dir: effectivePriceIntent,
                  base_category: priceResult.category!,
                  status: 'pending',
                  created_turn: messages.length,
                  turns_since_touched: 0,
                };
                slotsUpdated = true;
                console.log(`[Chat] Created new price slot: "${slotKey}" for "${priceResult.category}" (${effectivePriceIntent})`);
              }
            } else {
              console.log(`[Chat] PriceIntent: no results for "${priceQuery}" (tried ${synonymQueries.length} variants), falling through WITH price intent preserved`);
              // CRITICAL: Do NOT reset effectivePriceIntent here — it will be used by fallback pipeline
            }
          }
        } else if (effectivePriceIntent && !effectiveCategory) {
          console.log(`[Chat] Price intent detected but no category, skipping`);
        }
        
        // === TITLE-FIRST (only if price intent didn't handle it AND not a replacement intent) ===
        // For is_replacement=true: skip title-first short-circuit so the replacement-block can do
        // characteristics-first search and return ANALOGS (not the original product) to the user.
        if (!articleShortCircuit && classification?.has_product_name && classification.product_name && !classification?.is_replacement) {
          const searchStart = Date.now();
          const directResults = await searchProductsByCandidate(
            { query: classification.product_name, brand: null, category: null, min_price: null, max_price: null },
            appSettings.volt220_api_token!,
            15
          );
          const searchElapsed = Date.now() - searchStart;
          console.log(`[Chat] Title-first search: ${directResults.length} products in ${searchElapsed}ms for "${classification.product_name}"`);
          
          if (directResults.length > 0) {
            foundProducts = directResults.slice(0, 10);
            articleShortCircuit = true;
            console.log(`[Chat] Title-first SUCCESS: ${foundProducts.length} products, skipping LLM 1 (total ${classifyElapsed + searchElapsed}ms)`);
          } else {
            console.log(`[Chat] Title-first: 0 results for "${classification.product_name}", proceeding to LLM 1`);
          }
        } else if (classification?.is_replacement && classification?.has_product_name && classification?.product_name) {
          console.log(`[Chat] Title-first SKIPPED: is_replacement=true, deferring to replacement-pipeline (characteristics-first)`);
        }
        
        // === CATEGORY-FIRST (category without specific product name) ===
        if (!articleShortCircuit && effectiveCategory && !classification?.has_product_name && !classification?.is_replacement && !effectivePriceIntent && appSettings.volt220_api_token) {
          const modifiers = classification?.search_modifiers || [];
          console.log(`[Chat] Category-first: category="${effectiveCategory}", modifiers=[${modifiers.join(', ')}]`);
          const categoryStart = Date.now();

          // ===== NEW: SEMANTIC CATEGORY-MATCHER PATH (race with 10s timeout) =====
          // Maps user query → exact pagetitle[] from /api/categories via LLM.
          // On WIN: short-circuits, sets foundProducts, skips legacy bucket-logic below.
          // On miss/timeout/empty: falls through to legacy logic (no regression).
          let categoryFirstWinResolved = false;
          // Plan V4 — last 3 user replies for matcher (Rule 7 household-vs-industrial preference).
          // Hoisted to outer scope so the V7 ambiguity classifier can reuse the same context.
          const historyContextForMatcher = (historyForContext || [])
            .filter((m: any) => m && m.role === 'user')
            .slice(-3)
            .map((m: any) => `- ${String(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 200)}`)
            .join('\n');
          try {
            const matcherDeadline = new Promise<{ matches: string[] }>((_, rej) =>
              setTimeout(() => rej(new Error('matcher_timeout_10s')), 10000)
            );
            const matcherWork = (async () => {
              const catalog = await getCategoriesCache(appSettings.volt220_api_token!);
              if (catalog.length === 0) return { matches: [] };
              const matches = await matchCategoriesWithLLM(effectiveCategory, catalog, appSettings, historyContextForMatcher);
              return { matches };
            })();
            const { matches } = await Promise.race([matcherWork, matcherDeadline]);

            if (matches.length > 0) {
              // Plan V7 — Category disambiguation: if matcher returned ≥2 buckets, ask the
              // dedicated classifier whether they are SYNONYMS (proceed normally) or DISTINCT
              // groups (ask the user). Skips classifier when matches.length < 2.
              if (matches.length >= 2 && !disambiguationResponse) {
                const ambiguity = await classifyCategoryAmbiguity(
                  effectiveCategory, matches, appSettings, historyContextForMatcher
                );
                if (ambiguity.ambiguous) {
                  const preMods = (classification?.search_modifiers || []).join(' ').trim();
                  const slotKey = `cd_${Date.now()}`;
                  dialogSlots[slotKey] = {
                    intent: 'category_disambiguation',
                    base_category: effectiveCategory,
                    candidate_options: JSON.stringify(ambiguity.options),
                    pending_modifiers: preMods || undefined,
                    original_query: userMessage.slice(0, 200),
                    status: 'pending',
                    created_turn: messages.length,
                    turns_since_touched: 0,
                  };
                  slotsUpdated = true;
                  const optionLabels = ambiguity.options.map(o => o.label);
                  const niceList = optionLabels.length === 2
                    ? `${optionLabels[0]} или ${optionLabels[1]}`
                    : optionLabels.slice(0, -1).join(', ') + ` или ${optionLabels[optionLabels.length - 1]}`;
                  disambiguationResponse = {
                    content: `Уточните, пожалуйста: вас интересуют ${niceList}?`,
                    quick_replies: ambiguity.options.map(o => ({ label: o.label, value: o.value })),
                  };
                  console.log(`[Chat] CategoryAmbiguity SHORT-CIRCUIT: slot="${slotKey}", options=${JSON.stringify(optionLabels)}, preMods="${preMods}"`);
                  categoryFirstWinResolved = true;
                  articleShortCircuit = true;
                }
              }

              // Plan V4 — Domain Guard: remember which categories matcher selected
              // so rerankProducts can drop products from unrelated categories later.
              for (const m of matches) allowedCategoryTitles.add(m);
              console.log(`[Chat] CategoryMatcher WIN candidates for "${effectiveCategory}": ${JSON.stringify(matches)} (allowedCategoryTitles set, size=${allowedCategoryTitles.size})`);
              // Parallel: GET ?category=<exact pagetitle> for each match, plus query-fallback safety net
              const catPromises = matches.map(cat =>
                searchProductsByCandidate(
                  { query: null, brand: null, category: cat, min_price: null, max_price: null },
                  appSettings.volt220_api_token!, 30
                )
              );
              const queryFallbackPromise = searchProductsByCandidate(
                { query: effectiveCategory, brand: null, category: null, min_price: null, max_price: null },
                appSettings.volt220_api_token!, 30
              );
              const allRes = await Promise.all([...catPromises, queryFallbackPromise]);
              const matcherSeenIds = new Set<string | number>();
              const matcherProducts: Product[] = [];
              // Prefer exact-category matches first (their results land before query-fallback in iteration order)
              for (let i = 0; i < allRes.length; i++) {
                const arr = allRes[i];
                for (const p of arr) {
                  if (!matcherSeenIds.has(p.id)) {
                    matcherSeenIds.add(p.id);
                    matcherProducts.push(p);
                  }
                }
              }
              const matchedCategorySet = new Set(matches);
              const exactCategoryHits = matcherProducts.filter(p =>
                matchedCategorySet.has((p as any).category?.pagetitle || '')
              );
              console.log(`[Chat] CategoryMatcher merged ${matcherProducts.length} unique (${exactCategoryHits.length} in matched categories)`);

              if (matcherProducts.length === 0) {
                console.log(`[Chat] [Path] FALLBACK_TO_BUCKETS reason=zero_after_category_search effectiveCategory="${effectiveCategory}"`);
              } else if (modifiers.length === 0) {
                // No modifiers — return matched-category products directly (or full set if matched is empty)
                const pool = exactCategoryHits.length > 0 ? exactCategoryHits : matcherProducts;
                { const _r = pickDisplayWithTotal(pool); foundProducts = _r.displayed; totalCollected = _r.total; totalCollectedBranch = 'matcher_no_modifiers'; console.log(`[Chat] DisplayLimit: collected=${_r.total} displayed=${_r.displayed.length} branch=matcher_no_modifiers zeroFiltered=${_r.filteredZeroPrice}`); }
                articleShortCircuit = true;
                categoryFirstWinResolved = true;
                console.log(`[Chat] [Path] WIN mode=no_modifiers matched_cats=${matches.length} count=${foundProducts.length} elapsed=${Date.now() - categoryStart}ms`);
              } else {
                // Load FULL category options schema (all keys + all values across the matched
                // categories) so the FilterLLM is not constrained to whatever options happen to
                // appear in the first 30 products. This is the fix for "белая двухгнёздная розетка".
                const fullSchema = await getUnionCategoryOptionsSchema(matches, appSettings.volt220_api_token!);

                // Resolve filters once on the merged pool, with the full schema as authoritative source
                const { resolved: mResolvedRaw, unresolved: mUnresolved } = await resolveFiltersWithLLM(
                  matcherProducts, modifiers, appSettings, classification?.critical_modifiers, fullSchema
                );
                const mResolved = flattenResolvedFilters(mResolvedRaw);
                console.log(`[Chat] CategoryMatcher resolved=${JSON.stringify(mResolved)}, unresolved=[${mUnresolved.join(', ')}]`);

                // Build literal from FULL modifier list, then drop only tokens
                // that map to resolved values (unified helper, allowEmpty=true).
                const matcherLiteral = modifiers.length > 0 ? modifiers.join(' ') : null;
                const queryText = suppressResolvedFromQuery(
                  matcherLiteral,
                  extractResolvedValues(mResolved),
                  modifiers,
                  { allowEmptyQuery: true, path: 'matcher' },
                );
                const filteredPromises = matches.map(cat =>
                  searchProductsByCandidate(
                    { query: queryText, brand: null, category: cat, min_price: null, max_price: null },
                    appSettings.volt220_api_token!, 30,
                    Object.keys(mResolved).length > 0 ? mResolved : undefined
                  )
                );
                const filteredRes = await Promise.all(filteredPromises);
                const filtSeen = new Set<string | number>();
                let filteredProducts: Product[] = [];
                for (const arr of filteredRes) {
                  for (const p of arr) {
                    if (!filtSeen.has(p.id)) { filtSeen.add(p.id); filteredProducts.push(p); }
                  }
                }
                console.log(`[Chat] CategoryMatcher server-filtered: ${filteredProducts.length} products across ${matches.length} categories`);

                // Cascading relaxed: drop one non-critical filter at a time
                if (filteredProducts.length === 0 && Object.keys(mResolved).length > 1) {
                  const filterKeys = Object.keys(mResolved);
                  const droppable = filterKeys.filter(k => !(mResolvedRaw[k]?.is_critical));
                  let bestRelaxed: Product[] = [];
                  let droppedKey = '';
                  for (const dropKey of droppable) {
                    const partial = { ...mResolved };
                    delete partial[dropKey];
                    const relaxedRes = await Promise.all(
                      matches.map(cat => searchProductsByCandidate(
                        { query: null, brand: null, category: cat, min_price: null, max_price: null },
                        appSettings.volt220_api_token!, 30, partial
                      ))
                    );
                    const relaxedSeen = new Set<string | number>();
                    const relaxedMerged: Product[] = [];
                    for (const arr of relaxedRes) for (const p of arr) {
                      if (!relaxedSeen.has(p.id)) { relaxedSeen.add(p.id); relaxedMerged.push(p); }
                    }
                    if (relaxedMerged.length > bestRelaxed.length) {
                      bestRelaxed = relaxedMerged;
                      droppedKey = dropKey;
                    }
                  }
                  if (bestRelaxed.length > 0) {
                    filteredProducts = bestRelaxed;
                    console.log(`[Chat] CategoryMatcher relaxed (dropped ${droppedKey}): ${filteredProducts.length} products`);
                  }
                }

                if (filteredProducts.length > 0) {
                  { const _r = pickDisplayWithTotal(filteredProducts); foundProducts = _r.displayed; totalCollected = _r.total; totalCollectedBranch = 'matcher_server'; console.log(`[Chat] DisplayLimit: collected=${_r.total} displayed=${_r.displayed.length} branch=matcher_server zeroFiltered=${_r.filteredZeroPrice}`); }
                  articleShortCircuit = true;
                  categoryFirstWinResolved = true;
                  console.log(`[Chat] [Path] WIN mode=server_match matched_cats=${matches.length} resolved=${Object.keys(mResolved).length}/${modifiers.length} count=${foundProducts.length} elapsed=${Date.now() - categoryStart}ms`);

                  // Slot for refinement
                  if (foundProducts.length > 7) {
                    const slotKey = `ps_${Date.now()}`;
                    dialogSlots[slotKey] = {
                      intent: 'product_search',
                      base_category: effectiveCategory,
                      plural_category: matches[0],
                      resolved_filters: JSON.stringify(mResolved || {}),
                      unresolved_query: mUnresolved?.length > 0 ? mUnresolved.join(' ') : '',
                      status: 'pending',
                      created_turn: messages.length,
                      turns_since_touched: 0,
                    };
                    slotsUpdated = true;
                    console.log(`[Chat] CategoryMatcher created slot "${slotKey}"`);
                  }
                } else {
                  console.log(`[Chat] [Path] FALLBACK_TO_BUCKETS reason=zero_after_filters matched_cats=${matches.length}`);
                }
              }
            } else {
              console.log(`[Chat] [Path] FALLBACK_TO_BUCKETS reason=matcher_empty effectiveCategory="${effectiveCategory}"`);
            }
          } catch (matcherErr) {
            console.log(`[Chat] [Path] FALLBACK_TO_BUCKETS reason=${(matcherErr as Error).message}`);
          }

          if (!categoryFirstWinResolved) {
          // ===== LEGACY bucket-logic (fallback when matcher fails) =====
          // Step 1: Two parallel searches — by category AND by query (to cover multiple subcategories)
          let pluralCategory = toPluralCategory(effectiveCategory);
          console.log(`[Chat] Category-first: plural="${pluralCategory}"`);
          
          // Search 1: strict category match
          const categorySearchPromise = searchProductsByCandidate(
            { query: null, brand: null, category: pluralCategory, min_price: null, max_price: null },
            appSettings.volt220_api_token, 50
          );
          // Search 2: broad query match (catches related subcategories)
          const querySearchPromise = searchProductsByCandidate(
            { query: effectiveCategory, brand: null, category: null, min_price: null, max_price: null },
            appSettings.volt220_api_token, 50
          );
          const [catResults, queryResults] = await Promise.all([categorySearchPromise, querySearchPromise]);
          console.log(`[Chat] Category-first: category="${pluralCategory}" → ${catResults.length}, query="${effectiveCategory}" → ${queryResults.length}`);
          
          // Merge results, deduplicate by id
          const seenIds = new Set<string | number>();
          let rawProducts: Product[] = [];
          for (const p of [...catResults, ...queryResults]) {
            if (!seenIds.has(p.id)) {
              seenIds.add(p.id);
              rawProducts.push(p);
            }
          }
          console.log(`[Chat] Category-first: merged ${rawProducts.length} unique products`);
          
          // Track which decision branch produced final results (used in DECISION log below)
          let resultMode: string = 'init';

          if (rawProducts.length > 0 && modifiers.length > 0) {
            // Bucketize by category
            console.log(`[Chat] Category-first STAGE 1: ${rawProducts.length} products for schema extraction`);
            
            const categoryDistribution: Record<string, number> = {};
            for (const p of rawProducts) {
              const catTitle = (p as any).category?.pagetitle || (p as any).parent_name || 'unknown';
              categoryDistribution[catTitle] = (categoryDistribution[catTitle] || 0) + 1;
            }
            console.log(`[Chat] Category-buckets: ${JSON.stringify(categoryDistribution)}`);

            // Try each bucket with resolveFiltersWithLLM, pick the one that resolves the most modifiers.
            // Prioritize buckets whose name matches classifier.category (root match) before sorting by size.
            const sortedBuckets = prioritizeBuckets(categoryDistribution, effectiveCategory);
            console.log(`[Chat] Sorted buckets (category-first, kw="${effectiveCategory}"): ${JSON.stringify(sortedBuckets.slice(0, MAX_BUCKETS_TO_CHECK))}`);
            // Compute priority map for fallback (priority=2 = root match with classifier.category)
            const bucketPriority: Record<string, number> = {};
            for (const [name] of sortedBuckets) {
              const lower = name.toLowerCase();
              const kw = (effectiveCategory || '').toLowerCase().trim();
              const root = kw.replace(/(ыми|ями|ами|ого|ему|ому|ой|ей|ую|юю|ие|ые|ах|ям|ов|ев|ам|ы|и|а|у|е|о|я)$/, '');
              const useRoot = root.length >= 4 ? root : kw;
              bucketPriority[name] = (kw && lower.includes(kw)) || (useRoot && lower.includes(useRoot)) ? 2 : 0;
            }
            
            let bestBucketCat = '';
            let bestResolvedRaw: Record<string, ResolvedFilter> = {};
            let bestUnresolved: string[] = [...modifiers];

            // Trust the classifier: only consider buckets whose category name matches
            // the classifier root (priority=2). This prevents irrelevant categories
            // (e.g. "Колодки" for query "розетка") from winning the resolve loop just
            // because they happened to match more modifier filters.
            // Fallback to all buckets only if NO bucket matches the classifier.
            const allBuckets = sortedBuckets.slice(0, MAX_BUCKETS_TO_CHECK);
            const relevantBuckets = allBuckets.filter(([name]) => bucketPriority[name] === 2);
            const bucketsToTry = relevantBuckets.length > 0 ? relevantBuckets : allBuckets;
            console.log(
              relevantBuckets.length > 0
                ? `[Chat] Category-first: ${relevantBuckets.length}/${allBuckets.length} relevant buckets (match classifier="${effectiveCategory}")`
                : `[Chat] Category-first: NO buckets match classifier="${effectiveCategory}", fallback to all ${allBuckets.length}`
            );

            // Pre-load full category option schemas for all candidate buckets in parallel.
            // This ensures FilterLLM sees the AUTHORITATIVE list of keys/values for each
            // category (not just whatever happens to be in the 24-item sample), so modifiers
            // like "двухместная" can be matched to keys like `kolichestvo_razyemov` even when
            // the sample doesn't contain a single double socket. Cached 30 min per category.
            const bucketCatNames = bucketsToTry.filter(([, c]) => c >= 2).map(([n]) => n);
            const bucketSchemaMap: Map<string, Map<string, { caption: string; values: Set<string> }>> = new Map();
            if (appSettings.volt220_api_token && bucketCatNames.length > 0) {
              const schemas = await Promise.all(
                bucketCatNames.map(n => getCategoryOptionsSchema(n, appSettings.volt220_api_token!).then(r => r.schema).catch(() => new Map<string, { caption: string; values: Set<string> }>()))
              );
              bucketCatNames.forEach((n, i) => bucketSchemaMap.set(n, schemas[i]));
            }

            for (const [catName, count] of bucketsToTry) {
              if (count < 2) continue;
              let bucketProducts = rawProducts.filter(p => 
                ((p as any).category?.pagetitle || (p as any).parent_name || 'unknown') === catName
              );
              if (bucketProducts.length < 10 && appSettings.volt220_api_token) {
                console.log(`[Chat] Bucket "${catName}" too small (${bucketProducts.length}), fetching more for schema...`);
                const extraProducts = await searchProductsByCandidate(
                  { query: null, brand: null, category: catName, min_price: null, max_price: null },
                  appSettings.volt220_api_token, 50
                );
                if (extraProducts.length > bucketProducts.length) {
                  bucketProducts = extraProducts;
                  console.log(`[Chat] Bucket "${catName}" expanded to ${bucketProducts.length} products`);
                }
              }
              const bucketSchema = bucketSchemaMap.get(catName);
              const { resolved: br, unresolved: bu } = await resolveFiltersWithLLM(
                bucketProducts, modifiers, appSettings, classification?.critical_modifiers,
                bucketSchema && bucketSchema.size > 0 ? bucketSchema : undefined
              );
              console.log(`[Chat] Bucket "${catName}" (${bucketProducts.length}, schema=${bucketSchema?.size || 0} keys): resolved=${JSON.stringify(flattenResolvedFilters(br))}, unresolved=[${bu.join(', ')}]`);
              
              if (Object.keys(br).length > Object.keys(bestResolvedRaw).length) {
                bestBucketCat = catName;
                bestResolvedRaw = br;
                bestUnresolved = bu;
              }
              if (Object.keys(br).length >= modifiers.length) break;
            }
            
            if (Object.keys(bestResolvedRaw).length === 0 && sortedBuckets.length > 0) {
              bestBucketCat = sortedBuckets[0][0];
              console.log(`[Chat] No bucket resolved modifiers, using largest: "${bestBucketCat}"`);
            }
            
            if (bestBucketCat) {
              console.log(`[Chat] Category-first WINNER: "${bestBucketCat}" (resolved ${Object.keys(bestResolvedRaw).length}/${modifiers.length})`);
              pluralCategory = bestBucketCat;
            }
            
            const resolvedFiltersRaw = bestResolvedRaw;
            const resolvedFilters = flattenResolvedFilters(resolvedFiltersRaw);
            const unresolvedMods = bestUnresolved;

            if (foundProducts.length === 0 && (Object.keys(resolvedFilters).length > 0 || unresolvedMods.length > 0)) {
              console.log(`[Chat] Category-first resolved filters: ${JSON.stringify(resolvedFilters)}, unresolved: [${unresolvedMods.join(', ')}]`);

              // STAGE 2: Hybrid API call — resolved → options, unresolved → query text.
              // Use unified suppressResolvedFromQuery helper (allowEmpty=true for bucket-N).
              const bucketLiteral = modifiers.length > 0 ? modifiers.join(' ') : null;
              const queryText = suppressResolvedFromQuery(
                bucketLiteral,
                extractResolvedValues(resolvedFilters),
                modifiers,
                { allowEmptyQuery: true, path: 'bucket-N' },
              );
              console.log(`[Chat] Category-first STAGE 2: server options=${JSON.stringify(resolvedFilters)}, query="${queryText}"`);
              let serverFiltered = await searchProductsByCandidate(
                { query: queryText, brand: null, category: pluralCategory, min_price: null, max_price: null },
                appSettings.volt220_api_token, 50,
                Object.keys(resolvedFilters).length > 0 ? resolvedFilters : undefined
              );
              console.log(`[Chat] Category-first server-filtered: ${serverFiltered.length} products`);

              if (serverFiltered.length > 0) {
                { const _r = pickDisplayWithTotal(serverFiltered); foundProducts = _r.displayed; totalCollected = _r.total; totalCollectedBranch = 'bucket-N'; console.log(`[Chat] DisplayLimit: collected=${_r.total} displayed=${_r.displayed.length} branch=bucket-N zeroFiltered=${_r.filteredZeroPrice}`); }
                articleShortCircuit = true;
                resultMode = 'server_exact_match';
              } else {
                // FALLBACK на bucket-2 — только bucket'ы с priority=2 (корневой матч)
                const altBuckets = sortedBuckets
                  .filter(([name]) => name !== bestBucketCat && bucketPriority[name] === 2)
                  .slice(0, 2);
                for (const [altCat, altCount] of altBuckets) {
                  if (altCount < 2) continue;
                  console.log(`[Chat] STAGE 2 fallback to bucket-N: "${altCat}" (priority=2)`);
                  let altProducts = rawProducts.filter(p =>
                    ((p as any).category?.pagetitle || (p as any).parent_name || 'unknown') === altCat
                  );
                  if (altProducts.length < 10 && appSettings.volt220_api_token) {
                    const extra = await searchProductsByCandidate(
                      { query: null, brand: null, category: altCat, min_price: null, max_price: null },
                      appSettings.volt220_api_token, 50
                    );
                    if (extra.length > altProducts.length) altProducts = extra;
                  }
                  const altSchema: Map<string, { caption: string; values: Set<string> }> = appSettings.volt220_api_token
                    ? await getCategoryOptionsSchema(altCat, appSettings.volt220_api_token).then(r => r.schema).catch(() => new Map<string, { caption: string; values: Set<string> }>())
                    : new Map<string, { caption: string; values: Set<string> }>();
                  const { resolved: altResolvedRaw, unresolved: altUnresolved } = await resolveFiltersWithLLM(
                    altProducts, modifiers, appSettings, classification?.critical_modifiers,
                    altSchema && altSchema.size > 0 ? altSchema : undefined
                  );
                  console.log(`[Chat] Alt bucket "${altCat}" schema=${altSchema?.size || 0} keys`);
                  const altResolved = flattenResolvedFilters(altResolvedRaw);
                  if (Object.keys(altResolved).length === 0) {
                    console.log(`[Chat] Alt bucket "${altCat}" resolved nothing, skip`);
                    continue;
                  }
                  const altLiteral = modifiers.length > 0 ? modifiers.join(' ') : null;
                  const altQuery = suppressResolvedFromQuery(
                    altLiteral,
                    extractResolvedValues(altResolved),
                    modifiers,
                    { allowEmptyQuery: true, path: 'alt-bucket' },
                  );
                  const altServer = await searchProductsByCandidate(
                    { query: altQuery, brand: null, category: altCat, min_price: null, max_price: null },
                    appSettings.volt220_api_token, 50,
                    altResolved
                  );
                  console.log(`[Chat] Alt bucket "${altCat}" server-filtered: ${altServer.length} products`);
                  if (altServer.length > 0) {
                    { const _r = pickDisplayWithTotal(altServer); foundProducts = _r.displayed; totalCollected = _r.total; totalCollectedBranch = `alt-bucket:${altCat}`; console.log(`[Chat] DisplayLimit: collected=${_r.total} displayed=${_r.displayed.length} branch=alt-bucket zeroFiltered=${_r.filteredZeroPrice}`); }
                    pluralCategory = altCat;
                    articleShortCircuit = true;
                    resultMode = `server_exact_match (alt-bucket "${altCat}")`;
                    break;
                  }
                }

                // Cascading relaxed fallback: drop one filter at a time, but NEVER drop critical ones
                if (foundProducts.length === 0) {
                  const filterKeys = Object.keys(resolvedFilters);
                  const droppableKeys = filterKeys.filter(k => !(resolvedFiltersRaw[k]?.is_critical));
                  const blockedCritical = filterKeys.filter(k => resolvedFiltersRaw[k]?.is_critical);
                  if (droppableKeys.length === 0 && filterKeys.length > 0) {
                    console.log(`[Chat] Relaxed BLOCKED (critical: ${blockedCritical.join(', ')}) — all resolved filters are critical`);
                  } else if (filterKeys.length > 1) {
                    let bestRelaxed: Product[] = [];
                    let droppedKey = '';
                    for (const dropKey of droppableKeys) {
                      const partial = { ...resolvedFilters };
                      delete partial[dropKey];
                      const partialResult = await searchProductsByCandidate(
                        { query: null, brand: null, category: pluralCategory, min_price: null, max_price: null },
                        appSettings.volt220_api_token, 50,
                        partial
                      );
                      console.log(`[Chat] Relaxed server filter (dropped ${dropKey}): ${partialResult.length} products`);
                      if (partialResult.length > bestRelaxed.length) {
                        bestRelaxed = partialResult;
                        droppedKey = dropKey;
                      }
                    }
                    if (bestRelaxed.length > 0) {
                      { const _r = pickDisplayWithTotal(bestRelaxed); foundProducts = _r.displayed; totalCollected = _r.total; totalCollectedBranch = 'relaxed'; console.log(`[Chat] DisplayLimit: collected=${_r.total} displayed=${_r.displayed.length} branch=relaxed zeroFiltered=${_r.filteredZeroPrice}`); }
                      articleShortCircuit = true;
                      resultMode = `relaxed_server_match (dropped ${droppedKey})`;
                    }
                  }
                }

                if (foundProducts.length === 0) {
                  // Honest no_match when critical filters block relaxed; otherwise text fallback
                  const filterKeys = Object.keys(resolvedFilters);
                  const allCritical = filterKeys.length > 0 && filterKeys.every(k => resolvedFiltersRaw[k]?.is_critical);
                  if (allCritical) {
                    console.log(`[Chat] Category-first: honest no_match (all filters critical, no products)`);
                    foundProducts = [];
                    articleShortCircuit = false;
                    resultMode = 'no_match_critical';
                  } else {
                    const modifierQuery = modifiers.join(' ');
                    console.log(`[Chat] Category-first final fallback: query="${modifierQuery}" + category="${pluralCategory}"`);
                    const textFallback = await searchProductsByCandidate(
                      { query: modifierQuery, brand: null, category: pluralCategory, min_price: null, max_price: null },
                      appSettings.volt220_api_token, 50
                    );
                    if (textFallback.length > 0) {
                      { const _r = pickDisplayWithTotal(textFallback); foundProducts = _r.displayed; totalCollected = _r.total; totalCollectedBranch = 'text_fallback'; console.log(`[Chat] DisplayLimit: collected=${_r.total} displayed=${_r.displayed.length} branch=text_fallback zeroFiltered=${_r.filteredZeroPrice}`); }
                      articleShortCircuit = true;
                      resultMode = 'text_fallback';
                    } else {
                      foundProducts = [];
                      articleShortCircuit = false;
                      resultMode = 'no_match';
                    }
                  }
                }
              }
            } else {
              { const _r = pickDisplayWithTotal(rawProducts); foundProducts = _r.displayed; totalCollected = _r.total; totalCollectedBranch = 'category-first_no_filters'; console.log(`[Chat] DisplayLimit: collected=${_r.total} displayed=${_r.displayed.length} branch=category-first_no_filters zeroFiltered=${_r.filteredZeroPrice}`); }
              articleShortCircuit = true;
              resultMode = 'no_filters';
            }
            
            const categoryElapsed = Date.now() - categoryStart;
            console.log(`[Chat] Category-first DECISION: mode=${resultMode}, count=${foundProducts.length}, elapsed=${categoryElapsed}ms`);
            
            if (foundProducts.length > 7) {
              const slotKey = `ps_${Date.now()}`;
              dialogSlots[slotKey] = {
                intent: 'product_search',
                base_category: effectiveCategory || pluralCategory,
                plural_category: pluralCategory,
                resolved_filters: JSON.stringify(resolvedFilters || {}),
                unresolved_query: unresolvedMods?.length > 0 ? unresolvedMods.join(' ') : '',
                status: 'pending',
                created_turn: messages.length,
                turns_since_touched: 0,
              };
              slotsUpdated = true;
              console.log(`[Chat] Created product_search slot "${slotKey}": filters=${JSON.stringify(resolvedFilters || {})}, query="${unresolvedMods?.length > 0 ? unresolvedMods.join(' ') : ''}"`);
            }
          } else if (rawProducts.length > 0) {
            { const _r = pickDisplayWithTotal(rawProducts); foundProducts = _r.displayed; totalCollected = _r.total; totalCollectedBranch = 'category-first_no_modifiers'; console.log(`[Chat] DisplayLimit: collected=${_r.total} displayed=${_r.displayed.length} branch=category-first_no_modifiers zeroFiltered=${_r.filteredZeroPrice}`); }
            articleShortCircuit = true;
            const categoryElapsed = Date.now() - categoryStart;
            console.log(`[Chat] Category-first DECISION: mode=no_modifiers, count=${foundProducts.length}, elapsed=${categoryElapsed}ms`);
          } else {
            const categoryElapsed = Date.now() - categoryStart;
            console.log(`[Chat] Category-first: 0 results for "${effectiveCategory}", elapsed=${categoryElapsed}ms, proceeding to LLM 1`);
          }
          } // end if (!categoryFirstWinResolved) — legacy bucket-logic block
        }
        
        // === REPLACEMENT/ALTERNATIVE INTENT (category-first pipeline) ===
        if (classification?.is_replacement && appSettings.volt220_api_token) {
         try {
          console.log(`[Chat] Replacement intent detected!`);
          const replacementStart = Date.now();
          
          let originalProduct: Product | null = null;
          
          if (articleShortCircuit && foundProducts.length > 0) {
            originalProduct = foundProducts[0];
            console.log(`[Chat] Replacement: original found "${originalProduct.pagetitle}"`);
          }
          
          // Determine category and modifiers for category-first search
          let replCategory = '';
          let replModifiers: string[] = [];
          
          if (originalProduct) {
            // Case 1: Original product found — extract category & modifiers from its data
            replCategory = (originalProduct as any).category?.pagetitle || (originalProduct as any).parent_name || '';
            replModifiers = extractModifiersFromProduct(originalProduct);
            console.log(`[Chat] Replacement: category="${replCategory}", modifiers=[${replModifiers.join(', ')}]`);
          } else if (classification.product_name || (classification.search_modifiers?.length ?? 0) > 0) {
            // Case 2: Product not in catalog — trust the classifier.
            // Modifiers (brand, color, specs) are already extracted semantically by the micro-LLM.
            // No regex slicing: it loses the brand and adds noise like the category word itself.
            replCategory = effectiveCategory || classification.search_category || '';
            replModifiers = [...(classification.search_modifiers || [])];
            console.log(`[Chat] Replacement: NOT found, category="${replCategory}", modifiers=[${replModifiers.join(', ')}] (from classifier)`);
          }
          
          if (replCategory) {
            // ===== NEW: SEMANTIC CATEGORY-MATCHER PATH (race with 10s timeout) =====
            // If originalProduct found → its exact category.pagetitle is used directly (matcher skipped).
            // Otherwise → matcher maps replCategory → exact pagetitle[].
            // On WIN: short-circuits, sets foundProducts + replacementMeta, skips legacy bucket-logic.
            let replacementWinResolved = false;
            try {
              let replMatches: string[] = [];
              const originalCatPagetitle = originalProduct ? ((originalProduct as any).category?.pagetitle || '') : '';
              if (originalCatPagetitle) {
                replMatches = [originalCatPagetitle];
                console.log(`[Chat] Replacement: matcher SKIPPED, using original.category.pagetitle="${originalCatPagetitle}"`);
              } else {
                const replMatcherDeadline = new Promise<{ matches: string[] }>((_, rej) =>
                  setTimeout(() => rej(new Error('repl_matcher_timeout_10s')), 10000)
                );
                const replMatcherWork = (async () => {
                  const catalog = await getCategoriesCache(appSettings.volt220_api_token!);
                  if (catalog.length === 0) return { matches: [] };
                  const matches = await matchCategoriesWithLLM(replCategory, catalog, appSettings);
                  return { matches };
                })();
                const r = await Promise.race([replMatcherWork, replMatcherDeadline]);
                replMatches = r.matches;
              }

              if (replMatches.length > 0) {
                console.log(`[Chat] Replacement matcher candidates for "${replCategory}": ${JSON.stringify(replMatches)}`);
                // Parallel: GET ?category=<exact pagetitle> + query-fallback safety net
                const rCatPromises = replMatches.map(cat =>
                  searchProductsByCandidate(
                    { query: null, brand: null, category: cat, min_price: null, max_price: null },
                    appSettings.volt220_api_token!, 30
                  )
                );
                const rQueryFallback = searchProductsByCandidate(
                  { query: replCategory, brand: null, category: null, min_price: null, max_price: null },
                  appSettings.volt220_api_token!, 30
                );
                const rAllRes = await Promise.all([...rCatPromises, rQueryFallback]);
                const rSeen = new Set<string | number>();
                const rPool: Product[] = [];
                for (const arr of rAllRes) for (const p of arr) {
                  if (!rSeen.has(p.id)) { rSeen.add(p.id); rPool.push(p); }
                }
                console.log(`[Chat] Replacement matcher merged ${rPool.length} unique`);

                if (rPool.length > 0) {
                  let rFinal: Product[] = [];
                  if (replModifiers.length === 0) {
                    rFinal = rPool;
                  } else {
                    // Load full category schema for the replacement target categories
                    const rFullSchema = await getUnionCategoryOptionsSchema(replMatches, appSettings.volt220_api_token!);
                    const { resolved: rResolvedRaw, unresolved: rUnresolved } = await resolveFiltersWithLLM(
                      rPool, replModifiers, appSettings, classification?.critical_modifiers, rFullSchema
                    );
                    const rResolved = flattenResolvedFilters(rResolvedRaw);
                    console.log(`[Chat] Replacement matcher resolved=${JSON.stringify(rResolved)}, unresolved=[${rUnresolved.join(', ')}]`);
                    // Replacement branch: allowEmpty=false (keep literal as fallback signal).
                    const rLiteral = replModifiers.length > 0 ? replModifiers.join(' ') : null;
                    const qText = suppressResolvedFromQuery(
                      rLiteral,
                      extractResolvedValues(rResolved),
                      replModifiers,
                      { allowEmptyQuery: false, path: 'replacement-matcher' },
                    );
                    const rFiltRes = await Promise.all(replMatches.map(cat =>
                      searchProductsByCandidate(
                        { query: qText, brand: null, category: cat, min_price: null, max_price: null },
                        appSettings.volt220_api_token!, 30,
                        Object.keys(rResolved).length > 0 ? rResolved : undefined
                      )
                    ));
                    const rfSeen = new Set<string | number>();
                    for (const arr of rFiltRes) for (const p of arr) {
                      if (!rfSeen.has(p.id)) { rfSeen.add(p.id); rFinal.push(p); }
                    }
                    // Cascading relaxed
                    if (rFinal.length === 0 && Object.keys(rResolved).length > 1) {
                      const droppable = Object.keys(rResolved).filter(k => !(rResolvedRaw[k]?.is_critical));
                      let bestRelaxed: Product[] = [];
                      let droppedKey = '';
                      for (const dropKey of droppable) {
                        const partial = { ...rResolved };
                        delete partial[dropKey];
                        const relaxedRes = await Promise.all(replMatches.map(cat =>
                          searchProductsByCandidate(
                            { query: null, brand: null, category: cat, min_price: null, max_price: null },
                            appSettings.volt220_api_token!, 30, partial
                          )
                        ));
                        const seenR = new Set<string | number>();
                        const merged: Product[] = [];
                        for (const arr of relaxedRes) for (const p of arr) {
                          if (!seenR.has(p.id)) { seenR.add(p.id); merged.push(p); }
                        }
                        if (merged.length > bestRelaxed.length) {
                          bestRelaxed = merged;
                          droppedKey = dropKey;
                        }
                      }
                      if (bestRelaxed.length > 0) {
                        rFinal = bestRelaxed;
                        console.log(`[Chat] Replacement matcher relaxed (dropped ${droppedKey}): ${rFinal.length}`);
                      }
                    }
                  }

                  // Exclude original product
                  const originalId = originalProduct?.id;
                  if (originalId) rFinal = rFinal.filter(p => p.id !== originalId);

                  if (rFinal.length > 0) {
                    { const _r = pickDisplayWithTotal(rFinal); foundProducts = _r.displayed; totalCollected = _r.total; totalCollectedBranch = 'replacement_matcher'; console.log(`[Chat] DisplayLimit: collected=${_r.total} displayed=${_r.displayed.length} branch=replacement_matcher zeroFiltered=${_r.filteredZeroPrice}`); }
                    articleShortCircuit = true;
                    replacementWinResolved = true;
                    replacementMeta = {
                      isReplacement: true,
                      original: originalProduct,
                      originalName: classification.product_name,
                      noResults: false,
                    };
                    console.log(`[Chat] [Path] WIN replacement matched_cats=${replMatches.length} count=${foundProducts.length} elapsed=${Date.now() - replacementStart}ms`);
                  } else {
                    console.log(`[Chat] [Path] FALLBACK_TO_BUCKETS replacement reason=zero_after_filters matched_cats=${replMatches.length}`);
                  }
                } else {
                  console.log(`[Chat] [Path] FALLBACK_TO_BUCKETS replacement reason=zero_pool matched_cats=${replMatches.length}`);
                }
              } else {
                console.log(`[Chat] [Path] FALLBACK_TO_BUCKETS replacement reason=matcher_empty replCategory="${replCategory}"`);
              }
            } catch (rmErr) {
              console.log(`[Chat] [Path] FALLBACK_TO_BUCKETS replacement reason=${(rmErr as Error).message}`);
            }

            if (!replacementWinResolved) {
            // ===== LEGACY bucket-logic for replacement (fallback when matcher fails) =====
            // Run category-first pipeline with bucket-matching
            let pluralRepl = toPluralCategory(replCategory);
            console.log(`[Chat] Replacement category-first: plural="${pluralRepl}"`);
            
            // Two parallel searches: by category + by query
            const replCatPromise = searchProductsByCandidate(
              { query: null, brand: null, category: pluralRepl, min_price: null, max_price: null },
              appSettings.volt220_api_token, 50
            );
            const replQueryPromise = searchProductsByCandidate(
              { query: replCategory, brand: null, category: null, min_price: null, max_price: null },
              appSettings.volt220_api_token, 50
            );
            const [replCatRes, replQueryRes] = await Promise.all([replCatPromise, replQueryPromise]);
            console.log(`[Chat] Replacement: category="${pluralRepl}" → ${replCatRes.length}, query="${replCategory}" → ${replQueryRes.length}`);
            
            // Merge & deduplicate
            const replSeenIds = new Set<string | number>();
            let replRawProducts: Product[] = [];
            for (const p of [...replCatRes, ...replQueryRes]) {
              if (!replSeenIds.has(p.id)) {
                replSeenIds.add(p.id);
                replRawProducts.push(p);
              }
            }
            console.log(`[Chat] Replacement: merged ${replRawProducts.length} unique products`);
            
            if (replRawProducts.length > 0 && replModifiers.length > 0) {
              // Bucketize by category
              const replCatDist: Record<string, number> = {};
              for (const p of replRawProducts) {
                const catTitle = (p as any).category?.pagetitle || (p as any).parent_name || 'unknown';
                replCatDist[catTitle] = (replCatDist[catTitle] || 0) + 1;
              }
              console.log(`[Chat] Replacement buckets: ${JSON.stringify(replCatDist)}`);
              
              // Try each bucket, pick best by resolved count.
              // Prioritize buckets matching classifier.category root.
              const replSortedBuckets = prioritizeBuckets(replCatDist, replCategory);
              console.log(`[Chat] Sorted buckets (replacement, kw="${replCategory}"): ${JSON.stringify(replSortedBuckets.slice(0, MAX_BUCKETS_TO_CHECK))}`);
              const replBucketPriority: Record<string, number> = {};
              for (const [name] of replSortedBuckets) {
                const lower = name.toLowerCase();
                const kw = (replCategory || '').toLowerCase().trim();
                const root = kw.replace(/(ыми|ями|ами|ого|ему|ому|ой|ей|ую|юю|ие|ые|ах|ям|ов|ев|ам|ы|и|а|у|е|о|я)$/, '');
                const useRoot = root.length >= 4 ? root : kw;
                replBucketPriority[name] = (kw && lower.includes(kw)) || (useRoot && lower.includes(useRoot)) ? 2 : 0;
              }
              
              let replBestCat = '';
              let replBestResolvedRaw: Record<string, ResolvedFilter> = {};
              let replBestUnresolved: string[] = [...replModifiers];
              let replacementProducts: Product[] = [];

              // Symmetric to category-first: trust the classifier — only buckets
              // whose category matches the classifier root (priority=2) compete.
              // Fallback to all buckets if none match.
              const replAllBuckets = replSortedBuckets.slice(0, MAX_BUCKETS_TO_CHECK);
              const replRelevantBuckets = replAllBuckets.filter(([name]) => replBucketPriority[name] === 2);
              const replBucketsToTry = replRelevantBuckets.length > 0 ? replRelevantBuckets : replAllBuckets;
              console.log(
                replRelevantBuckets.length > 0
                  ? `[Chat] Replacement: ${replRelevantBuckets.length}/${replAllBuckets.length} relevant buckets (match classifier="${replCategory}")`
                  : `[Chat] Replacement: NO buckets match classifier="${replCategory}", fallback to all ${replAllBuckets.length}`
              );

              for (const [catName, count] of replBucketsToTry) {
                if (count < 2) continue;
                let bucketProducts = replRawProducts.filter(p =>
                  ((p as any).category?.pagetitle || (p as any).parent_name || 'unknown') === catName
                );
                if (bucketProducts.length < 10 && appSettings.volt220_api_token) {
                  console.log(`[Chat] Replacement bucket "${catName}" too small (${bucketProducts.length}), fetching more...`);
                  const extraProducts = await searchProductsByCandidate(
                    { query: null, brand: null, category: catName, min_price: null, max_price: null },
                    appSettings.volt220_api_token, 50
                  );
                  if (extraProducts.length > bucketProducts.length) {
                    bucketProducts = extraProducts;
                    console.log(`[Chat] Replacement bucket "${catName}" expanded to ${bucketProducts.length}`);
                  }
                }
                const { resolved: br, unresolved: bu } = await resolveFiltersWithLLM(bucketProducts, replModifiers, appSettings, classification?.critical_modifiers);
                console.log(`[Chat] Replacement bucket "${catName}" (${bucketProducts.length}): resolved=${JSON.stringify(flattenResolvedFilters(br))}, unresolved=[${bu.join(', ')}]`);
                if (Object.keys(br).length > Object.keys(replBestResolvedRaw).length) {
                  replBestCat = catName;
                  replBestResolvedRaw = br;
                  replBestUnresolved = bu;
                }
                if (Object.keys(br).length >= replModifiers.length) break;
              }
              
              if (Object.keys(replBestResolvedRaw).length === 0 && replSortedBuckets.length > 0) {
                replBestCat = replSortedBuckets[0][0];
              }
              if (replBestCat) {
                console.log(`[Chat] Replacement WINNER: "${replBestCat}" (resolved ${Object.keys(replBestResolvedRaw).length}/${replModifiers.length})`);
                pluralRepl = replBestCat;
              }
              
              const replResolvedFiltersRaw = replBestResolvedRaw;
              const replResolvedFilters = flattenResolvedFilters(replResolvedFiltersRaw);
              const replUnresolvedMods = replBestUnresolved;

              if (replacementProducts.length === 0 && (Object.keys(replResolvedFilters).length > 0 || replUnresolvedMods.length > 0)) {
                console.log(`[Chat] Replacement STAGE 2: resolved options=${JSON.stringify(replResolvedFilters)}, unresolved=[${replUnresolvedMods.join(', ')}]`);
                // STAGE 3: Hybrid API call. Unified helper, allowEmpty=false (replacement).
                const replLiteral = replModifiers.length > 0 ? replModifiers.join(' ') : null;
                const replQueryText = suppressResolvedFromQuery(
                  replLiteral,
                  extractResolvedValues(replResolvedFilters),
                  replModifiers,
                  { allowEmptyQuery: false, path: 'replacement-stage2' },
                );
                console.log(`[Chat] Replacement STAGE 3: API call category="${pluralRepl}", options=${JSON.stringify(replResolvedFilters)}, query="${replQueryText}"`);
                let replFiltered = await searchProductsByCandidate(
                  { query: replQueryText, brand: null, category: pluralRepl, min_price: null, max_price: null },
                  appSettings.volt220_api_token, 50,
                  Object.keys(replResolvedFilters).length > 0 ? replResolvedFilters : undefined
                );
                console.log(`[Chat] Replacement STAGE 3 result: ${replFiltered.length} products`);
                
                // Fallback на bucket-2 (priority=2) ДО relaxed
                if (replFiltered.length === 0) {
                  const altBuckets = replSortedBuckets
                    .filter(([name]) => name !== replBestCat && replBucketPriority[name] === 2)
                    .slice(0, 2);
                  for (const [altCat, altCount] of altBuckets) {
                    if (altCount < 2) continue;
                    console.log(`[Chat] STAGE 2 fallback to bucket-N: "${altCat}" (replacement, priority=2)`);
                    let altProducts = replRawProducts.filter(p =>
                      ((p as any).category?.pagetitle || (p as any).parent_name || 'unknown') === altCat
                    );
                    if (altProducts.length < 10 && appSettings.volt220_api_token) {
                      const extra = await searchProductsByCandidate(
                        { query: null, brand: null, category: altCat, min_price: null, max_price: null },
                        appSettings.volt220_api_token, 50
                      );
                      if (extra.length > altProducts.length) altProducts = extra;
                    }
                    const { resolved: altResolvedRaw, unresolved: altUnresolved } = await resolveFiltersWithLLM(altProducts, replModifiers, appSettings, classification?.critical_modifiers);
                    const altResolved = flattenResolvedFilters(altResolvedRaw);
                    if (Object.keys(altResolved).length === 0) continue;
                    const altReplLiteral = replModifiers.length > 0 ? replModifiers.join(' ') : null;
                    const altQ = suppressResolvedFromQuery(
                      altReplLiteral,
                      extractResolvedValues(altResolved),
                      replModifiers,
                      { allowEmptyQuery: false, path: 'replacement-alt-bucket' },
                    );
                    const altServer = await searchProductsByCandidate(
                      { query: altQ, brand: null, category: altCat, min_price: null, max_price: null },
                      appSettings.volt220_api_token, 50,
                      altResolved
                    );
                    console.log(`[Chat] Replacement alt-bucket "${altCat}" server: ${altServer.length} products`);
                    if (altServer.length > 0) {
                      replFiltered = altServer;
                      pluralRepl = altCat;
                      break;
                    }
                  }
                }

                // Cascading relaxed fallback — only drop NON-critical filters
                if (replFiltered.length === 0) {
                  const replFilterKeys = Object.keys(replResolvedFilters);
                  const droppableKeys = replFilterKeys.filter(k => !(replResolvedFiltersRaw[k]?.is_critical));
                  const blockedCritical = replFilterKeys.filter(k => replResolvedFiltersRaw[k]?.is_critical);
                  if (droppableKeys.length === 0 && replFilterKeys.length > 0) {
                    console.log(`[Chat] Relaxed BLOCKED (replacement, critical: ${blockedCritical.join(', ')})`);
                  } else if (replFilterKeys.length > 1) {
                    let bestRelaxed: Product[] = [];
                    let droppedKey = '';
                    for (const dropKey of droppableKeys) {
                      const partial = { ...replResolvedFilters };
                      delete partial[dropKey];
                      const partialResult = await searchProductsByCandidate(
                        { query: null, brand: null, category: pluralRepl, min_price: null, max_price: null },
                        appSettings.volt220_api_token, 50,
                        partial
                      );
                      console.log(`[Chat] Replacement relaxed (dropped ${dropKey}): ${partialResult.length} products`);
                      if (partialResult.length > bestRelaxed.length) {
                        bestRelaxed = partialResult;
                        droppedKey = dropKey;
                      }
                    }
                    if (bestRelaxed.length > 0) {
                      replFiltered = bestRelaxed;
                      console.log(`[Chat] Replacement relaxed match (dropped ${droppedKey}): ${replFiltered.length} products`);
                    }
                  }
                  
                  // Final fallback: modifiers as text query — only if no critical block
                  if (replFiltered.length === 0 && (droppableKeys.length > 0 || replFilterKeys.length === 0)) {
                    const modQuery = replModifiers.join(' ');
                    replFiltered = await searchProductsByCandidate(
                      { query: modQuery, brand: null, category: pluralRepl, min_price: null, max_price: null },
                      appSettings.volt220_api_token, 50
                    );
                    console.log(`[Chat] Replacement text fallback: ${replFiltered.length} products`);
                  }
                }
                
                // Exclude original product
                const originalId = originalProduct?.id;
                if (originalId) {
                  replFiltered = replFiltered.filter(p => p.id !== originalId);
                }
                
                if (replFiltered.length > 0) {
                  { const _r = pickDisplayWithTotal(replFiltered); foundProducts = _r.displayed; totalCollected = _r.total; totalCollectedBranch = 'replacement_filtered'; console.log(`[Chat] DisplayLimit: collected=${_r.total} displayed=${_r.displayed.length} branch=replacement_filtered zeroFiltered=${_r.filteredZeroPrice}`); }
                  articleShortCircuit = true;
                  replacementMeta = {
                    isReplacement: true,
                    original: originalProduct,
                    originalName: classification.product_name,
                    noResults: false,
                  };
                  
                  // Create slot if >7 results for refinement
                  if (foundProducts.length > 7) {
                    const slotKey = `ps_${Date.now()}`;
                    dialogSlots[slotKey] = {
                      intent: 'product_search',
                      base_category: replCategory,
                      plural_category: pluralRepl,
                      resolved_filters: JSON.stringify(replResolvedFilters || {}),
                      unresolved_query: replUnresolvedMods?.length > 0 ? replUnresolvedMods.join(' ') : '',
                      status: 'pending',
                      created_turn: messages.length,
                      turns_since_touched: 0,
                      isReplacement: true,
                      originalName: originalProduct?.pagetitle || classification.product_name || '',
                    };
                    slotsUpdated = true;
                    console.log(`[Chat] Replacement: created product_search slot "${slotKey}" for refinement`);
                  }
                  
                  console.log(`[Chat] Replacement SUCCESS: ${foundProducts.length} alternatives found (${Date.now() - replacementStart}ms)`);
                } else {
                  replacementMeta = { isReplacement: true, original: originalProduct, originalName: classification.product_name, noResults: true };
                  console.log(`[Chat] Replacement: 0 alternatives after filtering (${Date.now() - replacementStart}ms)`);
                }
              } else {
                // No modifiers resolved — return category products excluding original
                let catProducts = replRawProducts;
                const originalId = originalProduct?.id;
                if (originalId) catProducts = catProducts.filter(p => p.id !== originalId);
                { const _r = pickDisplayWithTotal(catProducts); foundProducts = _r.displayed; totalCollected = _r.total; totalCollectedBranch = 'replacement_cat_no_filters'; console.log(`[Chat] DisplayLimit: collected=${_r.total} displayed=${_r.displayed.length} branch=replacement_cat_no_filters zeroFiltered=${_r.filteredZeroPrice}`); }
                articleShortCircuit = true;
                replacementMeta = { isReplacement: true, original: originalProduct, originalName: classification.product_name, noResults: foundProducts.length === 0 };
                console.log(`[Chat] Replacement: no filters resolved, showing ${foundProducts.length} category products (${Date.now() - replacementStart}ms)`);
              }
            } else if (replRawProducts.length > 0) {
              // No modifiers — show category products
              let catProducts = replRawProducts;
              const originalId = originalProduct?.id;
              if (originalId) catProducts = catProducts.filter(p => p.id !== originalId);
              { const _r = pickDisplayWithTotal(catProducts); foundProducts = _r.displayed; totalCollected = _r.total; totalCollectedBranch = 'replacement_cat_no_modifiers'; console.log(`[Chat] DisplayLimit: collected=${_r.total} displayed=${_r.displayed.length} branch=replacement_cat_no_modifiers zeroFiltered=${_r.filteredZeroPrice}`); }
              articleShortCircuit = true;
              replacementMeta = { isReplacement: true, original: originalProduct, originalName: classification.product_name, noResults: foundProducts.length === 0 };
              console.log(`[Chat] Replacement: no modifiers, showing ${foundProducts.length} category products (${Date.now() - replacementStart}ms)`);
            } else {
              replacementMeta = { isReplacement: true, original: null, originalName: classification.product_name, noResults: true };
              console.log(`[Chat] Replacement: 0 products in category "${replCategory}" (${Date.now() - replacementStart}ms)`);
            }
            } // end if (!replacementWinResolved) — legacy bucket-logic block
          } else {
            replacementMeta = { isReplacement: true, original: null, originalName: classification.product_name, noResults: true };
            console.log(`[Chat] Replacement: no category determined`);
          }
         } catch (replErr) {
           console.log(`[Chat] Replacement pipeline error (original product still returned):`, replErr);
           // replacementMeta may already be set; if not, leave as null so normal flow continues
         }
        }
      } catch (e) {
        console.log(`[Chat] Pipeline error (post-classify branch, fallback to LLM 1):`, e);
      }
    }



    let extractedIntent: ExtractedIntent;
    
    if (articleShortCircuit) {
      extractedIntent = {
        intent: 'catalog',
        candidates: detectedArticles.length > 0 
          ? detectedArticles.map(a => ({ query: a, brand: null, category: null, min_price: null, max_price: null }))
          : [{ query: cleanQueryForDirectSearch(userMessage), brand: null, category: null, min_price: null, max_price: null }],
        originalQuery: userMessage,
      };
    } else if (classification?.intent === 'info' || classification?.intent === 'general') {
      // Micro-LLM already determined intent — skip expensive Gemini Pro call
      console.log(`[Chat] Micro-LLM intent="${classification.intent}" — skipping generateSearchCandidates`);
      extractedIntent = {
        intent: classification.intent,
        candidates: [],
        originalQuery: userMessage,
      };
    } else {
      // catalog/brands or no intent — full pipeline
      // Хардкодим Flash для AI Candidates: задача класса "извлечь структурированные параметры из короткой фразы",
      // Pro здесь избыточен и медленнее. Финальный ответ пользователю по-прежнему идёт на aiConfig.model.
      const candidatesModel = 'google/gemini-2.5-flash';
      extractedIntent = await generateSearchCandidates(userMessage, aiConfig.apiKeys, historyForContext, aiConfig.url, candidatesModel, classification?.product_category);
    }
    console.log(`[Chat] AI Intent=${extractedIntent.intent}, Candidates: ${extractedIntent.candidates.length}, ShortCircuit: ${articleShortCircuit}`);

    // Plan V5: knowledge & contacts были предзапущены в начале handler'а (earlyKnowledgePromise/earlyContactsPromise),
    // здесь только дожидаемся их вместе с GeoIP. Для article-shortcircuit это экономит сотни мс.
    const [knowledgeResults, contactsInfo, geoResult] = await Promise.all([earlyKnowledgePromise, earlyContactsPromise, detectedCityPromise]);
    const detectedCity = geoResult.city;
    const isVPN = geoResult.isVPN;
    const userCountryCode = geoResult.countryCode;
    const userCountry = geoResult.country;
    console.log(`[Chat] GeoIP: city=${detectedCity || 'unknown'}, VPN=${isVPN}, country=${userCountry || 'unknown'} (${userCountryCode || '?'})`);
    console.log(`[Chat] Contacts loaded: ${contactsInfo.length} chars`);

    if (knowledgeResults.length > 0) {
      // Plan V5: для article-shortcircuit ответ — простой "да, есть, X тг". 15 КБ статей раздувают токены и латентность.
      // Режем budget до 2 КБ и берём только топ-1 самую релевантную запись.
      const KB_TOTAL_BUDGET = articleShortCircuit ? 2000 : 15000;
      const KB_MAX_ENTRIES = articleShortCircuit ? 1 : knowledgeResults.length;
      let kbUsed = 0;
      const kbParts: string[] = [];

      for (let i = 0; i < knowledgeResults.length && i < KB_MAX_ENTRIES; i++) {
        const r = knowledgeResults[i];
        if (kbUsed >= KB_TOTAL_BUDGET) break;
        const perEntryBudget = r.content.length > 100000 ? 6000 : 4000;
        const remaining = KB_TOTAL_BUDGET - kbUsed;
        const budget = Math.min(perEntryBudget, remaining);
        const excerpt = extractRelevantExcerpt(r.content, userMessage, budget);
        kbParts.push(`--- ${r.title} ---\n${excerpt}${r.source_url ? `\nИсточник: ${r.source_url}` : ''}`);
        kbUsed += excerpt.length;
      }

      knowledgeContext = `
📚 ИНФОРМАЦИЯ ИЗ БАЗЫ ЗНАНИЙ (используй для ответа!):

${kbParts.join('\n\n')}

ИНСТРУКЦИЯ: Используй информацию выше для ответа клиенту. Если информация релевантна вопросу — цитируй её, ссылайся на конкретные пункты.`;

      if (articleShortCircuit) {
        console.log(`[Chat] Knowledge truncated for article-shortcircuit: top-1 entry, ${kbUsed} chars (budget ${KB_TOTAL_BUDGET})`);
      } else {
        console.log(`[Chat] Added ${kbParts.length} knowledge entries to context (${kbUsed} chars, budget ${KB_TOTAL_BUDGET})`);
      }
    }
    if (articleShortCircuit && foundProducts.length > 0) {
      const formattedProducts = formatProductsForAI(foundProducts, needsExtendedOptions(userMessage));
      console.log(`[Chat] Short-circuit formatted products for AI:\n${formattedProducts}`);
      
      // Check if it was article/site-id or title-first
      if (detectedArticles.length > 0) {
        productContext = `\n\n**Товар найден по артикулу (${detectedArticles.join(', ')}):**\n\n${formattedProducts}`;
      } else {
        productContext = `\n\n**Товар найден по названию:**\n\n${formattedProducts}`;
      }
    } else if (!articleShortCircuit && extractedIntent.intent === 'brands' && extractedIntent.candidates.length > 0) {
      const hasSpecificBrand = extractedIntent.candidates.some(c => c.brand && c.brand.trim().length > 0);
      
      if (hasSpecificBrand) {
        console.log(`[Chat] "brands" intent with specific brand → treating as catalog search`);
        foundProducts = await searchProductsMulti(extractedIntent.candidates, 8, appSettings.volt220_api_token || undefined);
        
        if (foundProducts.length > 0) {
          const candidateQueries = extractedIntent.candidates.map(c => c.query).join(', ');
          const formattedProducts = formatProductsForAI(foundProducts, needsExtendedOptions(userMessage));
          console.log(`[Chat] Formatted products for AI:\n${formattedProducts}`);
          productContext = `\n\n**Найденные товары (поиск по: ${candidateQueries}):**\n\n${formattedProducts}`;
        }
      } else {
        foundProducts = await searchProductsMulti(extractedIntent.candidates, 50, appSettings.volt220_api_token || undefined);
        
        if (foundProducts.length > 0) {
          const brands = extractBrandsFromProducts(foundProducts);
          const categoryQuery = extractedIntent.candidates[0]?.query || 'инструменты';
          console.log(`[Chat] Found ${brands.length} brands for "${categoryQuery}": ${brands.join(', ')}`);
          
          if (brands.length > 0) {
            brandsContext = `
НАЙДЕННЫЕ БРЕНДЫ ПО ЗАПРОСУ "${categoryQuery}":
${brands.map((b, i) => `${i + 1}. ${b}`).join('\n')}

Всего найдено ${foundProducts.length} товаров от ${brands.length} брендов.`;
          }
        }
      }
    } else if (!articleShortCircuit && extractedIntent.intent === 'catalog' && extractedIntent.candidates.length > 0) {
      const searchLimit = extractedIntent.usage_context ? 25 : 15;
      foundProducts = await searchProductsMulti(extractedIntent.candidates, searchLimit, appSettings.volt220_api_token || undefined);
      
      // === ENGLISH FALLBACK: Only if <3 results AND have english_queries ===
      if (foundProducts.length === 0 && extractedIntent.english_queries && extractedIntent.english_queries.length > 0) {
        console.log(`[Chat] Only ${foundProducts.length} products found, trying English fallback: ${extractedIntent.english_queries.join(', ')}`);
        const englishCandidates: SearchCandidate[] = extractedIntent.english_queries.slice(0, 2).map(eq => ({
          query: eq.trim().toLowerCase(),
          brand: extractedIntent.candidates[0]?.brand || null,
          category: null,
          min_price: extractedIntent.candidates[0]?.min_price || null,
          max_price: extractedIntent.candidates[0]?.max_price || null,
          option_filters: extractedIntent.candidates[0]?.option_filters,
        }));
        const englishResults = await searchProductsMulti(englishCandidates, searchLimit, appSettings.volt220_api_token || undefined);
        if (englishResults.length > 0) {
          console.log(`[Chat] English fallback found ${englishResults.length} additional products`);
          const mergedMap = new Map<number, Product>();
          for (const p of englishResults) mergedMap.set(p.id, p);
          for (const p of foundProducts) { if (!mergedMap.has(p.id)) mergedMap.set(p.id, p); }
          foundProducts = Array.from(mergedMap.values()).slice(0, searchLimit);
        }
      }
      
      // === RERANK before presenting results ===
      if (foundProducts.length > 0) {
        // === SERVER-SIDE PRICE SORT: if effectivePriceIntent is active, sort by price before reranking ===
        if (effectivePriceIntent && !articleShortCircuit) {
          foundProducts.sort((a, b) => {
            if (effectivePriceIntent === 'most_expensive') return b.price - a.price;
            return a.price - b.price;
          });
          console.log(`[Chat] Fallback price-sort applied: ${effectivePriceIntent}, top price=${foundProducts[0]?.price}`);
        } else {
          foundProducts = rerankProducts(foundProducts, userMessage, allowedCategoryTitles);
        }
        
        const candidateQueries = extractedIntent.candidates.map(c => c.query).join(', ');
        const formattedProducts = formatProductsForAI(foundProducts.slice(0, 10), needsExtendedOptions(userMessage));
        console.log(`[Chat] Formatted products for AI:\n${formattedProducts}`);
        
        const appliedFilters = describeAppliedFilters(extractedIntent.candidates);
        const filterNote = appliedFilters ? `\n⚠️ ПРИМЕНЁННЫЕ ФИЛЬТРЫ: ${appliedFilters}\nВсе товары ниже УЖЕ отфильтрованы по этим характеристикам — ты можешь уверенно это сообщить клиенту!\n` : '';
        
        const contextNote = extractedIntent.usage_context 
          ? `\n🎯 КОНТЕКСТ ИСПОЛЬЗОВАНИЯ: "${extractedIntent.usage_context}"\nСреди товаров ниже ВЫБЕРИ ТОЛЬКО подходящие для этого контекста на основе их характеристик (степень защиты, тип монтажа и т.д.). Объясни клиенту ПОЧЕМУ выбранные товары подходят для его задачи. Если не можешь определить — покажи все.\n` 
          : '';
        
        // === PRICE INTENT INSTRUCTION for LLM fallback ===
        const priceIntentNote = (effectivePriceIntent && !articleShortCircuit)
          ? `\n💰 ЦЕНОВОЙ ИНТЕНТ: Пользователь ищет САМЫЙ ${effectivePriceIntent === 'most_expensive' ? 'ДОРОГОЙ' : 'ДЕШЁВЫЙ'} товар. Товары ниже уже отсортированы по ${effectivePriceIntent === 'most_expensive' ? 'убыванию' : 'возрастанию'} цены. Покажи ПЕРВЫЙ товар как основной результат — он ${effectivePriceIntent === 'most_expensive' ? 'самый дорогой' : 'самый дешёвый'} из найденных.\n`
          : '';
        
        productContext = `\n\n**Найденные товары (поиск по: ${candidateQueries}):**${filterNote}${contextNote}${priceIntentNote}\n${formattedProducts}`;
      }
    }

    // ШАГ 3: Системный промпт с контекстом товаров
    const greetingRegex = /^(привет|здравствуй|добрый|хай|hello|hi|хеллоу|салем)/i;
    const greetingMatch = greetingRegex.test(userMessage.trim());
    const isGreeting = extractedIntent.intent === 'general' && greetingMatch;
    
    console.log(`[Chat] userMessage: "${userMessage}", greetingMatch: ${greetingMatch}, isGreeting: ${isGreeting}`);
    
    const hasAssistantGreeting = messages.some((m, i) => 
      i < messages.length - 1 &&
      m.role === 'assistant' && 
      m.content &&
      /здравствуйте|привет|добр(ый|ое|ая)|рад.*видеть/i.test(m.content)
    );
    
    console.log(`[Chat] hasAssistantGreeting: ${hasAssistantGreeting}`);
    
    let productInstructions = '';
    const isReplacementIntent = !!replacementMeta?.isReplacement;
    const replacementOriginal = replacementMeta?.original || undefined;
    const replacementOriginalName = replacementMeta?.originalName || undefined;
    const replacementNoResults = !!replacementMeta?.noResults;
    
    if (isReplacementIntent && !replacementNoResults && productContext) {
      // Replacement intent with alternatives found
      const origInfo = replacementOriginal 
        ? `**${replacementOriginal.pagetitle}** (${replacementOriginal.vendor || 'без бренда'}, ${replacementOriginal.price} тг)`
        : `**${replacementOriginalName || 'указанный товар'}**`;
      
      productInstructions = `
🔄 ПОИСК АНАЛОГА / ЗАМЕНЫ

Клиент ищет замену или аналог для: ${origInfo}

НАЙДЕННЫЕ АНАЛОГИ:
${productContext}

ТВОЙ ОТВЕТ:
1. Кратко: "Вот ближайшие аналоги для [товар]:"
2. Покажи 3-5 товаров, СРАВНИВАЯ их с оригиналом по ключевым характеристикам (мощность, тип, защита, цена)
3. Укажи отличия: что лучше, что хуже, что совпадает
4. Ссылки копируй как есть в формате [Название](URL) — НЕ МЕНЯЙ URL!
5. ВАЖНО: если в названии товара есть экранированные скобки \\( и \\) — СОХРАНЯЙ их!
6. Тон: профессиональный, как опытный консультант. Помоги клиенту выбрать лучшую замену.
7. В конце спроси: "Какой вариант вам больше подходит? Могу уточнить детали по любому из них."`;
    } else if (isReplacementIntent && replacementNoResults) {
      // Replacement intent but no alternatives found
      productInstructions = `
🔄 ПОИСК АНАЛОГА — НЕ НАЙДЕНО

Клиент ищет замену/аналог для: **${replacementOriginalName || 'товар'}**
К сожалению, в каталоге не удалось найти подходящие аналоги.

ТВОЙ ОТВЕТ:
1. Скажи, что точных аналогов в каталоге не нашлось
2. Предложи: уточнить характеристики нужного товара, чтобы расширить поиск
3. Предложи связаться с менеджером — он может подобрать вручную
4. Покажи ссылку на каталог: https://220volt.kz/catalog/`;
    } else if (brandsContext) {
      productInstructions = `
${brandsContext}

ТВОЙ ОТВЕТ:
1. Перечисли найденные бренды списком
2. Спроси, какой бренд интересует клиента — ты подберёшь лучшие модели
3. Предложи ссылку на каталог: https://220volt.kz/catalog/`;
    } else if (articleShortCircuit && productContext && detectedArticles.length > 0) {
      // Article-first: товар найден по артикулу
      productInstructions = `
🎯 ТОВАР НАЙДЕН ПО АРТИКУЛУ (покажи сразу, БЕЗ уточняющих вопросов о самом товаре!):
${productContext}

⚠️ СТРОГОЕ ПРАВИЛО:
- Клиент указал артикул — он ЗНАЕТ что ему нужно. НЕ задавай уточняющих вопросов О ВЫБОРЕ ТОВАРА!
- Покажи товар сразу: название, цена, наличие (включая остатки по городам, если данные есть), ссылка
- Ссылки копируй как есть в формате [Название](URL) — НЕ МЕНЯЙ URL!
- ВАЖНО: если в названии товара есть экранированные скобки \\( и \\) — СОХРАНЯЙ их!

📈 ПОСЛЕ ИНФОРМАЦИИ О ТОВАРЕ — ДОБАВЬ КОНТЕКСТНЫЙ CROSS-SELL (обязательно!):
Структура ответа:
1. **Карточка товара**: название, цена, наличие, ссылка — кратко и чётко
2. **Контекстное предложение** (1–2 предложения): предложи ЛОГИЧЕСКИ СВЯЗАННЫЙ товар или аксессуар, который обычно покупают ВМЕСТЕ с этим товаром. Примеры:
   - Автомат → «Для монтажа также понадобится DIN-рейка и кабель-канал — могу подобрать?»
   - Кабель-канал → «Обычно вместе берут заглушки и угловые соединители. Подобрать?»
   - Розетка → «Если нужна рамка или подрозетник — подскажу подходящие варианты»
   - Светильник → «К нему подойдут лампы с цоколем E27. Показать варианты?»
   НЕ ВЫДУМЫВАЙ cross-sell если не знаешь категорию! В этом случае просто спроси: «Что ещё подобрать для вашего проекта?»
3. Тон: профессиональный, как опытный консультант. БЕЗ восклицательных знаков, без «отличный выбор!», без давления.`;
    } else if (priceIntentClarify) {
      // Price intent with too many products — ask user to narrow down
      productInstructions = `
🔍 ЦЕНОВОЙ ЗАПРОС — НУЖНО УТОЧНЕНИЕ

Клиент ищет самый ${priceIntentClarify.category ? `дорогой/дешёвый товар в категории "${priceIntentClarify.category}"` : 'дорогой/дешёвый товар'}.
В этой категории найдено **${priceIntentClarify.total} товаров** — это слишком много, чтобы точно определить крайнюю цену.

ТВОЙ ОТВЕТ:
1. Скажи клиенту, что в категории "${priceIntentClarify.category}" найдено ${priceIntentClarify.total} товаров
2. Попроси УТОЧНИТЬ тип или подкатегорию, чтобы сузить поиск. Предложи 3-4 варианта подкатегорий, если знаешь (например, для фонарей: налобный, аккумуляторный, LED и т.д.)
3. Объясни, что после уточнения ты сможешь точно найти самый дорогой/дешёвый вариант
4. Тон: профессиональный, дружелюбный, без давления`;
    } else if (articleShortCircuit && productContext) {
      // Title-first or price-intent answer: товар найден.
      // displayedCount  — сколько карточек реально ушло в LLM-контекст (≤ DISPLAY_LIMIT).
      // collectedCount  — сколько товаров API вернул ДО обрезки (реальный объём подборки).
      // fewProducts решается по collectedCount: если в каталоге <=7, показываем все;
      // если в каталоге много — даже когда displayed=15, говорим честное число "подобрано N".
      const isPriceSort = foundProducts.length > 0 && !detectedArticles.length;
      const displayedCount = foundProducts.length;
      const collectedCount = totalCollected > 0 ? totalCollected : displayedCount;
      const fewProducts = collectedCount <= 7;
      console.log(`[Chat] PromptCounts: displayed=${displayedCount} collected=${collectedCount} branch=${totalCollectedBranch} fewProducts=${fewProducts}`);
      
      if (fewProducts) {
        productInstructions = `
🎯 ТОВАР НАЙДЕН ПО НАЗВАНИЮ — ПОКАЖИ ВСЕ ${displayedCount} ПОЗИЦИЙ:
${productContext}

🚫 АБСОЛЮТНЫЙ ЗАПРЕТ: ЗАПРЕЩЕНО задавать уточняющие вопросы! Товаров мало (${displayedCount}) — покажи ВСЕ найденные позиции.
- Покажи каждый товар: название, цена, наличие, ссылка
- Ссылки копируй как есть в формате [Название](URL) — НЕ МЕНЯЙ URL!
- ВАЖНО: если в названии товара есть экранированные скобки \\( и \\) — СОХРАНЯЙ их!

📈 ПОСЛЕ ИНФОРМАЦИИ О ТОВАРЕ — ДОБАВЬ КОНТЕКСТНЫЙ CROSS-SELL:
- Предложи 1 ЛОГИЧЕСКИ СВЯЗАННЫЙ аксессуар
- Тон: профессиональный, без давления`;
      } else {
        productInstructions = `
🎯 ПОДОБРАНО ${collectedCount} ТОВАРОВ ПО ЗАПРОСУ (показаны первые ${displayedCount}):
${productContext}

📋 ОБЯЗАТЕЛЬНЫЙ ФОРМАТ ОТВЕТА:
1. Покажи ПЕРВЫЕ 3 наиболее релевантных товара: название, цена, наличие, ссылка
2. Скажи ОДНОЙ фразой: "Всего подобрано ${collectedCount} вариантов." (используй именно число ${collectedCount}, не округляй и не выдумывай!)
3. Предложи сузить выбор: "Если хотите, могу подобрать точнее — подскажите [цвет/серию/производителя/цену]"
- Ссылки копируй как есть в формате [Название](URL) — НЕ МЕНЯЙ URL!
- ВАЖНО: если в названии товара есть экранированные скобки \\( и \\) — СОХРАНЯЙ их!
- Тон: профессиональный, без давления
- 🚫 НЕ задавай уточняющий вопрос БЕЗ показа товаров. Всегда сначала показывай 3 товара!
- 🚫 НЕ говори "нашлось 15", "нашлось ровно 15" — это лимит показа, а не реальное количество. Реальное число = ${collectedCount}.`;
      }
    } else if (productContext) {
      productInstructions = `
НАЙДЕННЫЕ ТОВАРЫ (КОПИРУЙ ССЫЛКИ ТОЧНО КАК ДАНО — НЕ МОДИФИЦИРУЙ!):
${productContext}

⚠️ СТРОГОЕ ПРАВИЛО ДЛЯ ССЫЛОК: 
- Ссылки в данных выше уже готовы! Просто скопируй их как есть в формате [Название](URL)
- НЕ МЕНЯЙ URL! НЕ ПРИДУМЫВАЙ URL! 
- Используй ТОЛЬКО те ссылки, которые даны выше
- Если хочешь упомянуть товар — бери ссылку ТОЛЬКО из списка выше
- ВАЖНО: если в названии товара есть экранированные скобки \\( и \\) — СОХРАНЯЙ их! Не убирай обратные слэши! Пример: [Розетка \\(белый\\)](url) — это ПРАВИЛЬНО. [Розетка (белый)](url) — это НЕПРАВИЛЬНО, сломает ссылку!

📈 КОНТЕКСТНЫЙ CROSS-SELL (условный):
- Если ты показал конкретный товар или помог клиенту с выбором из нескольких — в конце ответа предложи 1 ЛОГИЧЕСКИ СВЯЗАННЫЙ аксессуар. Примеры:
  • Автомат → DIN-рейка, кабель-канал
  • Розетка → рамка, подрозетник
  • Светильник → лампа с подходящим цоколем
  • Перфоратор → буры, патрон
- Если ты задаёшь УТОЧНЯЮЩИЙ ВОПРОС (серия, мощность, полюсность, тип) — cross-sell НЕ добавляй! Сначала помоги выбрать основной товар
- Формат: одна фраза, без списков. Пример: «Для монтажа также понадобится DIN-рейка — подобрать?»
- Если не знаешь категорию товара — вместо cross-sell спроси: «Что ещё подобрать для вашего проекта?»
- Тон: профессиональный, без восклицательных знаков, без давления`;
    } else if (isGreeting) {
      productInstructions = '';
    } else if (extractedIntent.intent === 'info') {
      if (knowledgeResults.length > 0) {
        // Find the most relevant KB entry by title/content match to user query
        // Strip punctuation from query words for accurate matching
        const queryWords = userMessage.toLowerCase().replace(/[?!.,;:()«»"']/g, '').split(/\s+/).filter(w => w.length > 2);
        const bestMatch = knowledgeResults.find(r => 
          queryWords.some(w => r.title.toLowerCase().includes(w))
        ) || knowledgeResults.find(r =>
          queryWords.some(w => r.content.toLowerCase().includes(w))
        );
        
        console.log(`[Chat] Info intent: queryWords=${JSON.stringify(queryWords)}, bestMatch=${bestMatch?.title || 'NONE'}`);
        
        // Build direct answer quote from best match
        let directAnswerBlock = '';
        if (bestMatch) {
          const fullContent = bestMatch.content.length > 2000 
            ? bestMatch.content.substring(0, 2000) 
            : bestMatch.content;
          directAnswerBlock = `

═══════════════════════════════════════════════════════
🎯 НАЙДЕН ТОЧНЫЙ ОТВЕТ В БАЗЕ ЗНАНИЙ! ИСПОЛЬЗУЙ ЕГО!
═══════════════════════════════════════════════════════
Запись: «${bestMatch.title}»
Текст записи: «${fullContent}»
${bestMatch.source_url ? `Источник: ${bestMatch.source_url}` : ''}
═══════════════════════════════════════════════════════

⛔ СТОП! Прочитай текст записи выше. Это ФАКТ из базы данных компании.
Твоя задача — ПЕРЕСКАЗАТЬ эту информацию клиенту своими словами.
ЗАПРЕЩЕНО: говорить "нет" если в записи написано "есть", или наоборот.
ЗАПРЕЩЕНО: использовать свои общие знания вместо данных из записи.`;
        }
        
        productInstructions = `
💡 ВОПРОС О КОМПАНИИ / УСЛОВИЯХ / ДОКУМЕНТАХ

Клиент написал: "${extractedIntent.originalQuery}"
${directAnswerBlock}

⚠️ КРИТИЧЕСКИ ВАЖНО — ПРАВИЛА ОТВЕТА НА ИНФОРМАЦИОННЫЕ ВОПРОСЫ:
1. Твой ответ ДОЛЖЕН быть основан ИСКЛЮЧИТЕЛЬНО на данных из Базы Знаний
2. 🚫 КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО отвечать из своих общих знаний или "здравого смысла"!
3. Если в Базе Знаний написано, что что-то ЕСТЬ — ты говоришь что ЕСТЬ. Не спорь с базой!
4. Если в Базе Знаний написано, что чего-то НЕТ — ты говоришь что НЕТ
5. Цитируй конкретные пункты, если они есть
6. Если точного ответа нет в Базе Знаний — честно скажи и предложи контакт менеджера`;
      } else {
        productInstructions = `
💡 ВОПРОС О КОМПАНИИ

Клиент написал: "${extractedIntent.originalQuery}"

В Базе Знаний нет информации по этому вопросу. Предложи связаться с менеджером.`;
      }
    } else if (extractedIntent.intent === 'catalog' && extractedIntent.candidates.length > 0) {
      productInstructions = `
Клиент ищет товар: "${extractedIntent.originalQuery}"
К сожалению, в каталоге ничего не найдено по данному запросу.

ТВОЙ ОТВЕТ:
1. Скажи, что конкретно этот товар не найден
2. Предложи АЛЬТЕРНАТИВЫ (если знаешь что это за товар, предложи похожие)
3. Предложи уточнить: категорию, бренд, характеристики
4. Покажи ссылку на каталог: https://220volt.kz/catalog/`;
    }

    // Geo context for system prompt
    let geoContext = '';
    if (detectedCity && !isVPN) {
      geoContext = `\n\n📍 ГЕОЛОКАЦИЯ КЛИЕНТА: город ${detectedCity}${userCountryCode === 'RU' ? `, ${userCountry}` : ''}. При ответах о наличии/доставке учитывай это.`;
    } else if (isVPN) {
      geoContext = '\n\n📍 ГЕОЛОКАЦИЯ: не определена (VPN/прокси). Если клиент спрашивает о наличии — уточни город.';
    }

    const customPrompt = appSettings.system_prompt || '';
    
    const systemPrompt = `Ты — профессиональный консультант интернет-магазина электротоваров 220volt.kz.
${customPrompt}

🚫 АБСОЛЮТНЫЙ ЗАПРЕТ ПРИВЕТСТВИЙ:
Ты НИКОГДА не здороваешься, не представляешься, не пишешь "Здравствуйте", "Привет", "Добрый день" или любые другие формы приветствия.
ИСКЛЮЧЕНИЕ: если клиент ВПЕРВЫЕ пишет приветствие ("Привет", "Здравствуйте") И в истории диалога НЕТ твоего приветствия — можешь поздороваться ОДИН РАЗ.
${hasAssistantGreeting ? '⚠️ Ты УЖЕ поздоровался в этом диалоге — НИКАКИХ повторных приветствий!' : ''}

Язык ответа: отвечай на том языке, на котором написал клиент (русский, казахский и т.д.). По умолчанию — русский.

# Ключевые правила
- Будь кратким и конкретным
- Используй markdown для форматирования: **жирный** для важного, списки для перечислений
- Ссылки на товары — в формате markdown: [Название](URL)
- НЕ ВЫДУМЫВАЙ товары, цены, характеристики — используй ТОЛЬКО данные из контекста
- Если клиент спрашивает конкретную числовую характеристику (вес, размер, мощность и т.д.), а в данных товара её НЕТ — ответь: "К сожалению, информация о [характеристике] не указана в карточке товара. Рекомендую уточнить на странице товара или у менеджера." НИКОГДА не выдумывай числовые значения!
- Если не знаешь ответ — скажи честно и предложи связаться с менеджером

# Доменное разделение товаров (КРИТИЧЕСКИ ВАЖНО!)
- Если клиент просит «розетку» БЕЗ слов «телефон», «RJ11», «RJ45», «компьютер», «интернет», «LAN» — он ищет ЭЛЕКТРИЧЕСКУЮ СИЛОВУЮ розетку. НИКОГДА не предлагай телефонные/компьютерные розетки (RJ11/RJ45) вместо силовых!
- Если среди найденных товаров нет точного совпадения — честно скажи: «Точных совпадений не найдено. Вот ближайшие варианты:» и покажи лучшее из того, что есть. НЕ ПОДМЕНЯЙ один тип товара другим.
- Если клиент ЯВНО указал «телефонная розетка», «RJ11», «RJ45», «компьютерная розетка» — тогда показывай telecom-товары.

# Уточняющие вопросы (Smart Consultant)
Когда клиент ищет категорию товаров (не конкретный артикул):
1. Посмотри на найденные товары — есть ли ЗНАЧИМЫЕ различия (тип монтажа, мощность, назначение)?
2. Если да — задай ОДИН конкретный уточняющий вопрос с вариантами
3. Формулируй ПОНЯТНЫМ языком
4. НЕ задавай вопрос если клиент УЖЕ указал параметр
5. НЕ задавай вопрос если товаров мало (1-2) и они однотипные

Пример: Клиент спросил "щитки". Среди найденных товаров есть щитки для внутренней и наружной установки.
→ "Подскажите, вам нужен щиток для **внутренней** (встраиваемый в стену) или **наружной** (накладной) установки? Также — на сколько модулей (автоматов)?"

ВАЖНО:
- Задавай вопрос ТОЛЬКО если различие реально существует в найденных товарах
- Формулируй варианты ПОНЯТНЫМ языком (не "IP44", а "влагозащищённый (IP44) — подходит для ванной или улицы")
- НЕ задавай вопрос если клиент УЖЕ указал этот параметр в запросе
- НЕ задавай вопрос если в истории диалога клиент уже отвечал на подобный вопрос
- Если товаров мало (1-2) и они однотипные — вопрос не нужен

# Фильтрация по характеристикам
Каждый товар содержит раздел «Характеристики» (длина, мощность, сечение, количество розеток и т.д.).
Когда клиент указывает конкретные параметры (например, «5 метров», «2000 Вт», «3 розетки»):
1. Просмотри характеристики ВСЕХ найденных товаров
2. Отбери ТОЛЬКО те, что соответствуют запрошенным параметрам
3. Если подходящих товаров нет среди найденных — честно скажи и предложи ближайшие варианты
4. НЕ выдумывай характеристики — бери ТОЛЬКО из данных

# Расчёт объёма товаров
Когда клиент спрашивает про объём, транспортировку, какая машина нужна, сколько места займёт:
1. Найди в характеристиках товара ЛЮБОЕ поле, содержащее слово «объем» или «объём» (напр. «Объем, м3», «Объём единицы», «Объем упаковки» и т.д.). Извлеки из него числовое значение. Если значение очень маленькое (напр. 0.000077) — это нормально для кабелей, не игнорируй его!
2. Внутренняя формула (НЕ показывай клиенту): Общий объём = Количество × Объём единицы × Коэффициент запаса. Коэффициент: 1.2 для кабелей/проводов, 1.1 для остальных.
3. ВАЖНО: Клиенту выводи ТОЛЬКО итоговый результат. НЕ показывай формулу, коэффициенты, промежуточные вычисления. Если клиент спрашивает про коэффициенты — отвечай: "Для уточнения деталей расчёта рекомендую обратиться к менеджеру."
4. Если клиент указал количество — сразу посчитай и выведи только итог, например: "Общий объём кабеля АВВГ 2×2.5 на 5000 м — **0.462 м³**"
5. Если количество не указано — спроси: "Сколько единиц вам нужно? Посчитаю общий объём для транспортировки."
6. Если НИ ОДНА характеристика не содержит слово «объем/объём» — скажи: "К сожалению, объём этого товара не указан в карточке. Рекомендую уточнить у менеджера."
7. ВАЖНО: единица измерения в названии характеристики («м3», «м³», «л») подсказывает формат. 1 л = 0.001 м³.


# Формат ответа: филиалы и контакты
Когда клиент спрашивает про филиалы, адреса, контакты — определи ХАРАКТЕР запроса:

**А) Запрос ПОЛНОГО СПИСКА** (примеры: "список филиалов", "все филиалы", "перечисли филиалы", "где вы находитесь", "ваши адреса", "все адреса магазинов"):
→ Покажи ВСЕ филиалы из данных ниже, сгруппированные по городам. НЕ спрашивай город — клиент явно хочет полный список!

**Б) ТОЧЕЧНЫЙ вопрос** (примеры: "где купить в Алматы", "есть филиал в Москве", "ближайший магазин", "куда приехать забрать"):
→ Если город определён по геолокации — СРАЗУ покажи ближайший филиал. Упомяни: "Мы также есть в других городах — подсказать?"
→ Если город НЕ определён — уточни: "В каком городе вам удобнее?"

Каждый филиал — отдельным блоком:

**📍 Город — Название**
🏠 адрес
📞 [номер](tel:номер_без_пробелов) — телефоны ВСЕГДА кликабельные: [+7 700 123 45 67](tel:+77001234567)
🕐 режим работы

Если у филиала нет телефона/режима — просто пропусти строку.
WhatsApp всегда кликабельный: [WhatsApp](https://wa.me/номер)

# Контакты компании и филиалы (из Базы Знаний)
Ниже — ЕДИНСТВЕННЫЙ источник контактных данных. WhatsApp, email, телефоны, адреса — всё бери ОТСЮДА.

${contactsInfo || 'Данные о контактах не загружены.'}

# Эскалация менеджеру
Когда нужен менеджер — добавь маркер [CONTACT_MANAGER] в конец сообщения (он скрыт от клиента, заменяется карточкой контактов). Перед маркером предложи WhatsApp и email из данных выше.

${(() => {
      const shouldIncludeKnowledge = 
        extractedIntent.intent === 'info' || 
        extractedIntent.intent === 'general' ||
        foundProducts.length === 0;
      return shouldIncludeKnowledge ? knowledgeContext : '';
    })()}

${productInstructions}`;

    // Diagnostic logs
    const knowledgeLen = knowledgeContext.length;
    const productInsLen = productInstructions.length;
    const contactsLen = contactsInfo.length;
    const historyLen = messages.reduce((sum: number, m: any) => sum + (m.content?.length || 0), 0);
    console.log(`[Chat] Context breakdown: system_prompt=${systemPrompt.length}, knowledge=${knowledgeLen}, products=${productInsLen}, contacts=${contactsLen}, history=${historyLen}`);
    console.log(`[Chat] Total estimated tokens: ~${Math.round((systemPrompt.length + historyLen) / 4)}`);

    // ШАГ 4: Финальный ответ от AI
    const trimmedMessages = messages.slice(-8).map((m: any) => {
      if (m.role === 'assistant' && m.content && m.content.length > 500) {
        return { ...m, content: m.content.substring(0, 500) + '...' };
      }
      return m;
    });
    const trimmedHistoryLen = trimmedMessages.reduce((sum: number, m: any) => sum + (m.content?.length || 0), 0);
    console.log(`[Chat] History trimmed: ${messages.length} → ${trimmedMessages.length} msgs, ${historyLen} → ${trimmedHistoryLen} chars`);

    // For info queries with KB match, inject the answer as a separate message
    // so the LLM cannot ignore it (system prompt instructions get lost in long contexts)
    const infoKbInjection: any[] = [];
    if (extractedIntent.intent === 'info' && knowledgeResults.length > 0) {
      const qw = userMessage.toLowerCase().replace(/[?!.,;:()«»"']/g, '').split(/\s+/).filter((w: string) => w.length > 2);
      const bm = knowledgeResults.find((r: any) => qw.some((w: string) => r.title.toLowerCase().includes(w))) 
        || knowledgeResults.find((r: any) => qw.some((w: string) => r.content.toLowerCase().includes(w)));
      if (bm) {
        console.log(`[Chat] Info KB injection: matched entry "${bm.title}" (${bm.content.length} chars)`);
        infoKbInjection.push({
          role: 'user',
          content: `[СИСТЕМНАЯ СПРАВКА — данные из базы знаний компании]\nНа вопрос "${userMessage}" в базе знаний найдена запись:\n\nЗаголовок: ${bm.title}\nСодержание: ${bm.content}\n\nОтветь клиенту, используя ИМЕННО эту информацию. Не противоречь ей.`
        });
        infoKbInjection.push({
          role: 'assistant', 
          content: 'Понял, использую информацию из базы знаний для ответа.'
        });
      }
    }

    const messagesForAI = [
      { role: 'system', content: systemPrompt },
      ...infoKbInjection,
      ...trimmedMessages,
    ];
    
    console.log(`[Chat] Response model: ${responseModel} (reason: ${responseModelReason})`);
    console.log(`[Chat] Streaming with reasoning: excluded (model=${responseModel})`);
    console.log(`[Chat] Sampling: top_k=1 seed=42 provider=google-ai-studio`);

    // ─────────────────────────────────────────────────────────────────────────
    // Plan V7 — Category Disambiguation SHORT-CIRCUIT
    // If matcher detected ≥2 semantically distinct buckets, we have a pre-built
    // clarification message + quick_replies. Skip the LLM entirely and return
    // it directly. Saves ~2-4s and avoids the LLM "guessing" a category.
    // ─────────────────────────────────────────────────────────────────────────
    if (disambiguationResponse) {
      console.log(`[Chat] Disambiguation SHORT-CIRCUIT: skipping LLM, returning ${disambiguationResponse.quick_replies.length} quick_replies`);
      const dr = disambiguationResponse;

      if (!useStreaming) {
        const responseBody: {
          content: string;
          quick_replies: Array<{ label: string; value: string }>;
          slot_update?: DialogSlots;
        } = {
          content: dr.content,
          quick_replies: dr.quick_replies,
        };
        if (slotsUpdated) responseBody.slot_update = dialogSlots;
        return new Response(
          JSON.stringify(responseBody),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Streaming: emit content as a single SSE chunk (OpenAI-style delta),
      // then the quick_replies + slot_update events, then [DONE].
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const contentDelta = `data: ${JSON.stringify({
            choices: [{ delta: { content: dr.content }, index: 0 }],
          })}\n\n`;
          controller.enqueue(encoder.encode(contentDelta));

          const qrEvent = `data: ${JSON.stringify({ quick_replies: dr.quick_replies })}\n\n`;
          controller.enqueue(encoder.encode(qrEvent));

          if (slotsUpdated) {
            const slotEvent = `data: ${JSON.stringify({ slot_update: dialogSlots })}\n\n`;
            controller.enqueue(encoder.encode(slotEvent));
          }

          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }


    const response = await callAIWithKeyFallback(aiConfig.url, aiConfig.apiKeys, {
      model: responseModel,
      messages: messagesForAI,
      stream: useStreaming,
      ...DETERMINISTIC_SAMPLING,
      reasoning: { exclude: true },
      // 4096 — safe ceiling: avg response 800-1500 tokens, list of 5-7 products with descriptions ~2500-3000.
      // Without this, OpenRouter uses provider default (~1024-2048) and gemini-2.5-pro burns part of it on hidden reasoning,
      // leaving ~200-400 tokens for actual content → response truncates mid-sentence. DO NOT REMOVE.
      max_tokens: 4096,
    }, 'Chat');

    if (!response.ok) {
      if (response.status === 429) {
        console.error(`[Chat] Rate limit 429 after all keys exhausted (OpenRouter)`);
        return new Response(
          JSON.stringify({ error: `Превышен лимит запросов к OpenRouter. Подождите 1-2 минуты и попробуйте снова.` }),
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: 'Требуется пополнение баланса AI.' }),
          { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      const errorText = await response.text();
      console.error('[Chat] AI Gateway error:', response.status, errorText);
      return new Response(
        JSON.stringify({ error: 'Ошибка AI сервиса' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const formattedContacts = formatContactsForDisplay(contactsInfo);

    const logTokenUsage = async (inputTokens: number, outputTokens: number, model: string) => {
      try {
        const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
        const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
        
        const totalTokens = inputTokens + outputTokens;
        const inputCost = (inputTokens / 1_000_000) * 0.30;
        const outputCost = (outputTokens / 1_000_000) * 2.50;
        const estimatedCost = inputCost + outputCost;
        
        const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        await sb.from('ai_usage_logs').insert({
          client_ip: clientIp,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: totalTokens,
          model: model,
          estimated_cost_usd: estimatedCost,
        });
        console.log(`[Usage] Logged: ${inputTokens} in / ${outputTokens} out = $${estimatedCost.toFixed(6)}`);
      } catch (e) {
        console.error('[Usage] Failed to log:', e);
      }
    };

    // NON-STREAMING MODE
    if (!useStreaming) {
      try {
        const aiData = await response.json();
        let content = aiData.choices?.[0]?.message?.content || '';
        console.log(`[Chat] Non-streaming response length: ${content.length}`);
        
        const usage = aiData.usage;
        if (usage) {
          logTokenUsage(usage.prompt_tokens || 0, usage.completion_tokens || 0, aiConfig.model);
        }
        
        const shouldShowContacts = content.includes('[CONTACT_MANAGER]');
        content = content.replace(/\s*\[CONTACT_MANAGER\]\s*/g, '').trim();
        
        const responseBody: { content: string; contacts?: string | null; slot_update?: DialogSlots } = { content };
        if (shouldShowContacts && formattedContacts) {
          responseBody.contacts = formattedContacts;
        }
        if (slotsUpdated) {
          responseBody.slot_update = dialogSlots;
        }
        
        return new Response(
          JSON.stringify(responseBody),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      } catch (e) {
        console.error('[Chat] Non-streaming parse error:', e);
        return new Response(
          JSON.stringify({ error: 'Failed to parse AI response' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // STREAMING MODE
    if (hasAssistantGreeting && isGreeting) {
      const reader = response.body?.getReader();
      if (!reader) {
        return new Response(
          JSON.stringify({ error: 'No response body' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      let greetingRemoved = false;
      let fullContent = '';
      let bufferedChunks: Uint8Array[] = [];
      let lastFinishReason = '';
      
      const stream = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            for (const chunk of bufferedChunks) {
              let text = decoder.decode(chunk);
              text = text.replace(/\[CONTACT_MANAGER\]/g, '');
              controller.enqueue(encoder.encode(text));
            }
            if (fullContent.includes('[CONTACT_MANAGER]') && formattedContacts) {
              const contactsEvent = `data: ${JSON.stringify({ contacts: formattedContacts })}\n\n`;
              controller.enqueue(encoder.encode(contactsEvent));
            }
            if (slotsUpdated) {
              const slotEvent = `data: ${JSON.stringify({ slot_update: dialogSlots })}\n\n`;
              controller.enqueue(encoder.encode(slotEvent));
            }
            const estInputTokens = Math.ceil(systemPrompt.length / 3);
            const estOutputTokens = Math.ceil(fullContent.length / 3);
            logTokenUsage(estInputTokens, estOutputTokens, aiConfig.model);
            console.log(`[Chat] Stream finished (greeting-strip): finish_reason=${lastFinishReason || 'unknown'} contentLen=${fullContent.length}`);
            controller.close();
            return;
          }
          
          let text = decoder.decode(value, { stream: true });
          
          // Strip OpenRouter reasoning fields BEFORE content extraction & enqueue
          text = text.replace(/"reasoning":\s*"(?:[^"\\]|\\.)*"/g, '"reasoning":""');
          text = text.replace(/"reasoning_details":\s*\[[\s\S]*?\]/g, '"reasoning_details":[]');
          
          try {
            const contentMatch = text.match(/"content":"([^"]*)"/g);
            if (contentMatch) {
              for (const m of contentMatch) {
                fullContent += m.replace(/"content":"/, '').replace(/"$/, '');
              }
            }
          } catch {}
          
          try {
            const finishMatches = text.match(/"finish_reason":"([^"]+)"/g);
            if (finishMatches && finishMatches.length > 0) {
              const last = finishMatches[finishMatches.length - 1];
              lastFinishReason = last.replace(/"finish_reason":"/, '').replace(/"$/, '');
            }
          } catch {}
          
          if (!greetingRemoved && text.includes('content')) {
            const before = text;
            const greetings = ['Здравствуйте', 'Привет', 'Добрый день', 'Добрый вечер', 'Доброе утро', 'Hello', 'Hi', 'Хай'];
            
            for (const greeting of greetings) {
              const pattern = new RegExp(
                `"content":"${greeting}[!.,]?\s*(?:👋|🛠️|😊)?\s*`,
                'gi'
              );
              text = text.replace(pattern, '"content":"');
            }
            
            if (before !== text) {
              greetingRemoved = true;
            }
          }
          
          text = text.replace(/\[CONTACT_MANAGER\]/g, '');
          text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
          text = text.replace(/ТИХОЕ РАЗМЫШЛЕНИЕ[\s\S]*?(?=data:|$)/g, '');
          
          // Intercept [DONE] — send slot_update before it
          if (text.includes('[DONE]')) {
            const beforeDone = text.replace(/data: \[DONE\]\n?\n?/g, '');
            if (beforeDone.trim()) {
              controller.enqueue(encoder.encode(beforeDone));
            }
            // Send slot_update before [DONE]
            if (slotsUpdated) {
              const slotEvent = `data: ${JSON.stringify({ slot_update: dialogSlots })}\n\n`;
              controller.enqueue(encoder.encode(slotEvent));
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            return;
          }
          
          controller.enqueue(encoder.encode(text));
        }
      });

      return new Response(stream, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/event-stream',
        },
      });
    }

    // Standard streaming
    const originalStream = response.body;
    if (!originalStream) {
      return new Response(
        JSON.stringify({ error: 'No response body' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    const encoder = new TextEncoder();
    const reader2 = originalStream.getReader();
    const decoder2 = new TextDecoder();
    
    let fullContent2 = '';
    let lastFinishReason2 = '';
    
    const streamWithContacts = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader2.read();
        if (done) {
          if (fullContent2.includes('[CONTACT_MANAGER]') && formattedContacts) {
            const contactsEvent = `data: ${JSON.stringify({ contacts: formattedContacts })}\n\n`;
            controller.enqueue(encoder.encode(contactsEvent));
          }
          if (slotsUpdated) {
            const slotEvent = `data: ${JSON.stringify({ slot_update: dialogSlots })}\n\n`;
            controller.enqueue(encoder.encode(slotEvent));
          }
          const estInputTokens = Math.ceil(systemPrompt.length / 3);
          const estOutputTokens = Math.ceil(fullContent2.length / 3);
          logTokenUsage(estInputTokens, estOutputTokens, aiConfig.model);
          console.log(`[Chat] Stream finished (standard): finish_reason=${lastFinishReason2 || 'unknown'} contentLen=${fullContent2.length}`);
          controller.close();
          return;
        }
        
        let text = decoder2.decode(value, { stream: true });
        
        // Strip OpenRouter reasoning fields BEFORE content extraction & enqueue
        text = text.replace(/"reasoning":\s*"(?:[^"\\]|\\.)*"/g, '"reasoning":""');
        text = text.replace(/"reasoning_details":\s*\[[\s\S]*?\]/g, '"reasoning_details":[]');
        
        try {
          const contentMatch = text.match(/"content":"([^"]*)"/g);
          if (contentMatch) {
            for (const m of contentMatch) {
              fullContent2 += m.replace(/"content":"/, '').replace(/"$/, '');
            }
          }
        } catch {}
        
        try {
          const finishMatches = text.match(/"finish_reason":"([^"]+)"/g);
          if (finishMatches && finishMatches.length > 0) {
            const last = finishMatches[finishMatches.length - 1];
            lastFinishReason2 = last.replace(/"finish_reason":"/, '').replace(/"$/, '');
          }
        } catch {}
        
        text = text.replace(/\[CONTACT_MANAGER\]/g, '');
        text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
        text = text.replace(/ТИХОЕ РАЗМЫШЛЕНИЕ[\s\S]*?(?=data:|$)/g, '');
        
        // Intercept [DONE] — send slot_update before it
        if (text.includes('[DONE]')) {
          const beforeDone = text.replace(/data: \[DONE\]\n?\n?/g, '');
          if (beforeDone.trim()) {
            controller.enqueue(encoder.encode(beforeDone));
          }
          if (slotsUpdated) {
            const slotEvent = `data: ${JSON.stringify({ slot_update: dialogSlots })}\n\n`;
            controller.enqueue(encoder.encode(slotEvent));
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          return;
        }
        
        controller.enqueue(encoder.encode(text));
      }
    });
    
    return new Response(streamWithContacts, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
      },
    });

  } catch (error) {
    console.error('[Chat] Error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Неизвестная ошибка' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
