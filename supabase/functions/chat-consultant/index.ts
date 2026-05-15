// chat-consultant v4.0 — Micro-LLM intent classifier + latency optimization
// build-marker: layer1-confidence-gate-2026-04-28T09:00Z (single-flight + SWR + key-only mode + parallel buckets)
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from 'npm:@supabase/supabase-js@2';
import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_CLASSIFIER_PROMPT } from "../_shared/classifier-prompt.ts";
import {
  createLogCtx,
  runWithLogCtx,
  wrapResponseForLogging,
  logSetSession,
  logSetUserQuery,
  logSetClassifier,
  logSetBranch,
  logAddStep,
  logSetProductsCount,
  logSetError,
} from '../_shared/request-logger.ts';
import {
  generateRelatedFollowup,
  fetchRelatedProducts as fetchRelatedProductsShared,
  acceptRelatedOffer,
  classifyRelatedOfferResponse,
  type RelatedFollowupDeps,
  type RelatedAnchor,
} from '../_shared/related-followup.ts';
import { wrapWithHeartbeat } from '../_shared/sse-heartbeat.ts';

// Per-request async context (carries reqId implicitly through all awaits inside `serve`).
// Used by Degraded-mode tracker so deeply nested catalog helpers do NOT need to thread
// reqId through their signatures — they read it from the active async context.
const _reqContext = new AsyncLocalStorage<{ reqId: string }>();
function _currentReqId(): string | undefined {
  return _reqContext.getStore()?.reqId;
}

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

// Anthropic не поддерживает top_k/seed и роутится через own provider.
// OpenRouter выкинет лишние поля, но указание `provider.order=google-ai-studio`
// для Claude приведёт к фолбэку (allow_fallbacks=true), что добавляет latency.
// Для Claude/OpenAI — отдельный пресет без Gemini-only полей.
// Lock Claude to native Anthropic provider first.
// Без provider-lock OpenRouter роутит часть запросов в Google Vertex Anthropic
// (provider_name="Google", request id req_vrtx_*), который отвечает 400
// "messages: at least one message is required" на наш payload с tool_calls.
// Имена провайдеров в OpenRouter регистрозависимые: "Anthropic", "Amazon Bedrock", "Google Vertex".
const DETERMINISTIC_SAMPLING_CLAUDE = {
  temperature: 0,
  top_p: 1,
  provider: {
    order: ['Anthropic', 'Amazon Bedrock'],
    ignore: ['Google Vertex', 'Google'],
    allow_fallbacks: true,
  },
} as const;

function samplingFor(model: string): Record<string, unknown> {
  if (model.startsWith('anthropic/') || model.startsWith('openai/')) {
    return { ...DETERMINISTIC_SAMPLING_CLAUDE };
  }
  return { ...DETERMINISTIC_SAMPLING };
}

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
  /** Editable classifier system prompt (admin /settings). Null = use DEFAULT_CLASSIFIER_PROMPT. */
  classifier_prompt: string | null;
  /**
   * §22.2 spec — Branch A флаг (Query-First). Прочитывается для observability;
   * полная V1-имплементация отложена (V1 ветка остаётся stable fallback).
   * Эксперимент проводится через V2 (`chat-consultant-v2`).
   */
  query_first_enabled: boolean;
  /** §22.3 spec — Branch B флаг (Soft-Suggest). Аналогично — пока observability-only в V1. */
  soft_suggest_enabled: boolean;
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
      classifier_model: 'anthropic/claude-sonnet-4.5',
      classifier_prompt: null,
      query_first_enabled: false,
      soft_suggest_enabled: false,
    };
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase
      .from('app_settings')
      .select('volt220_api_token, openrouter_api_key, google_api_key, ai_provider, ai_model, system_prompt, classifier_provider, classifier_model, classifier_prompt, query_first_enabled, soft_suggest_enabled')
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
      classifier_prompt: null,
        classifier_model: 'anthropic/claude-sonnet-4.5',
        query_first_enabled: false,
        soft_suggest_enabled: false,
      };
    }

    // §22 spec: V1 — observability-only (см. mem://features/query-first-branch).
    // Полная имплементация Branch A/B живёт в V2. Здесь только лог-эхо состояния флагов.
    const qf = (data as { query_first_enabled?: boolean }).query_first_enabled === true;
    const ss = (data as { soft_suggest_enabled?: boolean }).soft_suggest_enabled === true;
    if (qf || ss) {
      console.log(`[Settings] V1 sees experimental flags: query_first=${qf} soft_suggest=${ss} (no-op in V1, switch active_pipeline to v2 to use)`);
    }

    // Fallback to env vars if DB values are empty
    return {
      volt220_api_token: data.volt220_api_token || Deno.env.get('VOLT220_API_TOKEN') || null,
      openrouter_api_key: data.openrouter_api_key || null,
      google_api_key: data.google_api_key || null,
      ai_provider: data.ai_provider || 'openrouter',
      classifier_prompt: (data as { classifier_prompt?: string | null }).classifier_prompt || null,
      ai_model: data.ai_model || 'meta-llama/llama-3.3-70b-instruct:free',
      system_prompt: data.system_prompt || null,
      classifier_provider: data.classifier_provider || 'auto',
      classifier_model: data.classifier_model || 'anthropic/claude-sonnet-4.5',
      query_first_enabled: qf,
      soft_suggest_enabled: ss,
    };
  } catch (e) {
    console.error('[Settings] Failed to load settings:', e);
      return {
        volt220_api_token: Deno.env.get('VOLT220_API_TOKEN') || null,
        openrouter_api_key: null,
        google_api_key: null,
        ai_provider: 'openrouter',
        ai_model: 'meta-llama/llama-3.3-70b-instruct:free',
      classifier_prompt: null,
        system_prompt: null,
        classifier_provider: 'auto',
        classifier_model: 'anthropic/claude-sonnet-4.5',
        query_first_enabled: false,
        soft_suggest_enabled: false,
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

  // MODEL UPGRADE (2026-05-02): switched final response model from Gemini to Claude.
  // Gemini галлюцинировал в коротких ветках (price/title/article shortcircuit) — выдумывал
  // ссылки и товары, которых нет в переданном списке. Claude Sonnet 4.5 строго цитирует
  // только переданные товары и не дописывает от себя. Стоимость ~2-3x, latency +2-4с.
  let model = settings.ai_model || 'anthropic/claude-sonnet-4.5';
  if (!model.includes('/')) {
    // Bare names like "gemini-2.5-flash" → assume Google. Claude/OpenAI всегда указываются с префиксом.
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
// ============================================================
// Degraded-mode tracking (V1 honest-fail)
// ============================================================
// Per-request flag: was there ANY transport-level failure when calling
// the 220volt catalog API during this request? If so, the final LLM
// must NOT say "ничего не нашлось" — it must honestly admit the outage
// and offer verbal advice + manager handoff.
//
// State is keyed by reqId (set once per `serve` invocation) and lives
// in a module-level Map with TTL cleanup (Deno isolates are reused).
// We do NOT thread the flag through every helper — instead the central
// fetch wrapper marks it, and direct fetch() callsites use markIfCatalogError().
type DegradedState = { reasons: string[]; ts: number };
const _catalogDegraded = new Map<string, DegradedState>();
const _DEGRADED_TTL_MS = 5 * 60 * 1000;

function _gcDegraded() {
  const now = Date.now();
  for (const [k, v] of _catalogDegraded.entries()) {
    if (now - v.ts > _DEGRADED_TTL_MS) _catalogDegraded.delete(k);
  }
}

function markCatalogError(reqIdOrReason: string | undefined, maybeReason?: string): void {
  // Overload: markCatalogError(reason) — reads reqId from async context.
  // Or:       markCatalogError(reqId, reason) — explicit form (kept for fetchCatalogWithRetry).
  let reqId: string | undefined;
  let reason: string;
  if (maybeReason === undefined) {
    reqId = _currentReqId();
    reason = reqIdOrReason ?? 'unknown';
  } else {
    reqId = reqIdOrReason ?? _currentReqId();
    reason = maybeReason;
  }
  if (!reqId) return;
  const cur = _catalogDegraded.get(reqId);
  if (cur) {
    if (cur.reasons.length < 8) cur.reasons.push(reason);
    cur.ts = Date.now();
  } else {
    _catalogDegraded.set(reqId, { reasons: [reason], ts: Date.now() });
    if (_catalogDegraded.size > 1000) _gcDegraded();
  }
  console.warn(`[Degraded] Catalog API failure marked (reqId=${reqId}): ${reason}`);
}

function isCatalogDegraded(reqId?: string): boolean {
  const id = reqId ?? _currentReqId();
  if (!id) return false;
  return _catalogDegraded.has(id);
}

function getCatalogDegradedReasons(reqId?: string): string[] {
  const id = reqId ?? _currentReqId();
  if (!id) return [];
  return _catalogDegraded.get(id)?.reasons ?? [];
}

function clearCatalogDegraded(reqId?: string): void {
  const id = reqId ?? _currentReqId();
  if (!id) return;
  _catalogDegraded.delete(id);
}

/** Mark degraded if the error came from a 220volt catalog fetch. reqId optional — falls back to async context. */
function markIfCatalogError(tag: string, err: unknown, reqId?: string): void {
  const isAbort = (err as Error)?.name === 'AbortError';
  markCatalogError(reqId ?? _currentReqId(), isAbort ? `${tag}:timeout` : `${tag}:${(err as Error)?.message || 'fetch_error'}`);
}

/** Mark degraded for a non-OK HTTP response from catalog API. */
function markIfCatalogHttpError(tag: string, status: number, reqId?: string): void {
  markCatalogError(reqId ?? _currentReqId(), `${tag}:http_${status}`);
}

async function fetchCatalogWithRetry(
  url: string,
  apiToken: string,
  tag: string,
  timeoutMs = 8000,
  reqId?: string
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
        if (attempt === 2) {
          markCatalogError(reqId, `${tag}:http_${resp.status}`);
          return null;
        }
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
      if (attempt === 2) {
        markCatalogError(reqId, isAbort ? `${tag}:timeout` : `${tag}:${(err as Error)?.message || 'fetch_error'}`);
        return null;
      }
    }
  }
  return null;
}

/**
 * Exact lookup by Catalog `?pagetitle=` (full product title, символ-в-символ).
 * Используется как первая ступень PAGETITLE-FIRST FAST-PATH перед ?query=.
 * 0 результатов = нормальная ситуация (название не совпало точно) — продолжаем pipeline.
 */
async function searchByPagetitle(pagetitle: string, apiToken: string, perPage = 10): Promise<Product[]> {
  if (!pagetitle || !isSafeTitleParam(pagetitle)) return [];
  const params = new URLSearchParams();
  params.append('pagetitle', pagetitle);
  params.append('per_page', perPage.toString());

  console.log(`[PagetitleSearch] Searching by pagetitle: "${pagetitle.substring(0, 80)}"`);

  const response = await fetchCatalogWithRetry(
    `${VOLT220_API_URL}?${params}`,
    apiToken,
    'PagetitleSearch',
    8000
  );
  if (!response) return [];

  try {
    const rawData = await response.json();
    const data = rawData.data || rawData;
    const results = data.results || [];
    console.log(`[PagetitleSearch] Found ${results.length} product(s) for pagetitle "${pagetitle.substring(0, 60)}"`);
    return results;
  } catch (error) {
    console.error(`[PagetitleSearch] Parse error:`, error);
    return [];
  }
}

/**
 * Exact lookup by Catalog `?longtitle=` (extended product title, символ-в-символ).
 * Зеркало searchByPagetitle: используется как доп. ступень, если pagetitle вернул 0
 * (классификатор мог отдать «расширенное» имя с атрибутами вроде «переносная»/«IP44»,
 * которое матчится на longtitle, а не на pagetitle).
 * 0 результатов = нормальная ситуация — продолжаем pipeline.
 */
async function searchByLongtitle(longtitle: string, apiToken: string, perPage = 10): Promise<Product[]> {
  if (!longtitle || !isSafeTitleParam(longtitle)) return [];
  const params = new URLSearchParams();
  params.append('longtitle', longtitle);
  params.append('per_page', perPage.toString());

  console.log(`[LongtitleSearch] Searching by longtitle: "${longtitle.substring(0, 80)}"`);

  const response = await fetchCatalogWithRetry(
    `${VOLT220_API_URL}?${params}`,
    apiToken,
    'LongtitleSearch',
    8000
  );
  if (!response) return [];

  try {
    const rawData = await response.json();
    const data = rawData.data || rawData;
    const results = data.results || [];
    console.log(`[LongtitleSearch] Found ${results.length} product(s) for longtitle "${longtitle.substring(0, 60)}"`);
    return results;
  } catch (error) {
    console.error(`[LongtitleSearch] Parse error:`, error);
    return [];
  }
}

/**
 * Эвристика «запрос похож на конкретную модель/SKU» — цифры + единицы/размеры/IP/модули.
 * Используется как ДОПОЛНИТЕЛЬНЫЙ триггер pagetitle-first, если классификатор
 * пропустил has_product_name (типичный кейс: «Щит ... 75*124*57мм IP20»).
 */
function looksLikeProductMarking(text: string): boolean {
  if (!text || text.length < 6) return false;
  const t = text.toLowerCase();
  const hasDigit = /\d/.test(t);
  if (!hasDigit) return false;
  // Размеры (75*124*57, 3х2.5, 12x24), IP-класс, единицы, «модул», «мм», артикул-подобные
  return /(\d+\s*[x×х*]\s*\d+)|ip\s*\d{2}|\bмм\b|\bсм\b|\bвт\b|\bw\b|\bмодул|[a-zа-я]+\d|\d[a-zа-я]+/i.test(t);
}

function scoreDimensionGrouping(parts: string[]): number {
  const lengths = parts.map((p) => p.length);
  const spread = Math.max(...lengths) - Math.min(...lengths);
  const singleDigitPenalty = lengths.some((len) => len === 1) ? 2 : 0;
  const middleBonus = parts.length === 3 && lengths[1] === 3 ? -0.25 : 0;
  const edgePenalty = (lengths[0] === 2 ? 0 : 0.2) + (lengths[lengths.length - 1] === 2 ? 0 : 0.2);
  return spread + singleDigitPenalty + edgePenalty + middleBonus;
}

function buildDimensionGroupings(digits: string, maxVariants = 4): string[] {
  if (!/^\d{5,9}$/.test(digits)) return [];

  const candidates: string[][] = [];
  const visit = (offset: number, remainingGroups: number, parts: string[]) => {
    if (remainingGroups === 1) {
      const tailLen = digits.length - offset;
      if (tailLen < 1 || tailLen > 3) return;
      candidates.push([...parts, digits.slice(offset)]);
      return;
    }

    for (let len = 1; len <= 3; len += 1) {
      const next = offset + len;
      const remainingDigits = digits.length - next;
      const minNeeded = remainingGroups - 1;
      const maxNeeded = (remainingGroups - 1) * 3;
      if (remainingDigits < minNeeded || remainingDigits > maxNeeded) continue;
      visit(next, remainingGroups - 1, [...parts, digits.slice(offset, next)]);
    }
  };

  visit(0, 3, []);

  return candidates
    .sort((a, b) => scoreDimensionGrouping(a) - scoreDimensionGrouping(b))
    .map((parts) => parts.join('*'))
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .slice(0, maxVariants);
}

function buildTitleSearchCandidates(input: string): { exact: string[]; query: string[] } {
  const base = input.trim().replace(/\s+/g, ' ');
  const exact: string[] = [];
  const query: string[] = [];
  const pushUniqueExact = (value: string) => {
    const cleaned = value.trim();
    if (!cleaned || exact.includes(cleaned)) return;
    exact.push(cleaned);
  };
  const pushUniqueQuery = (value: string) => {
    const cleaned = value.trim().replace(/\s+/g, ' ');
    if (!cleaned || query.includes(cleaned)) return;
    query.push(cleaned);
  };

  if (!base) return { exact, query };

  const addExactVariants = (value: string) => {
    pushUniqueExact(value);
    pushUniqueExact(value.replace(/\.\s+(?=[A-Za-zА-Яа-яЁё])/g, '.'));
    pushUniqueExact(value.replace(/\s+IP(\d{2})\b/gi, '  IP$1'));
    pushUniqueExact(value.replace(/\.\s+(?=[A-Za-zА-Яа-яЁё])/g, '.').replace(/\s+IP(\d{2})\b/gi, '  IP$1'));
  };

  addExactVariants(base);
  pushUniqueQuery(base);

  const separatorNormalized = base
    .replace(/\s*[x×хХX]\s*/g, '*')
    .replace(/мм/gi, 'mm');

  addExactVariants(separatorNormalized);
  addExactVariants(separatorNormalized.replace(/\bmm\b/gi, 'мм'));
  pushUniqueQuery(separatorNormalized.replace(/\*/g, ' '));

  const gluedMatches = Array.from(separatorNormalized.matchAll(/(\d{5,9})\s*(mm|мм)\b/gi));
  for (const match of gluedMatches) {
    const fullMatch = match[0];
    const digits = match[1];
    const groupings = buildDimensionGroupings(digits, 4);
    for (const grouped of groupings) {
      addExactVariants(separatorNormalized.replace(fullMatch, `${grouped}mm`));
      addExactVariants(separatorNormalized.replace(fullMatch, `${grouped}мм`));
      pushUniqueQuery(separatorNormalized.replace(fullMatch, `${grouped.replace(/\*/g, ' ')} mm`));
    }
  }

  return {
    exact: exact.slice(0, 10),
    query: query.slice(0, 4),
  };
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
 * Thin wrapper around shared `fetchRelatedProducts` — оставлен для совместимости
 * с прежним сигнатурой (productId, apiToken). Использует общий fetchCatalogWithRetry,
 * чтобы сохранить request-scoped circuit-breaker и логирование Degraded-mode.
 */
async function fetchRelatedProducts(productId: number, apiToken: string): Promise<Product[]> {
  return (await fetchRelatedProductsShared(productId, {
    fetchRelatedRaw: (id, params) =>
      fetchCatalogWithRetry(buildRelatedUrl(id, params), apiToken, 'Related', 6000),
  })) as unknown as Product[];
}

/**
 * Build /api/products/{id}/related URL with optional query params.
 * Mirrors /products: page, per_page, category, min_price, max_price (swagger 2026-05-13).
 */
function buildRelatedUrl(id: number, params?: { page?: number; perPage?: number; category?: string; minPrice?: number; maxPrice?: number; options?: Record<string, string[]> }): string {
  const base = `https://220volt.kz/api/products/${id}/related`;
  if (!params) return base;
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.perPage) qs.set('per_page', String(params.perPage));
  if (params.category) qs.set('category', params.category);
  if (params.minPrice != null) qs.set('min_price', String(params.minPrice));
  if (params.maxPrice != null) qs.set('max_price', String(params.maxPrice));
  if (params.options) {
    for (const [k, vals] of Object.entries(params.options)) {
      for (const v of vals) qs.append(`options[${k}][]`, v);
    }
  }
  const s = qs.toString();
  return s ? `${base}?${s}` : base;
}

/**
 * Decide whether a Micro-LLM classification yields a candidate title strong enough
 * for the title-first fast-path (single API hop via ?query=, skip slot/category/strict).
 *
 * Heuristic: classifier flagged has_product_name AND the name looks like a real
 * product model — long enough, contains a digit OR a latin letter (model markers
 * such as "A60", "LED", "9W", "E27", "GX53", "IP44"). Pure "лампы для школы" or
 * "розетки белые" → no digit/latin → NOT a candidate, fall through to normal pipeline.
 */
function extractCandidateTitle(classification: ClassificationResult | null): string | null {
  if (!classification?.has_product_name) return null;
  const name = (classification.product_name || '').trim();
  if (name.length < 6) return null;
  const hasLetter = /[A-Za-zА-Яа-яЁё]/.test(name);
  const hasDigitOrLatin = /[\dA-Za-z]/.test(name);
  if (!hasLetter || !hasDigitOrLatin) return null;
  return name;
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
    caption?: string;
    value?: string;
    caption_ru?: string;
    value_ru?: string;
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

interface ComputeRequest {
  /** Что спрашивают: «вес», «мощность», «IP», «габариты», «гарантия», «количество ламп» и т.п. */
  attribute: string;
  /** Множитель ×N штук, если пользователь указал количество. null/undefined = одна штука. */
  multiplier?: number | null;
}

interface ExtractedIntent {
  intent: 'catalog' | 'brands' | 'info' | 'general';
  candidates: SearchCandidate[];
  originalQuery: string;
  usage_context?: string;
  english_queries?: string[];
  /** Надстройка к любой ветке: пользователь хочет узнать характеристику найденного товара (опц. ×N). */
  compute?: ComputeRequest;
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
  sub_intent?: 'availability' | 'price' | 'location' | 'spec';
  /** Расчёт характеристики, заполняется только при sub_intent="spec". */
  compute?: ComputeRequest;
}

function detectSubIntentFallback(message: string): ClassificationResult['sub_intent'] {
  const normalized = message
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[?!.:,;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return undefined;

  if (
    /(сколько стоит|какая цена|почем|почём|цена)/.test(normalized)
  ) {
    return 'price';
  }

  if (
    /(где забрат|в каком магазин|в каком городе|самовывоз|где находится|где есть)/.test(normalized)
  ) {
    return 'location';
  }

  if (
    /(какая мощност|какой ток|какая длина|какое сечение|какой материал|какая характеристик|сколько ват|сколько киловат|сколько ампер)/.test(normalized)
  ) {
    return 'spec';
  }

  if (
    /(есть в наличии|в наличии|есть ли|остал(?:ся|ись|ось)|можно купить|доступен|доступна|доступны)/.test(normalized)
  ) {
    return 'availability';
  }

  return undefined;
}

// Diagnostics последнего вызова classifyProductName — читается caller'ом для логирования.
// Прозрачно показывает причину null/деградации: timeout / http_error / empty / parse_error / recovery_path.
export interface ClassifyDiagnostics {
  model: string | null;
  http_status: number | null;
  response_ms: number | null;
  timeout: boolean;
  empty_content: boolean;
  raw_preview: string | null;       // первые 500 символов content (или error message)
  parse_error: string | null;       // exception message при JSON.parse
  recovery_used: 'json_repair' | 'regex_extract' | null;
  fail_reason: 'no_api_key' | 'http_error' | 'timeout' | 'empty' | 'parse_failed' | 'exception' | null;
  exception: string | null;
}
let __lastClassifyDiagnostics: ClassifyDiagnostics = {
  model: null, http_status: null, response_ms: null, timeout: false,
  empty_content: false, raw_preview: null, parse_error: null,
  recovery_used: null, fail_reason: null, exception: null,
};
export function getLastClassifyDiagnostics(): ClassifyDiagnostics { return __lastClassifyDiagnostics; }

async function classifyProductName(message: string, recentHistory?: Array<{role: string, content: string}>, settings?: CachedSettings | null): Promise<ClassificationResult | null> {
  // Reset diagnostics для нового вызова
  __lastClassifyDiagnostics = {
    model: null, http_status: null, response_ms: null, timeout: false,
    empty_content: false, raw_preview: null, parse_error: null,
    recovery_used: null, fail_reason: null, exception: null,
  };
  // STRICT OpenRouter: no cascade, no Google direct, no Lovable Gateway.
  // Cascade fallbacks were a primary source of non-determinism (different users got different providers).
  if (!settings?.openrouter_api_key) {
    console.log('[Classify] OpenRouter key missing — classification skipped (deterministic null)');
    __lastClassifyDiagnostics.fail_reason = 'no_api_key';
    return null;
  }

  // MODEL UPGRADE (2026-05-02): switched Classifier from Gemini Flash to Claude Sonnet 4.5.
  // Gemini Flash нестабильно определял price_intent (самый дешёвый/дорогой) и critical_modifiers,
  // что приводило к выбору неправильной ветки (catalog vs price-shortcircuit) и к выдуманным
  // ответам. Claude строже следует JSON-схеме классификатора.
  const model = 'anthropic/claude-sonnet-4.5';

  const url = 'https://openrouter.ai/api/v1/chat/completions';
  const apiKeys = [settings.openrouter_api_key];

  console.log(`[Classify] OpenRouter (strict), model=${model} (Claude — strict intent/price_intent)`);

  const systemPrompt = (settings?.classifier_prompt && settings.classifier_prompt.trim().length > 50)
    ? settings.classifier_prompt
    : DEFAULT_CLASSIFIER_PROMPT;

  const classifyBody = {
    model: model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...(recentHistory || []).map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user', content: message }
    ],
    ...samplingFor(model),
    max_tokens: 300,
    reasoning: { exclude: true },
  };
  console.log(`[ExtractIntent] Sampling for ${model}: ${model.startsWith('anthropic/') ? 'temperature=0 top_p=1 (Claude)' : 'top_k=1 seed=42 google-ai-studio'}`);

  // STRICT OpenRouter: single deterministic attempt, no cascade fallbacks.
  // Fallbacks to other providers caused different users to get different classifier outputs.
  interface ProviderAttempt { url: string; apiKeys: string[]; model: string; label: string; }
  const attempts: ProviderAttempt[] = [{ url, apiKeys, model, label: 'openrouter(strict)' }];

  for (const attempt of attempts) {
    const attemptStart = Date.now();
    __lastClassifyDiagnostics.model = attempt.model;
    try {
      const body = { ...classifyBody, model: attempt.model };
      const classifyPromise = callAIWithKeyFallback(attempt.url, attempt.apiKeys, body, 'Classify');
      const timeoutPromise = new Promise<Response>((_, reject) => 
        setTimeout(() => reject(new DOMException('Timeout', 'AbortError')), 12000)
      );

      const response = await Promise.race([classifyPromise, timeoutPromise]);
      __lastClassifyDiagnostics.response_ms = Date.now() - attemptStart;
      __lastClassifyDiagnostics.http_status = response.status;

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        __lastClassifyDiagnostics.raw_preview = errBody.slice(0, 500);
        __lastClassifyDiagnostics.fail_reason = 'http_error';
        console.error(`[Classify] ${attempt.label} error: ${response.status}, trying next...`);
        continue;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        __lastClassifyDiagnostics.empty_content = true;
        __lastClassifyDiagnostics.raw_preview = JSON.stringify(data).slice(0, 500);
        __lastClassifyDiagnostics.fail_reason = 'empty';
        console.log(`[Classify] ${attempt.label} empty response, trying next...`);
        continue;
      }

      const jsonStr = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      __lastClassifyDiagnostics.raw_preview = jsonStr.slice(0, 500);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (parseErr) {
        // Recovery: try to repair truncated JSON (closing braces/quotes)
        __lastClassifyDiagnostics.parse_error = (parseErr as Error)?.message ?? String(parseErr);
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
          __lastClassifyDiagnostics.recovery_used = 'json_repair';
          console.log(`[Classify] ${attempt.label} JSON recovered successfully`);
        } catch {
          // Last resort: regex-extract critical fields
          const intentMatch = jsonStr.match(/"intent"\s*:\s*"(\w+)"/);
          const hasNameMatch = jsonStr.match(/"has_product_name"\s*:\s*(true|false)/);
          const productNameMatch = jsonStr.match(/"product_name"\s*:\s*"([^"]*)"/);
          const categoryMatch = jsonStr.match(/"product_category"\s*:\s*"([^"]*)"/);
          if (intentMatch || hasNameMatch) {
            __lastClassifyDiagnostics.recovery_used = 'regex_extract';
            console.log(`[Classify] ${attempt.label} regex-extracted partial result`);
            parsed = {
              intent: intentMatch?.[1],
              has_product_name: hasNameMatch?.[1] === 'true',
              product_name: productNameMatch?.[1],
              product_category: categoryMatch?.[1],
              search_modifiers: [],
            };
          } else {
            __lastClassifyDiagnostics.fail_reason = 'parse_failed';
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
      const validSubIntents = ['availability', 'price', 'location', 'spec'];
      const rawSubIntent = typeof parsed.sub_intent === 'string' ? parsed.sub_intent.toLowerCase().trim() : null;
      const llmSubIntent = validSubIntents.includes(rawSubIntent!) ? rawSubIntent as ClassificationResult['sub_intent'] : undefined;
      const subIntent = llmSubIntent ?? detectSubIntentFallback(message);
      if (!llmSubIntent && subIntent) {
        console.log(`[Classify] sub_intent fallback=${subIntent} for message="${message.slice(0, 120)}"`);
      }
      // Compute (spec_query): принимаем только когда sub_intent='spec' и attribute непустой.
      let computeField: ComputeRequest | undefined;
      if (subIntent === 'spec' && parsed.compute && typeof parsed.compute === 'object') {
        const rawAttr = (parsed.compute as Record<string, unknown>).attribute;
        if (typeof rawAttr === 'string' && rawAttr.trim().length > 0) {
          const rawMul = (parsed.compute as Record<string, unknown>).multiplier;
          const multiplier = (typeof rawMul === 'number' && Number.isFinite(rawMul) && rawMul > 0)
            ? Math.floor(rawMul)
            : null;
          computeField = { attribute: rawAttr.trim(), multiplier };
          console.log(`[Classify] compute extracted: attribute="${computeField.attribute}", multiplier=${multiplier ?? 'null'}`);
        }
      }
      return {
        intent: finalIntent as string | undefined,
        has_product_name: !!parsed.has_product_name,
        product_name: (typeof parsed.product_name === 'string' ? parsed.product_name : '') || undefined,
        price_intent: (parsed.price_intent === 'most_expensive' || parsed.price_intent === 'cheapest') ? parsed.price_intent : undefined,
        product_category: (typeof parsed.product_category === 'string' ? parsed.product_category : '') || undefined,
        is_replacement: !!parsed.is_replacement,
        search_modifiers: rawSearchMods,
        critical_modifiers: rawCritical,
        sub_intent: subIntent,
        compute: computeField,
      };
    } catch (e) {
      __lastClassifyDiagnostics.exception = (e as Error)?.message ?? String(e);
      if (e instanceof DOMException && e.name === 'AbortError') {
        __lastClassifyDiagnostics.timeout = true;
        __lastClassifyDiagnostics.fail_reason = 'timeout';
        console.log(`[Classify] ${attempt.label} timeout (12s), no fallback (strict OpenRouter)`);
      } else {
        if (!__lastClassifyDiagnostics.fail_reason) __lastClassifyDiagnostics.fail_reason = 'exception';
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
    const captionLower = (opt.caption ?? '').toLowerCase();

    if (!importantPatterns.some(p => p.test(keyLower) || p.test(captionLower))) continue;

    const cleanValue = (opt.value ?? '').split('//')[0].trim();
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
// Source: 220volt /api/categories/options?pagetitle=... (added Apr 2026).
// Returns the full options schema for ALL products in the category — no sampling.
// Shape: { category: {total_products, ...}, options: [{key, caption_ru, caption_kz,
//   values: [{value_ru, value_kz, products_count}, ...]}] }
//
// We map it to the existing internal type Map<key, {caption, values:Set<string>}>
// where values are stored as `${value_ru}//${value_kz}` so downstream code that
// already does .split('//')[0] keeps working untouched.
//
// On error or empty options[]: fallback to legacy product-sampling implementation.
// TTL 30m, in-memory.
const CATEGORY_OPTIONS_TTL_MS = 30 * 60 * 1000;
// Cache version — bump when dedupe logic changes so old entries (with stale dup keys)
// invalidate immediately on deploy without waiting 30 min TTL.
const CATEGORY_OPTIONS_CACHE_VERSION = 'v3-confidence';
// Confidence reflects whether downstream resolvers may trust the schema:
//   'full'    — facets API returned with non-empty values for every kept key.
//               Resolver runs at full strength (key+value lookup against truth).
//   'partial' — schema came from legacy product-sampling fallback (≤200 items),
//               so values are a subset of reality. Resolver MUST NOT guess on
//               this — pipeline degrades to top-N + ask-user instead of silently
//               picking a wrong filter from a truncated value list.
//   'empty'   — neither facets API nor sampling produced anything usable.
type SchemaConfidence = 'full' | 'partial' | 'empty';
interface CategorySchemaResult {
  schema: Map<string, { caption: string; values: Set<string> }>;
  productCount: number;
  cacheHit: boolean;
  confidence: SchemaConfidence;
  source: 'facets-api' | 'legacy-sampling' | 'cache' | 'none';
}
const categoryOptionsCache: Map<string, { schema: Map<string, { caption: string; values: Set<string> }>; ts: number; productCount: number; confidence: SchemaConfidence; source: 'facets-api' | 'legacy-sampling' }> = new Map();
const cacheKey = (pagetitle: string) => `${CATEGORY_OPTIONS_CACHE_VERSION}:${pagetitle}`;
// Single-flight: dedupes concurrent cold-loads for the same category. Without this,
// 5 parallel buckets requesting the same /categories/options endpoint would issue
// 5 HTTP calls and choke upstream (observed: 14s timeouts when 2 cold-loads collide).
const inflightSchemaRequests: Map<string, Promise<CategorySchemaResult>> = new Map();
// Stale-while-revalidate window: after TTL (30m) we still serve cached `full` data
// for up to STALE_GRACE_MS while a background refresh runs. Never serves stale
// `partial`/`empty` — those must always re-fetch (they were degraded to begin with).
const STALE_GRACE_MS = 60 * 60 * 1000; // 1h beyond TTL

// =============================================================================
// OPTION ALIASES — duplicate-key collapse.
// Some categories expose the same physical property under multiple distinct
// API keys (e.g. "Розетки" → cvet__tүs vs "Розетки силовые" → cvet__tүsі).
// These are different keys for the API: filtering by one will miss products
// stored under the other. We collapse duplicates BEFORE handing the schema to
// FilterLLM (LLM sees one key per property), and on the way OUT we expand the
// chosen key back into all its aliases when building the API request — so the
// final query becomes options[cvet__tүs][]=Чёрный&options[cvet__tүsі][]=Чёрный.
//
// Registry is module-level (built lazily by dedupeSchemaInPlace, read by
// applyResolvedFiltersToParams). It's idempotent — re-running on the same
// schema is a no-op.
// =============================================================================
const optionAliasesRegistry: Map<string, string[]> = new Map();

function getAliasKeysFor(representativeKey: string): string[] {
  const aliases = optionAliasesRegistry.get(representativeKey);
  return aliases && aliases.length > 0 ? aliases : [representativeKey];
}

// Caption normalization for grouping: "Цвет" / "цвет " / "цвет (корпуса)" → "цвет"
function normalizeOptionCaption(caption: string): string {
  if (!caption) return '';
  return caption
    .split('//')[0]
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\([^)]*\)/g, '') // drop "(мм)", "(шт)" etc
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Key prefix up to first "__" — used as a guard so we never merge two physically
// different properties that happen to share a translated caption.
// e.g. cvet__tүs (prefix="cvet") vs cvetovaya_temperatura__... (prefix="cvetovaya_temperatura")
//      → different prefixes → NOT merged.
function keyPrefix(key: string): string {
  const idx = key.indexOf('__');
  return idx > 0 ? key.slice(0, idx) : key;
}

// Force-merge family: ALL keys whose prefix is exactly "cvet" (the body color),
// excluding nothing (cvetovaya_temperatura has prefix "cvetovaya_temperatura",
// so it is naturally excluded by prefix-equality).
const FORCE_MERGE_PREFIXES = new Set<string>(['cvet']);

// Kazakh-suffix family normalization. Real-world dup pattern from 220volt:
//   cvet__tүs   ↔ cvet__tүsі   (translit suffix differ by trailing і)
//   garantiynyy ↔ garantiynyi  (Russian translit variants)
// Strategy: collapse trailing Kazakh case/affix endings AND common translit
// variants on the part AFTER "__" so that minor spelling drift collapses to
// one canonical bucket. Idempotent. No external dependencies.
function normalizeKeyForFuzzyMerge(key: string): string {
  const idx = key.indexOf('__');
  if (idx < 0) return key;
  const prefix = key.slice(0, idx);
  let suffix = key.slice(idx + 2);
  // Strip trailing Kazakh-case affixes (longest first to avoid partial collisions).
  // Covers і / ы / нің / тің / ің / ғі / гі — common nominative/genitive endings
  // that surface in 220volt option keys.
  suffix = suffix.replace(/(ң?нің|ң?тің|ң?ің|ғі|гі|і|ы)$/u, '');
  // Common Russian translit variant: trailing -yy ↔ -yi (garantiynyy / garantiynyi).
  suffix = suffix.replace(/yy$/, 'y').replace(/yi$/, 'y');
  return `${prefix}__${suffix}`;
}

/**
 * Collapse duplicate keys in a schema (in-place). Two keys are considered
 * aliases when they have the SAME key-prefix (substring before first "__")
 * AND the same normalized caption. Force-merge families (cvet) ignore the
 * caption check — any two cvet__* keys are merged together.
 *
 * Pass 2 (post-caption-merge): collapse residual duplicates within the same
 * prefix when their suffixes differ only by Kazakh case affixes or yy/yi
 * translit drift. Catches cvet__tүs ↔ cvet__tүsі that survive the caption
 * pass because their captions are literally different strings.
 *
 * Side effects:
 *  - mutates `schema` (deletes alias entries, keeps representative)
 *  - merges values from aliases into the representative's values set (null-safe)
 *  - writes representative→[aliases incl self] mapping into optionAliasesRegistry
 *
 * Representative selection: key with the largest values set wins; ties → first
 * alphabetically. This keeps logging/debug stable across runs.
 */
function dedupeSchemaInPlace(schema: Map<string, { caption: string; values: Set<string> }>, contextLabel: string): void {
  if (!schema || schema.size < 2) return;

  // Diagnostic: surface known-duplicate families BEFORE dedupe so we can see
  // exactly what came from the API in logs (helps explain regressions).
  const KNOWN_DUP_FAMILIES = ['cvet', 'garantiynyy', 'garantiynyi', 'stepeny_zaschity', 'srok_slughby', 'material'];
  for (const family of KNOWN_DUP_FAMILIES) {
    const matching = Array.from(schema.keys()).filter(k => k === family || k.startsWith(family + '__'));
    if (matching.length >= 2) {
      console.log(`[DedupDebug] ${contextLabel}: BEFORE family="${family}" (${matching.length} keys): ${JSON.stringify(matching)}`);
    }
  }

  // ===== PASS 1: prefix + caption (existing behavior) =====
  // Group: prefix → captionNormalized → list of {key, info}
  const groups: Map<string, Map<string, Array<{ key: string; info: { caption: string; values: Set<string> } }>>> = new Map();
  for (const [key, info] of schema.entries()) {
    const prefix = keyPrefix(key);
    const captionNorm = FORCE_MERGE_PREFIXES.has(prefix) ? '__force__' : normalizeOptionCaption(info.caption);
    if (!captionNorm) continue;
    if (!groups.has(prefix)) groups.set(prefix, new Map());
    const byCaption = groups.get(prefix)!;
    if (!byCaption.has(captionNorm)) byCaption.set(captionNorm, []);
    byCaption.get(captionNorm)!.push({ key, info });
  }

  for (const [prefix, byCaption] of groups.entries()) {
    for (const [captionNorm, members] of byCaption.entries()) {
      if (members.length < 2) continue;

      // Pick representative: most values, then alphabetic.
      members.sort((a, b) => {
        const sizeDiff = b.info.values.size - a.info.values.size;
        if (sizeDiff !== 0) return sizeDiff;
        return a.key.localeCompare(b.key);
      });
      const rep = members[0];
      const aliasList: string[] = members.map(m => m.key);

      // Union all values into representative (null-safe — degraded payloads
      // can leak undefined/empty into Sets).
      for (let i = 1; i < members.length; i++) {
        for (const v of members[i].info.values) if (v) rep.info.values.add(v);
        schema.delete(members[i].key);
      }

      optionAliasesRegistry.set(rep.key, aliasList);
      console.log(`[OptionAliases] ${contextLabel}: grouped under "${rep.key}" (caption="${(rep.info.caption ?? '').split('//')[0]}", prefix="${prefix}"): [${aliasList.join(', ')}] — ${rep.info.values.size} values total`);
    }
  }

  // ===== PASS 2: Kazakh-suffix / translit fuzzy merge =====
  // After PASS 1 there may still be residual dups whose captions differ literally
  // (e.g. cvet__tүs caption="Цвет" vs cvet__tүsі caption="Цвет //Түсі") OR captions
  // are bilingually-formatted differently. Collapse by fuzzy-normalized key.
  const fuzzyGroups: Map<string, Array<{ key: string; info: { caption: string; values: Set<string> } }>> = new Map();
  for (const [key, info] of schema.entries()) {
    const normKey = normalizeKeyForFuzzyMerge(key);
    if (normKey === key && !key.includes('__')) continue; // skip prefix-less keys
    if (!fuzzyGroups.has(normKey)) fuzzyGroups.set(normKey, []);
    fuzzyGroups.get(normKey)!.push({ key, info });
  }

  for (const [normKey, members] of fuzzyGroups.entries()) {
    if (members.length < 2) continue;
    members.sort((a, b) => {
      const sizeDiff = b.info.values.size - a.info.values.size;
      if (sizeDiff !== 0) return sizeDiff;
      return a.key.localeCompare(b.key);
    });
    const rep = members[0];
    const mergedKeys: string[] = [rep.key];
    for (let i = 1; i < members.length; i++) {
      for (const v of members[i].info.values) if (v) rep.info.values.add(v);
      schema.delete(members[i].key);
      mergedKeys.push(members[i].key);
    }
    // Update aliases registry: union with whatever PASS 1 wrote (don't drop existing aliases).
    const existing = optionAliasesRegistry.get(rep.key) || [rep.key];
    const aliasUnion = Array.from(new Set([...existing, ...mergedKeys]));
    optionAliassRegistrySafeSet(rep.key, aliasUnion);
    console.log(`[ForceMerge] ${contextLabel}: fuzzy-merged ${mergedKeys.length} keys into "${rep.key}" (norm="${normKey}"): [${mergedKeys.join(', ')}] — ${rep.info.values.size} values total`);
  }

  // Diagnostic: AFTER pass — what's left for the same families.
  for (const family of KNOWN_DUP_FAMILIES) {
    const matching = Array.from(schema.keys()).filter(k => k === family || k.startsWith(family + '__'));
    if (matching.length >= 2) {
      console.log(`[DedupDebug] ${contextLabel}: AFTER family="${family}" still has ${matching.length} keys: ${JSON.stringify(matching)}`);
    }
  }
}

// Safe wrapper — keeps optionAliasesRegistry write contract identical to PASS 1
// (one place to change if we ever scope the registry per-request).
function optionAliassRegistrySafeSet(key: string, aliases: string[]) {
  optionAliasesRegistry.set(key, aliases);
}



async function getCategoryOptionsSchema(
  categoryPagetitle: string,
  apiToken: string
): Promise<CategorySchemaResult> {
  const key = cacheKey(categoryPagetitle);
  const cached = categoryOptionsCache.get(key);
  const now = Date.now();

  // FRESH cache hit
  if (cached && now - cached.ts < CATEGORY_OPTIONS_TTL_MS) {
    console.log(`[CategoryOptionsSchema] cache HIT "${categoryPagetitle}" (${cached.schema.size} keys, ${cached.productCount} products, conf=${cached.confidence}, src=${cached.source}, age=${Math.round((now - cached.ts) / 1000)}s)`);
    return { schema: cached.schema, productCount: cached.productCount, cacheHit: true, confidence: cached.confidence, source: 'cache' };
  }

  // STALE-WHILE-REVALIDATE: cache expired but still within grace window AND
  // confidence='full' (we never serve stale degraded data). Return stale immediately,
  // kick off background refresh (deduped by inflight map). User pays zero latency.
  if (cached && cached.confidence === 'full' && now - cached.ts < CATEGORY_OPTIONS_TTL_MS + STALE_GRACE_MS) {
    const ageMin = Math.round((now - cached.ts) / 60000);
    console.log(`[CategoryOptionsSchema] cache STALE-SERVE "${categoryPagetitle}" (age=${ageMin}m, refreshing in background)`);
    // Fire-and-forget refresh (errors swallowed — stale data is still good enough)
    if (!inflightSchemaRequests.has(key)) {
      const refreshPromise = _doFetchCategoryOptionsSchema(categoryPagetitle, apiToken)
        .catch(e => {
          console.log(`[CategoryOptionsSchema] background refresh failed for "${categoryPagetitle}": ${(e as Error).message}`);
          return { schema: cached.schema, productCount: cached.productCount, cacheHit: false, confidence: cached.confidence, source: 'cache' as const };
        })
        .finally(() => inflightSchemaRequests.delete(key));
      inflightSchemaRequests.set(key, refreshPromise);
    }
    return { schema: cached.schema, productCount: cached.productCount, cacheHit: true, confidence: cached.confidence, source: 'cache' };
  }

  // SINGLE-FLIGHT: if another request is already fetching this category, await it
  // instead of issuing a duplicate HTTP call (root cause of upstream timeout cascade).
  const inflight = inflightSchemaRequests.get(key);
  if (inflight) {
    console.log(`[CategoryOptionsSchema] single-flight WAIT "${categoryPagetitle}" (joining inflight request)`);
    return await inflight;
  }

  // Cold load: register inflight, fetch, clean up on completion (success or failure).
  const fetchPromise = _doFetchCategoryOptionsSchema(categoryPagetitle, apiToken)
    .finally(() => inflightSchemaRequests.delete(key));
  inflightSchemaRequests.set(key, fetchPromise);
  return await fetchPromise;
}

// Actual fetch implementation. Always called under single-flight protection from the
// public wrapper above — never call directly from feature code.
async function _doFetchCategoryOptionsSchema(
  categoryPagetitle: string,
  apiToken: string
): Promise<CategorySchemaResult> {
  const t0 = Date.now();
  const url = `https://220volt.kz/api/categories/options?pagetitle=${encodeURIComponent(categoryPagetitle)}`;

  // Inner: one fetch attempt with its own timeout/abort. Returns raw response or throws.
  const attemptFetch = async (attemptNo: number, timeoutMs: number): Promise<Response> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      return res;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  let res: Response | null = null;
  let lastError: unknown = null;
  // Attempt 1: 6s timeout. Attempt 2 (only on abort/network error): 8s after 300ms delay.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const tAttempt = Date.now();
      res = await attemptFetch(attempt, attempt === 1 ? 6000 : 8000);
      if (attempt === 2) {
        console.log(`[CategoryOptionsSchema] retry attempt=2 cat="${categoryPagetitle}" status=${res.status} took=${Date.now() - tAttempt}ms`);
      }
      break;
    } catch (e) {
      lastError = e;
      const isAbort = (e as any)?.name === 'AbortError' || /aborted|abort/i.test((e as Error).message);
      if (attempt === 1 && isAbort) {
        console.log(`[CategoryOptionsSchema] attempt=1 aborted cat="${categoryPagetitle}" took=${Date.now() - t0}ms → retrying once`);
        await new Promise(r => setTimeout(r, 300));
        continue;
      }
      // non-abort error or already retried — give up
      break;
    }
  }

  if (!res) {
    console.log(`[CategoryOptionsSchema] retry_failed cat="${categoryPagetitle}" total_ms=${Date.now() - t0} err="${(lastError as Error)?.message || 'unknown'}" → falling back to legacy sampling (will be marked confidence=partial)`);
    return await getCategoryOptionsSchemaLegacy(categoryPagetitle, apiToken);
  }

  try {
    if (!res.ok) {
      console.log(`[CategoryOptionsSchema] /categories/options HTTP ${res.status} for "${categoryPagetitle}" → falling back to legacy sampling`);
      return await getCategoryOptionsSchemaLegacy(categoryPagetitle, apiToken);
    }

    const raw = await res.json();
    let data = raw.data || raw;
    if (data && typeof data === 'object' && 'data' in data && !('options' in data)) data = (data as any).data;
    const optionsArr: any[] = Array.isArray(data?.options) ? data.options : [];
    const totalProducts: number = Number(data?.category?.total_products) || 0;

    if (optionsArr.length === 0) {
      console.log(`[CategoryOptionsSchema] /categories/options returned EMPTY options for "${categoryPagetitle}" (total_products=${totalProducts}) → falling back to legacy sampling`);
      return await getCategoryOptionsSchemaLegacy(categoryPagetitle, apiToken);
    }

    const schema: Map<string, { caption: string; values: Set<string> }> = new Map();
    let totalValues = 0;
    for (const opt of optionsArr) {
      if (!opt || typeof opt.key !== 'string') continue;
      if (isExcludedOption(opt.key)) continue;
      const captionRu = (opt.caption_ru || opt.caption || opt.key).toString().trim();
      const captionKz = (opt.caption_kz || '').toString().trim();
      const caption = captionKz ? `${captionRu}//${captionKz}` : captionRu;
      const valuesSet = new Set<string>();
      const values: any[] = Array.isArray(opt.values) ? opt.values : [];
      for (const v of values) {
        if (!v) continue;
        const vr = (v.value_ru ?? v.value ?? '').toString().trim();
        const vk = (v.value_kz ?? '').toString().trim();
        if (!vr && !vk) continue;
        const joined = vk ? `${vr}//${vk}` : vr;
        valuesSet.add(joined);
      }
      if (valuesSet.size === 0) continue;
      schema.set(opt.key, { caption, values: valuesSet });
      totalValues += valuesSet.size;
    }

    // Defensive: if API returned options[] but every entry had zero values,
    // we got a degraded payload (seen in prod). Don't cache, fall back to legacy.
    if (totalValues === 0) {
      console.log(`[CategoryOptionsSchema] /categories/options returned ${optionsArr.length} keys but ZERO values for "${categoryPagetitle}" → falling back to legacy sampling (NOT caching)`);
      return await getCategoryOptionsSchemaLegacy(categoryPagetitle, apiToken);
    }

    dedupeSchemaInPlace(schema, `facets:${categoryPagetitle}`);
    categoryOptionsCache.set(cacheKey(categoryPagetitle), { schema, ts: Date.now(), productCount: totalProducts, confidence: 'full', source: 'facets-api' });
    const keysWithZero = Array.from(schema.values()).filter(i => i.values.size === 0).length;
    const totalValuesPostDedupe = Array.from(schema.values()).reduce((s, i) => s + i.values.size, 0);
    console.log(`[FacetsHealth] cat="${categoryPagetitle}" source=facets-api confidence=full keys=${schema.size} keys_with_zero_values=${keysWithZero} total_values=${totalValuesPostDedupe} products=${totalProducts}`);
    console.log(`[CategoryOptionsSchema] /categories/options HIT "${categoryPagetitle}": ${schema.size} keys, ${totalValues} values, ${totalProducts} products, ${Date.now() - t0}ms (cached 30m, post-dedupe, confidence=full)`);
    return { schema, productCount: totalProducts, cacheHit: false, confidence: 'full', source: 'facets-api' };
  } catch (e) {
    console.log(`[CategoryOptionsSchema] /categories/options parse error for "${categoryPagetitle}": ${(e as Error).message} → falling back to legacy sampling`);
    return await getCategoryOptionsSchemaLegacy(categoryPagetitle, apiToken);
  }
}

// Legacy implementation: samples up to 5×200 products and aggregates options manually.
// Kept as a safety fallback for the first weeks after switching to /categories/options.
// If logs show zero invocations for 7 days — delete.
async function getCategoryOptionsSchemaLegacy(
  categoryPagetitle: string,
  apiToken: string
): Promise<CategorySchemaResult> {
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
      let res: Response;
      try {
        res = await fetch(`${VOLT220_API_URL}?${params}`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        markIfCatalogError('CategoryOptionsSchemaLegacy', fetchErr);
        throw fetchErr;
      }

      if (!res.ok) {
        console.log(`[CategoryOptionsSchemaLegacy] HTTP ${res.status} on page ${page} for "${categoryPagetitle}", aborting`);
        markIfCatalogHttpError('CategoryOptionsSchemaLegacy', res.status);
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
            schema.set(opt.key, {
              caption: cleanOptionCaption(opt.caption_ru ?? opt.caption ?? opt.key) || opt.key,
              values: new Set(),
            });
          }
          const normalizedValue = cleanOptionValue(opt.value_ru ?? opt.value);
          if (normalizedValue) {
            schema.get(opt.key)!.values.add(normalizedValue);
          }
        }
      }

      totalPages = Math.max(1, Number(data.pagination?.pages) || 1);
      if (results.length < PER_PAGE) break;
      page++;
    } while (page <= totalPages && page <= MAX_PAGES);

    const totalValues = Array.from(schema.values()).reduce((s, v) => s + v.values.size, 0);
    // Don't cache obviously broken results — let next call retry the API.
    if (schema.size === 0 || totalValues === 0) {
      console.log(`[CategoryOptionsSchemaLegacy] "${categoryPagetitle}": ${schema.size} keys, ${totalValues} values — NOT caching (confidence=empty)`);
      return { schema, productCount: totalProducts, cacheHit: false, confidence: 'empty', source: 'legacy-sampling' };
    }
    dedupeSchemaInPlace(schema, `legacy:${categoryPagetitle}`);
    // CONFIDENCE=PARTIAL — legacy sampling sees ≤1000 products. For categories with
    // 2000+ items (Розетки = 2078) values are guaranteed to be a subset of reality.
    // Resolver layer must NOT trust this for value validation.
    categoryOptionsCache.set(cacheKey(categoryPagetitle), { schema, ts: Date.now(), productCount: totalProducts, confidence: 'partial', source: 'legacy-sampling' });
    const keysWithZero = Array.from(schema.values()).filter(i => i.values.size === 0).length;
    const totalValuesPostDedupe = Array.from(schema.values()).reduce((s, i) => s + i.values.size, 0);
    console.log(`[FacetsHealth] cat="${categoryPagetitle}" source=legacy-sampling confidence=partial keys=${schema.size} keys_with_zero_values=${keysWithZero} total_values=${totalValuesPostDedupe} products=${totalProducts}`);
    console.log(`[CategoryOptionsSchemaLegacy] "${categoryPagetitle}": ${schema.size} keys, ${totalValues} values (from ${totalProducts} products, ${Date.now() - t0}ms, cached 30m, post-dedupe, confidence=partial)`);
    return { schema, productCount: totalProducts, cacheHit: false, confidence: 'partial', source: 'legacy-sampling' };
  } catch (e) {
    console.log(`[CategoryOptionsSchemaLegacy] error for "${categoryPagetitle}": ${(e as Error).message} — returning empty schema (confidence=empty)`);
    return { schema: new Map(), productCount: 0, cacheHit: false, confidence: 'empty', source: 'legacy-sampling' };
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
      for (const v of info.values) if (v) target.values.add(v);
    }
  }
  // Union may surface NEW duplicates that didn't exist within a single category
  // (e.g. cvet__tүs from "Розетки" + cvet__tүsі from "Розетки силовые"). Re-dedupe.
  dedupeSchemaInPlace(union, `union:[${pagetitles.join('|')}]`);
  const totalValues = Array.from(union.values()).reduce((s, v) => s + v.values.size, 0);
  console.log(`[CategoryOptionsSchema] union ${pagetitles.length} categories → ${union.size} keys, ${totalValues} values (from ${totalProducts} products, post-dedupe)`);
  return union;
}



interface PriceIntentResult {
  action: 'answer' | 'not_found';
  products?: Product[];
  total?: number;
  category?: string;
}

// Removed: generatePriceSynonyms / generateCategorySynonyms (static synonym dictionaries).
// Reason: violated "Systemic, scalable solutions only" core rule — hardcoded list of 14 categories.
// Price branch now uses single-query + min_price=1 server sort (see Core memory 2026-05-02).
// generateCategorySynonyms was dead code (never called).

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
  intent: 'price_extreme' | 'product_search' | 'category_disambiguation' | 'price_facet_clarify' | 'pending_offer' | 'cross_sell_offer' | 'remaining_offer';
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
  // price_facet_clarify state (V1 bootstrap-facets clarify)
  // JSON: {"query":"розетка","facet":{"key":"tip","caption_ru":"Тип","values":[{"value_ru":"Бытовая","count":5},...]},"min_price":null,"max_price":null}
  price_facet_state?: string;
  // pending_offer state (cross-sell follow-up): bot proposed something at end of previous turn
  // offer_text  — фраза, которую сказал бот (для контекста LLM-резолвера)
  // offer_query — короткий поисковый запрос, который применяем при «давай/да/ок»
  offer_text?: string;
  offer_query?: string;
  // cross_sell_offer state (V1 Step 3): бот показал нативную фразу про сопутствующие
  // и сохранил anchor_ids чтобы по «да/покажи» отдать реальные /related товары
  // БЕЗ нового catalog-search.
  // anchor_ids — JSON массив id (например "[12345,67890]")
  // related_categories — JSON массив строк-категорий, которые упомянуты в фразе (для post-filter)
  anchor_ids?: string;
  related_categories?: string;
  // anchors — JSON snapshot RelatedAnchor[] (id+price+options+category) для acceptRelatedOffer
  // позволяет fetchWithRelaxation строить фильтры без повторного fetch'а каталога.
  anchors?: string;
  // remaining_offer state (V1, 2026-05-15): после показа «Подобрано ещё N — показать остальные?»
  // храним остальные товары + анкоры для cross-sell, чтобы на 2-м сообщении выдать без поиска.
  // remaining_products — JSON массив ProductLite (id,pagetitle,url,price,vendor,warehouses[≤3],brand)
  remaining_products?: string;
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
    if (s.intent !== 'price_extreme' && s.intent !== 'product_search' && s.intent !== 'category_disambiguation' && s.intent !== 'price_facet_clarify' && s.intent !== 'pending_offer' && s.intent !== 'cross_sell_offer' && s.intent !== 'remaining_offer') continue;
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
      intent: s.intent as DialogSlot['intent'],
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
      price_facet_state: typeof s.price_facet_state === 'string' ? s.price_facet_state.substring(0, 4000) : undefined,
      offer_text: typeof s.offer_text === 'string' ? sanitize(s.offer_text) : undefined,
      offer_query: typeof s.offer_query === 'string' ? sanitize(s.offer_query) : undefined,
      anchor_ids: typeof s.anchor_ids === 'string' ? s.anchor_ids.substring(0, 500) : undefined,
      related_categories: typeof s.related_categories === 'string' ? s.related_categories.substring(0, 1000) : undefined,
      anchors: typeof s.anchors === 'string' ? s.anchors.substring(0, 4000) : undefined,
      remaining_products: typeof s.remaining_products === 'string' ? s.remaining_products.substring(0, 12000) : undefined,
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
    let matchType: 'value' | 'label' | 'pagetitle' | 'fuzzy_label' | 'fuzzy_value' | null = null;
    let chosen = options.find(o => normCmp(o.value) === userNorm);
    if (chosen) matchType = 'value';
    if (!chosen) {
      chosen = options.find(o => normCmp(o.label) === userNorm);
      if (chosen) matchType = 'label';
    }
    if (!chosen) {
      chosen = options.find(o => o.pagetitle && normCmp(o.pagetitle) === userNorm);
      if (chosen) matchType = 'pagetitle';
    }
    if (!chosen && userMessage.length < 60) {
      // Short free-text reply — match by inclusion (e.g. user typed "бытовые" while option is "Бытовые розетки")
      chosen = options.find(o => normCmp(o.label).includes(userNorm) && userNorm.length >= 4);
      if (chosen) matchType = 'fuzzy_label';
      if (!chosen) {
        chosen = options.find(o => normCmp(o.value).includes(userNorm) && userNorm.length >= 4);
        if (chosen) matchType = 'fuzzy_value';
      }
    }
    if (!chosen) {
      console.log(`[Slots] category_disambiguation "${key}": user reply "${userMessage.slice(0, 50)}" doesn't match options=${JSON.stringify(options.map(o => o.label))}, falling through`);
      console.log(`[QR] NO_MATCH slot="${key}" user_input="${userMessage.slice(0, 100)}" user_norm="${userNorm}" options=${JSON.stringify(options.map(o => ({ label: o.label, value: o.value })))} pending_modifiers="${slot.pending_modifiers || ''}" pending_filters=${JSON.stringify(slot.pending_filters || null)}`);
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
    console.log(`[QR] MATCH slot="${key}" match_type="${matchType}" user_input="${userMessage.slice(0, 100)}" chosen_label="${chosen.label}" chosen_value="${chosen.value}" chosen_pagetitle="${chosen.pagetitle || chosen.value}" base_category="${slot.base_category}" original_query="${slot.original_query || ''}" pending_modifiers=${JSON.stringify(pendingModifiers)} pending_filters=${JSON.stringify(pendingFilters)} all_options=${JSON.stringify(options.map(o => ({ label: o.label, value: o.value })))}`);

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
  
  // Check if user message is a refinement (short reply continuing the pending slot)
  const isShort = userMessage.length < 80;
  const hasNewPriceIntent = classificationResult?.price_intent != null 
    && (classificationResult.price_intent as string) !== 'none';
  const classifiedCategory = (classificationResult?.product_category || '').trim().toLowerCase();
  const baseCategoryLower = pendingSlot.base_category.trim().toLowerCase();
  
  // If classifier found a new price_intent with a DIFFERENT category, it's a new request → drop slot path
  if (hasNewPriceIntent && classifiedCategory && classifiedCategory !== baseCategoryLower) {
    return null;
  }
  
  // Treat as refinement if:
  //   (a) short message AND no new price intent (e.g. "встраиваемая"), OR
  //   (b) short message AND classifier echoed the SAME base category (LLM lost the modifier
  //       and just repeated "розетка" — but the user's raw word IS the refinement).
  const sameCategoryEcho = hasNewPriceIntent && classifiedCategory === baseCategoryLower;
  if (isShort && (!hasNewPriceIntent || sameCategoryEcho)) {
    // When classifier echoed the base, prefer the raw user message — it carries the refinement.
    // Otherwise prefer LLM-cleaned category/product_name (strips filler like "давай", "ладно").
    const refinement = sameCategoryEcho
      ? userMessage.trim()
      : (classificationResult?.product_category 
        || classificationResult?.product_name 
        || userMessage.trim());
    const combinedQuery = `${refinement} ${pendingSlot.base_category}`.trim();
    
    const updatedSlots = { ...slots };
    updatedSlots[pendingKey] = {
      ...pendingSlot,
      refinement,
      turns_since_touched: 0,
    };
    
    console.log(`[Slots] Resolved refinement: "${refinement}" + base "${pendingSlot.base_category}" → "${combinedQuery}", dir=${pendingSlot.price_dir} (sameCategoryEcho=${sameCategoryEcho})`);
    
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

/**
 * SERVER-SIDE PRICE SORTING via 220volt API quirk:
 * Передача `min_price=1` (любое число > 0) автоматически:
 *   1. Исключает товары с price=0 (наш HARD BAN — больше не нужен Composer pre-render)
 *   2. ВКЛЮЧАЕТ серверную сортировку по цене ASC (verified empirically 2026-05-02)
 * Параметр `?sort=` API игнорирует, но min_price даёт нам нужный sort бесплатно.
 *
 * cheapest:        page=1                           → results[0..N] = самые дешёвые
 * most_expensive:  page=ceil(total/perPage)         → последняя страница = самые дорогие
 *
 * Это убирает многократный fetch + клиентскую сортировку и снимает CLARIFY-мурыжку
 * на запросах вида «самая дешёвая розетка» (2712 товаров → ответ за 1 запрос).
 */
async function handlePriceIntent(
  queries: string[],
  priceIntent: 'most_expensive' | 'cheapest',
  apiToken: string,
  extraParams: Array<[string, string]> = [],
  category?: string,
): Promise<PriceIntentResult> {
  const overallStart = Date.now();
  const PER_PAGE = 10;

  const buildParams = (q: string, page: number): URLSearchParams => {
    const p = new URLSearchParams();
    // Если есть подтверждённая категория каталога — используем ?category=<pagetitle>
    // (строгий фильтр по категории), а не ?query=<noun> (full-text по описанию,
    // который втягивает коробки/рамки/крышки из других категорий по совпадению слов).
    if (category && category.trim().length > 0) {
      p.append('category', category);
    } else {
      p.append('query', q);
    }
    p.append('min_price', '1');
    p.append('per_page', String(PER_PAGE));
    p.append('page', String(page));
    for (const [k, v] of extraParams) p.append(k, v);
    return p;
  };

  const fetchPage = async (params: URLSearchParams, timeoutMs: number): Promise<{ results: Product[]; total: number } | null> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(`${VOLT220_API_URL}?${params}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!resp.ok) {
        markIfCatalogHttpError('PriceIntent.fetch', resp.status);
        return null;
      }
      const raw = await resp.json();
      const data = raw.data || raw;
      return {
        results: (data.results || []) as Product[],
        total: data.pagination?.total || 0,
      };
    } catch (err) {
      clearTimeout(timeoutId);
      markIfCatalogError('PriceIntent.fetch', err);
      return null;
    }
  };

  let activeQuery = queries[0];
  let probe = await fetchPage(buildParams(activeQuery, 1), 15000);

  if (!probe || probe.total === 0) {
    for (const altQuery of queries.slice(1, 4)) {
      const altResult = await fetchPage(buildParams(altQuery, 1), 8000);
      if (altResult && altResult.total > 0) {
        activeQuery = altQuery;
        probe = altResult;
        break;
      }
    }
  }

  if (!probe || probe.total === 0) return { action: 'not_found' };

  let products = probe.results.filter(p => p.price > 0);

  // most_expensive: jump to last page (server sort ASC via min_price=1, then reverse)
  if (priceIntent === 'most_expensive' && probe.total > PER_PAGE) {
    const lastPage = Math.ceil(probe.total / PER_PAGE);
    const lastResult = await fetchPage(buildParams(activeQuery, lastPage), 15000);
    if (lastResult) {
      products = lastResult.results.filter(p => p.price > 0).reverse();
    } else {
      products = products.reverse();
    }
  }

  console.log(`[PriceIntent] simplified: ${category ? `category="${category}"` : `query="${activeQuery}"`} extra=${JSON.stringify(extraParams)} intent=${priceIntent} total=${probe.total} returned=${products.length} ${Date.now() - overallStart}ms`);
  return { action: 'answer', products: products.slice(0, PER_PAGE), total: probe.total };
}

// ============================================================
// PRICE-FACET CLARIFY — bootstrap facets from /products + slot-based clarify
// ============================================================
// Flow:
//   1) User asks «самая дешёвая розетка» (no characteristics).
//   2) Probe `/products?query=розетка&per_page=100` (single hop, no Resolver).
//   3) Aggregate Product.options[] → facets list (key + caption_ru + values+counts).
//   4) Pick BEST facet (≥2 distinct values, max diversity). Show top-3 cheapest + ask.
//   5) Save slot `price_facet_clarify` with full facet snapshot.
//   6) Next turn: strict-match user reply against snapshot.values → re-call handlePriceIntent
//      with `options[<key>][]=<value_ru>` and same min_price=1.
// NO LLM picks facets/values — bootstrap is the source of truth.

export interface BootstrapFacet {
  key: string;
  caption_ru: string;
  values: Array<{ value_ru: string; count: number }>;
}

export function extractFacetsFromProducts(products: Product[]): BootstrapFacet[] {
  const map = new Map<string, { caption_ru: string; values: Map<string, number> }>();
  for (const p of products) {
    const opts = Array.isArray((p as any)?.options) ? (p as any).options : [];
    for (const o of opts) {
      const key = typeof o?.key === 'string' ? o.key.trim() : '';
      const caption = typeof o?.caption_ru === 'string' ? o.caption_ru.trim() : '';
      const value = typeof o?.value_ru === 'string' ? o.value_ru.trim() : '';
      if (!key || !caption || !value) continue;
      let entry = map.get(key);
      if (!entry) {
        entry = { caption_ru: caption, values: new Map() };
        map.set(key, entry);
      }
      entry.values.set(value, (entry.values.get(value) || 0) + 1);
    }
  }
  const facets: BootstrapFacet[] = [];
  for (const [key, entry] of map.entries()) {
    const values = Array.from(entry.values.entries())
      .map(([value_ru, count]) => ({ value_ru, count }))
      .sort((a, b) => b.count - a.count);
    facets.push({ key, caption_ru: entry.caption_ru, values });
  }
  return facets;
}

/** Pick facet most useful for clarification: ≥2 distinct values, prefer max diversity then total coverage. */
export function pickClarifyFacet(facets: BootstrapFacet[]): BootstrapFacet | null {
  const candidates = facets.filter(f => f.values.length >= 2);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const diversityDiff = b.values.length - a.values.length;
    if (diversityDiff !== 0) return diversityDiff;
    const coverageA = a.values.reduce((s, v) => s + v.count, 0);
    const coverageB = b.values.reduce((s, v) => s + v.count, 0);
    return coverageB - coverageA;
  });
  const chosen = candidates[0];
  return { ...chosen, values: chosen.values.slice(0, 5) };
}

function extractSchemaFromProducts(products: Product[]): Map<string, { caption: string; values: Set<string> }> {
  const schema = new Map<string, { caption: string; values: Set<string> }>();
  for (const p of products) {
    const opts = (p as any).options;
    if (!Array.isArray(opts)) continue;
    for (const opt of opts) {
      if (!opt || typeof opt !== 'object') continue;
      const key = typeof opt.key === 'string' ? opt.key.trim() : '';
      if (!key || isExcludedOption(key)) continue;
      const caption = cleanOptionCaption(opt.caption_ru ?? opt.caption ?? opt.caption_kz ?? key) || key;
      const value = cleanOptionValue(opt.value_ru ?? opt.value ?? opt.value_kz);
      let bucket = schema.get(key);
      if (!bucket) {
        bucket = { caption, values: new Set<string>() };
        schema.set(key, bucket);
      }
      if (value) bucket.values.add(value);
    }
  }
  dedupeSchemaInPlace(schema, 'products-sample');
  return schema;
}

/** Bootstrap-facets probe: /products?query=<>&per_page=100 (single hop). */
async function probeFacetsForPriceQuery(query: string, apiToken: string): Promise<{ products: Product[]; facets: BootstrapFacet[]; total: number } | null> {
  const params = new URLSearchParams();
  params.append('query', query);
  params.append('min_price', '1');
  params.append('per_page', '100');
  params.append('page', '1');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(`${VOLT220_API_URL}?${params}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) {
      markIfCatalogHttpError('PriceFacetProbe', resp.status);
      return null;
    }
    const raw = await resp.json();
    const data = raw.data || raw;
    const products = (data.results || []).filter((p: Product) => p.price > 0);
    const facets = extractFacetsFromProducts(products);
    return { products, facets, total: data.pagination?.total || products.length };
  } catch (err) {
    clearTimeout(timeoutId);
    markIfCatalogError('PriceFacetProbe', err);
    return null;
  }
}

/** Build clarify message: top-3 cheapest cards + ONE question with real facet values. */
export function buildPriceFacetClarifyContent(params: {
  products: Product[];
  priceIntent: 'most_expensive' | 'cheapest';
  facet: BootstrapFacet;
}): string {
  const { products, priceIntent, facet } = params;
  const intro = priceIntent === 'most_expensive'
    ? 'Вот самые дорогие варианты из подборки:'
    : 'Вот самые доступные варианты из подборки:';
  const cards = products.slice(0, 3).map(p => formatProductCardDeterministic(p)).join('\n');
  const valueList = facet.values
    .map(v => `*${v.value_ru}* (${v.count})`)
    .join(', ');
  const tail = `\n\nЧтобы сузить выдачу, уточните **${facet.caption_ru}**: ${valueList}.`;
  return `${intro}\n\n${cards}${tail}`;
}

/** Strict match user reply against snapshot facet values (normalized, word-boundary). */
export function matchFacetValueFromReply(reply: string, facet: BootstrapFacet): { value_ru: string } | null {
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
  const replyNorm = ` ${norm(reply)} `;
  const sorted = [...facet.values].sort((a, b) => b.value_ru.length - a.value_ru.length);
  for (const v of sorted) {
    const valNorm = norm(v.value_ru);
    if (!valNorm) continue;
    if (replyNorm.includes(` ${valNorm} `)) return { value_ru: v.value_ru };
  }
  return null;
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
  // Null-safe: any product field can be undefined/null in payload from 220volt API.
  const safeTitle = product?.pagetitle ?? '';
  const titleTokens = extractTokens(safeTitle);
  const titleText = safeTitle.toLowerCase();
  
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
  const titleSpecs = extractSpecs(safeTitle);
  // Null-safe: option.value can be missing — coerce to '' before toLowerCase().
  // This was the source of [Chat] Error: TypeError ... reading 'toLowerCase'.
  const optionValues = (product?.options || [])
    .map(o => (o?.value ?? '').toLowerCase())
    .join(' ');
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
    const productBrand = (product?.vendor ?? '').toLowerCase();
    const brandOption = product?.options?.find(o => o?.key === 'brend__brend');
    const brandRaw = brandOption?.value ?? '';
    const optBrand = brandRaw.split('//')[0].trim().toLowerCase();
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
 *
 * RESILIENCE: wrapped in try/catch — if scoring blows up on a malformed product
 * (e.g. missing options/value), we log [RankerCrash] with stack and return the
 * input pool as-is rather than failing the whole chat response. NO silent
 * fallback — error is always surfaced via console.error.
 */
function rerankProducts(
  products: Product[],
  userQuery: string,
  allowedPagetitles?: Set<string>,
  reqId: string = '?'
): Product[] {
  try {
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
        const cat = (p as any)?.category?.pagetitle || (p as any)?.parent_name || '';
        if (allowedPagetitles.has(cat)) return true;
        if (dropped.length < 5) dropped.push(`"${(p?.pagetitle ?? '').substring(0, 40)}" [${cat}]`);
        return false;
      });
      if (before !== pool.length) {
        console.log(`[DomainGuard req=${reqId}] dropped ${before - pool.length}/${before} items from non-allowed categories. Sample: ${dropped.join(' | ')}`);
      }
    }

    const scored = pool.map(p => ({
      product: p,
      score: scoreProductMatch(p, queryTokens, querySpecs, undefined, userQuery),
    }));

    scored.sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      console.log(`[Rerank req=${reqId}] Top scores: ${scored.slice(0, 5).map(s => `${s.score}:"${(s.product?.pagetitle ?? '').substring(0, 40)}"`).join(', ')}`);
    }

    return scored.map(s => s.product);
  } catch (e) {
    const err = e as Error;
    console.error(`[RankerCrash req=${reqId}]`, JSON.stringify({
      error: err?.message ?? String(e),
      stack: (err?.stack ?? '').split('\n').slice(0, 5).join(' | '),
      product_count: products?.length ?? 0,
      query: (userQuery ?? '').substring(0, 80),
    }));
    return products || [];
  }
}


function hasGoodMatch(products: Product[], userQuery: string, threshold: number = 35, reqId: string = '?'): boolean {
  try {
    const queryTokens = extractTokens(userQuery);
    const querySpecs = extractSpecs(userQuery);
    
    for (const p of products) {
      const score = scoreProductMatch(p, queryTokens, querySpecs);
      if (score >= threshold) {
        console.log(`[TitleScore req=${reqId}] Good match (${score}≥${threshold}): "${(p?.pagetitle ?? '').substring(0, 60)}"`);
        return true;
      }
    }
    return false;
  } catch (e) {
    const err = e as Error;
    console.error(`[RankerCrash req=${reqId}] hasGoodMatch failed:`, JSON.stringify({
      error: err?.message ?? String(e),
      stack: (err?.stack ?? '').split('\n').slice(0, 3).join(' | '),
    }));
    return false;
  }
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

ПОДСЧЁТ / ХАРАКТЕРИСТИКА (compute):
Это НАДСТРОЙКА к любому intent — основной intent (catalog/brands/info) и кандидаты не меняются. Заполняй compute, когда пользователь спрашивает о КОНКРЕТНОЙ характеристике товара или просит её посчитать (умножить на количество). Примеры: «сколько весит», «какой вес у 5 штук», «какая мощность», «какой IP», «какие габариты», «сколько ламп», «гарантия», «диаметр», «длина кабеля», «какой объём 100 розеток», «сколько места займут 50 кабелей», «влезет ли в Газель 200 ламп».
- compute.attribute — короткое русское название характеристики, как её обычно называет пользователь («вес», «мощность», «IP», «габариты», «гарантия», «длина», «количество ламп», «материал», «объём»). Для вопросов о транспортировке, перевозке, «сколько места», «влезет ли в машину/Газель/кузов» — ставь attribute="объём". НЕ перечисляй несколько — выбери главную.
- compute.multiplier — целое число, если пользователь явно указал количество («5 штук», «×3», «для 10 светильников»). Если количество не названо — null.
- Если пользователь просто ищет товар без вопроса о характеристике — compute=null. Не выдумывай.
- Если пользователь спрашивает про характеристику без привязки к товару, но в контексте уже обсуждавшегося товара (followup: «а сколько он весит?») — всё равно заполни compute, кандидаты могут быть пустыми/общими, дальше система возьмёт товар из контекста.

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
      ...samplingFor(aiModel),
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
                },
                compute: {
                  type: 'object',
                  nullable: true,
                  description: 'Надстройка: пользователь спрашивает о характеристике товара (опционально ×N штук). null если вопроса о характеристике нет.',
                  properties: {
                    attribute: {
                      type: 'string',
                      description: 'Короткое русское название характеристики, как её называет пользователь: «вес», «мощность», «IP», «габариты», «гарантия», «длина», «количество ламп», «материал» и т.п.'
                    },
                    multiplier: {
                      type: 'number',
                      nullable: true,
                      description: 'Множитель ×N штук, если пользователь указал количество («5 штук», «×3»). null если количество не названо.'
                    }
                  },
                  required: ['attribute'],
                  additionalProperties: false
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
      
      // Compute надстройка — пользователь спрашивает о характеристике (опц. ×N).
      let compute: ComputeRequest | undefined;
      if (parsed.compute && typeof parsed.compute === 'object' && typeof parsed.compute.attribute === 'string') {
        const attribute = parsed.compute.attribute.trim();
        if (attribute.length > 0) {
          const rawMul = parsed.compute.multiplier;
          const multiplier = (typeof rawMul === 'number' && Number.isFinite(rawMul) && rawMul > 0)
            ? Math.floor(rawMul)
            : null;
          compute = { attribute, multiplier };
          console.log(`[AI Candidates] Compute request: attribute="${attribute}", multiplier=${multiplier}`);
        }
      }

      return {
        intent: finalIntent,
        candidates: broadened,
        originalQuery: message,
        usage_context: usageContext,
        english_queries: englishQueries.length > 0 ? englishQueries : undefined,
        compute,
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
        optionIndex.set(opt.key, { key: opt.key, caption: opt.caption ?? '', values: new Set() });
      }
      optionIndex.get(opt.key)!.values.add(opt.value ?? '');
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
  prebuiltSchema?: Map<string, { caption: string; values: Set<string> }>,
  schemaConfidence: SchemaConfidence = 'full',
  productNoun?: string
): Promise<{
  resolved: Record<string, ResolvedFilter>;
  unresolved: string[];
  /**
   * Schema-known but value-unresolved modifiers.
   * LLM matched the modifier to a real facet key (e.g. "мощность 7Вт" → key "moschnost"),
   * but the requested value (7) was NOT in the live catalog values for that key.
   * Used by QFv2 to trigger honest-empty even when other filters yielded results.
   */
  unresolvedDetails?: Array<{
    modifier: string;
    key: string;
    caption: string;
    requestedValue: string;
    availableValues: string[];
  }>;
}> {
  if (!modifiers || modifiers.length === 0) return { resolved: {}, unresolved: [], unresolvedDetails: [] };

  // CONFIDENCE GATE — Layer 1 P0: never resolve filters against degraded schema.
  //   'empty'   → no usable schema at all. Skip LLM entirely (saves tokens, prevents
  //              false negatives like {"cvet__tүs":"Черный"} → rejected because
  //              schema values are []). Caller falls through to category+query path.
  //   'partial' → schema keys are real but values are a SUBSET of reality (legacy
  //              sampling saw ≤1000/2000 products). We let LLM run but switch to
  //              KEY-ONLY mode below: validator accepts any value the LLM proposes
  //              for a known key, value is taken verbatim from user query (acts as
  //              a free-text filter on a real attribute, not a guess from a stub list).
  //   'full'    → trust schema completely (legacy strict path).
  if (schemaConfidence === 'empty') {
    console.log(`[FilterLLM] CONFIDENCE GATE: schema confidence=empty for ${modifiers.length} modifier(s) — skipping LLM (caller will degrade to category+query)`);
    return { resolved: {}, unresolved: [...modifiers] };
  }
  const keyOnlyMode = schemaConfidence === 'partial';

  // FilterLLM bulkhead: ANY error inside (schema build, LLM call, validation, dedupe lookups)
  // must NOT propagate up — caller's pipeline keeps running with empty resolved set.
  // Logged as [FilterLLMCrash] for visibility.
  try {
  // Default critical = all modifiers (safe behavior)
  const criticalSet = new Set<string>((criticalModifiers && criticalModifiers.length > 0 ? criticalModifiers : modifiers).map(m => m.toLowerCase().trim()));
  const isCritical = (mod: string) => criticalSet.has(mod.toLowerCase().trim());

  // Build option schema. Prefer prebuilt full-category schema when provided
  // (covers all products in category, not just a 30-item sample).
  let optionIndex: Map<string, { caption: string; values: Set<string> }>;
  if (prebuiltSchema && prebuiltSchema.size > 0) {
    optionIndex = prebuiltSchema;
    console.log(`[FilterLLM] Using prebuilt category schema (${optionIndex.size} keys, confidence=${schemaConfidence}${keyOnlyMode ? ', mode=key-only' : ''})`);
  } else {
    optionIndex = new Map();
    for (const product of products) {
      if (!product.options) continue;
        for (const opt of product.options) {
        if (isExcludedOption(opt.key)) continue;
        if (!optionIndex.has(opt.key)) {
            optionIndex.set(opt.key, { caption: cleanOptionCaption(opt.caption_ru ?? opt.caption) || opt.key, values: new Set() });
        }
          const normalizedValue = cleanOptionValue(opt.value_ru ?? opt.value);
          if (normalizedValue) optionIndex.get(opt.key)!.values.add(normalizedValue);
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
    const caption = (info?.caption ?? '').split('//')[0].trim();
    const allVals = [...(info?.values ?? [])].filter(Boolean).map(v => (v ?? '').split('//')[0].trim());
    const vals = allVals.join(', ');
    schemaLines.push(`KEY="${apiKey}" | ${caption} | values: ${vals}`);
    schemaDebug.push(`  ${apiKey} (${caption}): ${allVals.slice(0, 5).join(', ')}${allVals.length > 5 ? ` ... +${allVals.length - 5}` : ''}`);
  }
  const schemaText = schemaLines.join('\n');
  console.log(`[FilterLLM] Schema (${optionIndex.size} keys):\n${schemaDebug.join('\n')}`);

  const nounLine = (productNoun && productNoun.trim().length > 0)
    ? `ТИП ТОВАРА (что ищет пользователь): "${productNoun.trim()}"\n`
    : '';

  const systemPrompt = `Ты — резолвер фильтров каталога электротоваров. Твоя задача: для каждого модификатора пользователя найти ОДИН правильный (key, value) из схемы — или честно отказаться, если уверенного матча нет.

ВХОДНЫЕ ДАННЫЕ
${nounLine}СХЕМА ХАРАКТЕРИСТИК КАТЕГОРИИ (источник истины — только она):
${schemaText}

МОДИФИКАТОРЫ ПОЛЬЗОВАТЕЛЯ:
${JSON.stringify(modifiers)}

ПРИНЦИП РАБОТЫ
Не сопоставляй слова со словами. Сопоставляй СМЫСЛ модификатора со СМЫСЛОМ характеристики ИМЕННО для того типа товара, который ищет пользователь. Один и тот же модификатор у разных товаров относится к разным физическим свойствам: «места» у розетки — это куда втыкают вилку (разъёмы/гнёзда), а у монтажной рамки — это посадочные места под механизмы (посты); «конфорки» у плиты — это варочные зоны, а не модули; «полюса» у автомата — это коммутируемые фазы, а не количество модулей. Твоя работа — соединить смысл модификатора со смыслом характеристики ЧЕРЕЗ контекст типа товара, опираясь на здравый смысл, а не на совпадение строк.

ОБЯЗАТЕЛЬНЫЙ АЛГОРИТМ ИЗ ТРЁХ ШАГОВ
Выполни шаги последовательно для всех модификаторов и заполни все три секции ответа.

ШАГ 1 — DECOMPOSE (через тип товара, без схемы).
Для каждого модификатора, НЕ ГЛЯДЯ в схему, опиши его смысл одной фразой по шаблону:
  — что за свойство ИМЕННО У ЭТОГО ТИПА ТОВАРА (если тип товара указан выше — обязательно интерпретируй модификатор в его контексте: «на 2 места» у розетки = два разъёма для вилок; «на 2 места» у рамки = два посадочных места под механизмы; «двухконфорочная» у плиты = две варочные зоны);
  — какова единица измерения или область значений (целое число «штук чего-то конкретного для этого товара», физическая величина с единицей, слово из перечисления, имя бренда);
  — какое конкретное значение задаёт пользователь.
Если модификатор содержит числительное-прилагательное (одинарный/двойной/трёхполюсный/четырёхместный/двухгнёздный/двухконфорочный и т.п.) — извлеки число и определи, ЕДИНИЦАМИ ЧЕГО оно является ДЛЯ УКАЗАННОГО ТИПА ТОВАРА (а не абстрактно).

ШАГ 2 — MATCH (со схемой).
Для каждого извлечённого смысла пройди по схеме и выбери ОДИН ключ, у которого:
  (а) caption описывает то же физическое свойство данного типа товара (та же единица измерения / та же область значений);
  (б) формат values совместим с типом значения из шага 1 (целые числа — со счётным фасетом, цвет-слово — с цветовым фасетом, и т.д.).
Если в схеме есть несколько похожих фасетов (например, два «цветовых»: цвет корпуса и цветовая температура; или несколько «количественных»: число постов, число модулей, число полюсов, число разъёмов) — выбирай тот, который физически относится к УКАЗАННОМУ ТИПУ ТОВАРА. Например, если тип товара = розетка и пользователь говорит «на N мест» — это про разъёмы (куда втыкают вилку), а НЕ про посты (которые относятся к рамкам/накладкам, а не к самой розетке). Если тип товара не указан или неоднозначен — выбирай ключ, который встречается у большинства товаров в выдаче (доминирующий сегмент).
После выбора ключа возьми из его values то значение, которое в точности соответствует значению из шага 1. Берёшь строку буква-в-букву, как в схеме.


ШАГ 3 — VERIFY (самопроверка).
Для каждой пары (key, value), которую ты собираешься вернуть, мысленно ответь на вопрос: «Если я возьму произвольный товар, у которого характеристика key равна value — будет ли он удовлетворять модификатору пользователя?»
  — если ответ уверенное «да» — оставляешь матч;
  — если «не уверен», «частично», «возможно» или «нет» — УДАЛЯЕШЬ матч и помещаешь модификатор в unresolved. Лучше пропустить модификатор, чем сматчить его неправильно: пропущенный модификатор обработается мягким fallback'ом, неправильный матч приведёт к нулевой выдаче.

ЖЁСТКИЕ ЗАПРЕТЫ
— Не подставляй «ближайшее» значение, если точного нет в values (хочет «1 полюс», есть «2, 3, 4» → пропуск, не «2»).
— Не выдумывай ключи, которых нет в схеме.
— Не объединяй два разных модификатора в один ключ.
— Не возвращай один и тот же ключ для двух модификаторов с разным смыслом.
— Не используй для матча совпадение подстрок в caption ключа со словом из модификатора — только смысловое соответствие.

ФОРМАТ ОТВЕТА (строгий JSON, ничего кроме):
{
  "intents": [
    {"modifier": "<исходный модификатор>", "property": "<краткое описание свойства>", "unit": "<единица или область значений>", "value": "<желаемое значение>"}
  ],
  "matches": [
    {"modifier": "<исходный модификатор>", "key": "<KEY из схемы>", "value": "<точное значение из values>", "reason": "<одна фраза: почему этот key и почему это value>"}
  ],
  "verifications": [
    {"modifier": "<исходный модификатор>", "key": "<KEY>", "value": "<value>", "ok": true|false, "note": "<если false — почему отвергли>"}
  ],
  "filters": { "<KEY>": "<value>", ... }
}

В поле "filters" попадают ТОЛЬКО те пары, у которых в "verifications" стоит ok=true. Если ни один модификатор не прошёл verify — верни "filters": {}. Поля intents/matches/verifications обязательны всегда (даже если пустые массивы), они нужны для отладки и не влияют на дальнейшую логику.`;

  // STRICT OpenRouter only — no cascade fallback (deterministic for all users).
  if (!settings.openrouter_api_key) {
    console.log('[FilterLLM] OpenRouter key missing — skipping (deterministic empty)');
    return { resolved: {}, unresolved: [...modifiers] };
  }
  // MODEL UPGRADE (2026-05-01 → 2026-05-02): switched FilterLLM from Gemini to Claude.
  // Reason: Gemini (2.5-flash и 3-flash-preview) галлюцинировал значения, выбирая value
  // которого нет в schema[key].values для конкретной категории (bootstrap агрегирует
  // значения из всего pool, поэтому value валиден глобально, но не для подкатегории).
  // Claude Sonnet 4.5 строже следует структурным ограничениям и проверяет ∈ enum.
  // Эта стадия — единственная, где FilterLLM выбирает key=value из схемы фасетов;
  // остальные стадии (classify, candidates, composer) остаются на Gemini.
  const model = 'anthropic/claude-sonnet-4.5';
  const url = 'https://openrouter.ai/api/v1/chat/completions';
  const apiKeys = [settings.openrouter_api_key];
  console.log(`[FilterLLM] OpenRouter (strict), model=${model} (Claude — strict schema adherence)`);

  const reqBody = {
    model,
    messages: [{ role: 'user', content: systemPrompt }],
    temperature: 0,
    max_tokens: 2000,
    response_format: { type: 'json_object' },
  };
  console.log(`[FilterLLM] Sampling: temperature=0 model=${model}`);

  try {
    console.log(`[FilterLLM] Resolving ${modifiers.length} modifier(s) against ${optionIndex.size} option(s)`);
    const controller = new AbortController();
    // Timeout 25s: Claude Sonnet 4.5 на схеме 100-150 ключей думает 8-15с (vs Gemini 2-3с).
    // Точность критичнее скорости — лучше 12с правильного матчинга, чем 2с галлюцинации.
    const timeout = setTimeout(() => controller.abort(), 25000);

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

    // Strip markdown code fences (Claude often wraps JSON in ```json ... ```)
    const stripFences = (s: string): string => {
      let t = s.trim();
      const fence = t.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```\s*$/);
      if (fence) t = fence[1].trim();
      // Fallback: extract first {...} block if still not pure JSON
      if (!t.startsWith('{')) {
        const m = t.match(/\{[\s\S]*\}/);
        if (m) t = m[0];
      }
      return t;
    };

    let parsed: any;
    try {
      parsed = JSON.parse(stripFences(content));
    } catch (e) {
      console.log(`[FilterLLM] JSON parse failed: ${(e as Error).message}`);
      return { resolved: {}, unresolved: [...modifiers] };
    }
    // [intent-reasoning] surface decompose/match/verify trail to logs (does not affect downstream)
    if (Array.isArray(parsed?.intents)) console.log(`[FilterLLM][intents] ${JSON.stringify(parsed.intents)}`);
    if (Array.isArray(parsed?.matches)) console.log(`[FilterLLM][matches] ${JSON.stringify(parsed.matches)}`);
    if (Array.isArray(parsed?.verifications)) console.log(`[FilterLLM][verify] ${JSON.stringify(parsed.verifications)}`);
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
    // Null-safe: any of (rawKey, value, schema value v) may be undefined/null in degraded payloads.
    const norm = (s: unknown) => (typeof s === 'string' ? s : '').replace(/ё/g, 'е').toLowerCase().trim();

    for (const [rawKey, value] of Object.entries(filters)) {
      if (typeof value !== 'string') continue;
      if (typeof rawKey !== 'string' || !rawKey) continue;
      // Try exact match first, then strip caption suffix like " (Цвет)"
      let resolvedKey = rawKey;
      if (!optionIndex.has(resolvedKey)) {
        const stripped = (resolvedKey ?? '').split(' (')[0].trim();
        if (optionIndex.has(stripped)) {
          resolvedKey = stripped;
        }
      }
      if (optionIndex.has(resolvedKey)) {
        // KEY exists — now validate VALUE against known values in schema
        const knownValues = optionIndex.get(resolvedKey)!.values;
       const matchedValue = [...knownValues].find(v => {
         if (!v) return false; // guard: undefined/null/empty in degraded schemas
         const nv = norm(v);
         const nval = norm(value);
         if (nv === nval) return true;
         // Bilingual values: "накладной//бетіне орнатылған" — match Russian part before "//"
         const ruPart = (nv ?? '').split('//')[0].trim();
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
        } else if (keyOnlyMode) {
          // KEY-ONLY MODE (confidence=partial): schema key is real, but values are a
          // SUBSET of reality (legacy sampling). Trust LLM's value as a free-text
          // filter on a real attribute instead of rejecting. Worst case: API returns
          // 0 for that combo and caller falls through to query-only path.
          // Mark as non-critical so caller can relax it if it produces zero hits.
          let sourceMod: string | undefined;
          for (const mod of modifiers) {
            if (norm(mod) === norm(value) || norm(value).includes(norm(mod)) || norm(mod).includes(norm(value))) {
              sourceMod = mod;
              matchedModifiers.add(mod);
              break;
            }
          }
          validated[resolvedKey] = { value, is_critical: false, source_modifier: sourceMod };
          console.log(`[FilterLLM] Resolved (key-only, partial schema): "${resolvedKey}" = "${value}" [critical=false, src="${sourceMod || 'n/a'}"]`);
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

    // unresolvedDetails: schema-known KEY but value not in schema. Source = parsed.matches
    // entries where value=null AND key resolves to a real optionIndex entry. This lets QFv2
    // honest-empty distinguish "we tried this exact attribute, the value just doesn't exist
    // in catalog" from "we couldn't even map the modifier to anything".
    const unresolvedDetails: Array<{ modifier: string; key: string; caption: string; requestedValue: string; availableValues: string[] }> = [];
    if (Array.isArray(parsed?.matches)) {
      for (const m of parsed.matches) {
        if (!m || typeof m !== 'object') continue;
        if (m.value !== null && m.value !== undefined) continue;
        const rawK = typeof m.key === 'string' ? m.key : '';
        if (!rawK) continue;
        let resolvedK = rawK;
        if (!optionIndex.has(resolvedK)) {
          const stripped = resolvedK.split(' (')[0].trim();
          if (optionIndex.has(stripped)) resolvedK = stripped;
        }
        if (!optionIndex.has(resolvedK)) continue;
        const bucket = optionIndex.get(resolvedK)!;
        const modStr = typeof m.modifier === 'string' ? m.modifier : '';
        // Extract numeric/value token from modifier (e.g. "мощность 7Вт" → "7")
        const numMatch = modStr.match(/[\d.,]+/);
        const requestedValue = numMatch ? numMatch[0].replace(',', '.') : modStr;
        unresolvedDetails.push({
          modifier: modStr,
          key: resolvedK,
          caption: bucket.caption,
          requestedValue,
          availableValues: [...bucket.values].filter(Boolean).slice(0, 12),
        });
      }
    }

    const criticalitySummary = Object.entries(validated).map(([k, v]) => `${k}=${v.value}(${v.is_critical ? 'crit' : 'opt'})`).join(', ');
    const filterSig = await sha256Hex(JSON.stringify(Object.entries(validated).map(([k, v]) => [k, v.value]).sort()));
    console.log(`[FilterLLM] Resolved with criticality: {${criticalitySummary}}, unresolved=[${unresolved.join(', ')}] unresolvedDetails=${JSON.stringify(unresolvedDetails)} | signature=${filterSig}`);
    return { resolved: validated, unresolved, unresolvedDetails };
  } catch (error) {
    console.error(`[FilterLLM] Error:`, error);
    return { resolved: {}, unresolved: [...modifiers] };
  }
  } catch (outerErr) {
    // Bulkhead: outer crash (e.g. undefined.split during schema build, dedup lookup)
    // — don't propagate, fall through with empty resolved set so caller's pipeline survives.
    const err = outerErr as Error;
    console.error(`[FilterLLMCrash]`, JSON.stringify({
      error: err?.message ?? String(outerErr),
      stack: (err?.stack ?? '').split('\n').slice(0, 5).join(' | '),
      modifier_count: modifiers?.length ?? 0,
      modifiers: (modifiers ?? []).slice(0, 5),
    }));
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

export function choosePriceResolve2Category(params: {
  classifierCategory?: string;
  catalog: string[];
  matcherMatches?: string[];
}): string {
  const raw = (params.classifierCategory || '').trim();
  const plural = raw ? toPluralCategory(raw) : '';
  const catalogSet = new Set(params.catalog || []);
  if (raw && catalogSet.has(raw)) return raw;
  if (plural && catalogSet.has(plural)) return plural;
  return (params.matcherMatches || [])[0] || '';
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
    const optNorm = normalize((colorOpt.value ?? '').toString());
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
    if (candidate.query && !isSafeCatalogQueryParam(candidate.query)) {
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
    
    // Apply resolved option filters from pass 2.
    // For each resolved key we expand into ALL its alias keys (see optionAliasesRegistry):
    // duplicate API keys for the same physical property (e.g. cvet__tүs / cvet__tүsі)
    // must all be sent — one alone covers only a fraction of products.
    if (resolvedFilters) {
      for (const [key, value] of Object.entries(resolvedFilters)) {
        const aliasKeys = getAliasKeysFor(key);
        for (const aliasKey of aliasKeys) {
          params.append(`options[${aliasKey}][]`, value);
        }
        if (aliasKeys.length > 1) {
          console.log(`[Search] Filter "${key}=${value}" applied via ${aliasKeys.length} alias keys: [${aliasKeys.join(', ')}]`);
        }
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
      markIfCatalogHttpError('Search', response.status);
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
    markIfCatalogError('Search', error);
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

  // === PASS 2: Apply human-readable option_filters via existing dynamic resolver ===
  // No hardcoded mapping tables: resolve against real product/category options from Pass 1,
  // then replay the same queries with concrete options[<real_key>][]=<value> in API.
  if (hasHumanFilters && productMap.size > 0 && settings) {
    const allProducts = Array.from(productMap.values());
    const humanModifiers = Array.from(new Set(
      Object.entries(humanFilters)
        .map(([k, v]) => {
          const label = cleanOptionCaption(k.replace(/__.*/, '').replace(/_/g, ' '));
          const value = cleanOptionValue(v);
          return `${label || k} ${value}`.trim();
        })
        .filter(Boolean)
    ));

    if (humanModifiers.length > 0) {
      const { resolved: resolvedFromHumanRaw, unresolved: unresolvedHuman } = await resolveFiltersWithLLM(
        allProducts,
        humanModifiers,
        settings,
        humanModifiers,
      );
      const resolvedFromHuman = flattenResolvedFilters(resolvedFromHumanRaw);

      if (Object.keys(resolvedFromHuman).length > 0) {
        console.log(`[Search] Human option_filters resolved: ${JSON.stringify(resolvedFromHuman)}; unresolved=[${unresolvedHuman.join(', ')}]`);
        const pass2Promises = cappedPass1.map(candidate =>
          searchProductsByCandidate(candidate, apiToken, perPage, resolvedFromHuman)
        );
        const pass2Results = await Promise.all(pass2Promises);
        const pass2Map = new Map<number, Product>();
        for (const products of pass2Results) {
          for (const product of products) {
            if (!pass2Map.has(product.id)) {
              pass2Map.set(product.id, product);
            }
          }
        }

        console.log(`[Search] Pass 2 (resolved option_filters): ${pass2Map.size} unique products`);
        // HONEST EMPTY: even when pass2 returns 0, replace productMap with the
        // (empty) filtered set. Otherwise downstream sees stale Pass 1 results
        // and treats them as "matching" the requested filters — which is a lie
        // and triggers garbage deterministic renders.
        productMap.clear();
        for (const [id, product] of pass2Map.entries()) {
          productMap.set(id, product);
        }
        if (pass2Map.size === 0) {
          console.log(`[Search] Pass 2 returned 0 — productMap cleared (honest empty, no Pass 1 fallback)`);
        }
      } else {
        console.log(`[Search] Human option_filters present but could not be resolved against Pass 1 products`);
      }
    }
  }
  
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
            const pv = (opt.value ?? '').toString().toLowerCase().trim();
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
// Hard blacklist для фасетов из /categories/options и Product.options.
// Согласовано вручную с продакт-владельцем (2026-04-30, аудит «Розетки»).
// Эти ключи НЕ попадают ни в Facet Matcher, ни в LLM-промпт, ни в кэш.
// V2-зеркало: supabase/functions/chat-consultant-v2/catalog/facet-filter.ts
const EXCLUDED_OPTION_PREFIXES = [
  // Группа A — техническая метаинформация / служебные ID (5)
  'kodnomenklatury',
  'identifikator_sayta__sayt_identifikatory',
  'soputstvuyuschiytovar',
  'tovar_internet_magazina',
  'poiskovyy_zapros',
  // Группа B — казахские дубли (2)
  'naimenovanie_na_kazahskom_yazyke',
  'opisanie_na_kazahskom_yazyke',
  // Группа C — медиа (1)
  'fayl',
  // Pre-existing legacy V1 exclusions (оставляем — это V1-специфика):
  'kod_tn_ved',
  'ogranichennyy_prosmotr',
  'prodaetsya_to',
];

// Extended fields — included only when user query is relevant
const EXTENDED_OPTION_PREFIXES = [
  'opisaniefayla',     // file descriptions
  'novinka',           // new arrival flag
  'populyarnyy',      // popularity flag
  'garantiynyy',       // warranty
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

function isExcludedOption(key: unknown, includeExtended: boolean = true): boolean {
  if (typeof key !== 'string' || key.length === 0) return true;
  if (EXCLUDED_OPTION_PREFIXES.some(prefix => key.startsWith(prefix))) return true;
  if (!includeExtended && EXTENDED_OPTION_PREFIXES.some(prefix => key.startsWith(prefix))) return true;
  return false;
}

function cleanOptionValue(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  const parts = value.split('//');
  return (parts[0] || '').trim();
}

function cleanOptionCaption(caption: unknown): string {
  if (typeof caption !== 'string' || caption.length === 0) return '';
  const parts = caption.split('//');
  return (parts[0] || '').trim();
}

// Форматирование товаров для AI
function formatProductsForAI(products: Product[], includeExtended: boolean = true): string {
  if (products.length === 0) {
    return 'Товары не найдены в каталоге.';
  }

  const lines: string[] = [];
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    try {
      let brand = '';
      if (Array.isArray(p?.options)) {
        const brandOption = p.options.find((o: any) => o && o.key === 'brend__brend');
        if (brandOption) {
          brand = cleanOptionValue(brandOption.value);
        }
      }
      if (!brand) {
        brand = (typeof p?.vendor === 'string' ? p.vendor : '') || '';
      }

      const safeUrl = typeof p?.url === 'string' ? p.url : '';
      const productUrl = toProductionUrl(safeUrl).replace(/\(/g, '%28').replace(/\)/g, '%29');
      const safeName = (typeof p?.pagetitle === 'string' ? p.pagetitle : 'Товар')
        .replace(/\(/g, '\\(').replace(/\)/g, '\\)');
      const nameWithLink = `[${safeName}](${productUrl})`;

      const priceNum = typeof p?.price === 'number' ? p.price : 0;
      const oldPriceNum = typeof p?.old_price === 'number' ? p.old_price : 0;

      const parts = [
        `${i + 1}. **${nameWithLink}**`,
        `   - Цена: ${priceNum.toLocaleString('ru-KZ')} ₸${oldPriceNum > priceNum ? ` ~~${oldPriceNum.toLocaleString('ru-KZ')} ₸~~` : ''}`,
        brand ? `   - Бренд: ${brand}` : '',
        p?.article ? `   - Артикул: ${p.article}` : '',
        (() => {
          const available = (Array.isArray(p?.warehouses) ? p.warehouses : []).filter((w: any) => w && Number(w.amount) > 0);
          if (available.length > 0) {
            const shown = available.slice(0, 5).map((w: any) => `${w.city}: ${w.amount} шт.`).join(', ');
            const extra = available.length > 5 ? ` и ещё в ${available.length - 5} городах` : '';
            return `   - Остатки по городам: ${shown}${extra}`;
          }
          const amt = Number(p?.amount) || 0;
          return amt > 0 ? `   - В наличии: ${amt} шт.` : `   - Под заказ`;
        })(),
        p?.category?.pagetitle ? `   - Категория: ${p.category.pagetitle}` : '',
      ];

      if (Array.isArray(p?.options) && p.options.length > 0) {
        const specs = p.options
          .filter((o: any) => o && !isExcludedOption(o.key, includeExtended))
          .map((o: any) => `${cleanOptionCaption(o.caption_ru ?? o.caption)}: ${cleanOptionValue(o.value_ru ?? o.value)}`)
          .filter((s: string) => s && !s.startsWith(': '));

        if (specs.length > 0) {
          parts.push(`   - Характеристики: ${specs.join('; ')}`);
        }
      }

      lines.push(parts.filter(Boolean).join('\n'));
    } catch (err) {
      // CRITICAL: never let one bad product crash the whole response (was returning 500 → "Connection Error" in widget)
      console.error(`[FormatCrash] product_index=${i} id=${p?.id ?? 'unknown'} pagetitle="${p?.pagetitle ?? ''}" err=${(err as Error).message}`);
      try {
        // Log a tiny shape diagnostic so we can find the root cause in the upstream API payload
        const optShape = Array.isArray(p?.options)
          ? p.options.slice(0, 3).map((o: any) => ({ key: typeof o?.key, value: typeof o?.value, caption: typeof o?.caption }))
          : 'no_options';
        console.error(`[FormatCrash] options_shape=${JSON.stringify(optShape)}`);
      } catch {}
      const safeName = (typeof p?.pagetitle === 'string' ? p.pagetitle : 'Товар').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
      const safeUrl = typeof p?.url === 'string' ? toProductionUrl(p.url).replace(/\(/g, '%28').replace(/\)/g, '%29') : '#';
      const priceNum = typeof p?.price === 'number' ? p.price : 0;
      lines.push(`${i + 1}. **[${safeName}](${safeUrl})** — ${priceNum.toLocaleString('ru-KZ')} ₸`);
    }
  }
  return lines.join('\n\n');
}

export function formatProductCardDeterministic(product: Product): string {
  const safeName = (typeof product?.pagetitle === 'string' ? product.pagetitle : 'Товар')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
  const rawUrl = typeof product?.url === 'string' ? product.url : '';
  const normalizedUrl = rawUrl
    ? toProductionUrl(rawUrl).replace(/\(/g, '%28').replace(/\)/g, '%29')
    : '';

  let brand = '';
  if (Array.isArray(product?.options)) {
    const brandOption = product.options.find((o: any) => o && o.key === 'brend__brend');
    if (brandOption) brand = cleanOptionValue(brandOption.value);
  }
  if (!brand) brand = (typeof product?.vendor === 'string' ? product.vendor.trim() : '') || '';

  const lines = [
    normalizedUrl ? `- **[${safeName}](${normalizedUrl})**` : `- **${safeName}**`,
    `  - Цена: *${(typeof product?.price === 'number' ? product.price : 0).toLocaleString('ru-KZ')} ₸*`,
    brand ? `  - Бренд: ${brand}` : '',
    (() => {
      const available = (Array.isArray(product?.warehouses) ? product.warehouses : []).filter((w: any) => w && Number(w.amount) > 0);
      if (available.length > 0) {
        const shown = available.slice(0, 3).map((w: any) => `${w.city}: ${w.amount} шт.`).join(', ');
        return `  - Наличие: ${shown}`;
      }
      const amount = Number(product?.amount) || 0;
      return amount > 0 ? `  - Наличие: ${amount} шт.` : '';
    })(),
  ];

  return lines.filter(Boolean).join('\n');
}

/**
 * Единый форматтер intro-фразы по sub_intent + reason.
 * Вынесен из buildDeterministicShortCircuitContent (Шаг 3, 2026-05-07)
 * для переиспользования во всех ветках ответа.
 *
 * Приоритет: sub_intent (availability/price/location/spec) → reason-specific → generic.
 */
export function buildIntroBySubIntent(params: {
  productsCount: number;
  reason: string;
  subIntent?: 'availability' | 'price' | 'location' | 'spec';
  effectivePriceIntent?: 'most_expensive' | 'cheapest';
}): string {
  const { productsCount, reason, subIntent, effectivePriceIntent } = params;
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
  const isOne = productsCount === 1;

  // Под-интент перебивает дефолтные intro для ЛЮБОЙ ветки с реальным товаром
  if (subIntent === 'availability') {
    return isOne
      ? pick([
          'Да, есть на складе — смотрите:',
          'Да, в наличии. Вот он:',
          'Есть, держите:',
        ])
      : pick([
          'Да, есть в наличии — вот варианты:',
          'Есть на складе, смотрите что подходит:',
          'В наличии — выбирайте:',
        ]);
  }
  if (subIntent === 'price') {
    return isOne
      ? pick([
          'Вот актуальная цена:',
          'Смотрите, сколько стоит:',
          'Цена на сегодня:',
        ])
      : pick([
          'Смотрите актуальные цены:',
          'Вот цены по вашему запросу:',
          'Цены на сегодня:',
        ]);
  }
  if (subIntent === 'location') {
    return pick([
      'Товар есть в каталоге — наличие по магазинам уточните у менеджера:',
      'В каталоге есть, по магазинам подскажет менеджер:',
    ]);
  }
  if (subIntent === 'spec') {
    return isOne
      ? pick([
          'Вот товар — все характеристики на карточке:',
          'Смотрите, характеристики указаны в карточке:',
        ])
      : pick([
          'Вот подходящие — характеристики на карточках:',
          'Смотрите, все характеристики в карточках:',
        ]);
  }

  // Reason-specific intros (без sub_intent)
  if (reason === 'price-shortcircuit') {
    return effectivePriceIntent === 'most_expensive'
      ? pick([
          'Смотрите, вот самые дорогие варианты:',
          'Подобрал самые премиальные модели:',
          'Вот топовые по цене варианты:',
        ])
      : pick([
          'Смотрите, вот самые доступные варианты:',
          'Подобрал самые бюджетные:',
          'Вот что подешевле:',
        ]);
  }
  if (reason === 'article-shortcircuit' || reason === 'siteid-shortcircuit') {
    return pick([
      'Нашёл по точному запросу:',
      'Вот этот товар:',
      'Держите — нашёл:',
    ]);
  }
  if (reason === 'pass2-shortcircuit') {
    return pick([
      'Смотрите, что подобрал под ваши параметры:',
      'Вот подходящие варианты:',
      'Подобрал, смотрите:',
    ]);
  }
  return pick([
    'Смотрите, что нашлось под ваш запрос:',
    'Вот что есть в каталоге:',
    'Подобрал несколько вариантов, смотрите:',
  ]);
}

export function buildDeterministicShortCircuitContent(params: {
  products: Product[];
  reason: string;
  userMessage: string;
  effectivePriceIntent?: 'most_expensive' | 'cheapest';
  subIntent?: 'availability' | 'price' | 'location' | 'spec';
  /**
   * Реальное число собранных товаров до обрезки до DISPLAY_LIMIT.
   * Если > products.length — появится строка «Подобрано ещё N — показать остальные?».
   * Если не передано, берётся products.length (без хвоста).
   */
  totalCollected?: number;
  /**
   * Подавить хвост «Подобрано ещё N — показать остальные?» (one-shot, 2026-05-15).
   * Используется на 2-м ходу после того, как `remaining_offer` уже был предложен.
   */
  suppressTail?: boolean;
}): string {
  const { products, reason, userMessage, effectivePriceIntent, subIntent, suppressTail } = params;
  if (!products.length) return '';

  const intro = buildIntroBySubIntent({
    productsCount: Math.min(products.length, 3),
    reason,
    subIntent,
    effectivePriceIntent,
  });

  // Системный лимит: всегда показываем top-3 карточки в детерминистичном рендере.
  // Если на входе больше — добавляем хвост «подобрано ещё N — показать остальные?».
  const SHOWN = 3;
  const visible = products.slice(0, SHOWN);
  const cards = visible.map(formatProductCardDeterministic).join('\n\n');

  // total = реальное количество в подборке (totalCollected приоритетен, иначе products.length).
  const total = Math.max(params.totalCollected ?? 0, products.length);
  const remaining = Math.max(0, total - visible.length);
  const tail = (remaining > 0 && !suppressTail)
    ? `\n\nПодобрано ещё ${remaining} ${pluralizeRu(remaining, ['вариант', 'варианта', 'вариантов'])} — показать остальные?`
    : '';

  return `${intro}\n\n${cards}${tail}`.trim();
}

/**
 * Русская плюрализация для "1 вариант / 2 варианта / 5 вариантов".
 */
function pluralizeRu(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

/**
 * Cross-sell tail для детерминистичного рендера.
 * Отдельный LLM-вызов (Claude Sonnet 4.5), 1-3 предложения, БЕЗ SKU/цен/ссылок/брендов
 * найденных товаров — чистый текст про сопутствующие категории. Безопасен для URL,
 * т.к. инструкция запрещает любые ссылки/артикулы.
 * Возвращает '' при любой ошибке/таймауте — silent skip, карточки уходят без хвоста.
 */
async function generateCrossSellTail(params: {
  products: Product[];
  userMessage: string;
  settings: CachedSettings;
}): Promise<{ text: string; offerQuery: string }> {
  const { products, userMessage, settings } = params;
  if (!products.length || !settings.openrouter_api_key) return { text: '', offerQuery: '' };

  // Берём только названия первых 3 товаров — этого достаточно, чтобы LLM поняла категорию.
  const titles = products.slice(0, 3).map(p => (p.pagetitle || '').trim()).filter(Boolean);
  if (!titles.length) return { text: '', offerQuery: '' };

  const systemPrompt = `Ты эксперт-консультант 220volt.kz. Клиенту только что показали карточки товаров. Твоя задача — добавить ОДНУ короткую фразу контекстного cross-sell: предложить ЛОГИЧЕСКИ СВЯЗАННЫЙ аксессуар или сопутствующий товар, который обычно докупают вместе.

Запрос клиента: "${userMessage}"
Показанные товары:
${titles.map(t => `- ${t}`).join('\n')}

ПРИМЕРЫ КОНТЕКСТНЫХ ПАР (ориентируйся на смысл, не копируй дословно):
- Розетка / выключатель → рамка, подрозетник
- Автомат, УЗО → DIN-рейка, кабель-канал, бокс
- Кабель-канал → заглушки, угловые соединители
- Светильник → лампа с подходящим цоколем (E27/E14/GU10)
- Перфоратор / дрель → буры, патрон, СДС-насадки
- Лампа → подходящий светильник или патрон
- Кабель → клеммы, гильзы, гофра

ПРАВИЛА для phrase:
- Ровно ОДНА фраза, до 180 символов, заканчивается мягким CTA: «— подобрать?», «— показать варианты?», «— подскажу подходящие».
- Тон: спокойный, профессиональный, как опытный консультант.
- ЗАПРЕЩЕНО: артикулы, цены, ссылки, названия конкретных товаров, БРЕНДЫ, СЕРИИ, КОЛЛЕКЦИИ, МОДЕЛИ, восклицательные знаки, «отличный выбор», давление, маркетинговые штампы.
- НЕ повторяй то, что уже показано в карточках. НЕ предлагай ту же категорию.
- Говори ОБОБЩЁННО: «обычно докупают …», «к этому подходят …». Только тип товара (категория), без привязки к конкретному производителю или линейке.

ПРАВИЛА для offer_query:
- Короткий поисковый запрос (2-5 слов), который применим, если клиент скажет «да/давай/покажи».
- ТОЛЬКО обобщённое название категории/типа товара (например: "подрозетники", "рамки для розеток", "лампы E27", "DIN-рейка", "буры SDS").
- СТРОГО ЗАПРЕЩЕНО упоминать бренды, серии, коллекции, артикулы, модели, цвета конкретных линеек. Это приведёт к пустой выдаче — таких комбинаций может не быть в каталоге.
- Технические универсальные параметры (цоколь E27/E14/GU10, диаметр SDS, сечение кабеля) — РАЗРЕШЕНЫ, они не привязаны к бренду.

Если для этого запроса cross-sell неуместен (категория неочевидна, сопутствующих нет, уже показаны аксессуары) — верни phrase="" и offer_query="".`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${settings.openrouter_api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4.5',
        messages: [{ role: 'user', content: systemPrompt }],
        temperature: 0.3,
        max_tokens: 250,
        tools: [{
          type: 'function',
          function: {
            name: 'propose_cross_sell',
            description: 'Return a one-sentence cross-sell phrase plus a follow-up search query.',
            parameters: {
              type: 'object',
              properties: {
                phrase: { type: 'string', description: 'One short sentence ending in a soft CTA. Empty string if cross-sell is inappropriate.' },
                offer_query: { type: 'string', description: 'Short catalog search query (2-5 words) for the proposed item. Empty if phrase is empty.' },
              },
              required: ['phrase', 'offer_query'],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: 'function', function: { name: 'propose_cross_sell' } },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      console.log(`[CrossSellTail] API error: ${response.status}`);
      return { text: '', offerQuery: '' };
    }
    const data = await response.json();
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall?.function?.arguments) return { text: '', offerQuery: '' };
    let parsed: { phrase?: string; offer_query?: string };
    try { parsed = JSON.parse(toolCall.function.arguments); } catch { return { text: '', offerQuery: '' }; }
    let text = (parsed.phrase || '').trim();
    const offerQuery = (parsed.offer_query || '').trim().slice(0, 100);
    // Sanitize: вырезаем markdown-ссылки/цены — на всякий случай
    if (/\[.*?\]\(.*?\)/.test(text) || /https?:\/\//i.test(text) || /\d+\s*(?:₸|тг|тенге|руб)/i.test(text)) {
      console.log(`[CrossSellTail] Sanitize: rejected text with link/price: ${text.slice(0, 80)}`);
      return { text: '', offerQuery: '' };
    }
    if (text.length > 300) text = text.slice(0, 300);
    return { text, offerQuery: text ? offerQuery : '' };
  } catch (e) {
    console.log(`[CrossSellTail] Error (silent skip): ${(e as Error).message}`);
    return { text: '', offerQuery: '' };
  }
}

// `generateRelatedFollowup` extracted to ../_shared/related-followup.ts (2026-05-12).
// Call-sites теперь передают `deps: { fetchRelatedRaw, openrouterApiKey }`. Это локально
// обёрнуто в `buildRelatedDeps(apiToken, settings)` — см. helper ниже.
function buildRelatedDeps(apiToken: string, settings: CachedSettings): RelatedFollowupDeps {
  return {
    fetchRelatedRaw: (id, params) =>
      fetchCatalogWithRetry(buildRelatedUrl(id, params), apiToken, 'Related', 6000),
    openrouterApiKey: settings.openrouter_api_key,
  };
}

/**
 * LLM-классификатор: принимает ли пользователь cross-sell offer прошлого хода.
 * Без хардкод-списка слов: модель сама решает на основе семантики.
 * Возвращает 'accept' (короткое согласие БЕЗ новых сущностей), 'new_request' (что-то иное),
 * либо 'unclear' (пропускаем — пусть основной pipeline разбирается).
 */

async function classifyOfferResponse(params: {
  offerText: string;
  offerQuery: string;
  userMessage: string;
  settings: CachedSettings;
}): Promise<'accept' | 'new_request' | 'unclear'> {
  const { offerText, offerQuery, userMessage, settings } = params;
  if (!settings.openrouter_api_key) return 'unclear';
  if (!offerText || !userMessage.trim()) return 'unclear';

  const prompt = `Ты классификатор намерений в чат-консультанте магазина электротоваров.

В прошлом ходе бот предложил клиенту дополнительный товар:
Фраза бота: "${offerText}"
(внутренний поисковый запрос для этого предложения: "${offerQuery}")

Сейчас клиент написал: "${userMessage}"

Определи, что значит сообщение клиента в КОНТЕКСТЕ предложения бота:
- "accept": клиент СОГЛАШАЕТСЯ с предложением бота и хочет его увидеть. Это короткие подтверждения без новой темы и без новых требований ("да", "давай", "ок", "покажи", "хочу", "интересно" и любые семантически близкие).
- "new_request": клиент проигнорировал предложение и пишет ЧТО-ТО ДРУГОЕ — новый запрос, уточнение по уже показанным товарам, изменение фильтров (другой цвет/цена/бренд), вопрос не по теме предложения. Любое сообщение, которое содержит новые сущности или модификаторы — это new_request.
- "unclear": неоднозначно, либо сообщение не относится ни к одному варианту.

Важно: даже если клиент пишет "давай покажи розетки подешевле" после предложения подрозетников — это NEW_REQUEST, потому что есть новая тема (розетки) и модификатор (дешевле). "Accept" — только когда клиент НЕ добавляет ничего своего.`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${settings.openrouter_api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash-lite',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 50,
        tools: [{
          type: 'function',
          function: {
            name: 'classify_offer_response',
            description: 'Classify user reply to a previous cross-sell offer.',
            parameters: {
              type: 'object',
              properties: {
                decision: { type: 'string', enum: ['accept', 'new_request', 'unclear'] },
              },
              required: ['decision'],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: 'function', function: { name: 'classify_offer_response' } },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return 'unclear';
    const data = await response.json();
    const args = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!args) return 'unclear';
    const parsed = JSON.parse(args);
    const decision = parsed.decision;
    if (decision === 'accept' || decision === 'new_request') return decision;
    return 'unclear';
  } catch (e) {
    console.log(`[OfferResolver] Error (silent skip): ${(e as Error).message}`);
    return 'unclear';
  }
}

export function isDeterministicShortCircuitReason(reason: string): boolean {
  return ['price-shortcircuit', 'article-shortcircuit', 'siteid-shortcircuit', 'title-shortcircuit'].includes(reason);
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
    if (Array.isArray(product?.options)) {
      const brandOption = product.options.find((o: any) => o && o.key === 'brend__brend');
      if (brandOption) {
        const brandName = cleanOptionValue(brandOption.value);
        if (brandName) {
          brands.add(brandName);
          found = true;
        }
      }
    }
    if (!found && typeof product?.vendor === 'string' && product.vendor.trim()) {
      brands.add(product.vendor.trim());
    }
  }
  
  return Array.from(brands).sort();
}

// ============================================================
// COMPUTE BLOCK — spec_query надстройка
// ============================================================
// Классификатор пометил compute={attribute, multiplier?} — пользователь
// спросил о характеристике товара (опц. ×N). Список характеристик товара
// УЖЕ есть в LLM-контексте (см. formatProductsForAI → "Характеристики: ...").
// LLM сама находит подходящее поле и считает — никаких словарей синонимов,
// никакого ручного матчинга. Здесь только короткая инструкция-задача.
// Anti-hallucination: использовать ТОЛЬКО значения из контекста; если поля
// нет — честно сказать «не указано».
// ============================================================
function buildComputeInstructionBlock(params: {
  attribute: string;
  multiplier: number | null | undefined;
}): string {
  const { attribute, multiplier } = params;
  const mulText = (multiplier && multiplier > 1) ? ` × ${multiplier} шт.` : '';
  const attrLower = attribute.toLowerCase();
  const isVolumeQuery = /объ[её]м|места|место|перевоз|транспорт|машин|газел|кузов|влез|помест/i.test(attrLower);
  const volumeBlock = isVolumeQuery ? `

📦 СПЕЦПРАВИЛО ДЛЯ ОБЪЁМА (для расчёта транспортировки):
- Возьми объём единицы из характеристик товара и умножь на количество.
- Применяй внутренний коэффициент запаса (упаковка/намотка/паллетирование), но **НИКОГДА не упоминай его в ответе** — ни число, ни слово «коэффициент», ни «×1.1», ни «×1.2», ни «с учётом запаса», ни «с запасом на намотку». Просто посчитай и сразу выдай итог.
  • Если товар — КАБЕЛЬ или ПРОВОД (определи это сам по названию и характеристикам) → умножай дополнительно на 1.2.
  • Любой другой товар → умножай дополнительно на 1.1.
- Приведи ответ в м³. Если в характеристиках указаны дм³ / литры / см³ — переведи самостоятельно (1 м³ = 1000 л = 1000 дм³ = 1 000 000 см³). Единицу в ответе указывай.
- Пример формулировки (живым языком, БЕЗ упоминания коэффициента): «100 метров такого кабеля займут примерно 0.06 м³» или «50 таких розеток — около 0.03 м³».
- Если поля «объём» (или эквивалентного) нет в характеристиках — честно скажи, что объём не указан, и предложи уточнить у менеджера. НЕ выдумывай числа.
` : '';
  return `🧮 КЛИЕНТ СПРАШИВАЕТ О ХАРАКТЕРИСТИКЕ: «${attribute}»${mulText}

Список характеристик каждого товара (поле «Характеристики: …») у тебя уже есть ниже. Найди в нём поле, соответствующее запросу клиента (значение бери ТОЛЬКО оттуда — не выдумывай).

🎭 ПЕРСОНА: ты — живой менеджер-консультант магазина электрики, говоришь с клиентом в чате. Не робот, не справочник. Тон тёплый, по-человечески, но по делу — как продавец, который реально хочет помочь подобрать.

✅ ТВОЯ ЗАДАЧА:
1. Найди в характеристиках товара значение, соответствующее «${attribute}». Поле может называться по-разному (для «вес» подойдёт «Масса, кг» или «Вес нетто»; для «объём» — «Объём, м³», «Объём упаковки» и т.п.).
2. ${(multiplier && multiplier > 1)
    ? `Если значение числовое — умножь на ${multiplier} и дай короткий человеческий ответ ОДНОЙ фразой ПЕРЕД карточкой. Например: «${multiplier} таких светильников будут весить около 3.5 кг — спокойно увезёте на легковушке» или «По мощности ${multiplier} штук — суммарно 300 Вт, для бытовой сети нормально». НЕ пиши сухие формулы вида «вес × 5 = 3.5 кг». Если значение нечисловое (IP-класс, цвет, материал) — просто по-человечески прокомментируй, умножение не применяй.`
    : `Ответь ОДНОЙ короткой человеческой фразой ПЕРЕД карточкой, как продавец в зале. Например: «Смотрите, этот светильник весит всего 0.7 кг — крепится на любой потолок» или «У него IP44 — для ванной и улицы под навесом самое то». НЕ пиши сухие формулы вида «вес: 0.7 кг» и не начинай с «согласно характеристикам», «представляю вашему вниманию», «данная модель».`}
3. После ответа покажи карточку(и) товара как обычно: название-ссылка, Цена, Бренд, Наличие.
4. ПОСЛЕ карточки добавь ОДИН короткий вопрос-зацепку, чтобы продолжить разговор и помочь с выбором. Подбирай по смыслу запроса, например: «Подобрать под конкретный цоколь?», «Нужна для дома или для производства?», «Сколько штук планируете брать — посчитаю на партию?», «Показать варианты подешевле / помощнее?». НЕ задавай вопрос, если клиент уже явно всё определил.
5. Если в характеристиках НЕТ поля, соответствующего «${attribute}» — честно одной фразой скажи по-человечески, что в карточке эта характеристика не указана, и предложи уточнить у менеджера или посмотреть полную страницу товара. НИКОГДА не выдумывай числовые значения.

🚫 ЗАПРЕЩЕНО: канцелярит и роботизм — «согласно характеристикам», «представляю вашему вниманию», «данная модель обладает», «информирую вас», «вышеуказанный товар». Пиши как живой человек в чате.${volumeBlock}
`;
}

/**
 * Превращает «голые» контакты в кликабельные markdown-ссылки внутри ЛЮБОГО
 * текста: телефон → tel:, email → mailto:, WhatsApp/wa.me → https://wa.me/.
 * Идемпотентна: уже оформленные `[label](tel:|mailto:|http...)` не трогает.
 * Используется для:
 *   1) Пред-обработки contactsInfo (источник для LLM) — гарантия, что модель
 *      физически не видит голые контакты и не сможет их скопировать.
 *   2) Пост-обработки финального текста (страховка для не-стримовой ветки).
 */
function linkifyContacts(text: string): string {
  if (!text) return text;
  // Защищаем уже существующие markdown-ссылки от повторной обработки.
  const protectedSlots: string[] = [];
  let out = text.replace(/\[[^\]]+\]\([^)]+\)/g, (m) => {
    protectedSlots.push(m);
    return `\u0000LINK${protectedSlots.length - 1}\u0000`;
  });

  // Email → mailto:
  out = out.replace(
    /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g,
    (_m, email) => `[${email}](mailto:${email})`,
  );

  // WhatsApp ссылки и упоминания «WhatsApp: +7...»
  out = out.replace(/https?:\/\/wa\.me\/(\d+)/gi, (_m, n) => `[WhatsApp](https://wa.me/${n})`);
  out = out.replace(
    /\bWhatsApp\b\s*[:\-—]?\s*((?:\+7|8)[\s\(\)\-]*\d{3}[\s\(\)\-]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2})/gi,
    (_m, raw) => {
      const num = raw.replace(/[\s\(\)\-]/g, '');
      return `[WhatsApp](https://wa.me/${num})`;
    },
  );

  // Телефоны → tel:
  out = out.replace(
    /(?:\+7|8)[\s\(\)\-]*\d{3}[\s\(\)\-]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/g,
    (raw) => {
      const num = raw.replace(/[\s\(\)\-]/g, '');
      return `[${raw.trim()}](tel:${num})`;
    },
  );

  // Возвращаем защищённые ссылки.
  out = out.replace(/\u0000LINK(\d+)\u0000/g, (_m, i) => protectedSlots[Number(i)]);
  return out;
}

function formatContactsForDisplay(contactsText: string): string | null {
  if (!contactsText || contactsText.trim().length === 0) return null;

  const lines: string[] = [];
  const seenPhones = new Set<string>();

  const phoneRegex = /(?:\+7|8)[\s\(\)\-]*\d{3}[\s\(\)\-]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/g;
  const phoneMatches = contactsText.match(phoneRegex);
  if (phoneMatches) {
    for (const raw of phoneMatches) {
      const telNumber = raw.replace(/[\s\(\)\-]/g, '');
      if (seenPhones.has(telNumber)) continue;
      seenPhones.add(telNumber);
      lines.push(`📞 [${raw.trim()}](tel:${telNumber})`);
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

function scoreKnowledgeEntryForInfoQuery(
  query: string,
  entry: { title: string; content: string },
): { score: number; activeBoostKeywords: string[] } {
  const queryWords = query.toLowerCase().replace(/[?!.,;:()«»"']/g, '').split(/\s+/).filter(w => w.length > 2);
  const lq = query.toLowerCase();
  const topicBoosts: Array<{ match: RegExp; titleKeywords: string[] }> = [
    { match: /(работа\w*|работ?ете|режим|график|открыт\w*|закрыт\w*|часы|до\s+скольк\w*|со\s+скольк\w*|выходн\w*)/i, titleKeywords: ['контакт', 'режим', 'график', 'часы работы', 'время работы'] },
    { match: /(достав\w*|курьер\w*|самовывоз\w*|привез\w*)/i, titleKeywords: ['доставк'] },
    { match: /(оплат\w*|kaspi|каспи|карта|наличн\w*|перевод\w*|счёт|счет)/i, titleKeywords: ['оплат'] },
    { match: /(гаранти\w*)/i, titleKeywords: ['гаранти'] },
    { match: /(возврат\w*|обмен\w*|вернуть)/i, titleKeywords: ['возврат', 'обмен'] },
    { match: /(адрес\w*|где\s+(вы|нах|купить|магазин)|филиал\w*|офис\w*|магазин\w*)/i, titleKeywords: ['контакт', 'филиал', 'адрес'] },
    { match: /(телефон\w*|номер|позвон\w*|связ\w*|email|почт\w*|whatsapp|ватсап)/i, titleKeywords: ['контакт'] },
  ];

  const activeBoostKeywords: string[] = [];
  for (const tb of topicBoosts) {
    if (tb.match.test(lq)) activeBoostKeywords.push(...tb.titleKeywords);
  }

  const titleLc = entry.title.toLowerCase();
  const contentLc = entry.content.toLowerCase();
  let score = 0;

  for (const w of queryWords) {
    if (titleLc.includes(w)) score += 3;
    if (contentLc.includes(w)) score += 1;
  }
  for (const kw of activeBoostKeywords) {
    if (titleLc.includes(kw)) score += 10;
  }

  return { score, activeBoostKeywords };
}

function pickBestKnowledgeEntryForInfoQuery<T extends { title: string; content: string }>(
  query: string,
  knowledgeResults: T[],
): { bestMatch: T | null; runnerUp: T | null; bestScore: number; runnerUpScore: number; activeBoostKeywords: string[] } {
  const scored = knowledgeResults.map((r) => {
    const { score, activeBoostKeywords } = scoreKnowledgeEntryForInfoQuery(query, r);
    return { r, score, activeBoostKeywords };
  }).sort((a, b) => b.score - a.score);

  return {
    bestMatch: scored.length > 0 && scored[0].score > 0 ? scored[0].r : null,
    runnerUp: scored[1]?.r ?? null,
    bestScore: scored[0]?.score ?? 0,
    runnerUpScore: scored[1]?.score ?? 0,
    activeBoostKeywords: scored[0]?.activeBoostKeywords ?? [],
  };
}

function getCurrentWeekdayLabelsInAlmaty(now = new Date()): { ruShort: string; weekdayIndex: number } {
  const weekdayShort = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Almaty',
    weekday: 'short',
  }).format(now).toLowerCase().replace('.', '');
  const weekdayMap: Record<string, number> = {
    'вс': 0,
    'пн': 1,
    'вт': 2,
    'ср': 3,
    'чт': 4,
    'пт': 5,
    'сб': 6,
  };
  return { ruShort: weekdayShort, weekdayIndex: weekdayMap[weekdayShort] ?? -1 };
}

function extractTodayWorkingHoursFromContacts(contactsText: string, query: string): string | null {
  if (!contactsText) return null;
  const lq = query.toLowerCase();
  if (!/(работа\w*|работ?ете|режим|график|до\s+скольк\w*|со\s+скольк\w*|открыт\w*|закрыт\w*|часы)/i.test(lq)) {
    return null;
  }

  const cityVariants: Array<{ target: string; variants: string[] }> = [
    { target: 'караганда', variants: ['караганда', 'караганде'] },
    { target: 'астана', variants: ['астана', 'астане'] },
    { target: 'алматы', variants: ['алматы', 'алмате'] },
    { target: 'шымкент', variants: ['шымкент', 'шымкенте'] },
    { target: 'актобе', variants: ['актобе', 'актобе'] },
  ];
  const targetCity = cityVariants.find(({ variants }) => variants.some((variant) => lq.includes(variant)))?.target ?? '';
  const lines = contactsText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const candidates = lines.filter(line => {
    const lc = line.toLowerCase();
    if (!lc.includes('филиал:')) return false;
    if (targetCity && !lc.includes(targetCity)) return false;
    return /(пн|вт|ср|чт|пт|сб|вс)/i.test(lc);
  });
  if (candidates.length === 0) return null;

  const { ruShort, weekdayIndex } = getCurrentWeekdayLabelsInAlmaty();
  const todayFullMap: Record<string, string> = {
    'пн': 'сегодня, в понедельник',
    'вт': 'сегодня, во вторник',
    'ср': 'сегодня, в среду',
    'чт': 'сегодня, в четверг',
    'пт': 'сегодня, в пятницу',
    'сб': 'сегодня, в субботу',
    'вс': 'сегодня, в воскресенье',
  };

  const directDayPatterns: Array<{ days: number[]; regex: RegExp }> = [
    { days: [1, 2, 3, 4, 5], regex: /пн\.?\s*-\s*пт\.?\s*([0-2]?\d[:.]\d{2}\s*-\s*[0-2]?\d[:.]\d{2})/i },
    { days: [6, 0], regex: /сб\.?\s*-\s*вс\.?\s*([0-2]?\d[:.]\d{2}\s*-\s*[0-2]?\d[:.]\d{2}|выходной)/i },
    { days: [6], regex: /сб\.?\s*[:\-]?\s*([0-2]?\d[:.]\d{2}\s*-\s*[0-2]?\d[:.]\d{2}|выходной)/i },
    { days: [0], regex: /вс\.?\s*[:\-]?\s*([0-2]?\d[:.]\d{2}\s*-\s*[0-2]?\d[:.]\d{2}|выходной)/i },
    { days: [1], regex: /пн\.?\s*[:\-]?\s*([0-2]?\d[:.]\d{2}\s*-\s*[0-2]?\d[:.]\d{2}|выходной)/i },
    { days: [2], regex: /вт\.?\s*[:\-]?\s*([0-2]?\d[:.]\d{2}\s*-\s*[0-2]?\d[:.]\d{2}|выходной)/i },
    { days: [3], regex: /ср\.?\s*[:\-]?\s*([0-2]?\d[:.]\d{2}\s*-\s*[0-2]?\d[:.]\d{2}|выходной)/i },
    { days: [4], regex: /чт\.?\s*[:\-]?\s*([0-2]?\d[:.]\d{2}\s*-\s*[0-2]?\d[:.]\d{2}|выходной)/i },
    { days: [5], regex: /пт\.?\s*[:\-]?\s*([0-2]?\d[:.]\d{2}\s*-\s*[0-2]?\d[:.]\d{2}|выходной)/i },
  ];

  type BranchInfo = {
    name: string;
    address: string;
    phone: string | null;
    hours: string;
  };

  const extractForLine = (line: string): BranchInfo | null => {
    const parts = line.split('|').map(p => p.trim()).filter(Boolean);
    // Формат: "Филиал: г. Караганда | <address> | <name?> | <phone?> | <schedule>"
    if (parts.length < 2) return null;

    const phoneRegex = /(?:\+7|8)[\s\(\)\-]*\d{3}[\s\(\)\-]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/;
    const scheduleRegex = /(пн|вт|ср|чт|пт|сб|вс)/i;

    let address = parts[1] || '';
    let name = '';
    let phone: string | null = null;
    let scheduleSource = '';

    for (let i = 2; i < parts.length; i++) {
      const p = parts[i];
      const phoneM = p.match(phoneRegex);
      if (phoneM && !phone) {
        phone = phoneM[0].trim();
        continue;
      }
      if (scheduleRegex.test(p)) {
        // Берём ПОСЛЕДНЕЕ расписание (часто две колонки — будни/выходные суммарно).
        scheduleSource = scheduleSource ? `${scheduleSource}; ${p}` : p;
        continue;
      }
      if (!name) {
        name = p;
      }
    }

    if (!scheduleSource) return null;

    const src = scheduleSource.toLowerCase();
    const clean = scheduleSource.replace(/\s+/g, ' ').trim();
    let hours = '';

    if (/пн-?вс/.test(src)) {
      const m = clean.match(/пн-?вс\.?\s*([0-2]?\d[:.]\d{2}\s*-\s*[0-2]?\d[:.]\d{2})/i);
      if (m) hours = m[1].replace(/\./g, ':');
    }
    if (!hours) {
      for (const pattern of directDayPatterns) {
        if (!pattern.days.includes(weekdayIndex)) continue;
        const match = clean.match(pattern.regex);
        if (!match) continue;
        hours = match[1].replace(/\./g, ':');
        break;
      }
    }
    if (!hours) return null;

    return {
      name: name || 'Магазин 220 VOLT',
      address,
      phone,
      hours,
    };
  };

  // Лёгкий вопрос для удержания — менеджер так и общается.
  const followUpQuestions = [
    'А что вы подбираете — подскажу прямо сейчас?',
    'Кстати, что именно ищете? Помогу с выбором.',
    'А по какому товару вопрос? Подскажу варианты.',
  ];
  const followUp = followUpQuestions[new Date().getMinutes() % followUpQuestions.length];

  const todayLabel = todayFullMap[ruShort] || 'сегодня';
  const cityLabel = targetCity ? targetCity.charAt(0).toUpperCase() + targetCity.slice(1) : '';

  const branches: BranchInfo[] = [];
  const seenKey = new Set<string>();
  for (const line of candidates) {
    const resolved = extractForLine(line);
    if (!resolved) continue;
    const key = `${resolved.address}|${resolved.hours}|${resolved.phone ?? ''}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    branches.push(resolved);
  }

  if (branches.length === 0) return null;

  // NBSP внутри номера, чтобы браузер не переносил цифры на новую строку.
  const formatPhone = (raw: string): string => {
    const num = raw.replace(/[\s\(\)\-]/g, '');
    const display = raw.trim().replace(/\s+/g, '\u00A0').replace(/-/g, '\u2011');
    return `[${display}](tel:${num})`;
  };

  const todayCap = todayLabel === 'сегодня'
    ? 'Сегодня'
    : todayLabel.charAt(0).toUpperCase() + todayLabel.slice(1);

  const formatHoursLine = (hours: string): string => {
    if (hours.toLowerCase().includes('выходной')) return `${todayCap} — выходной`;
    const [s, e] = hours.split('-').map((x) => x.trim());
    return `${todayCap} работает с **${s}** до **${e || s}**`;
  };

  const formatBranch = (b: BranchInfo): string => {
    const lines: string[] = [];
    lines.push(`- **${b.name}**`);
    if (b.address) lines.push(`  - 📍\u00A0${b.address}`);
    lines.push(`  - 🕒\u00A0${formatHoursLine(b.hours)}`);
    if (b.phone) lines.push(`  - 📞\u00A0${formatPhone(b.phone)}`);
    return lines.join('\n');
  };

  // Один филиал — компактный блок, но с переносами «поле — значение».
  if (branches.length === 1) {
    const b = branches[0];
    const lines: string[] = [];
    lines.push(`**${b.name}**`);
    if (b.address) lines.push(`📍 ${b.address}`);
    lines.push(`🕒 ${formatHoursLine(b.hours)}.`);
    if (b.phone) lines.push(`📞 ${formatPhone(b.phone)}`);
    lines.push('');
    lines.push(followUp);
    return lines.join('\n');
  }

  // Несколько филиалов — список.
  const header = cityLabel
    ? `${todayCap} в ${cityLabel} работают ${branches.length} наших точек:`
    : `${todayCap} работают наши точки:`;

  return [header, branches.map(formatBranch).join('\n\n'), followUp].join('\n\n');
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

function isSafeCatalogQueryParam(value: string): boolean {
  if (!value || value.length === 0 || value.length > 200) return false;
  // Для `?query=` каталог принимает реальные товарные строки с `+`, `*`, `×`, `х`, `/`, `№`,
  // кавычками и двоеточиями. Резать их общим whitelist'ом нельзя — иначе name-first
  // short-circuit блокируется до запроса в API.
  return !/[\x00-\x1F\x7F<>\\|&%?#=]/.test(value);
}

/**
 * Расширенный whitelist специально для exact-match по названию товара
 * (`?pagetitle=` и `?longtitle=`). В реальных названиях встречаются `+`, `*`,
 * `×`, `х`, `/`, `№`, кавычки, двоеточия и др. — их санитизировать нельзя,
 * иначе exact match гарантированно не сработает. URL-encoding делает
 * URLSearchParams. Защита от инъекций — чёрный список реально опасных
 * символов в URL/HTTP-контексте + контрольные символы + лимит длины.
 */
function isSafeTitleParam(value: string): boolean {
  if (!value || value.length === 0 || value.length > 200) return false;
  // Запрещаем: control chars, перевод строк/таб, и символы, ломающие URL/HTTP:
  // < > \ | & % ? # =
  return !/[\x00-\x1F\x7F<>\\|&%?#=]/.test(value);
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

// ─── Server-side slot-state persistence (V1) ────────────────────────────────
// Хранит finalised dialogSlots между ходами в `chat_cache_v2` под ключом
// `slot:v1:<sessionId>`. Восстанавливается, если фронт не прислал dialogSlots.
// Backward-совместимо: если body.dialogSlots пришли — они приоритетнее.
const SLOT_STATE_TTL_SEC = 30 * 60; // 30 минут

function slotStateKey(sessionId: string): string {
  return `slot:v1:${sessionId}`;
}

async function loadPersistedSlots(sessionId: string): Promise<DialogSlots | null> {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await sb
      .from('chat_cache_v2')
      .select('cache_value, expires_at')
      .eq('cache_key', slotStateKey(sessionId))
      .maybeSingle();
    if (error || !data) return null;
    if (new Date(data.expires_at as string).getTime() < Date.now()) return null;
    const raw = (data.cache_value as { slots?: unknown })?.slots;
    return raw ? validateAndSanitizeSlots(raw) : null;
  } catch (e) {
    console.warn('[SlotPersist] load failed:', e);
    return null;
  }
}

// Fire-and-forget: не ждём, не блокируем стрим.
function persistSlotsAsync(sessionId: string, slots: DialogSlots): void {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  const expiresAt = new Date(Date.now() + SLOT_STATE_TTL_SEC * 1000).toISOString();
  (async () => {
    try {
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { error } = await sb
        .from('chat_cache_v2')
        .upsert(
          {
            cache_key: slotStateKey(sessionId),
            cache_value: { slots, persisted_at: new Date().toISOString() },
            expires_at: expiresAt,
          },
          { onConflict: 'cache_key' },
        );
      if (error) console.warn('[SlotPersist] upsert error:', error.message);
    } catch (e) {
      console.warn('[SlotPersist] upsert exception:', e);
    }
  })();
}

export async function handleChatConsultant(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Request-scoped logger (TTL 24ч в chat_request_logs)
  const logCtx = createLogCtx(req, 'v1');
  return await runWithLogCtx(logCtx, async () => {
    try {
      // SSE heartbeat wrapper:
      //  • fast inner (<200ms) → pass-through unchanged (errors, duplicates, 429)
      //  • slow inner (typical pipeline 30–50s) → SSE `: keepalive` every 5s
      //    sent immediately so proxies/NAT/browser don't drop the idle TCP
      //    connection (root cause of «Failed to fetch» on long requests).
      // The heavy pipeline runs unchanged inside _handleChatConsultantInner.
      const innerPromise = _handleChatConsultantInner(req);
      const wrapped = await wrapWithHeartbeat(innerPromise, { corsHeaders });
      return wrapResponseForLogging(wrapped, logCtx);
    } catch (e) {
      logSetError(e);
      const { flushLog } = await import('../_shared/request-logger.ts');
      flushLog(logCtx).catch(() => {});
      throw e;
    }
  });
}

async function _handleChatConsultantInner(req: Request): Promise<Response> {

  // Per-request correlation id — included in every key log line so we can
  // grep one user's full pipeline (classify → facets → filter-LLM → rerank)
  // out of the firehose of concurrent requests.
  const reqId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).slice(0, 8);

  // Run the entire request inside an AsyncLocalStorage context so deeply nested
  // catalog helpers can read reqId via _currentReqId() and mark Degraded-mode
  // without threading the id through every signature.
  return await _reqContext.run({ reqId }, async () => {

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
      // Skip log insert for duplicate calls (избегаем двойной записи user_query).
      const dupCtx = (await import('../_shared/request-logger.ts')).getLogCtx?.();
      if (dupCtx) dupCtx.flushed = true;
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
    // Логирование сессии и текста запроса
    try {
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
      logSetSession(conversationId);
      logSetUserQuery(lastUserMsg ? lastUserMsg.content : null);
    } catch (_) { /* ignore */ }
    // === DIALOG SLOTS: read and validate ===
    // Server-managed persistence (V1): если фронт не прислал dialogSlots —
    // подтягиваем последнее сохранённое состояние по sessionId из chat_cache_v2.
    // Если прислал — он приоритетнее (обратная совместимость с виджетом).
    const clientSentSlots = body.dialogSlots && Object.keys(body.dialogSlots).length > 0;
    let dialogSlots: DialogSlots = validateAndSanitizeSlots(body.dialogSlots);
    if (!clientSentSlots) {
      const persisted = await loadPersistedSlots(conversationId);
      if (persisted && Object.keys(persisted).length > 0) {
        dialogSlots = persisted;
        console.log(`[Chat] Dialog slots restored from cache: ${Object.keys(dialogSlots).length} slot(s)`);
      }
    }
    let slotsUpdated = false;
    console.log(`[Chat] Dialog slots active: ${Object.keys(dialogSlots).length} slot(s) (clientSent=${clientSentSlots})`);

    // Age all pending slots by 1 turn
    dialogSlots = ageSlots(dialogSlots);
    
    const appSettings = await getAppSettings();
    const aiConfig = getAIConfig(appSettings);
    
    console.log(`[Chat] AI Provider: OpenRouter (strict), Model: ${aiConfig.model}`);

    const lastMessage = messages[messages.length - 1];
    const rawUserMessage = lastMessage?.content || '';
    
    let userMessage = sanitizeUserInput(rawUserMessage);
    
    messages = messages.map(m => ({
      ...m,
      content: m.role === 'user' ? sanitizeUserInput(m.content) : m.content
    }));
    
    console.log(`[Chat req=${reqId}] Processing: "${userMessage.substring(0, 100)}"`);
    console.log(`[Chat req=${reqId}] Conversation ID: ${conversationId}`);

    // === REMAINING_OFFER RESOLVER (V1, 2026-05-15) ===
    // На прошлом ходу мы показали 3 карточки + хвост «Подобрано ещё N — показать остальные?»
    // и сохранили `remaining_offer` slot с remaining_products + anchors для cross-sell.
    //   accept   → отдаём оставшиеся карточки БЕЗ хвоста + cross-sell-пузырь.
    //   decline  → короткий нативный ack + cross-sell-пузырь.
    //   new_request / unclear → slot чистим, идём в обычный pipeline.
    // Флаг `tailWasOfferedLastTurn` фиксируем ДО любых мутаций slot'а — он
    // подавит повторный хвост «Подобрано ещё N» на текущем ходу (one-shot).
    const tailWasOfferedLastTurn = !!dialogSlots['remaining_offer'];
    const remainingOfferSlot = dialogSlots['remaining_offer'];
    if (remainingOfferSlot && remainingOfferSlot.remaining_products) {
      const decision = await classifyRelatedOfferResponse({
        offerText: remainingOfferSlot.offer_text || 'Подобрано ещё — показать остальные?',
        userMessage,
        openrouterApiKey: appSettings.openrouter_api_key,
      });
      console.log(`[Chat req=${reqId}] Remaining offer decision: ${decision} (user="${userMessage.slice(0, 60)}")`);

      if (decision === 'accept' || decision === 'decline') {
        // Парсим сохранённое.
        let remainingProducts: Product[] = [];
        try {
          const parsed = JSON.parse(remainingOfferSlot.remaining_products);
          if (Array.isArray(parsed)) remainingProducts = parsed as Product[];
        } catch { /* malformed → degrade */ }

        let savedAnchors: RelatedAnchor[] = [];
        try {
          const parsed = JSON.parse(remainingOfferSlot.anchors || '[]');
          if (Array.isArray(parsed)) {
            savedAnchors = parsed
              .filter((a: any) => a && Number.isFinite(a.id))
              .map((a: any) => ({
                id: a.id,
                price: typeof a.price === 'number' ? a.price : undefined,
                category: a.category || undefined,
                options: Array.isArray(a.options) ? a.options : undefined,
              }));
          }
        } catch { /* ignore */ }

        // Cross-sell follow-up — общий для accept и decline.
        const runCrossSell = async () => {
          if (!savedAnchors.length || !appSettings.volt220_api_token) {
            return { text: '', anchorIds: [] as number[], categories: [] as string[] };
          }
          try {
            return await generateRelatedFollowup({
              anchors: savedAnchors,
              userMessage: rawUserMessage,
              productCategory: classification?.product_category,
              deps: buildRelatedDeps(appSettings.volt220_api_token, appSettings),
            });
          } catch (e) {
            console.log(`[RemainingOffer] cross-sell error (silent skip): ${(e as Error).message}`);
            return { text: '', anchorIds: [] as number[], categories: [] as string[] };
          }
        };

        // Сохранение cross_sell_offer slot после показа cross-sell.
        const saveCrossSellSlotFromRemaining = (followup: { text: string; anchorIds: number[]; categories: string[] }) => {
          if (!followup.text || !followup.anchorIds.length) return;
          const anchorSnapshot = savedAnchors
            .filter((a) => followup.anchorIds.includes(a.id))
            .slice(0, 5)
            .map((a) => ({ id: a.id, price: a.price, options: a.options, category: a.category }));
          dialogSlots['cross_sell_offer'] = {
            intent: 'cross_sell_offer',
            base_category: remainingOfferSlot.base_category || 'cross_sell',
            status: 'pending',
            created_turn: 0,
            turns_since_touched: 0,
            offer_text: followup.text.slice(0, 500),
            anchor_ids: JSON.stringify(followup.anchorIds.slice(0, 5)),
            related_categories: JSON.stringify(followup.categories.slice(0, 5)),
            anchors: JSON.stringify(anchorSnapshot),
          };
        };

        // Главный контент:
        //   accept  → карточки оставшихся товаров без хвоста (intro + cards)
        //   decline → короткий нативный ack
        let mainContent: string;
        if (decision === 'accept' && remainingProducts.length) {
          const introOptions = ['Конечно, вот остальные:', 'Держите остальные:', 'Хорошо, вот что ещё есть:', 'Вот оставшиеся варианты:'];
          const intro = introOptions[Math.floor(Math.random() * introOptions.length)];
          const cards = remainingProducts.map((p) => formatProductCardDeterministic(p)).join('\n\n');
          mainContent = `${intro}\n\n${cards}`.trim();
        } else if (decision === 'accept') {
          // accept, но remaining_products пуст (malformed) → degrade в decline-ack
          mainContent = 'Хорошо.';
        } else {
          // decline
          const ackOptions = [
            'Понял, не настаиваю.',
            'Хорошо, как скажете.',
            'Ок, не буду перегружать.',
            'Принято.',
          ];
          mainContent = ackOptions[Math.floor(Math.random() * ackOptions.length)];
        }

        // Удаляем remaining_offer одноразово.
        delete dialogSlots['remaining_offer'];
        slotsUpdated = true;

        // Запускаем cross-sell.
        const followup = await runCrossSell();
        saveCrossSellSlotFromRemaining(followup);
        if (followup.text) slotsUpdated = true;

        console.log(`[Chat req=${reqId}] Remaining offer ${decision.toUpperCase()} → main(${mainContent.length} chars) + crossSell(${followup.text ? 'yes' : 'no'})`);
        persistSlotsAsync(conversationId, dialogSlots);

        if (!useStreaming) {
          const responseBody: { content: string; slot_update?: DialogSlots; followup?: { text: string } } = { content: mainContent };
          if (slotsUpdated) responseBody.slot_update = dialogSlots;
          if (followup.text) responseBody.followup = { text: followup.text };
          return new Response(JSON.stringify(responseBody), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: mainContent }, index: 0 }] })}\n\n`));
            if (slotsUpdated) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ slot_update: dialogSlots })}\n\n`));
            }
            if (followup.text) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ followup: { text: followup.text } })}\n\n`));
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { ...corsHeaders, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
        });
      }

      // new_request / unclear → удаляем слот, идём дальше как обычно.
      delete dialogSlots['remaining_offer'];
      slotsUpdated = true;
    }

    // === CROSS_SELL_OFFER RESOLVER (V1, Step 3) ===
    // На прошлом ходу мы показали нативную фразу про сопутствующие товары и
    // сохранили `cross_sell_offer` slot с anchor_ids. Если клиент соглашается —
    // фетчим /related для этих anchor_ids и отдаём реальные карточки БЕЗ нового
    // catalog-search (защита от галлюцинаций).
    // Слот одноразовый: после resolve удаляется в любом случае.
    const crossSellSlot = dialogSlots['cross_sell_offer'];
    if (crossSellSlot && crossSellSlot.anchor_ids) {
      let anchorIds: number[] = [];
      try {
        const parsed = JSON.parse(crossSellSlot.anchor_ids);
        if (Array.isArray(parsed)) anchorIds = parsed.filter((x) => Number.isFinite(x));
      } catch { /* malformed → silent skip */ }

      if (anchorIds.length) {
        const decision = await classifyRelatedOfferResponse({
          offerText: crossSellSlot.offer_text || '',
          userMessage,
          openrouterApiKey: appSettings.openrouter_api_key,
        });
        console.log(`[Chat req=${reqId}] Cross-sell offer decision: ${decision} (anchors=${anchorIds.join(',')}, user="${userMessage.slice(0, 60)}")`);

        if (decision === 'accept') {
          let preferredCategories: string[] = [];
          try {
            const parsedCats = JSON.parse(crossSellSlot.related_categories || '[]');
            if (Array.isArray(parsedCats)) preferredCategories = parsedCats.filter((x) => typeof x === 'string');
          } catch { /* ignore */ }

          // Если пользователь упомянул одну из предложенных категорий («подбери коробки
          // монтажные» из 3 предложенных) — сужаем post-filter ТОЛЬКО до неё. Иначе
          // показываем все 3. Маппинг через нормализованное substring-сопоставление
          // (без морфологии — короткое пересечение по корню достаточно).
          const normalize = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
          const userNorm = ' ' + normalize(userMessage) + ' ';
          const matchedCats = preferredCategories.filter((cat) => {
            const tokens = normalize(cat).split(' ').filter((t) => t.length >= 4);
            return tokens.some((t) => userNorm.includes(' ' + t.slice(0, Math.min(t.length, 6))));
          });
          const effectiveCategories = matchedCats.length ? matchedCats : preferredCategories;
          if (matchedCats.length) {
            console.log(`[Chat req=${reqId}] Cross-sell narrowed to user-picked categories: ${JSON.stringify(matchedCats)}`);
          }

          let anchorsFull: RelatedAnchor[] = [];
          try {
            const parsedAnchors = JSON.parse(crossSellSlot.anchors || '[]');
            if (Array.isArray(parsedAnchors)) {
              anchorsFull = parsedAnchors
                .filter((a: any) => a && Number.isFinite(a.id))
                .map((a: any) => ({
                  id: a.id,
                  price: typeof a.price === 'number' ? a.price : undefined,
                  category: a.category || undefined,
                  options: Array.isArray(a.options) ? a.options : undefined,
                }));
            }
          } catch { /* malformed → degrade to id-only */ }

          const relatedProducts = appSettings.volt220_api_token
            ? await acceptRelatedOffer({
                anchorIds,
                anchors: anchorsFull,
                deps: buildRelatedDeps(appSettings.volt220_api_token, appSettings),
                preferredCategories: effectiveCategories,
                strictCategories: matchedCats.length > 0,
                limit: 6,
              })
            : [];

          // Удаляем слот в любом случае — он одноразовый
          delete dialogSlots['cross_sell_offer'];
          slotsUpdated = true;

          if (relatedProducts.length) {
            const intro = 'Вот что обычно берут к этому:';
            const cards = relatedProducts.slice(0, 6).map((p) => formatProductCardDeterministic(p as unknown as Product)).join('\n\n');
            const content = `${intro}\n\n${cards}`.trim();
            console.log(`[Chat req=${reqId}] Cross-sell ACCEPT → rendered ${relatedProducts.length} related products deterministically`);
            persistSlotsAsync(conversationId, dialogSlots);

            if (!useStreaming) {
              return new Response(JSON.stringify({ content, slot_update: dialogSlots }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              });
            }
            const encoder = new TextEncoder();
            const stream = new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, index: 0 }] })}\n\n`));
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ slot_update: dialogSlots })}\n\n`));
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
              },
            });
            return new Response(stream, {
              headers: { ...corsHeaders, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
            });
          }
          // accept, но /related пуст по якорю — НЕ уходим в общий catalog-search
          // (там рандомные товары не из /related). Отдаём короткое soft-сообщение.
          const softContent = 'К сожалению, по этому товару сопутствующих позиций сейчас нет. Подскажите, что именно ищете — подберу отдельно.';
          console.log(`[Chat req=${reqId}] Cross-sell ACCEPT but /related returned 0 → soft reply (no fallthrough)`);
          persistSlotsAsync(conversationId, dialogSlots);
          if (!useStreaming) {
            return new Response(JSON.stringify({ content: softContent, slot_update: dialogSlots }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          {
            const encoder = new TextEncoder();
            const stream = new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: softContent }, index: 0 }] })}\n\n`));
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ slot_update: dialogSlots })}\n\n`));
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
              },
            });
            return new Response(stream, {
              headers: { ...corsHeaders, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
            });
          }
        } else if (decision === 'decline') {
          // Чистый отказ от cross-sell — короткий нативный ack, БЕЗ нового поиска.
          delete dialogSlots['cross_sell_offer'];
          slotsUpdated = true;
          const ackOptions = [
            'Понял, как скажете. Если что — обращайтесь.',
            'Хорошо, не настаиваю. Будут вопросы — пишите.',
            'Ок, не буду перегружать. Обращайтесь, если что.',
            'Принято. Если ещё что-то понадобится — я тут.',
          ];
          const softContent = ackOptions[Math.floor(Math.random() * ackOptions.length)];
          console.log(`[Chat req=${reqId}] Cross-sell DECLINE → soft ack`);
          persistSlotsAsync(conversationId, dialogSlots);
          if (!useStreaming) {
            return new Response(JSON.stringify({ content: softContent, slot_update: dialogSlots }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          {
            const encoder = new TextEncoder();
            const stream = new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: softContent }, index: 0 }] })}\n\n`));
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ slot_update: dialogSlots })}\n\n`));
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
              },
            });
            return new Response(stream, {
              headers: { ...corsHeaders, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
            });
          }
        } else {
          // new_request / unclear → удаляем слот, идём дальше как обычно.
          delete dialogSlots['cross_sell_offer'];
          slotsUpdated = true;
        }
      } else {
        delete dialogSlots['cross_sell_offer'];
        slotsUpdated = true;
      }
    }

    // === PENDING OFFER RESOLVER (V1) ===
    // Если на прошлом ходу бот предложил cross-sell и мы сохранили pending_offer slot —
    // спрашиваем у LLM, является ли текущее сообщение согласием с этим предложением.
    // На "accept" подменяем userMessage на offer_query и идём через обычный pipeline.
    // На "new_request"/"unclear" — слот удаляем (предложение неактуально), pipeline без изменений.
    const pendingOfferSlot = dialogSlots['pending_offer'];
    if (pendingOfferSlot && pendingOfferSlot.offer_query) {
      const decision = await classifyOfferResponse({
        offerText: pendingOfferSlot.offer_text || '',
        offerQuery: pendingOfferSlot.offer_query,
        userMessage,
        settings: appSettings,
      });
      console.log(`[Chat req=${reqId}] Pending offer decision: ${decision} (offer_query="${pendingOfferSlot.offer_query}", user="${userMessage.slice(0, 60)}")`);
      if (decision === 'accept') {
        const newQuery = pendingOfferSlot.offer_query;
        userMessage = newQuery;
        // Подменяем последнее user-сообщение, чтобы classifier и весь pipeline увидели новый запрос
        if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
          messages = [...messages.slice(0, -1), { role: 'user', content: newQuery }];
        }
        console.log(`[Chat req=${reqId}] Pending offer ACCEPTED → userMessage rewritten to "${newQuery}"`);
      }
      // В любом случае удаляем slot — он одноразовый
      delete dialogSlots['pending_offer'];
      slotsUpdated = true;
    }


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
    // QueryFirstV2 honest-empty context: when final filtered search returns 0,
    // we DO NOT silently show the broader pool (which mixes irrelevant products).
    // Instead, we clear results and pass this context into Soft-404 so the LLM
    // can craft an honest answer: "не нашёл <noun> с <facets>, что важнее?".
    // Each entry: { caption: human-readable facet name, value: requested value,
    // alternativeValues: other values available in pool for that facet }.
    let qfv2HonestEmptyContext: {
      noun: string;
      originalQuery: string;
      attemptedFacets: Array<{ caption: string; value: string; alternativeValues: string[] }>;
    } | null = null;
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
    // Price-Facet-Clarify state (V1 bootstrap-facets clarify) — поднято на верхний scope,
    // чтобы deterministic short-circuit ниже мог построить корректное сообщение.
    let pendingClarifyFacet: BootstrapFacet | null = null;
    let pendingClarifyIntent: 'most_expensive' | 'cheapest' | null = null;

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
        responseModel = 'anthropic/claude-sonnet-4.5'; // 2026-05-02: Gemini Flash галлюцинировал ссылки на товары — Claude строго цитирует переданный список
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
          responseModel = 'anthropic/claude-sonnet-4.5'; // 2026-05-02: Gemini Flash галлюцинировал ссылки на товары — Claude строго цитирует переданный список
          responseModelReason = 'siteid-shortcircuit';
          console.log(`[Chat] SiteId-fallback SUCCESS: found ${foundProducts.length} product(s), skipping LLM 1`);
        } else {
          console.log(`[Chat] Article-first + SiteId: no results, falling back to normal pipeline`);
        }
     }
    }

    // === TITLE-FIRST SHORT-CIRCUIT via Micro-LLM classifier ===
    // AI determines if message contains a product name and/or price intent

    let effectivePriceIntent: 'most_expensive' | 'cheapest' | undefined = undefined;
    let effectiveCategory = '';
    let classification: any = null;
    
    if (!articleShortCircuit && appSettings.volt220_api_token) {
      const classifyStart = Date.now();
      try {
        const recentHistoryForClassifier = historyForContext.slice(-4).map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }));
        classification = await classifyProductName(userMessage, recentHistoryForClassifier, appSettings);
        const classifyElapsed = Date.now() - classifyStart;
        console.log(`[Chat] Micro-LLM classify: ${classifyElapsed}ms → intent=${classification?.intent || 'none'}, sub_intent=${classification?.sub_intent || 'none'}, has_product_name=${classification?.has_product_name}, name="${classification?.product_name || ''}", price_intent=${classification?.price_intent || 'none'}, category="${classification?.product_category || ''}", is_replacement=${classification?.is_replacement || false}`);
        logSetClassifier(classification ?? null);
        const __classifyDiag = getLastClassifyDiagnostics();
        logAddStep({
          step: 'classify',
          ms: classifyElapsed,
          meta: {
            intent: classification?.intent,
            sub_intent: classification?.sub_intent,
            has_product_name: classification?.has_product_name,
            price_intent: classification?.price_intent,
            category: classification?.product_category,
            product_name: classification?.product_name,
            critical_modifiers: classification?.critical_modifiers,
            search_modifiers: classification?.search_modifiers,
            is_replacement: classification?.is_replacement,
            // Diagnostics: всё про сам HTTP-вызов и парсинг — видно root-cause при null/деградации
            classifier_null: classification === null,
            diag: __classifyDiag,
          },
        });

        // === NAME-FIRST FAST-PATH (single block, two API steps) ===
        // Один short-circuit перед всем pipeline. Две ступени по эскалации точности:
        //   STEP 1: ?pagetitle=<candidate>  — точное совпадение названия (символ-в-символ).
        //           Безопасно для critical_modifiers — это exact match, не fuzzy.
        //   STEP 2: ?query=<candidate>       — fuzzy. ПРОПУСКАЕМ при critical_modifiers,
        //           иначе вернём шумный список без учёта характеристик (Pass 2 нужен).
        // Триггер: has_product_name=true ИЛИ запрос «выглядит как маркировка»
        // (looksLikeProductMarking: цифры + размеры/IP/мм/Вт/буквенно-цифровые сочетания).
        // Skip для replacement intent — там нужны traits оригинала, а не сам товар.
        // Любой ≥1 результат → articleShortCircuit=true, downstream рендерит детерминистично.
        const hasCriticalModifiers = Array.isArray(classification?.critical_modifiers) && classification.critical_modifiers.length > 0;
        if (!articleShortCircuit && !classification?.is_replacement) {
          const candidate = (classification?.product_name || '').trim() || (userMessage || '').trim();
          const trigger =
            (!!classification?.has_product_name && candidate.length >= 6) ||
            looksLikeProductMarking(candidate);

          if (trigger && candidate) {
            const titleSearchCandidates = buildTitleSearchCandidates(candidate);
            // STEP 1: pagetitle (exact)
            try {
              const t0 = Date.now();
              let pagetitleVariantUsed = titleSearchCandidates.exact[0] || candidate;
              let ptResults: Product[] = [];
              for (const exactCandidate of titleSearchCandidates.exact) {
                ptResults = await searchByPagetitle(exactCandidate, appSettings.volt220_api_token, 10);
                pagetitleVariantUsed = exactCandidate;
                if (ptResults.length > 0) break;
              }
              const elapsed = Date.now() - t0;
              if (ptResults.length > 0) {
                foundProducts = ptResults.slice(0, 10);
                articleShortCircuit = true;
                responseModel = 'anthropic/claude-sonnet-4.5';
                responseModelReason = 'pagetitle-shortcircuit';
                console.log(`[Chat] NAME-FIRST step=pagetitle SUCCESS: ${foundProducts.length} products in ${elapsed}ms for "${pagetitleVariantUsed.substring(0, 80)}"`);
                logAddStep({ step: 'pagetitle', total: ptResults.length, ms: elapsed, meta: { candidate: pagetitleVariantUsed.substring(0, 120), variantsTried: titleSearchCandidates.exact.length } });
                logSetBranch('pagetitle');
              } else {
                console.log(`[Chat] NAME-FIRST step=pagetitle: 0 results in ${elapsed}ms for "${candidate.substring(0, 80)}" (variants=${titleSearchCandidates.exact.length})`);
                logAddStep({ step: 'pagetitle', total: 0, ms: elapsed, meta: { candidate: candidate.substring(0, 120), variantsTried: titleSearchCandidates.exact.length } });
              }
            } catch (err) {
              console.error('[Chat] NAME-FIRST step=pagetitle error (silent fallback):', err);
              logAddStep({ step: 'pagetitle', meta: { error: String(err) } });
            }

            // STEP 1B: longtitle — ВРЕМЕННО ОТКЛЮЧЕНО (2026-05-14).
            // Catalog API silently игнорирует `?longtitle=` (verified curl: возвращает
            // полный каталог 21,971 товар независимо от значения). Ветка отдавала
            // случайные товары и нарушала price=0 ban. Включить, когда API заработает.
            // if (!articleShortCircuit) {
            //   try {
            //     const t0 = Date.now();
            //     let longtitleVariantUsed = titleSearchCandidates.exact[0] || candidate;
            //     let ltResults: Product[] = [];
            //     for (const exactCandidate of titleSearchCandidates.exact) {
            //       ltResults = await searchByLongtitle(exactCandidate, appSettings.volt220_api_token, 10);
            //       longtitleVariantUsed = exactCandidate;
            //       if (ltResults.length > 0) break;
            //     }
            //     const elapsed = Date.now() - t0;
            //     if (ltResults.length > 0) {
            //       foundProducts = ltResults.slice(0, 10);
            //       articleShortCircuit = true;
            //       responseModel = 'anthropic/claude-sonnet-4.5';
            //       responseModelReason = 'longtitle-shortcircuit';
            //       console.log(`[Chat] NAME-FIRST step=longtitle SUCCESS: ${foundProducts.length} products in ${elapsed}ms for "${longtitleVariantUsed.substring(0, 80)}"`);
            //       logAddStep({ step: 'longtitle', total: ltResults.length, ms: elapsed, meta: { candidate: longtitleVariantUsed.substring(0, 120), variantsTried: titleSearchCandidates.exact.length } });
            //       logSetBranch('longtitle');
            //     } else {
            //       console.log(`[Chat] NAME-FIRST step=longtitle: 0 results in ${elapsed}ms for "${candidate.substring(0, 80)}" (variants=${titleSearchCandidates.exact.length})`);
            //       logAddStep({ step: 'longtitle', total: 0, ms: elapsed, meta: { candidate: candidate.substring(0, 120), variantsTried: titleSearchCandidates.exact.length } });
            //     }
            //   } catch (err) {
            //     console.error('[Chat] NAME-FIRST step=longtitle error (silent fallback):', err);
            //     logAddStep({ step: 'longtitle', meta: { error: String(err) } });
            //   }
            // }

            // STEP 2: query (fuzzy) — только если pagetitle/longtitle пусты и нет critical_modifiers
            if (!articleShortCircuit && !hasCriticalModifiers) {
              const titleCandidate = extractCandidateTitle(classification) || candidate;
              const queryCandidates = buildTitleSearchCandidates(titleCandidate).query;
              if (titleCandidate.length >= 6) {
                try {
                  const t0 = Date.now();
                  let queryVariantUsed = queryCandidates[0] || titleCandidate;
                  let qResults: Product[] = [];
                  for (const queryCandidate of queryCandidates) {
                    qResults = await searchProductsByCandidate(
                      { query: queryCandidate, brand: null, category: null, min_price: null, max_price: null },
                      appSettings.volt220_api_token,
                      15
                    );
                    queryVariantUsed = queryCandidate;
                    if (qResults.length > 0) break;
                  }
                  const elapsed = Date.now() - t0;
                  if (qResults.length > 0) {
                    foundProducts = qResults.slice(0, 10);
                    articleShortCircuit = true;
                    responseModel = 'anthropic/claude-sonnet-4.5'; // 2026-05-02: Gemini Flash hallucinated URLs
                    responseModelReason = 'title-shortcircuit';
                    console.log(`[Chat] NAME-FIRST step=query SUCCESS: ${foundProducts.length} products in ${elapsed}ms for "${queryVariantUsed}"`);
                    logAddStep({ step: 'name-query', total: qResults.length, ms: elapsed, meta: { candidate: queryVariantUsed.substring(0, 120), variantsTried: queryCandidates.length } });
                    logSetBranch('name-query');
                  } else {
                    console.log(`[Chat] NAME-FIRST step=query: 0 results in ${elapsed}ms for "${titleCandidate}" (variants=${queryCandidates.length})`);
                    logAddStep({ step: 'name-query', total: 0, ms: elapsed, meta: { candidate: titleCandidate.substring(0, 120), variantsTried: queryCandidates.length } });
                  }
                } catch (err) {
                  console.error('[Chat] NAME-FIRST step=query error (silent fallback):', err);
                  logAddStep({ step: 'name-query', meta: { error: String(err) } });
                }
              }
            } else if (!articleShortCircuit && hasCriticalModifiers) {
              console.log(`[Chat] NAME-FIRST step=query SKIPPED: critical_modifiers=[${classification!.critical_modifiers!.join(', ')}] → full catalog pipeline (Pass 2 applies option_filters)`);
              logAddStep({ step: 'name-query', meta: { skipped: 'critical_modifiers', critical_modifiers: classification!.critical_modifiers } });
            }
          }
        }


        if (!articleShortCircuit) {
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
          const emptyResult: CategorySchemaResult = { schema: new Map(), productCount: 0, cacheHit: false, confidence: 'empty', source: 'none' };
          const slotPrebuiltResult: CategorySchemaResult = appSettings.volt220_api_token
            ? await getCategoryOptionsSchema(sp.category, appSettings.volt220_api_token).catch(() => emptyResult)
            : emptyResult;
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
            // [QR] Trace what context the resolver actually used to fetch products,
            // so a wrong-bucket pick can be traced back to chosen_value/pagetitle.
            console.log(`[QR] SEARCH slot="${slotResolution.slotKey}" chosen_label="${dis.chosenLabel}" chosen_value="${dis.chosenValue}" chosen_pagetitle="${dis.chosenPagetitle}" base_category="${dis.baseCategory}" original_query="${dis.originalQuery}" pending_modifiers=${JSON.stringify(dis.pendingModifiers)} pending_filters=${JSON.stringify(dis.pendingFilters)} dis_query="${disQuery}" results=${disProducts.length}`);

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
        // A) Resume price_facet_clarify slot if user reply matches stored facet value.
        // B) Mods present -> straight handlePriceIntent (Scenario C from spec).
        // C) Bootstrap facets from /products?query=<>&per_page=100 + ask one question.
        // pendingClarifyFacet / pendingClarifyIntent объявлены выше (верхний scope).
        if (effectivePriceIntent && appSettings.volt220_api_token) {
          const priceQuery = effectiveCategory || classification?.product_name || '';
          if (priceQuery) {
            const mods: string[] = Array.isArray(classification?.search_modifiers)
              ? classification!.search_modifiers.filter((m: unknown): m is string => typeof m === 'string' && m.trim().length > 0)
              : [];

            let resumedFromClarify = false;
            for (const [slotKey, slot] of Object.entries(dialogSlots)) {
              if (slot.status !== 'pending' || slot.intent !== 'price_facet_clarify' || !slot.price_facet_state || !slot.price_dir) continue;
              try {
                const state = JSON.parse(slot.price_facet_state) as { query: string; facet: BootstrapFacet };
                const matched = matchFacetValueFromReply(userMessage, state.facet);
                if (!matched) continue;
                console.log(`[Chat] PriceFacetClarify resumed: facet=${state.facet.key} value="${matched.value_ru}"`);
                const priceResult = await handlePriceIntent(
                  [state.query],
                  slot.price_dir,
                  appSettings.volt220_api_token!,
                  [[`options[${state.facet.key}][]`, matched.value_ru]],
                );
                if (priceResult.action === 'answer' && priceResult.products && priceResult.products.length > 0) {
                  foundProducts = priceResult.products;
                  articleShortCircuit = true;
                  responseModel = 'anthropic/claude-sonnet-4.5';
                  responseModelReason = 'price-shortcircuit';
                  dialogSlots[slotKey] = { ...slot, status: 'done', refinement: matched.value_ru };
                  slotsUpdated = true;
                  resumedFromClarify = true;
                }
              } catch (e) {
                console.error(`[Chat] PriceFacetClarify resume parse error:`, e);
              }
              break;
            }

            if (!resumedFromClarify) {
              if (mods.length > 0) {
                // Scenario C (rewritten 2026-05-12): мы НЕ клеим mods в ?query=, потому что
                // 220volt full-text по pagetitle не матчит фразы вроде «розетки белые двойные».
                // Делаем тот же путь, что QFv2: probe pool по noun → bootstrap-схема фасетов
                // → resolveFiltersWithLLM → options[<key>][]=<value> → handlePriceIntent.
                // Если probe/resolve ничего не дал — fallback на старое поведение (mods в query),
                // чтобы не регрессировать на сценариях, где schema пустая.
                  const ptrace = (tag: string, payload: Record<string, unknown>) => {
                    try {
                      console.log(`[PriceTrace] ${JSON.stringify({ tag, sid: conversationId, ...payload })}`);
                    } catch (_) { /* ignore */ }
                    try {
                      // Зеркалим в chat_request_logs.steps, чтобы было видно в UI /logs
                      const total = typeof (payload as any).total === 'number'
                        ? (payload as any).total
                        : (typeof (payload as any).poolSize === 'number'
                          ? (payload as any).poolSize
                          : (typeof (payload as any).productsReturned === 'number'
                            ? (payload as any).productsReturned
                            : undefined));
                      const ms = typeof (payload as any).ms === 'number' ? (payload as any).ms : undefined;
                      logAddStep({ step: `price:${tag}`, total, ms, meta: payload });
                    } catch (_) { /* ignore */ }
                  };
                 ptrace('start', {
                   noun: priceQuery,
                   mods,
                   intent: effectivePriceIntent,
                   classifierCategory: classification?.product_category || null,
                   criticalMods: Array.isArray(classification?.critical_modifiers) ? classification!.critical_modifiers : null,
                 });
                 console.log(`[Chat] Price intent with mods: noun="${priceQuery}" mods=${JSON.stringify(mods)}`);
                 let extraParams: Array<[string, string]> = [];
                 // Eager: матчим classifier.product_category против реального каталога,
                 // чтобы финальный price-запрос ушёл с ?category=<pagetitle> вместо
                 // ?query=<noun> — иначе full-text матчит коробки/рамки/крышки, у которых
                 // в описании встречается слово «розетки», и ломает price ASC.
                 let priceCategoryFinal: string | undefined = undefined;
                 try {
                   const catalog = await getCategoriesCache(appSettings.volt220_api_token!);
                   if (catalog.length > 0) {
                     const cls = (classification?.product_category || '').trim();
                     const eager = choosePriceResolve2Category({ classifierCategory: cls, catalog });
                     if (eager) priceCategoryFinal = eager;
                   }
                 } catch (_) { /* silent — упадём в legacy ?query= */ }
                 try {
                   const QF_POOL_SIZE = 100;
                   const tProbe = Date.now();
                   const probePool = await searchProductsByCandidate(
                     { query: priceQuery, brand: null, category: null, min_price: null, max_price: null },
                     appSettings.volt220_api_token!,
                     QF_POOL_SIZE
                   );
                   ptrace('probe', {
                     noun: priceQuery,
                     poolSize: probePool.length,
                     ms: Date.now() - tProbe,
                     sample: probePool.slice(0, 3).map((p: any) => ({
                       title: p?.pagetitle,
                       price: p?.price,
                       optsKeys: Array.isArray(p?.options) ? p.options.map((o: any) => o?.key).slice(0, 8) : [],
                     })),
                   });
                   console.log(`[Chat] [PriceProbe] noun="${priceQuery}" pool=${probePool.length} priceCategory=${priceCategoryFinal || 'none'}`);
                  if (probePool.length > 0 && appSettings.openrouter_api_key) {
                    const bootstrapSchema = new Map<string, { caption: string; values: Set<string> }>();
                    for (const p of probePool) {
                      const opts = (p as any).options;
                      if (!Array.isArray(opts)) continue;
                      for (const opt of opts) {
                        if (!opt || typeof opt !== 'object') continue;
                        const key = typeof opt.key === 'string' ? opt.key.trim() : '';
                        if (!key || isExcludedOption(key)) continue;
                        const caption =
                          (typeof opt.caption === 'string' && opt.caption) ||
                          (typeof opt.caption_ru === 'string' && opt.caption_ru) ||
                          (typeof opt.caption_kz === 'string' && opt.caption_kz) ||
                          key;
                        const value =
                          (typeof opt.value === 'string' && opt.value) ||
                          (typeof opt.value_ru === 'string' && opt.value_ru) ||
                          (typeof opt.value_kz === 'string' && opt.value_kz) ||
                          '';
                        const trimmedValue = value.trim();
                        if (!trimmedValue) continue;
                        let bucket = bootstrapSchema.get(key);
                        if (!bucket) {
                          bucket = { caption: String(caption), values: new Set<string>() };
                          bootstrapSchema.set(key, bucket);
                        }
                        bucket.values.add(trimmedValue);
                      }
                    }
                    ptrace('bootstrap_schema', {
                       keys: bootstrapSchema.size,
                       sample: Array.from(bootstrapSchema.entries()).slice(0, 8).map(([k, v]) => ({
                         key: k,
                         caption: v.caption,
                         valuesCount: v.values.size,
                         values: Array.from(v.values).slice(0, 5),
                       })),
                     });
                     console.log(`[Chat] [PriceProbe] bootstrap schema: ${bootstrapSchema.size} keys`);
                     if (bootstrapSchema.size > 0) {
                       try {
                         const criticalMods = Array.isArray(classification?.critical_modifiers)
                           ? classification!.critical_modifiers as string[]
                           : undefined;
                         const tR1 = Date.now();
                         const { resolved: rRaw, unresolved: rUnresolved, unresolvedDetails: rDetails } = await resolveFiltersWithLLM(
                           probePool,
                           mods,
                           appSettings,
                           criticalMods,
                           bootstrapSchema,
                           'full',
                           priceQuery
                         );
                         const resolvedFilters = flattenResolvedFilters(rRaw);
                         ptrace('resolve1', {
                           input: mods,
                           schemaKeys: bootstrapSchema.size,
                           resolved: resolvedFilters,
                           unresolved: rUnresolved || [],
                           ms: Date.now() - tR1,
                         });
                         console.log(`[Chat] [PriceResolve] resolved=${JSON.stringify(resolvedFilters)} unresolved=[${(rUnresolved || []).join(', ')}] unresolvedDetails=${(rDetails || []).length}`);

                         // ── Этап 2 (2026-05-12): если первый проход оставил unresolved
                         // модификаторы — bootstrap-схема pool'а слишком узкая (например,
                         // в pool «розетки» попали в основном крышки/подрозетники, и ключ
                         // "kolichestvo_mest" со значениями 1/2/3/4 в schema отсутствует).
                         // Делаем второй заход: matcher → real category pagetitle →
                         // getCategoryOptionsSchema (full /categories/options) → resolve
                         // только нерезолвенных модификаторов на широкой схеме → merge.
                         if (rUnresolved && rUnresolved.length > 0) {
                           try {
                             const t2 = Date.now();
                             const catalog = await getCategoriesCache(appSettings.volt220_api_token!);
                             if (catalog.length > 0) {
                               const classifierCategoryRaw = (classification?.product_category || '').trim();
                               let catTitle = '';
                               let matcherMatches: string[] = [];
                               let categorySource: string = 'none';

                               if (!choosePriceResolve2Category({ classifierCategory: classifierCategoryRaw, catalog })) {
                                 matcherMatches = await matchCategoriesWithLLM(priceQuery, catalog, appSettings);
                               }

                               catTitle = choosePriceResolve2Category({
                                 classifierCategory: classifierCategoryRaw,
                                 catalog,
                                 matcherMatches,
                               });

                               if (catTitle && classifierCategoryRaw && catTitle === classifierCategoryRaw) {
                                 categorySource = 'classifier_exact';
                                 console.log(`[Chat] [PriceResolve2] classifier category exact match="${catTitle}"`);
                               } else if (catTitle && classifierCategoryRaw && catTitle === toPluralCategory(classifierCategoryRaw)) {
                                 categorySource = 'classifier_plural';
                                 console.log(`[Chat] [PriceResolve2] classifier category plural match="${catTitle}" (from "${classifierCategoryRaw}")`);
                               } else if (catTitle) {
                                 categorySource = 'matcher_first';
                               }

                               ptrace('resolve2_category', {
                                 unresolvedIn: rUnresolved,
                                 classifierCategory: classifierCategoryRaw,
                                 matcherMatches: matcherMatches.slice(0, 5),
                                 chosen: catTitle || null,
                                 source: categorySource,
                               });

                               if (catTitle) {
                                 console.log(`[Chat] [PriceResolve2] matched category="${catTitle}" for noun="${priceQuery}"`);
                                 const tWide = Date.now();
                                 const wideProducts = await searchProductsByCandidate(
                                   { query: null, brand: null, category: catTitle, min_price: 1, max_price: null },
                                   appSettings.volt220_api_token!,
                                   200
                                 );
                                 const wideSchema = extractSchemaFromProducts(wideProducts);
                                 const newKeys = Array.from(wideSchema.keys()).filter(k => !bootstrapSchema.has(k));
                                 ptrace('resolve2_schema', {
                                   wideKeys: wideSchema.size,
                                   wideProducts: wideProducts.length,
                                   newKeysVsPool: newKeys.length,
                                   newKeysSample: newKeys.slice(0, 10),
                                   ms: Date.now() - tWide,
                                 });
                                 if (wideSchema.size > 0) {
                                   console.log(`[Chat] [PriceResolve2] wide schema: ${wideSchema.size} keys (source=category-products-sample, products=${wideProducts.length})`);
                                   const tR2 = Date.now();
                                   const { resolved: r2Raw, unresolved: r2Unresolved } = await resolveFiltersWithLLM(
                                     probePool,
                                     rUnresolved,
                                     appSettings,
                                     criticalMods,
                                     wideSchema,
                                     'partial',
                                     priceQuery
                                   );
                                   const resolved2 = flattenResolvedFilters(r2Raw);
                                   ptrace('resolve2', {
                                     input: rUnresolved,
                                     schemaKeys: wideSchema.size,
                                     resolved: resolved2,
                                     unresolved: r2Unresolved || [],
                                     ms: Date.now() - tR2,
                                   });
                                   console.log(`[Chat] [PriceResolve2] resolved=${JSON.stringify(resolved2)} unresolved=[${(r2Unresolved || []).join(', ')}] elapsed=${Date.now() - t2}ms`);
                                   for (const [k, v] of Object.entries(resolved2)) {
                                     if (!resolvedFilters[k]) resolvedFilters[k] = v;
                                   }
                                 } else {
                                   console.log(`[Chat] [PriceResolve2] wide schema empty for "${catTitle}"`);
                                 }
                               } else {
                                 console.log(`[Chat] [PriceResolve2] no category match for noun="${priceQuery}"`);
                               }
                             } else {
                               ptrace('resolve2_category', { error: 'empty_catalog' });
                             }
                           } catch (e2) {
                             ptrace('resolve2_error', { message: (e2 as Error).message });
                             console.log(`[Chat] [PriceResolve2] error=${(e2 as Error).message} → continuing with first-pass filters only`);
                           }
                         }

                         for (const [k, v] of Object.entries(resolvedFilters)) {
                           extraParams.push([`options[${k}][]`, String(v)]);
                         }
                       } catch (rErr) {
                         ptrace('resolve_error', { message: (rErr as Error).message });
                         console.log(`[Chat] [PriceResolve] error=${(rErr as Error).message} → continuing without options[]`);
                       }
                     } else {
                       ptrace('bootstrap_empty', {});
                     }
                   }
                 } catch (probeErr) {
                   ptrace('probe_error', { message: (probeErr as Error).message });
                   console.log(`[Chat] [PriceProbe] error=${(probeErr as Error).message}`);
                 }

                 // Если есть подтверждённая категория каталога — финальный запрос идёт
                 // ?category=<pagetitle>+options[..]+min_price=1, БЕЗ полнотекстового ?query=.
                 // mods клеим в query ТОЛЬКО как fallback, когда ни category, ни extraParams нет.
                 const priceQueryFinal = (priceCategoryFinal || extraParams.length > 0)
                   ? priceQuery
                   : `${priceQuery} ${mods.join(' ')}`.trim();
                 ptrace('final', {
                   query: priceQueryFinal,
                   category: priceCategoryFinal || null,
                   extraParams,
                   modsInQuery: !priceCategoryFinal && extraParams.length === 0,
                 });
                 console.log(`[Chat] Price final: query="${priceQueryFinal}" category="${priceCategoryFinal || ''}" extraParams=${extraParams.length}`);
                const priceResult = await handlePriceIntent(
                  [priceQueryFinal],
                  effectivePriceIntent,
                  appSettings.volt220_api_token!,
                  extraParams.length > 0 ? extraParams : undefined,
                  priceCategoryFinal,
                );
                if (priceResult.action === 'answer' && priceResult.products && priceResult.products.length > 0) {
                  foundProducts = priceResult.products;
                  articleShortCircuit = true;
                  responseModel = 'anthropic/claude-sonnet-4.5';
                  responseModelReason = 'price-shortcircuit';
                  logSetBranch('price-shortcircuit');
                }
                ptrace('result', {
                  action: priceResult.action,
                  productsReturned: priceResult.products?.length || 0,
                  total: (priceResult as any).total ?? null,
                  topPrices: (priceResult.products || []).slice(0, 5).map((p: any) => p?.price),
                });
              } else {
                // Scenario A/B: характеристик нет — bootstrap-фасеты + один уточняющий вопрос.
                console.log(`[Chat] Price intent NO mods → bootstrap facet probe for "${priceQuery}"`);
                const probe = await probeFacetsForPriceQuery(priceQuery, appSettings.volt220_api_token!);
                if (probe && probe.products.length > 0) {
                  const facet = pickClarifyFacet(probe.facets);
                  if (facet) {
                    pendingClarifyFacet = facet;
                    pendingClarifyIntent = effectivePriceIntent;
                    // top-3 cheapest для карточек: products уже отсортированы ASC сервером (min_price=1).
                    const topProducts = effectivePriceIntent === 'most_expensive'
                      ? [...probe.products].reverse().slice(0, 3)
                      : probe.products.slice(0, 3);
                    foundProducts = topProducts;
                    articleShortCircuit = true;
                    responseModel = 'anthropic/claude-sonnet-4.5';
                    responseModelReason = 'price-facet-clarify';
                    // Сохраняем слот: следующее сообщение пользователя будет матчиться против facet.values.
                    const slotKey = `pfc_${Date.now()}`;
                    dialogSlots[slotKey] = {
                      intent: 'price_facet_clarify',
                      base_category: priceQuery,
                      price_dir: effectivePriceIntent,
                      price_facet_state: JSON.stringify({ query: priceQuery, facet }),
                      status: 'pending',
                      created_turn: messages.length,
                      turns_since_touched: 0,
                    };
                    slotsUpdated = true;
                    console.log(`[Chat] PriceFacetClarify created slot=${slotKey} facet=${facet.key} values=${facet.values.length}`);
                  } else {
                    // Нет фасета с ≥2 значениями — отдаём 10 карточек без вопроса.
                    const priceResult = await handlePriceIntent([priceQuery], effectivePriceIntent, appSettings.volt220_api_token!);
                    if (priceResult.action === 'answer' && priceResult.products && priceResult.products.length > 0) {
                      foundProducts = priceResult.products;
                      articleShortCircuit = true;
                      responseModel = 'anthropic/claude-sonnet-4.5';
                      responseModelReason = 'price-shortcircuit';
                    }
                  }
                } else {
                  // probe не дал товаров — fallback на прямой handlePriceIntent.
                  const priceResult = await handlePriceIntent([priceQuery], effectivePriceIntent, appSettings.volt220_api_token!);
                  if (priceResult.action === 'answer' && priceResult.products && priceResult.products.length > 0) {
                    foundProducts = priceResult.products;
                    articleShortCircuit = true;
                    responseModel = 'anthropic/claude-sonnet-4.5';
                    responseModelReason = 'price-shortcircuit';
                  }
                }
              }
            }
          }
        }

        // The legacy duplicate block was removed; if the fast-path returned 0,
        // we don't repeat the identical ?query= call here.
        if (classification?.is_replacement && classification?.has_product_name && classification?.product_name) {
          console.log(`[Chat] Title-first SKIPPED: is_replacement=true, deferring to replacement-pipeline (characteristics-first)`);
        }
        
        // === CATEGORY-FIRST (category without specific product name) ===
        // 2026-05-04 (systemic fix for "has_product_name=true bypass"):
        //   When the classifier flags has_product_name=true (e.g. "Кабель ВВГнг 3х2.5"),
        //   the title-first FAST-PATH (?pagetitle/?article/?query=full_name) runs first.
        //   If ALL of those return 0 (articleShortCircuit stays false), we previously
        //   had no bridge into QFv2 — pipeline went straight to broad query → 0 →
        //   jargon-fallback (which proposes ALTERNATIVE terms, not facet decomposition).
        //   Result: technical markings like "ВВГнг" (stored as "ВВГ нг" in catalog) never
        //   triggered Self-Bootstrap Facets even though product_category was correctly
        //   identified ("кабель"). Fix: enter CATEGORY-FIRST + QFv2 when has_product_name=true
        //   AND we still have no products AND there is a product_category to use as noun.
        //   Inside the block we synthesise modifiers from product_name tokens when classifier
        //   left search_modifiers=[] (which it does per spec when has_product_name=true).
        if (!articleShortCircuit && effectiveCategory && !classification?.is_replacement && !effectivePriceIntent && appSettings.volt220_api_token) {
          let modifiers = classification?.search_modifiers || [];
          // Synthetic modifiers from product_name when classifier left them empty
          // (data-agnostic tokeniser: split on whitespace/hyphens + letter↔digit + cyrillic↔latin
          // boundaries, then drop the base category noun). Pure pre-LLM normalisation;
          // the Facet Matcher still maps tokens → real options from bootstrap schema.
          if (
            modifiers.length === 0 &&
            classification?.has_product_name &&
            typeof classification?.product_name === 'string' &&
            classification.product_name.trim().length > 0
          ) {
            const rawName = classification.product_name.trim();
            const categoryLower = (classification?.product_category || '').trim().toLowerCase();
            const synthesised: string[] = [];
            const seen = new Set<string>();
            // Step 1: split on whitespace, hyphens, slashes, parentheses, commas.
            const chunks = rawName.split(/[\s,()/\\-]+/).filter(Boolean);
            for (const chunk of chunks) {
              // Pre-check: монолитная alphanumeric-маркировка (≤ 8 символов, и буквы и цифры)
              // GX53, E27, T75, IP44, BA15s, MR16, R7s, 7Вт, 9Вт, 12В, 220В, 16А — НЕ режем.
              const hasLetter = /[а-яА-ЯёЁa-zA-Z]/.test(chunk);
              const hasDigit = /\d/.test(chunk);
              if (chunk.length <= 8 && hasLetter && hasDigit) {
                subTokens_label_skip: {
                  const tLower = chunk.toLowerCase();
                  if (tLower === categoryLower) break subTokens_label_skip;
                  if (seen.has(tLower)) break subTokens_label_skip;
                  seen.add(tLower);
                  synthesised.push(chunk);
                }
                continue;
              }
              // Step 2: split each chunk on script/script-class boundaries:
              //   letter↔digit (ВВГнг3 → ВВГнг, 3), cyrillic↔latin (LSPVS → LS, PVS only if mixed).
              //   Common separators inside numeric specs: × * х . , (treated as token break too).
              //   ВНИМАНИЕ: латинская x/X из multiplier-split исключена — иначе ломает GX53, MR16x.
              const subTokens = chunk
                .replace(/([а-яА-ЯёЁ])([a-zA-Z])/g, '$1 $2')
                .replace(/([a-zA-Z])([а-яА-ЯёЁ])/g, '$1 $2')
                .replace(/([а-яА-ЯёЁa-zA-Z])(\d)/g, '$1 $2')
                .replace(/(\d)([а-яА-ЯёЁa-zA-Z])/g, '$1 $2')
                .split(/[×*хХ]/)
                .flatMap((t: string) => t.split(/\s+/))
                .map((t: string) => t.trim())
                .filter(Boolean);
              for (const tok of subTokens) {
                const tLower = tok.toLowerCase();
                if (tLower === categoryLower) continue;       // drop base noun ("кабель")
                if (seen.has(tLower)) continue;
                seen.add(tLower);
                synthesised.push(tok);
              }
            }
            if (synthesised.length > 0) {
              modifiers = synthesised;
              console.log(`[Chat] Synthesised modifiers from product_name="${rawName}": [${modifiers.join(', ')}] (has_product_name=true bridge)`);
              logAddStep({ step: 'qfv2-bridge', meta: { product_name: rawName.substring(0, 120), synthesised_modifiers: synthesised.slice(0, 20) } });
            }
          }
          console.log(`[Chat] Category-first: category="${effectiveCategory}", modifiers=[${modifiers.join(', ')}], hasProductName=${!!classification?.has_product_name}`);
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
          // ═══════════════════════════════════════════════════════════════════
          // QUERY-FIRST v2 — Direct facet pipeline (no Category Resolver).
          // ───────────────────────────────────────────────────────────────────
          // Architectural decision (2026-04-30, mem://constraints/disambiguation-disabled):
          //   The bot must NEVER self-narrow the funnel by guessing a category.
          //   Instead: trust ?query=<noun>, build facet schema from the live pool
          //   (Self-Bootstrap §4.10.1), let the LLM map modifiers→options against
          //   that schema, then re-query with ?query=<noun>&options[...]= ...
          //   WITHOUT ?category=. The catalog API filters; we never pick a
          //   category on the user's behalf.
          //
          // Flow when query_first_enabled = true:
          //   1) extractCategoryNoun(userMessage)                        → noun
          //   2) /products?query=noun&perPage=100                        → pool
          //   3) extractFacetSchemaFromPool(pool)                        → schema
          //   4) resolveFiltersWithLLM(pool, modifiers, schema)          → options
          //   5) /products?query=noun&options[<k>][]=<v>&perPage=30      → final
          //   6a) final.length > 0 → display final, articleShortCircuit=true
          //   6b) final.length = 0 → Soft Fallback: display pool + droppedFacet
          //   ANY throw / pool=0 → silent fallback to legacy Category Resolver
          //
          // What is removed vs old behaviour:
          //   ✗ qfMatchesOverride (categories ranked by frequency in pool)
          //   ✗ ?category= in any /products call from this branch
          //   ✗ /categories/options HTTP roundtrip (timeouts source)
          //   ✗ Domain Guard / allowedCategoryTitles (no category to guard)
          //
          // Metrics (logs):
          //   query_first_v2_win, query_first_v2_soft_fallback,
          //   query_first_v2_pool_empty, query_first_v2_error
          // ═══════════════════════════════════════════════════════════════════
          let qfV2Resolved = false;        // true → skip the legacy matcher block entirely
          let qfV2DroppedFacetCaption: string | null = null;

          if (appSettings.query_first_enabled && appSettings.openrouter_api_key && appSettings.volt220_api_token) {
            const qfStart = Date.now();
            try {
              const { extractCategoryNoun, createProductionExtractorDeps } = await import("../_shared/category-noun-extractor.ts");
              const extractorDeps = createProductionExtractorDeps(appSettings.openrouter_api_key);
              const extractDeadline = new Promise<{ categoryNoun: string }>((_, rej) =>
                setTimeout(() => rej(new Error('qf_extract_timeout_8s')), 8000)
              );
              const nounStartMs = Date.now();
              const extractRes = await Promise.race([
                extractCategoryNoun({ userQuery: userMessage, locale: 'ru' }, extractorDeps),
                extractDeadline,
              ]);
              const noun = (extractRes.categoryNoun || '').trim();
              console.log(`[QueryFirstV2] noun="${noun}" (source=${(extractRes as any).source || 'n/a'})`);
              logAddStep({ step: 'qfv2-noun', ms: Date.now() - nounStartMs, meta: { noun, source: (extractRes as any).source || null } });

              if (noun.length === 0) {
                console.log(`[QueryFirstV2] empty noun → fallback to Category Resolver`);
              } else {
                // ── (2) Pool: ?query=noun [+ critical_modifiers], perPage=100.
                // 2026-05-05: pool query enriched with up to 3 critical modifiers so that
                // the catalog's poiskovyy_zapros + full-text matching does the heavy
                // lifting (e.g. "лампа для школьника" → НТО-12, "розетка чёрная двухместная"
                // → narrowed pool). FilterLLM then only cleans residual noise via options[].
                // Fallback: if enriched query returns 0, retry with bare noun (no regression
                // vs prior behavior). Cap = 3 modifiers to avoid over-long queries that
                // the catalog full-text degrades on.
                const QF_POOL_SIZE = 100;
                const QF_MAX_MODIFIERS_IN_QUERY = 3;
                const enrichMods = (classification?.critical_modifiers && classification.critical_modifiers.length > 0
                  ? classification.critical_modifiers
                  : modifiers).slice(0, QF_MAX_MODIFIERS_IN_QUERY);
                const enrichedQuery = enrichMods.length > 0 ? `${noun} ${enrichMods.join(' ')}`.trim() : noun;

                const poolStartMs = Date.now();
                let pool = await searchProductsByCandidate(
                  { query: enrichedQuery, brand: null, category: null, min_price: null, max_price: null },
                  appSettings.volt220_api_token!,
                  QF_POOL_SIZE
                );
                console.log(`[QueryFirstV2] pool query="${enrichedQuery}" size=${pool.length} (perPage=${QF_POOL_SIZE})`);
                logAddStep({ step: 'qfv2-pool', total: pool.length, ms: Date.now() - poolStartMs, meta: { query: enrichedQuery.substring(0, 200), perPage: QF_POOL_SIZE, enrichMods: enrichMods.slice(0, 5) } });

                if (pool.length === 0 && enrichedQuery !== noun) {
                  console.log(`[QueryFirstV2] enriched pool=0 → retry with bare noun="${noun}"`);
                  const poolRetryStart = Date.now();
                  pool = await searchProductsByCandidate(
                    { query: noun, brand: null, category: null, min_price: null, max_price: null },
                    appSettings.volt220_api_token!,
                    QF_POOL_SIZE
                  );
                  console.log(`[QueryFirstV2] pool noun="${noun}" size=${pool.length} (fallback)`);
                  logAddStep({ step: 'qfv2-pool-retry', total: pool.length, ms: Date.now() - poolRetryStart, meta: { query: noun, fallback: true } });
                }

                if (pool.length === 0) {
                  console.log(`[QueryFirstV2] query_first_v2_pool_empty noun="${noun}" → fallback to Category Resolver`);
                  logAddStep({ step: 'qfv2-pool-empty', total: 0, meta: { noun } });
                } else {
                  // ── (3) Self-Bootstrap facet schema from the live pool.
                  // Format = exact V1 contract: Map<key, {caption, values: Set<string>}>.
                  // No /categories/options HTTP call. No category assumption.
                  const bootstrapSchema = new Map<string, { caption: string; values: Set<string> }>();
                  for (const p of pool) {
                    const opts = (p as any).options;
                    if (!Array.isArray(opts)) continue;
                    for (const opt of opts) {
                      if (!opt || typeof opt !== 'object') continue;
                      const key = typeof opt.key === 'string' ? opt.key.trim() : '';
                      if (!key || isExcludedOption(key)) continue;
                      const caption =
                        (typeof opt.caption === 'string' && opt.caption) ||
                        (typeof opt.caption_ru === 'string' && opt.caption_ru) ||
                        (typeof opt.caption_kz === 'string' && opt.caption_kz) ||
                        key;
                      const value =
                        (typeof opt.value === 'string' && opt.value) ||
                        (typeof opt.value_ru === 'string' && opt.value_ru) ||
                        (typeof opt.value_kz === 'string' && opt.value_kz) ||
                        '';
                      const trimmedValue = value.trim();
                      if (!trimmedValue) continue;
                      let bucket = bootstrapSchema.get(key);
                      if (!bucket) {
                        bucket = { caption: String(caption), values: new Set<string>() };
                        bootstrapSchema.set(key, bucket);
                      }
                      bucket.values.add(trimmedValue);
                    }
                  }
                  console.log(`[QueryFirstV2] bootstrap schema: ${bootstrapSchema.size} keys, ${Array.from(bootstrapSchema.values()).reduce((s, b) => s + b.values.size, 0)} values (source=bootstrap)`);
                  logAddStep({
                    step: 'qfv2-bootstrap',
                    meta: {
                      keys: bootstrapSchema.size,
                      values_total: Array.from(bootstrapSchema.values()).reduce((s, b) => s + b.values.size, 0),
                      sample: Array.from(bootstrapSchema.entries()).slice(0, 8).map(([k, v]) => ({ key: k, caption: v.caption, values: Array.from(v.values).slice(0, 5) })),
                    },
                  });

                  // ── (4) Resolve modifiers → option filters against the live schema.
                  // If no modifiers: skip resolution, just display pool.
                  let resolvedFilters: Record<string, string> = {};
                  let resolverUnresolvedDetails: Array<{ modifier: string; key: string; caption: string; requestedValue: string; availableValues: string[] }> = [];
                  let resolverUnresolved: string[] = [];
                  if (modifiers.length > 0 && bootstrapSchema.size > 0) {
                    const filterStartMs = Date.now();
                    try {
                      const { resolved: rRaw, unresolved: rUnresolved, unresolvedDetails: rDetails } = await resolveFiltersWithLLM(
                        pool,
                        modifiers,
                        appSettings,
                        classification?.critical_modifiers,
                        bootstrapSchema,
                        'full',
                        noun
                      );
                      resolvedFilters = flattenResolvedFilters(rRaw);
                      resolverUnresolvedDetails = rDetails || [];
                      resolverUnresolved = rUnresolved || [];
                      console.log(`[QueryFirstV2] resolved=${JSON.stringify(resolvedFilters)} unresolved=[${rUnresolved.join(', ')}] unresolvedDetails=${resolverUnresolvedDetails.length}`);
                      logAddStep({
                        step: 'qfv2-filter-llm',
                        ms: Date.now() - filterStartMs,
                        meta: {
                          modifiers,
                          resolved: resolvedFilters,
                          unresolved: rUnresolved,
                          unresolvedDetails: resolverUnresolvedDetails.map(d => ({ modifier: d.modifier, key: d.key, caption: d.caption, requestedValue: d.requestedValue, availableValues: d.availableValues.slice(0, 8) })),
                        },
                      });
                    } catch (rErr) {
                      console.log(`[QueryFirstV2] resolveFilters error=${(rErr as Error).message} → continuing with empty filters`);
                      logAddStep({ step: 'qfv2-filter-llm', ms: Date.now() - filterStartMs, meta: { error: String((rErr as Error).message), modifiers } });
                    }
                  } else if (modifiers.length === 0) {
                    console.log(`[QueryFirstV2] no modifiers → display pool directly`);
                    logAddStep({ step: 'qfv2-filter-llm', meta: { skipped: 'no_modifiers' } });
                  }

                  // ── (4.5) ESCALATION: bootstrap из pool — это топ-100 товаров по релевантности
                  // запроса. Если модификатор относится к длинному хвосту категории (нишевая
                  // коллекция/бренд/редкий цвет), его value НЕ попадает в bootstrap-схему →
                  // FilterLLM честно возвращает unresolved (ему просто не из чего матчить).
                  //
                  // Системный fallback: подтянуть ПОЛНУЮ схему фасетов категории через
                  // /api/categories/options (это и есть «работа через категории», которую
                  // QFv2 обходил ради скорости). Категория = доминирующая category.pagetitle
                  // pool'а (без отдельного Category Resolver — у нас уже есть подтверждение
                  // через 100 живых товаров). Cache 30 мин в getCategoryOptionsSchema.
                  //
                  // Срабатывает ТОЛЬКО при unresolved.length > 0 — для популярных модификаторов
                  // («двухместная», «белая») путь остаётся прежний. Любая ошибка — silent skip.
                  if (resolverUnresolved.length > 0 && Object.keys(resolvedFilters).length < modifiers.length) {
                    const escStart = Date.now();
                    try {
                      // Доминирующая категория pool'а.
                      const catCounts = new Map<string, number>();
                      for (const p of pool) {
                        const cpt = p.category?.pagetitle?.trim();
                        if (cpt) catCounts.set(cpt, (catCounts.get(cpt) || 0) + 1);
                      }
                      const dominantCat = [...catCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
                      if (!dominantCat) {
                        console.log(`[QueryFirstV2] escalate SKIP: no dominant category in pool`);
                        logAddStep({ step: 'qfv2-escalate-skip', meta: { reason: 'no_dominant_category', unresolved: resolverUnresolved } });
                      } else {
                        const fullRes = await getCategoryOptionsSchema(dominantCat, appSettings.volt220_api_token!);
                        if (!fullRes.schema || fullRes.schema.size === 0) {
                          console.log(`[QueryFirstV2] escalate SKIP: full schema empty for "${dominantCat}"`);
                          logAddStep({ step: 'qfv2-escalate-skip', meta: { reason: 'empty_full_schema', dominantCat, unresolved: resolverUnresolved } });
                        } else {
                          console.log(`[QueryFirstV2] escalate: dominantCat="${dominantCat}" fullSchema=${fullRes.schema.size}keys src=${fullRes.source} → re-resolve unresolved=[${resolverUnresolved.join(', ')}]`);
                          const { resolved: rRaw2, unresolved: rUnresolved2, unresolvedDetails: rDetails2 } = await resolveFiltersWithLLM(
                            pool,
                            resolverUnresolved,
                            appSettings,
                            classification?.critical_modifiers,
                            fullRes.schema,
                            fullRes.confidence || 'full',
                            noun
                          );
                          const escResolved = flattenResolvedFilters(rRaw2);
                          if (Object.keys(escResolved).length > 0) {
                            // Merge: escalated wins over bootstrap (более полный источник).
                            const merged = { ...resolvedFilters, ...escResolved };
                            // Replace bootstrapSchema buckets with full ones for keys we resolved
                            // → buildAttemptedFacets() будет иметь правильные alternativeValues.
                            for (const k of Object.keys(escResolved)) {
                              const fullBucket = fullRes.schema.get(k);
                              if (fullBucket) bootstrapSchema.set(k, fullBucket);
                            }
                            resolvedFilters = merged;
                            // Drop now-resolved modifiers from unresolvedDetails.
                            const stillUnresolved = new Set((rUnresolved2 || []).map(m => m.toLowerCase().trim()));
                            const justResolvedMods = new Set(
                              resolverUnresolved
                                .filter(m => !stillUnresolved.has(m.toLowerCase().trim()))
                                .map(m => m.toLowerCase().trim())
                            );
                            resolverUnresolvedDetails = (rDetails2 || []).concat(
                              resolverUnresolvedDetails.filter(d => !justResolvedMods.has(d.modifier.toLowerCase().trim()))
                            );
                            resolverUnresolved = rUnresolved2 || [];
                            console.log(`[QueryFirstV2] escalate WIN: +${Object.keys(escResolved).length} filters merged=${JSON.stringify(merged)} stillUnresolved=[${resolverUnresolved.join(', ')}] elapsed=${Date.now() - escStart}ms`);
                            logAddStep({ step: 'qfv2-escalate-win', ms: Date.now() - escStart, meta: { dominantCat, src: fullRes.source, escalatedResolved: escResolved, stillUnresolved: resolverUnresolved } });
                          } else {
                            console.log(`[QueryFirstV2] escalate MISS: full schema didn't resolve any modifier (still unresolved=[${(rUnresolved2 || []).join(', ')}])`);
                            logAddStep({ step: 'qfv2-escalate-miss', ms: Date.now() - escStart, meta: { dominantCat, src: fullRes.source, stillUnresolved: rUnresolved2 || [] } });
                          }
                        }
                      }
                    } catch (escErr) {
                      console.log(`[QueryFirstV2] escalate error=${(escErr as Error).message} → silent skip (continue with bootstrap result)`);
                      logAddStep({ step: 'qfv2-escalate-error', ms: Date.now() - escStart, meta: { error: String((escErr as Error).message), unresolved: resolverUnresolved } });
                    }
                  }

                  // ── (5/6) Final search.
                  // (5a) modifiers + at least one resolved option → re-query with options.
                  // (5b) no resolved options → display the pool we already have.
                  // ── Noun stem post-filter (Variant Б, 2026-05-05).
                  // QFv2 pool/final by ?query=noun is fuzzy: API returns related categories
                  // (e.g. "розетка" → frames, supports). To avoid showing off-topic items
                  // we keep only products whose pagetitle/category contains the noun stem.
                  // Fallback: if the filter produces 0, return the original list (don't make
                  // things worse than before). Data-agnostic: stem = lowercase + strip trailing
                  // vowels (works for ru morphology of common nouns).
                  const stripVowel = (s: string) => s.replace(/[аяоеёуюыиэ]+$/iu, '');
                  const nounStem = stripVowel(noun.toLowerCase().trim());
                  const matchesNoun = (p: Product): boolean => {
                    if (!nounStem || nounStem.length < 3) return true;
                    const title = (p.pagetitle || '').toLowerCase();
                    const cat = (p.category?.pagetitle || '').toLowerCase();
                    return title.includes(nounStem) || cat.includes(nounStem);
                  };
                  const applyNounFilter = (list: Product[], strict = false): Product[] => {
                    // RE-ENABLED 2026-05-12: noun-filter дропает товары, у которых нет
                    // стема noun ни в pagetitle, ни в category.pagetitle. Защита от мусора:
                    // ?query=щит возвращает «стабилизаторы» / «счётчики» с IP20=20.
                    // Безопасный fallback: если фильтр оставил 0 — возвращаем исходный список
                    // (не хуже, чем было). strict=true для финального re-query: если 0 —
                    // оставляем 0 (caller ведёт в honest-empty).
                    if (!nounStem || nounStem.length < 3) {
                      console.log(`[QueryFirstV2] noun-filter SKIP (stem too short: "${nounStem}") — passing ${list.length} as-is`);
                      return list;
                    }
                    const filtered = list.filter(matchesNoun);
                    if (filtered.length === 0 && !strict) {
                      console.log(`[QueryFirstV2] noun-filter stem="${nounStem}" → 0 (non-strict fallback to ${list.length} as-is)`);
                      return list;
                    }
                    console.log(`[QueryFirstV2] noun-filter stem="${nounStem}" strict=${strict}: ${list.length} → ${filtered.length}`);
                    return filtered;
                  };
                  let displayList: Product[] = applyNounFilter(pool);
                  let branchTag = 'qfv2_pool_no_modifiers';
                  logSetBranch('qfv2');

                  // Helper: build attemptedFacets array from resolved filters + unresolvedDetails.
                  // Resolved entries take their requested value; unresolved-details entries
                  // surface "value not in catalog" with the original requested value so the LLM
                  // can answer honestly ("7 Вт нет, есть 6, 8, 10").
                  const buildAttemptedFacets = (): Array<{ caption: string; value: string; alternativeValues: string[] }> => {
                    const out: Array<{ caption: string; value: string; alternativeValues: string[] }> = [];
                    const seenKeys = new Set<string>();
                    for (const [fKey, fValue] of Object.entries(resolvedFilters)) {
                      const bucket = bootstrapSchema.get(fKey);
                      const caption = bucket?.caption || fKey;
                      const allValues = bucket ? Array.from(bucket.values) : [];
                      const alternativeValues = allValues.filter(v => v !== fValue).slice(0, 8);
                      out.push({ caption, value: String(fValue), alternativeValues });
                      seenKeys.add(fKey);
                    }
                    for (const d of resolverUnresolvedDetails) {
                      if (seenKeys.has(d.key)) continue;
                      out.push({
                        caption: d.caption,
                        value: d.requestedValue,
                        alternativeValues: d.availableValues.slice(0, 8),
                      });
                    }
                    return out;
                  };

                  if (Object.keys(resolvedFilters).length > 0 || resolverUnresolvedDetails.length > 0) {
                    // PARTIAL-UNRESOLVED HONEST-EMPTY (2026-05-07):
                    // если LLM распознал ключ фасета, но значения нет в каталоге
                    // (например «7Вт» при доступных {5.5, 6, 8, 10}) — показывать
                    // отфильтрованную выдачу без этого значения = обман пользователя.
                    // Сразу уходим в honest-empty с честным контекстом.
                    if (resolverUnresolvedDetails.length > 0) {
                      const attemptedFacets = buildAttemptedFacets();
                      qfv2HonestEmptyContext = {
                        noun,
                        originalQuery: userMessage || noun,
                        attemptedFacets,
                      };
                      displayList = [];
                      branchTag = 'qfv2_honest_empty_partial';
                      const firstUnresolvedKey = resolverUnresolvedDetails[0].key;
                      qfV2DroppedFacetCaption = bootstrapSchema.get(firstUnresolvedKey)?.caption || firstUnresolvedKey || null;
                      console.log(`[QueryFirstV2] query_first_v2_honest_empty_partial noun="${noun}" unresolvedDetails=${JSON.stringify(resolverUnresolvedDetails)} attemptedFacets=${JSON.stringify(attemptedFacets)} elapsed=${Date.now() - qfStart}ms`);
                      logAddStep({ step: 'qfv2-honest-empty-partial', total: 0, meta: { noun, unresolvedDetails: resolverUnresolvedDetails.map(d => ({ modifier: d.modifier, key: d.key, caption: d.caption, requestedValue: d.requestedValue, availableValues: d.availableValues.slice(0, 8) })), attemptedFacets } });
                    } else if (Object.keys(resolvedFilters).length > 0) {
                      const finalStartMs = Date.now();
                      const final = await searchProductsByCandidate(
                        { query: noun, brand: null, category: null, min_price: null, max_price: null },
                        appSettings.volt220_api_token!,
                        30,
                        resolvedFilters
                      );
                      const finalFiltered = applyNounFilter(final, true);
                      console.log(`[QueryFirstV2] final query="${noun}" filters=${JSON.stringify(resolvedFilters)} → ${final.length} (after noun-filter: ${finalFiltered.length})`);
                      logAddStep({
                        step: 'qfv2-final',
                        total: finalFiltered.length,
                        ms: Date.now() - finalStartMs,
                        meta: { query: noun, filters: resolvedFilters, raw_total: final.length, after_noun_filter: finalFiltered.length },
                      });

                      if (finalFiltered.length > 0) {
                        displayList = finalFiltered;
                        branchTag = 'qfv2_win';
                        console.log(`[QueryFirstV2] query_first_v2_win noun="${noun}" filters=${Object.keys(resolvedFilters).length} count=${finalFiltered.length} elapsed=${Date.now() - qfStart}ms`);
                      } else {
                        // HONEST-EMPTY (final=0 with all filters resolved against schema).
                        const attemptedFacets = buildAttemptedFacets();
                        qfv2HonestEmptyContext = {
                          noun,
                          originalQuery: userMessage || noun,
                          attemptedFacets,
                        };
                        displayList = [];
                        branchTag = 'qfv2_honest_empty';
                        const firstKey = Object.keys(resolvedFilters)[0];
                        const bucket = bootstrapSchema.get(firstKey);
                        qfV2DroppedFacetCaption = bucket?.caption || firstKey || null;
                        console.log(`[QueryFirstV2] query_first_v2_honest_empty noun="${noun}" attemptedFacets=${JSON.stringify(attemptedFacets)} elapsed=${Date.now() - qfStart}ms`);
                      }
                    }
                  }

                  // Commit results into the orchestrator state.
                  const _r = pickDisplayWithTotal(displayList);
                  foundProducts = _r.displayed;
                  totalCollected = _r.total;
                  totalCollectedBranch = branchTag;
                  // articleShortCircuit only when we actually have products to render
                  // deterministically. For honest-empty we want pipeline to flow into
                  // Soft-404 (which builds productInstructions for the LLM).
                  articleShortCircuit = _r.displayed.length > 0;
                  categoryFirstWinResolved = true;  // also short-circuits the legacy bucket fallback below
                  qfV2Resolved = true;
                  console.log(`[Chat] DisplayLimit: collected=${_r.total} displayed=${_r.displayed.length} branch=${branchTag} zeroFiltered=${_r.filteredZeroPrice}`);
                  logAddStep({ step: 'qfv2-branch', total: _r.displayed.length, ms: Date.now() - qfStart, meta: { branch: branchTag, collected: _r.total, displayed: _r.displayed.length, dropped_facet: qfV2DroppedFacetCaption } });
                }
              }
            } catch (qfErr) {
              console.log(`[QueryFirstV2] query_first_v2_error=${(qfErr as Error).message} → fallback to Category Resolver`);
              logAddStep({ step: 'qfv2-error', ms: Date.now() - qfStart, meta: { error: String((qfErr as Error).message) } });
            }
          }

          // QueryFirstV2-resolved path short-circuits earlier via articleShortCircuit,
          // so this legacy Category Resolver block runs only when QFv2 did NOT resolve.
          // Previously a `qfMatchesOverride` variable existed here as a no-op placeholder;
          // removed (was unreachable + caused TS narrowing issue inside async closure).
          if (qfV2Resolved) {
            console.log(`[QueryFirstV2] resolved=true → skipping legacy Category Resolver`);
          }

          if (!qfV2Resolved) {
          try {
            const matcherDeadline = new Promise<{ matches: string[] }>((_, rej) =>
              setTimeout(() => rej(new Error('matcher_timeout_10s')), 10000)
            );
            const matcherWork = (async () => {
              // qfMatchesOverride intentionally unused (see line 5382-5384):
              // QueryFirstV2-resolved path short-circuits earlier via articleShortCircuit,
              // so this legacy block always runs the standard Category Resolver.
              const catalog = await getCategoriesCache(appSettings.volt220_api_token!);
              if (catalog.length === 0) return { matches: [] };
              const matches = await matchCategoriesWithLLM(effectiveCategory, catalog, appSettings, historyContextForMatcher);
              return { matches };
            })();
            const { matches } = await Promise.race([matcherWork, matcherDeadline]);

            if (matches.length > 0) {
              // ──────────────────────────────────────────────────────────────
              // Plan V7 disambiguation DISABLED (architectural decision 2026-04-30):
              //   Disambiguation противоречит core-правилу «Bot NEVER self-narrows
              //   funnel». LLM придумывал ярлыки несуществующих категорий
              //   («Бытовые для дома»), задавал лишний вопрос ДО показа товара
              //   — лишний шаг в воронке без выгоды. Заменяется связкой
              //   Query-First (выше, str. 5172+) + Soft-Suggest (HINT после карточек).
              //   Все matches идут в параллельный поиск по ВСЕМ категориям сразу
              //   (str. 5281+), пользователь сразу видит товары, фасеты —
              //   мягкая подсказка после.
              // Сохранён пустой if-блок, чтобы не плодить diff в логике flow:
              //   следующий блок (Domain Guard) опирается на matches.length>0.
              // ──────────────────────────────────────────────────────────────
              if (false) {
                // legacy disambiguation block removed — see comment above
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
          } // end if (!qfV2Resolved)

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
            // Now stores confidence too — passed to resolver to gate trust level (P0 fix).
            const bucketCatNames = bucketsToTry.filter(([, c]) => c >= 2).map(([n]) => n);
            const bucketSchemaMap: Map<string, { schema: Map<string, { caption: string; values: Set<string> }>; confidence: SchemaConfidence }> = new Map();
            if (appSettings.volt220_api_token && bucketCatNames.length > 0) {
              const schemas = await Promise.all(
                bucketCatNames.map(n => getCategoryOptionsSchema(n, appSettings.volt220_api_token!)
                  .then(r => ({ schema: r.schema, confidence: r.confidence }))
                  .catch(() => ({ schema: new Map<string, { caption: string; values: Set<string> }>(), confidence: 'empty' as SchemaConfidence })))
              );
              bucketCatNames.forEach((n, i) => bucketSchemaMap.set(n, schemas[i]));
            }

            // PARALLEL bucket resolution with global deadline (P2 fix).
            // Previously: sequential await per bucket → up to N×LLM_latency (observed 118s
            // for 5 buckets). Now: all buckets resolve in parallel under a single 20s race.
            // Whichever buckets complete contribute to bestResolved selection; late ones
            // are abandoned (their work is wasted but pipeline stays responsive).
            const BUCKET_RESOLVE_DEADLINE_MS = 20000;
            const bucketResolveT0 = Date.now();
            const eligibleBuckets = bucketsToTry.filter(([, c]) => c >= 2);

            const bucketWorkers = eligibleBuckets.map(([catName, _count]) => (async () => {
              let bucketProducts = rawProducts.filter(p =>
                ((p as any).category?.pagetitle || (p as any).parent_name || 'unknown') === catName
              );
              if (bucketProducts.length < 10 && appSettings.volt220_api_token) {
                const extraProducts = await searchProductsByCandidate(
                  { query: null, brand: null, category: catName, min_price: null, max_price: null },
                  appSettings.volt220_api_token, 50
                ).catch(() => [] as Product[]);
                if (extraProducts.length > bucketProducts.length) {
                  bucketProducts = extraProducts;
                }
              }
              const bucketSchemaInfo = bucketSchemaMap.get(catName);
              const bucketSchema = bucketSchemaInfo?.schema;
              const bucketConf: SchemaConfidence = bucketSchemaInfo?.confidence || 'empty';
              const { resolved: br, unresolved: bu } = await resolveFiltersWithLLM(
                bucketProducts, modifiers, appSettings, classification?.critical_modifiers,
                bucketSchema && bucketSchema.size > 0 ? bucketSchema : undefined,
                bucketConf
              );
              console.log(`[Chat] Bucket "${catName}" (${bucketProducts.length}, schema=${bucketSchema?.size || 0} keys, conf=${bucketConf}): resolved=${JSON.stringify(flattenResolvedFilters(br))}, unresolved=[${bu.join(', ')}]`);
              return { catName, br, bu };
            })());

            const deadlinePromise = new Promise<'deadline'>(resolve => setTimeout(() => resolve('deadline'), BUCKET_RESOLVE_DEADLINE_MS));
            const settled = await Promise.race([
              Promise.allSettled(bucketWorkers).then(r => ({ kind: 'all' as const, results: r })),
              deadlinePromise.then(() => ({ kind: 'deadline' as const })),
            ]);

            if (settled.kind === 'deadline') {
              console.log(`[Chat] Bucket-resolve DEADLINE hit at ${BUCKET_RESOLVE_DEADLINE_MS}ms — using whatever finished, abandoning rest`);
            } else {
              console.log(`[Chat] Bucket-resolve ALL DONE in ${Date.now() - bucketResolveT0}ms (${settled.results.length} buckets)`);
            }
            const completedResults = settled.kind === 'all'
              ? settled.results.filter(r => r.status === 'fulfilled').map(r => (r as PromiseFulfilledResult<{ catName: string; br: Record<string, ResolvedFilter>; bu: string[] }>).value)
              : [];
            // Pick winner: bucket that resolved the most modifiers. Tie-breaker = priority order from bucketsToTry.
            const orderIndex = new Map(eligibleBuckets.map(([n], i) => [n, i] as const));
            completedResults.sort((a, b) => {
              const diff = Object.keys(b.br).length - Object.keys(a.br).length;
              if (diff !== 0) return diff;
              return (orderIndex.get(a.catName) ?? 999) - (orderIndex.get(b.catName) ?? 999);
            });
            if (completedResults.length > 0 && Object.keys(completedResults[0].br).length > 0) {
              bestBucketCat = completedResults[0].catName;
              bestResolvedRaw = completedResults[0].br;
              bestUnresolved = completedResults[0].bu;
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
                  const altSchemaInfo: { schema: Map<string, { caption: string; values: Set<string> }>; confidence: SchemaConfidence } = appSettings.volt220_api_token
                    ? await getCategoryOptionsSchema(altCat, appSettings.volt220_api_token)
                        .then(r => ({ schema: r.schema, confidence: r.confidence }))
                        .catch(() => ({ schema: new Map<string, { caption: string; values: Set<string> }>(), confidence: 'empty' as SchemaConfidence }))
                    : { schema: new Map<string, { caption: string; values: Set<string> }>(), confidence: 'empty' as SchemaConfidence };
                  const altSchema = altSchemaInfo.schema;
                  const { resolved: altResolvedRaw, unresolved: altUnresolved } = await resolveFiltersWithLLM(
                    altProducts, modifiers, appSettings, classification?.critical_modifiers,
                    altSchema && altSchema.size > 0 ? altSchema : undefined,
                    altSchemaInfo.confidence
                  );
                  console.log(`[Chat] Alt bucket "${altCat}" schema=${altSchema?.size || 0} keys, conf=${altSchemaInfo.confidence}`);
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

                  // DEGRADED-SCHEMA UX FALLBACK: nothing got resolved AND we have unresolved modifiers AND
                  // we have rawProducts in the bucket → show category top-N with an honest clarifying ask,
                  // instead of returning empty (which surfaces as silence in the widget).
                  const degradedSchema = filterKeys.length === 0 && unresolvedMods.length > 0 && rawProducts.length > 0;
                  if (degradedSchema) {
                    const _r = pickDisplayWithTotal(rawProducts);
                    foundProducts = _r.displayed;
                    totalCollected = _r.total;
                    totalCollectedBranch = 'degraded_schema_fallback';
                    articleShortCircuit = true;
                    resultMode = 'degraded_schema_fallback';
                    console.log(`[Path] DEGRADED_UX cat="${pluralCategory}" products_shown=${foundProducts.length} unresolved=[${unresolvedMods.join(', ')}]`);
                  } else if (allCritical) {
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
                    } else if (rawProducts.length > 0) {
                      // Last-resort: still show category top-N rather than silence
                      const _r = pickDisplayWithTotal(rawProducts);
                      foundProducts = _r.displayed;
                      totalCollected = _r.total;
                      totalCollectedBranch = 'category_topN_lastresort';
                      articleShortCircuit = true;
                      resultMode = 'category_topN_lastresort';
                      console.log(`[Path] CATEGORY_TOPN_LASTRESORT cat="${pluralCategory}" products_shown=${foundProducts.length}`);
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
        } // end if (!articleShortCircuit) — guard around slot/category pipeline (title-first short-circuit)
      } catch (e) {
        console.log(`[Chat] Pipeline error (post-classify branch, fallback to LLM 1):`, e);
      }
    }



    let extractedIntent: ExtractedIntent;
    
    if (articleShortCircuit) {
      // Compute читается напрямую из основного classifier (Шаг 1).
      // Удалён двойной вызов Claude (regex-gate looksLikeSpecQuery + generateSearchCandidates) —
      // см. .lovable/plan.md Шаг 2: -3-4с латентности и фикс нестабильности на длинных product_name.
      const computeField: ComputeRequest | undefined = classification?.compute;
      if (computeField) {
        console.log(`[Chat] Compute extracted from main classifier (shortcircuit path): attribute="${computeField.attribute}", multiplier=${computeField.multiplier ?? 'null'}`);
      }

      extractedIntent = {
        intent: 'catalog',
        candidates: detectedArticles.length > 0 
          ? detectedArticles.map(a => ({ query: a, brand: null, category: null, min_price: null, max_price: null }))
          : [{ query: cleanQueryForDirectSearch(userMessage), brand: null, category: null, min_price: null, max_price: null }],
        originalQuery: userMessage,
        compute: computeField,
      };
    } else if ((classification?.intent === 'info' || classification?.intent === 'general') && !classification?.product_category) {
      // Micro-LLM already determined intent — skip expensive Gemini Pro call
      // GUARD (2026-05-04): если micro-LLM сказал info/general, НО при этом
      // определил product_category (например «есть кабеля ВВГнг 3х2.5?» → general
      // + product_category=кабель), это caталог-вопрос, замаскированный под info.
      // Не верим intent, идём в полный pipeline (как §1373).
      console.log(`[Chat] Micro-LLM intent="${classification.intent}" — skipping generateSearchCandidates`);
      extractedIntent = {
        intent: classification.intent,
        candidates: [],
        originalQuery: userMessage,
      };
    } else if (classification?.intent === 'info' || classification?.intent === 'general') {
      // info/general WITH product_category → fall through to full pipeline
      console.log(`[Chat] Micro-LLM intent="${classification.intent}" but product_category="${classification.product_category}" → forcing catalog pipeline`);
      const candidatesModel = 'anthropic/claude-sonnet-4.5';
      extractedIntent = await generateSearchCandidates(userMessage, aiConfig.apiKeys, historyForContext, aiConfig.url, candidatesModel, classification?.product_category);
    } else {
      // catalog/brands or no intent — full pipeline
      // MODEL UPGRADE (probe 2026-05-01): gemini-2.5-flash галлюцинировал brand из произвольных
      // слов («PROBEMARKER» → brand) и терял модификаторы («двухместная» → option_filters={}).
      // EXPERIMENT 2026-05-04: переключаемся с gemini-3-flash-preview на Claude Sonnet 4.5 —
      // Gemini тоже терял модификаторы для технических артикулов («ВВГнг 3х2.5» → []).
      // Финальный ответ пользователю по-прежнему идёт на aiConfig.model.
      const candidatesModel = 'anthropic/claude-sonnet-4.5';
      extractedIntent = await generateSearchCandidates(userMessage, aiConfig.apiKeys, historyForContext, aiConfig.url, candidatesModel, classification?.product_category);
      // SYSTEMIC GUARD (2026-05-04): Micro-LLM (Claude) уже определил intent — это первичный источник правды.
      // generateSearchCandidates иногда возвращает intent='general' для разговорных формулировок
      // ("есть кабеля ВВГнг 3х2.5?"), потому что фокусируется на извлечении candidates, а не на
      // классификации. Если Micro-LLM сказал catalog/brands — доверяем ему и форсим intent.
      // Candidates от generateSearchCandidates сохраняем (там option_filters для Pass 2).
      if (classification?.intent === 'catalog' || classification?.intent === 'brands') {
        if (extractedIntent.intent !== classification.intent) {
          console.log(`[Chat] Intent override: Micro-LLM='${classification.intent}' wins over generateSearchCandidates='${extractedIntent.intent}' (Micro-LLM is primary classifier)`);
          extractedIntent.intent = classification.intent;
        }
      }
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

    const infoKbSelection = extractedIntent.intent === 'info' && knowledgeResults.length > 0
      ? pickBestKnowledgeEntryForInfoQuery(userMessage, knowledgeResults)
      : null;

    const directHoursAnswer = extractedIntent.intent === 'info'
      ? extractTodayWorkingHoursFromContacts(contactsInfo, userMessage)
      : null;
    if (directHoursAnswer) {
      console.log(`[Chat] Info hours short-circuit: ${directHoursAnswer}`);
      const content = linkifyContacts(directHoursAnswer);
      if (!useStreaming) {
        const responseBody: { content: string; slot_update?: DialogSlots } = { content };
        if (slotsUpdated) responseBody.slot_update = dialogSlots;
        persistSlotsAsync(conversationId, dialogSlots);
        return new Response(JSON.stringify(responseBody), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const contentDelta = `data: ${JSON.stringify({ choices: [{ delta: { content }, index: 0 }] })}\n\n`;
          controller.enqueue(encoder.encode(contentDelta));
          if (slotsUpdated) {
            const slotEvent = `data: ${JSON.stringify({ slot_update: dialogSlots })}\n\n`;
            controller.enqueue(encoder.encode(slotEvent));
          }
          persistSlotsAsync(conversationId, dialogSlots);
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
      const formattedProducts = formatProductsForAI(foundProducts, needsExtendedOptions(userMessage) || !!extractedIntent?.compute);
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
        foundProducts = await searchProductsMulti(extractedIntent.candidates, 8, appSettings.volt220_api_token || undefined, undefined, undefined, appSettings);
        
        if (foundProducts.length > 0) {
          const candidateQueries = extractedIntent.candidates.map(c => c.query).join(', ');
          const formattedProducts = formatProductsForAI(foundProducts, needsExtendedOptions(userMessage) || !!extractedIntent?.compute);
          console.log(`[Chat] Formatted products for AI:\n${formattedProducts}`);
          productContext = `\n\n**Найденные товары (поиск по: ${candidateQueries}):**\n\n${formattedProducts}`;
        }
      } else {
        foundProducts = await searchProductsMulti(extractedIntent.candidates, 50, appSettings.volt220_api_token || undefined, undefined, undefined, appSettings);
        
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
    } else if (!articleShortCircuit && !qfv2HonestEmptyContext && extractedIntent.intent === 'catalog' && extractedIntent.candidates.length > 0) {
      const searchLimit = extractedIntent.usage_context ? 25 : 15;
      foundProducts = await searchProductsMulti(extractedIntent.candidates, searchLimit, appSettings.volt220_api_token || undefined, undefined, undefined, appSettings);
      
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
        const englishResults = await searchProductsMulti(englishCandidates, searchLimit, appSettings.volt220_api_token || undefined, undefined, undefined, appSettings);
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
          foundProducts = rerankProducts(foundProducts, userMessage, allowedCategoryTitles, reqId);
        }
        
        const candidateQueries = extractedIntent.candidates.map(c => c.query).join(', ');
        const formattedProducts = formatProductsForAI(foundProducts.slice(0, 10), needsExtendedOptions(userMessage) || !!extractedIntent?.compute);
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

        // === DETERMINISTIC RENDER GUARD REMOVED (2026-05-05) ===
        // Раньше здесь поднимался articleShortCircuit=true при наличии
        // option_filters в кандидатах. Условие проверяло НАМЕРЕНИЕ фильтровать,
        // а не ФАКТ применения фильтров — при Pass 2 = 0 + broad fallback
        // в карточки уходили товары БЕЗ нужных характеристик (см. кейс
        // «найди чёрные розетки на два места» 2026-05-05).
        // Возврат флага только через корректное условие
        // «foundProducts реально пришли из вызова с options[...]».
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

    // ─── EARLY JARGON FALLBACK (см. mem://features/jargon-fallback) ──────────
    // Кейс: Query-First v2 нашёл пул по noun (например "лампа"), но НИ ОДИН
    // critical_modifier не сматчился со схемой фасетов (branch=qfv2_pool_no_modifiers).
    // В этом случае мы показывали бы клиенту 15 случайных ламп — это «молчаливое»
    // вранье: бот делает вид, что нашёл, хотя по сути проигнорировал ключевое
    // слово ("кукуруза"). Лучше попробовать жаргон-фоллбек:
    // спросить Claude, не бытовое ли это название (кукуруза → corn lamp),
    // и поискать по альтернативе. Если найдём — покажем эти товары вместо пула.
    try {
      const criticalMods = (
        (Array.isArray(classification?.critical_modifiers) && classification.critical_modifiers.length > 0)
          ? classification.critical_modifiers
          : (Array.isArray(classification?.search_modifiers) ? classification.search_modifiers : [])
      ) as string[];
      const isPoolNoModifiers = totalCollectedBranch === 'qfv2_pool_no_modifiers';
      if (
        isPoolNoModifiers &&
        criticalMods.length > 0 &&
        appSettings.openrouter_api_key &&
        appSettings.volt220_api_token &&
        extractedIntent.originalQuery &&
        extractedIntent.originalQuery.trim().length > 0
      ) {
        console.log(`[Chat req=${reqId}] [JargonFallback] EARLY trigger: branch=qfv2_pool_no_modifiers criticalMods=${JSON.stringify(criticalMods)}`);
        logSetBranch('jargon-fallback');
        const { tryJargonFallback } = await import('../_shared/jargon-fallback.ts');
        const jargonResult = await tryJargonFallback({
          originalQuery: extractedIntent.originalQuery,
          openrouterKey: appSettings.openrouter_api_key,
          searchFn: async (alt: string) => {
            return await searchProductsByCandidate(
              { query: alt, brand: null, category: null, min_price: null, max_price: null },
              appSettings.volt220_api_token!,
              30
            );
          },
          log: (event, data) => console.log(`[Chat req=${reqId}] [JargonFallback] ${event}`, data ?? {}),
        });
        if (jargonResult.products.length > 0) {
          console.log(`[Chat req=${reqId}] [JargonFallback] EARLY recovered via "${jargonResult.matchedAlternative}": ${jargonResult.products.length} products (replacing pool)`);
          const _r = pickDisplayWithTotal(jargonResult.products);
          foundProducts = _r.displayed;
          totalCollected = _r.total;
          totalCollectedBranch = 'jargon-fallback-early';
          // productContext был сформирован выше из старого pool — пересобираем.
          productContext = formatProductsForAI(foundProducts, needsExtendedOptions(userMessage) || !!extractedIntent?.compute);
        } else {
          // Системный фикс (2026-05-04): если critical_modifier не разрешён И
          // jargon-fallback тоже не нашёл альтернатив — НЕЛЬЗЯ показывать
          // pool из 15 случайных товаров (это «молчаливое» вранье — игнор
          // ключевого слова "початок"/"кукуруза"). Очищаем foundProducts,
          // чтобы пайплайн дошёл до Soft-404 с clarifyQuestion от LLM.
          console.log(`[Chat req=${reqId}] [JargonFallback] EARLY all_empty → clearing pool to force Soft-404 (was ${foundProducts.length} unrelated products)`);
          foundProducts = [];
          totalCollected = 0;
          totalCollectedBranch = 'jargon-fallback-empty';
          articleShortCircuit = false;
          productContext = '';
        }
      }
    } catch (e) {
      console.warn(`[Chat req=${reqId}] [JargonFallback] EARLY silent fail:`, e instanceof Error ? e.message : String(e));
    }

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
        const bestMatch = infoKbSelection?.bestMatch ?? null;
        console.log(`[Chat] Info intent: topicBoosts=${JSON.stringify(infoKbSelection?.activeBoostKeywords ?? [])}, bestMatch=${bestMatch?.title || 'NONE'} (score=${infoKbSelection?.bestScore ?? 0}), runnerUp=${infoKbSelection?.runnerUp?.title || 'NONE'}(${infoKbSelection?.runnerUpScore ?? 0})`);
        
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
      // ─── JARGON FALLBACK (см. mem://features/jargon-fallback) ─────────────
      // Перед Soft-404 спрашиваем Claude Sonnet 4.5: «может это бытовое
      // название?» (кукуруза → corn lamp / лампа-початок, груша → A60).
      // Если LLM предложит альтернативу, по которой реально находятся товары →
      // используем их и пропускаем Soft-404. Если все альтернативы пустые →
      // подставляем clarifyQuestion в Soft-404 промпт.
      // Любая ошибка LLM → silent fallback на стандартный Soft-404.
      let jargonClarifyQuestion = '';
      if (
        !qfv2HonestEmptyContext &&  // QFv2 honest-empty уже знает причину пустоты — не запускаем jargon, иначе перезапишет foundProducts
        appSettings.openrouter_api_key &&
        appSettings.volt220_api_token &&
        extractedIntent.originalQuery &&
        extractedIntent.originalQuery.trim().length > 0
      ) {
        try {
          const { tryJargonFallback } = await import('../_shared/jargon-fallback.ts');
          const jargonResult = await tryJargonFallback({
            originalQuery: extractedIntent.originalQuery,
            openrouterKey: appSettings.openrouter_api_key,
            searchFn: async (alt: string) => {
              return await searchProductsByCandidate(
                { query: alt, brand: null, category: null, min_price: null, max_price: null },
                appSettings.volt220_api_token!,
                30
              );
            },
            log: (event, data) => console.log(`[Chat req=${reqId}] [JargonFallback] ${event}`, data ?? {}),
          });
          if (jargonResult.products.length > 0) {
            // Нашли товары через альтернативу — подставляем и пропускаем Soft-404.
            console.log(`[Chat req=${reqId}] [JargonFallback] Recovered via alternative "${jargonResult.matchedAlternative}": ${jargonResult.products.length} products`);
            const _r = pickDisplayWithTotal(jargonResult.products);
            foundProducts = _r.displayed;
            totalCollected = _r.total;
            totalCollectedBranch = 'jargon-fallback';
            // Пересчитываем productInstructions через стандартную S-CATALOG ветку:
            // выходим из этой ветки, чтобы основной flow подобрал foundProducts.
            // Для этого продолжаем НЕ задавая productInstructions для Soft-404 —
            // дальше код проверяет foundProducts.length и выдаёт обычные карточки.
          } else {
            jargonClarifyQuestion = jargonResult.clarifyQuestion;
          }
        } catch (e) {
          console.warn(`[Chat req=${reqId}] [JargonFallback] silent fail:`, e instanceof Error ? e.message : String(e));
        }
      }

      // Если jargon не помог (или не вызывался) — строим Soft-404
      if (foundProducts.length === 0) {
        logSetBranch(qfv2HonestEmptyContext ? 'qfv2-honest-empty' : 'soft-404');
        logAddStep({ step: 'soft-404', total: 0 });
        // Soft 404 — каталог-интент с нулевыми результатами.
        // SYSTEMIC FIX (probe 2026-05-01): старая инструкция явно разрешала
        // «предложи АЛЬТЕРНАТИВЫ если знаешь что это за товар» — это легализация
        // галлюцинаций (модель выдумывала товары/артикулы, отсутствующие в каталоге).
        // Также нельзя утверждать «бренда X нет в ассортименте» — extracted intent
        // не равен факту отсутствия в БД (см. core: «Bot NEVER self-narrows funnel»).
        // По §5.6.1 (out_of_domain/empty) → честный Soft 404 + [CONTACT_MANAGER].
        if (qfv2HonestEmptyContext && qfv2HonestEmptyContext.attemptedFacets.length > 0) {
          // SPECIALIZED Soft-404 for QueryFirstV2 honest-empty:
          // We DO know what facets we tried and what alternatives exist in the pool.
          // Tell the LLM the truth so it can craft a precise, helpful clarify question.
          // This case explicitly OVERRIDES rule #4 (no facet explanations) — here the
          // facet info IS the helpful answer ("не нашёл с 5 розетками И заземлением,
          // что важнее?"). Without it the bot would sound vague.
          const ctx = qfv2HonestEmptyContext;
          const facetsList = ctx.attemptedFacets
            .map(f => {
              const altsPart = f.alternativeValues.length > 0
                ? ` (в наличии другие значения: ${f.alternativeValues.join(', ')})`
                : ` (других значений в подборке нет)`;
              return `   • ${f.caption} = «${f.value}»${altsPart}`;
            })
            .join('\n');
          productInstructions = `
🔍 ТОВАР С ТАКОЙ КОМБИНАЦИЕЙ ХАРАКТЕРИСТИК НЕ НАЙДЕН (Soft 404)

Клиент написал: "${ctx.originalQuery}"
Мы нашли в каталоге товары по основному запросу «${ctx.noun}», но НИ ОДИН из них не подходит под ВСЕ заявленные характеристики ОДНОВРЕМЕННО.

Применённые фильтры (все одновременно дали 0 результатов):
${facetsList}

⛔ КАТЕГОРИЧЕСКИЕ ЗАПРЕТЫ:
1. НЕ выдумывай товары, артикулы, бренды, модели.
2. НЕ показывай списки товаров — у тебя их сейчас нет.
3. НЕ говори «такого товара нет в магазине» — мы не нашли только эту КОМБИНАЦИЮ, отдельные характеристики возможно есть.
4. НЕ извиняйся, не используй восклицательные знаки.

✅ ТВОЙ ОТВЕТ (3-4 коротких предложения):
1. Честно скажи: «Не нашёл <${ctx.noun}> с одновременно <перечисли применённые значения через "и">».
2. Спроси, что для клиента важнее — назови 2 заявленные характеристики и предложи выбрать одну как обязательную.
3. Если у какой-то из характеристик есть «другие значения в подборке» (см. список выше) — мягко предложи рассмотреть их (например: «или рассмотрите варианты с 3, 4, 6 розетками»). Используй ТОЛЬКО значения из списка выше, не выдумывай свои.
4. В самый конец добавь маркер [CONTACT_MANAGER].

Тон: спокойный, профессиональный, экспертный.`;
        } else {
          const clarifyLine = jargonClarifyQuestion
            ? `Одним коротким уточняющим вопросом помоги клиенту переформулировать. Используй ИМЕННО этот вопрос (он подобран под запрос клиента): «${jargonClarifyQuestion}»`
            : `Одним коротким уточняющим вопросом помоги клиенту переформулировать (например: «Уточните, пожалуйста, бренд или артикул — поищу точнее» / «Для какой задачи нужен товар?»). ОДИН вопрос, не список.`;
          productInstructions = `
🔍 ТОВАР НЕ НАЙДЕН В КАТАЛОГЕ (Soft 404)

Клиент написал: "${extractedIntent.originalQuery}"
Поиск по каталогу 220volt.kz вернул 0 подходящих товаров.

⛔ КАТЕГОРИЧЕСКИЕ ЗАПРЕТЫ:
1. НЕ выдумывай товары, артикулы, бренды, модели — у тебя НЕТ данных каталога для этого ответа.
2. НЕ утверждай «бренда X нет в ассортименте» — мы не проверяли по бренду, мы только не нашли по запросу.
3. НЕ предлагай «похожие товары» из своих общих знаний — это будет ложь.
4. НЕ объясняй, какие фасеты/фильтры не подошли — клиент это не спрашивал.

✅ ТВОЙ ОТВЕТ (короткий, 2-3 предложения):
1. Одной фразой признай, что по этому запросу товаров не подобралось.
2. ${clarifyLine}
3. В САМЫЙ КОНЕЦ ответа добавь маркер [CONTACT_MANAGER] — фронт покажет кнопку связи с менеджером.

Тон: спокойный, профессиональный, без извинений и восклицательных знаков.`;
        }
      }
    }

    // ─── COMPUTE BLOCK (spec_query надстройка) ──────────────────────────────
    // Если классификатор пометил compute и у нас есть товары — клиент спросил
    // о КОНКРЕТНОЙ характеристике (опц. ×N). Добавляем инструкцию в самый верх
    // productInstructions: характеристика берётся ТОЛЬКО из реальных options
    // товара, никаких выдуманных значений. Работает поверх любой ветки выше
    // (article / title / replacement / regular catalog).
    if (
      extractedIntent.compute &&
      extractedIntent.compute.attribute &&
      foundProducts.length > 0 &&
      productInstructions.trim().length > 0
    ) {
      try {
        const computeBlock = buildComputeInstructionBlock({
          attribute: extractedIntent.compute.attribute,
          multiplier: extractedIntent.compute.multiplier ?? null,
        });
        console.log(`[Chat] Compute block injected: attribute="${extractedIntent.compute.attribute}", multiplier=${extractedIntent.compute.multiplier ?? 'null'}`);
        productInstructions = `${computeBlock}\n${productInstructions}`;
      } catch (e) {
        console.warn(`[Chat] Compute block silent fail:`, e instanceof Error ? e.message : String(e));
      }
    }

    // Geo context for system prompt
    let geoContext = '';
    if (detectedCity && !isVPN) {
      geoContext = `\n\n📍 ГЕОЛОКАЦИЯ КЛИЕНТА: город ${detectedCity}${userCountryCode === 'RU' ? `, ${userCountry}` : ''}. При ответах о наличии/доставке учитывай это.`;
    } else if (isVPN) {
      geoContext = '\n\n📍 ГЕОЛОКАЦИЯ: не определена (VPN/прокси). Если клиент спрашивает о наличии — уточни город.';
    }

    const customPrompt = appSettings.system_prompt || '';

    // Honest-fail: if catalog API failed during this request AND we have nothing
    // to show, the LLM must NOT pretend "ничего не нашлось". Inject a hard
    // override block at the very top of the system prompt.
    const _degraded = isCatalogDegraded(reqId) && foundProducts.length === 0;
    if (_degraded) {
      console.warn(`[Chat req=${reqId}] DEGRADED MODE: catalog API failures detected, switching prompt. Reasons: ${getCatalogDegradedReasons(reqId).join(', ')}`);
    }
    const degradedBlock = _degraded ? `
🚨 ТЕХНИЧЕСКИЙ СБОЙ КАТАЛОГА (КРИТИЧЕСКИ ВАЖНО, ПЕРЕОПРЕДЕЛЯЕТ ВСЁ ОСТАЛЬНОЕ):
Каталог 220volt.kz сейчас временно недоступен (таймауты/сетевая ошибка на стороне API). Это НЕ значит, что товара нет в магазине — это значит, что мы прямо сейчас не можем проверить наличие.

ТВОЙ ОТВЕТ ДОЛЖЕН:
1. ЧЕСТНО признать сбой одной короткой фразой (например: «Каталог сейчас временно недоступен — не могу проверить наличие в реальном времени.»). НЕ говори «ничего не нашлось», «товара нет», «не удалось найти» — это будет враньё.
2. Помочь СЛОВОМ: дай 2–4 коротких экспертных совета по подбору именно того, что спросил клиент (на что смотреть: мощность, цоколь, IP-класс, сечение, материал и т.д. — релевантно запросу). Используй свои знания об электротоварах, НЕ выдумывай конкретные модели/цены.
3. Предложить связаться с менеджером для проверки наличия и точной цены — добавь маркер [CONTACT_MANAGER] в конец сообщения.
4. НЕ показывай ссылку на каталог как «решение» — каталог сейчас тоже может не отвечать.

` : '';

    const systemPrompt = `${degradedBlock}Ты — профессиональный консультант интернет-магазина электротоваров 220volt.kz.
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

🔒🔒🔒 АБСОЛЮТНОЕ ПРАВИЛО ССЫЛОК (нарушение = критический баг):
1. URL товара = ТОЛЬКО посимвольная копия из контекста. Запрещено: транслитерировать, переводить, склонять, исправлять опечатки, дописывать слэши, менять регистр, добавлять/убирать параметры, смешивать кириллицу и латиницу.
2. Если рядом с названием товара в контексте НЕТ URL — выводи название БЕЗ ссылки. НИКОГДА не конструируй URL по шаблону вроде "https://220volt.kz/..." из названия товара или категории.
3. Запрещены ссылки на категории, каталог, главную, поиск ("/catalog/", "/search/", "/category/" и т.п.) — даже если они «логично» подходят. Только прямые URL товаров из контекста.
4. Каждая [Название](URL) — это пара из контекста. Название и URL берутся из ОДНОЙ И ТОЙ ЖЕ карточки товара. Не переставляй URL между товарами.
5. Если сомневаешься в URL хоть на один символ — выводи название без ссылки.
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

# 🔗 ЖЕЛЕЗНОЕ ПРАВИЛО ДЛЯ ВСЕХ КОНТАКТОВ (телефон, email, WhatsApp)
Любой контакт в ответе ДОЛЖЕН быть кликабельной markdown-ссылкой. БЕЗ ИСКЛЮЧЕНИЙ:
- Телефон → \`[+7 (XXX) XXX-XX-XX](tel:+7XXXXXXXXXX)\` — в \`tel:\` только цифры со знаком +, без пробелов/скобок/дефисов.
- Email → \`[user@domain](mailto:user@domain)\` — НИКОГДА не пиши email просто текстом.
- WhatsApp → \`[WhatsApp](https://wa.me/7XXXXXXXXXX)\` — НИКОГДА не упоминай «WhatsApp» без ссылки.
ЗАПРЕЩЕНО: писать «WhatsApp или email: intermag@220volt.kz», «звоните +7 721 230-35-51», «пишите на почту …» — без markdown-ссылок. Если не знаешь точного номера/адреса — НЕ выдумывай, используй блок ниже.

# Контакты компании и филиалы (из Базы Знаний)
Ниже — ЕДИНСТВЕННЫЙ источник контактных данных. Все телефоны/email/WhatsApp здесь УЖЕ оформлены markdown-ссылками — копируй их В ТОЧНОСТИ как есть, не разворачивай обратно в plain-текст.

${linkifyContacts(contactsInfo) || 'Данные о контактах не загружены.'}

# Эскалация менеджеру
Когда нужен менеджер — добавь маркер [CONTACT_MANAGER] в конец сообщения (он скрыт от клиента, заменяется карточкой контактов). Перед маркером предложи WhatsApp и email из данных выше — обязательно как кликабельные markdown-ссылки.

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
      const bm = infoKbSelection?.bestMatch ?? null;
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
    console.log(`[Chat] Sampling for ${responseModel}: ${responseModel.startsWith('anthropic/') || responseModel.startsWith('openai/') ? 'temperature=0 top_p=1' : 'top_k=1 seed=42 google-ai-studio'}`);

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
        persistSlotsAsync(conversationId, dialogSlots);
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
          persistSlotsAsync(conversationId, dialogSlots);

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


    // spec_query (compute) ВСЕГДА требует LLM-обработки: нужна формулировка
    // ответа про характеристику + опц. умножение на N — детерминистичный
    // рендерер этого не умеет (он рисует только карточки + intro/followUp).
    const hasComputeRequest = !!(extractedIntent.compute && extractedIntent.compute.attribute);
    // SYSTEMIC ANTI-HALLUCINATION (2026-05-04): любой ответ с найденными товарами
    // обязан рендериться детерминистично из ProductResource — иначе LLM переписывает
    // URL даже при инструкции «копируй как есть» (см. mem://constraints/deterministic-product-render).
    // Раньше условие требовало articleShortCircuit=true ИЛИ известный reason — но catalog-ветка
    // с Pass 2 (option_filters) использует общий поток без short-circuit и попадала на LLM-стрим.
    // Теперь правило: foundProducts>0 && !compute && intent='catalog' → ВСЕГДА детерминистично.
    // Replacement и similar-ветки имеют свои composer'ы и сюда не доходят.
    const isCatalogIntent = extractedIntent.intent === 'catalog' || extractedIntent.intent === 'brands';
    const shouldUseDeterministicProductRender = !hasComputeRequest && foundProducts.length > 0 && (
      isDeterministicShortCircuitReason(responseModelReason) ||
      responseModelReason === 'price-facet-clarify' ||
      articleShortCircuit ||
      isCatalogIntent
    );

    if (shouldUseDeterministicProductRender) {
      // Если попали сюда из общего catalog-потока (не short-circuit) — нормализуем reason
      // под обычный 'pass2-shortcircuit', чтобы intro/followUp подхватились корректно.
      const renderReason = (isDeterministicShortCircuitReason(responseModelReason) || responseModelReason === 'price-facet-clarify')
        ? responseModelReason
        : 'pass2-shortcircuit';
      const content = renderReason === 'price-facet-clarify' && pendingClarifyFacet && pendingClarifyIntent
        ? buildPriceFacetClarifyContent({
            products: foundProducts,
            priceIntent: pendingClarifyIntent,
            facet: pendingClarifyFacet,
          })
        : buildDeterministicShortCircuitContent({
            products: foundProducts,
            reason: renderReason,
            userMessage,
            effectivePriceIntent,
            subIntent: classification?.sub_intent,
            totalCollected,
            suppressTail: tailWasOfferedLastTurn,
          });
      console.log(`[Chat] Deterministic SHORT-CIRCUIT response: reason=${renderReason} (orig=${responseModelReason}, articleSC=${articleShortCircuit}, catalogIntent=${isCatalogIntent}) products=${foundProducts.length} contentLen=${content.length}`);
      logSetProductsCount(foundProducts.length);
      logAddStep({ step: 'final-deterministic', total: foundProducts.length, meta: { reason: renderReason } });

      // ─────────────────────────────────────────────────────────────────────
      // RELATED-FOLLOWUP (V1, 2026-05-12).
      //
      // Вместо хвоста «Могу чем-то ещё помочь?» отправляем ОТДЕЛЬНЫМ пузырём
      // короткую естественную фразу про сопутствующие товары, основанную
      // на реальных данных `GET /api/products/{id}/related` для якоря foundProducts[0].
      //
      // Условия пропуска (followup НЕ отправляем):
      //   • renderReason === 'price-facet-clarify' (там и так уточняющий вопрос)
      //   • replacementMeta.isReplacement (similar-ветка имеет свой композер)
      //   • foundProducts пуст
      //   • /related вернул < 2 категорий после фильтра price=0 + удаления категории якоря
      //   • LLM-formulator вернул пустую строку / упал (silent skip)
      //
      // Старый LLM-cross-sell (generateCrossSellTail + pending_offer) ОТКЛЮЧЁН
      // полностью — функция оставлена в коде как dead code до отдельного refactor PR.
      // ─────────────────────────────────────────────────────────────────────
      const finalContent = content;
      // Step 2 (2026-05-12): убрано single-anchor ограничение. Анкоры берём из
      // первых foundProducts с уникальными категориями (до 3-х). При широкой
      // выдаче это даёт более устойчивую агрегацию /related (категории-победители
      // отражают пересечение, а не «арбитрарного первого товара»).
      // Если показан хвост «Подобрано ещё N — показать остальные?», cross-sell-followup
      // ОТКЛАДЫВАЕМ до 2-го хода: сохраняем `remaining_offer` slot с (а) карточками
      // остальных товаров для accept-ветки и (б) анкорами для cross-sell после accept/decline.
      const shownDeterministicCount = Math.min(foundProducts.length, 3);
      const totalForTail = Math.max(totalCollected ?? 0, foundProducts.length);
      const hasRemainingTail = totalForTail > shownDeterministicCount && !tailWasOfferedLastTurn;
      const allowFollowup =
        renderReason !== 'price-facet-clarify' &&
        !replacementMeta?.isReplacement &&
        foundProducts.length > 0 &&
        !hasRemainingTail;

      // Анкоры для cross-sell — собираем ВСЕГДА (когда есть продукты), чтобы переиспользовать
      // и для текущего follow-up, и для save в remaining_offer (cross-sell на 2-м ходу).
      const crossSellAnchors: RelatedAnchor[] = (() => {
        if (!foundProducts.length) return [];
        const picked: RelatedAnchor[] = [];
        const seenCats = new Set<number>();
        for (const p of foundProducts) {
          if (!p?.id) continue;
          const catId = p.category?.id;
          if (catId && seenCats.has(catId)) continue;
          if (catId) seenCats.add(catId);
          picked.push({
            id: p.id,
            pagetitle: p.pagetitle,
            price: typeof p.price === 'number' ? p.price : undefined,
            category: p.category ? { id: p.category.id, pagetitle: p.category.pagetitle } : undefined,
            options: Array.isArray(p.options)
              ? p.options
                  .filter((o: any) => o && typeof o.key === 'string')
                  .map((o: any) => ({
                    key: o.key,
                    value_ru: (o.value_ru ?? o.value ?? '') || undefined,
                    caption_ru: (o.caption_ru ?? o.caption ?? '') || undefined,
                  }))
              : undefined,
          });
          if (picked.length >= 3) break;
        }
        return picked;
      })();
      const followupAnchors: RelatedAnchor[] = allowFollowup ? crossSellAnchors : [];

      // Сохраняем remaining_offer slot, если есть хвост — для accept/decline на 2-м ходу.
      if (hasRemainingTail && foundProducts.length > shownDeterministicCount) {
        const remainingLite = foundProducts.slice(shownDeterministicCount).map((p: any) => ({
          id: p?.id,
          pagetitle: p?.pagetitle,
          url: p?.url,
          price: typeof p?.price === 'number' ? p.price : 0,
          vendor: typeof p?.vendor === 'string' ? p.vendor : undefined,
          amount: typeof p?.amount === 'number' ? p.amount : undefined,
          warehouses: Array.isArray(p?.warehouses)
            ? p.warehouses.filter((w: any) => w && Number(w.amount) > 0).slice(0, 3).map((w: any) => ({ city: w.city, amount: Number(w.amount) }))
            : undefined,
          options: Array.isArray(p?.options)
            ? p.options.filter((o: any) => o && o.key === 'brend__brend').map((o: any) => ({ key: o.key, value_ru: o.value_ru ?? o.value ?? '' }))
            : undefined,
        }));
        const anchorSnapshotForLater = crossSellAnchors.slice(0, 5).map((a) => ({
          id: a.id, price: a.price, options: a.options, category: a.category,
        }));
        const remainingCount = totalForTail - shownDeterministicCount;
        dialogSlots['remaining_offer'] = {
          intent: 'remaining_offer',
          base_category: classification?.product_category || 'remaining',
          status: 'pending',
          created_turn: 0,
          turns_since_touched: 0,
          offer_text: `Подобрано ещё ${remainingCount} — показать остальные?`,
          anchors: JSON.stringify(anchorSnapshotForLater),
          remaining_products: JSON.stringify(remainingLite),
        };
        slotsUpdated = true;
      }

      const runFollowup = async () => {
        if (!followupAnchors.length || !appSettings.volt220_api_token) {
          return { text: '', anchorIds: [] as number[], categories: [] as string[] };
        }
        return await generateRelatedFollowup({
          anchors: followupAnchors,
          userMessage: rawUserMessage,
          productCategory: classification?.product_category,
          deps: buildRelatedDeps(appSettings.volt220_api_token, appSettings),
        });
      };

      // Сохранение cross_sell_offer slot — общее для streaming/non-streaming.
      const saveCrossSellSlot = (followup: { text: string; anchorIds: number[]; categories: string[] }) => {
        if (!followup.text || !followup.anchorIds.length) return;
        const anchorSnapshot = followupAnchors
          .filter((a) => followup.anchorIds.includes(a.id))
          .slice(0, 5)
          .map((a) => ({
            id: a.id,
            price: a.price,
            options: a.options,
            category: a.category,
          }));
        dialogSlots['cross_sell_offer'] = {
          intent: 'cross_sell_offer',
          base_category: classification?.product_category || 'cross_sell',
          status: 'pending',
          created_turn: 0,
          turns_since_touched: 0,
          offer_text: followup.text.slice(0, 500),
          anchor_ids: JSON.stringify(followup.anchorIds.slice(0, 5)),
          related_categories: JSON.stringify(followup.categories.slice(0, 5)),
          anchors: JSON.stringify(anchorSnapshot),
        };
        slotsUpdated = true;
      };

      if (!useStreaming) {
        const followup = await runFollowup();
        saveCrossSellSlot(followup);
        const responseBody: { content: string; slot_update?: DialogSlots; followup?: { text: string } } = { content: finalContent };
        if (slotsUpdated) responseBody.slot_update = dialogSlots;
        if (followup.text) responseBody.followup = { text: followup.text };
        persistSlotsAsync(conversationId, dialogSlots);
        return new Response(JSON.stringify(responseBody), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const contentDelta = `data: ${JSON.stringify({
            choices: [{ delta: { content: finalContent }, index: 0 }],
          })}\n\n`;
          controller.enqueue(encoder.encode(contentDelta));

          // Related-followup эмитим ПОСЛЕ основного контента, но ДО [DONE].
          // Frontend сам добавит визуальную задержку перед рендером пузыря.
          let followup = { text: '', anchorIds: [] as number[], categories: [] as string[] };
          try {
            followup = await runFollowup();
            saveCrossSellSlot(followup);
          } catch (e) {
            console.log(`[RelatedFollowup] stream error (silent skip): ${(e as Error).message}`);
          }

          // slot_update эмитим ПОСЛЕ followup, чтобы оно содержало cross_sell_offer.
          if (slotsUpdated) {
            const slotEvent = `data: ${JSON.stringify({ slot_update: dialogSlots })}\n\n`;
            controller.enqueue(encoder.encode(slotEvent));
          }
          persistSlotsAsync(conversationId, dialogSlots);

          if (followup.text) {
            const followupEvent = `data: ${JSON.stringify({ followup: { text: followup.text } })}\n\n`;
            controller.enqueue(encoder.encode(followupEvent));
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
      ...samplingFor(responseModel),
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
        // Страховка: даже если LLM вставил голые контакты — линкуем их.
        content = linkifyContacts(content);
        
        const responseBody: { content: string; contacts?: string | null; slot_update?: DialogSlots } = { content };
        if (shouldShowContacts && formattedContacts) {
          responseBody.contacts = formattedContacts;
        }
        if (slotsUpdated) {
          responseBody.slot_update = dialogSlots;
        }
        persistSlotsAsync(conversationId, dialogSlots);
        
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
            persistSlotsAsync(conversationId, dialogSlots);
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
            persistSlotsAsync(conversationId, dialogSlots);
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
          persistSlotsAsync(conversationId, dialogSlots);
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
          persistSlotsAsync(conversationId, dialogSlots);
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
  }); // end _reqContext.run
}

if (import.meta.main) {
  serve(handleChatConsultant);
}
