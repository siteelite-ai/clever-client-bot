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
async function searchByArticle(article: string, apiToken: string): Promise<Product[]> {
  try {
    const params = new URLSearchParams();
    params.append('article', article);
    params.append('per_page', '5');
    
    console.log(`[ArticleSearch] Searching by article: ${article}`);
    
    const response = await fetch(`${VOLT220_API_URL}?${params}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.error(`[ArticleSearch] API error: ${response.status}`);
      return [];
    }

    const rawData = await response.json();
    const data = rawData.data || rawData;
    const results = data.results || [];
    
    console.log(`[ArticleSearch] Found ${results.length} product(s) for article "${article}"`);
    return results;
  } catch (error) {
    console.error(`[ArticleSearch] Error:`, error);
    return [];
  }
}

/**
 * Search products by site identifier
 */
async function searchBySiteId(siteId: string, apiToken: string): Promise<Product[]> {
  try {
    const params = new URLSearchParams();
    params.append('options[identifikator_sayta__sayt_identifikatory][]', siteId);
    params.append('per_page', '5');
    
    console.log(`[SiteIdSearch] Searching by site identifier: ${siteId}`);
    
    const response = await fetch(`${VOLT220_API_URL}?${params}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.error(`[SiteIdSearch] API error: ${response.status}`);
      return [];
    }

    const rawData = await response.json();
    const data = rawData.data || rawData;
    const results = data.results || [];
    
    console.log(`[SiteIdSearch] Found ${results.length} product(s) for site ID "${siteId}"`);
    return results;
  } catch (error) {
    console.error(`[SiteIdSearch] Error:`, error);
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
ВАЖНО: при is_replacement=true система найдёт оригинал ТОЛЬКО для извлечения характеристик и вернёт пользователю АНАЛОГИ, а не сам оригинал.

Примеры (is_replacement=true):
- "светильник ДКУ-LED-03-100W (ЭТФ) предложи самую близкую замену по характеристикам" → is_replacement=true, has_product_name=true, product_name="ДКУ-LED-03-100W ЭТФ", product_category="светильник"
- "что взять вместо ABB S201 C16?" → is_replacement=true, has_product_name=true, product_name="ABB S201 C16", product_category="автомат"
- "подбери аналог розетке Werkel Atlas серого цвета" → is_replacement=true, has_product_name=true, product_name="Werkel Atlas розетка", product_category="розетка", search_modifiers=["серый"]

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
        product_name: parsed.product_name || undefined,
        price_intent: (parsed.price_intent === 'most_expensive' || parsed.price_intent === 'cheapest') ? parsed.price_intent : undefined,
        product_category: parsed.product_category || undefined,
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
  intent: 'price_extreme' | 'product_search';
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
    if (s.intent !== 'price_extreme' && s.intent !== 'product_search') continue;
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
      intent: s.intent as 'price_extreme' | 'product_search',
      price_dir: (s.price_dir === 'most_expensive' || s.price_dir === 'cheapest') ? s.price_dir : undefined,
      base_category: sanitize(s.base_category),
      refinement: s.refinement ? sanitize(s.refinement) : undefined,
      status: s.status as 'pending' | 'done',
      created_turn: typeof s.created_turn === 'number' ? s.created_turn : 0,
      turns_since_touched: typeof s.turns_since_touched === 'number' ? s.turns_since_touched : 0,
      resolved_filters: typeof s.resolved_filters === 'string' ? s.resolved_filters.substring(0, 2000) : undefined,
      unresolved_query: typeof s.unresolved_query === 'string' ? sanitize(s.unresolved_query) : undefined,
      plural_category: typeof s.plural_category === 'string' ? sanitize(s.plural_category) : undefined,
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
 | null {
  // First: check for pending product_search slot with filter state
  for (const [key, slot] of Object.entries(slots)) {
    if (slot.status === 'pending' && slot.intent === 'product_search' && slot.plural_category) {
      const isShort = userMessage.length < 100;
      const hasNewCategory = classificationResult?.product_category 
        && classificationResult.product_category !== slot.base_category;
      
      if (isShort && !hasNewCategory) {
        const existingFilters = slot.resolved_filters ? JSON.parse(slot.resolved_filters) : {};
        console.log(`[Slots] product_search slot resolved: refinementText="${userMessage}", existingUnresolved="${slot.unresolved_query || ''}", filters=${JSON.stringify(existingFilters)}`);
        
        const updatedSlots = { ...slots };
        updatedSlots[key] = { ...slot, refinement: userMessage.trim(), status: 'done', turns_since_touched: 0 };
        
        return { 
          slotKey: key, 
          searchParams: {
            category: slot.plural_category,
            resolvedFilters: existingFilters,
            refinementText: userMessage.trim(),
            refinementModifiers: classificationResult?.search_modifiers?.length 
              ? classificationResult.search_modifiers 
              : [userMessage.trim()],
            existingUnresolved: slot.unresolved_query || '',
            baseCategory: slot.base_category,
          },
          updatedSlots,
        };
      }
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
    && classificationResult.price_intent !== 'none';
  
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
function rerankProducts(products: Product[], userQuery: string): Product[] {
  const queryTokens = extractTokens(userQuery);
  const querySpecs = extractSpecs(userQuery);
  
  const scored = products.map(p => ({
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
  console.log(`[AI Candidates] Extracting search intent from: "${message}", classificationCategory: ${classificationCategory || 'none'}`);
  
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
  
  const extractionPrompt = `Ты — система извлечения поисковых намерений для интернет-магазина электроинструментов 220volt.kz.
${historyContext}
${recentHistory.length > 0 ? 'АНАЛИЗИРУЙ ТЕКУЩЕЕ сообщение С УЧЁТОМ КОНТЕКСТА РАЗГОВОРА!' : 'АНАЛИЗИРУЙ ТЕКУЩЕЕ сообщение КАК САМОСТОЯТЕЛЬНЫЙ ЗАПРОС!'}

🔄 ОБРАБОТКА УТОЧНЯЮЩИХ ОТВЕТОВ (КРИТИЧЕСКИ ВАЖНО!):
Если текущее сообщение — это ОТВЕТ на уточняющий вопрос консультанта (например "а для встраиваемой", "наружный", "на 12 модулей", "IP44"):
1. ВОССТАНОВИ полный контекст из истории: определи КАКОЙ ТОВАР обсуждался ранее (щиток, розетка, светильник и т.д.)
2. Сформируй НОВЫЙ полноценный набор кандидатов с ИСХОДНЫМ товаром + УТОЧНЕНИЕ как option_filter
3. intent ОБЯЗАТЕЛЬНО = "catalog" (это продолжение поиска товара!)
4. Генерируй СТОЛЬКО ЖЕ синонимов, как при первичном запросе

Примеры:
- Контекст: обсуждали щитки → Клиент: "для встраиваемой" → intent="catalog", candidates=[{"query":"щиток"},{"query":"бокс"},{"query":"щит"},{"query":"корпус модульный"},{"query":"ЩРВ"}], option_filters={"монтаж":"встраиваемый"}
- Контекст: обсуждали розетки → Клиент: "влагозащищённую" → intent="catalog", candidates=[{"query":"розетка"},{"query":"розетка влагозащищенная"}], option_filters={"защита":"IP44"}
- Контекст: обсуждали автоматы → Клиент: "на 32 ампера" → intent="catalog", candidates=[{"query":"автомат"},{"query":"автоматический выключатель"}], option_filters={"ток":"32"}

⚠️ НЕ генерируй пустые candidates для уточняющих ответов! Это НЕ "general" intent!

💰 ОБРАБОТКА ЦЕНОВЫХ СРАВНЕНИЙ (КРИТИЧЕСКИ ВАЖНО!):
Если пользователь просит "дешевле", "подешевле", "бюджетнее", "дороже", "подороже", "премиальнее":
1. Найди в КОНТЕКСТЕ РАЗГОВОРА ЦЕНУ обсуждаемого товара (число в тенге/₸)
2. "дешевле" / "подешевле" / "бюджетнее" → установи max_price = цена_товара - 1
3. "дороже" / "подороже" / "премиальнее" → установи min_price = цена_товара + 1
4. ОБЯЗАТЕЛЬНО восстанови контекст товара и сгенерируй кандидатов (intent="catalog")!
5. Если цену не удалось найти в истории — НЕ устанавливай min_price/max_price, просто ищи по названию

Примеры:
- Обсуждали отвёртку за 347₸ → Клиент: "есть дешевле?" → intent="catalog", max_price=346, candidates=[{"query":"отвертка"},{"query":"отвертки"}]
- Обсуждали дрель за 15000₸ → Клиент: "покажи подороже" → intent="catalog", min_price=15001, candidates=[{"query":"дрель"},{"query":"дрели"}]

🔢 ЧИСЛОВЫЕ АРТИКУЛЫ (КРИТИЧЕСКИ ВАЖНО!):
Если пользователь указывает числовой код из 4-8 цифр (например "16093", "5421", "12345678") и спрашивает о наличии, цене или информации о товаре — генерируй кандидата с полем "article" ВМЕСТО "query"!
Примеры:
- "16093 есть в наличии?" → intent="catalog", candidates=[{"article":"16093"}]
- "сколько стоит 5421?" → intent="catalog", candidates=[{"article":"5421"}]
- "артикул 12345" → intent="catalog", candidates=[{"article":"12345"}]
Поле "article" ищет по точному совпадению артикула и всегда находит товар, если он существует.

📖 ДОКУМЕНТАЦИЯ API КАТАЛОГА (220volt.kz/api/products):
Ты ДОЛЖЕН формировать корректные запросы к API. Вот доступные параметры:

| Параметр | Описание | Пример |
|----------|----------|--------|
| query | Текстовый поиск по названию и описанию товара. Включай модельные коды (T8, A60, MR16) и ключевые характеристики (18Вт, 6500К). НЕ передавай общие слова вроде "товары", "продукция", "изделия" — они бесполезны | "дрель", "УШМ", "кабель 3x2.5", "ECO T8 18Вт 6500К" |
| article | Точный поиск по артикулу/SKU товара. Используй для числовых кодов 4-8 цифр | "16093", "09-0201" |
| options[brend__brend][] | Фильтр по бренду. Значение = точное название бренда ЛАТИНИЦЕЙ с заглавной буквы | "Philips", "Bosch", "Makita" |
| category | Фильтр по категории (pagetitle родительского ресурса) | "Светильники", "Перфораторы" |
| min_price | Минимальная цена в тенге | 5000 |
| max_price | Максимальная цена в тенге | 50000 |

🔧 ФИЛЬТРЫ ПО ХАРАКТЕРИСТИКАМ (option_filters):
Когда пользователь упоминает ЛЮБУЮ техническую характеристику — извлеки её в option_filters!
Ключ = КРАТКОЕ человекочитаемое название (на русском, без пробелов, через подчёркивание).
Значение = значение характеристики.

Примеры:
- "белорусского производства" → option_filters: {"страна": "Беларусь"}
- "с цоколем E14" → option_filters: {"цоколь": "E14"}
- "накладной монтаж" → option_filters: {"монтаж": "накладной"}
- "степень защиты IP65" → option_filters: {"защита": "IP65"}
- "напряжение 220В" → option_filters: {"напряжение": "220"}
- "3 розетки" → option_filters: {"розетки": "3"}
- "сечение 2.5" → option_filters: {"сечение": "2.5"}
- "длина 5м" → option_filters: {"длина": "5"}

Ключи НЕ обязаны совпадать с API — система автоматически найдёт правильные ключи!

⚠️ ПРАВИЛА СОСТАВЛЕНИЯ ЗАПРОСОВ:
1. Если пользователь спрашивает о БРЕНДЕ ("есть Philips?", "покажи Makita") — используй ТОЛЬКО фильтр brand, БЕЗ query. API найдёт все товары бренда.
2. Если пользователь ищет КАТЕГОРИЮ товаров ("дрели", "розетки") — используй query с техническим названием. НЕ используй параметр category!
3. Если пользователь ищет ТОВАР КОНКРЕТНОГО БРЕНДА ("дрель Bosch", "светильник Philips") — используй И query, И brand.
4. query должен содержать ТЕХНИЧЕСКИЕ термины каталога, не разговорные слова.
5. Бренды ВСЕГДА латиницей: "филипс" → brand="Philips", "бош" → brand="Bosch", "макита" → brand="Makita"
6. НЕ ИСПОЛЬЗУЙ параметр category! Ты не знаешь точные названия категорий в каталоге. Используй только query для текстового поиска.
7. Если пользователь упоминает ХАРАКТЕРИСТИКУ — помести её в option_filters И ТАКЖЕ включи ключевые характеристики (мощность, температуру, модельный код) В query! Это повышает точность поиска.
8. Если пользователь описывает КОНТЕКСТ ИСПОЛЬЗОВАНИЯ (место, условия) — заполни usage_context И ТАКЖЕ выведи ПРЕДПОЛАГАЕМЫЕ технические характеристики в option_filters!

🌍 КОНТЕКСТЫ ИСПОЛЬЗОВАНИЯ (usage_context + option_filters ОДНОВРЕМЕННО!):
Когда пользователь описывает ГДЕ/КАК будет использоваться товар — заполни ОБА поля:
- usage_context: описание контекста для финального ответа
- option_filters: ПРЕДПОЛАГАЕМЫЕ технические характеристики для фильтрации в API

Примеры:
- "розетка для улицы" → usage_context="наружное использование", option_filters={"защита": "IP44"}, candidates=[{"query":"розетки"},{"query":"розетка влагозащищенная"},{"query":"розетка наружная"}]
- "розетка для бани" → usage_context="влажное помещение, высокая температура", option_filters={"защита": "IP44"}, candidates=[{"query":"розетки"},{"query":"розетка влагозащищенная"},{"query":"розетка герметичная"}]
- "розетка в ванную" → usage_context="влажное помещение", option_filters={"защита": "IP44"}, candidates=[{"query":"розетки"},{"query":"розетка влагозащищенная"}]
- "светильник для детской" → usage_context="детская комната, безопасность", option_filters={"защита": "IP20"}, candidates=[{"query":"светильник"},{"query":"светильник детский"}]
- "кабель на производство" → usage_context="промышленное использование", candidates=[{"query":"кабель"},{"query":"кабель силовой"},{"query":"кабель промышленный"}]
- "светильник в гараж" → usage_context="неотапливаемое помещение, пыль", option_filters={"защита": "IP44"}, candidates=[{"query":"светильник"},{"query":"светильник пылевлагозащищенный"},{"query":"светильник IP44"}]

⚠️ КРИТИЧЕСКИ ВАЖНО — ИЕРАРХИЯ КАНДИДАТОВ:
1. ПЕРВЫЙ кандидат = ОСНОВНОЙ ТОВАР (что конкретно ищем: "розетки", "светильник", "кабель")
2. ОСТАЛЬНЫЕ кандидаты = ОСНОВНОЙ ТОВАР + характеристика ("розетка влагозащищенная", "розетка IP44")
3. НИКОГДА не ставь характеристику/место БЕЗ основного товара! "баня", "улица", "влагозащита" сами по себе — НЕ кандидаты!
4. option_filters применяются ко ВСЕМ кандидатам для фильтрации результатов

📛 ПРИОРИТЕТ ПОЛНОГО НАЗВАНИЯ:
Если пользователь ввёл ПОЛНОЕ или ПОЧТИ ПОЛНОЕ название товара (например "Лампа светодиодная ECO T8 линейная 18Вт 230В 6500К G13 ИЭК"):
1. ПЕРВЫЙ кандидат = максимально близкое к исходному вводу пользователя (сохраняй модельные коды, числовые характеристики!)
2. ВТОРОЙ кандидат = укороченная версия без числовых спецификаций
3. НЕ ДРОБИ оригинальное название на слишком общие слова

🔄 СИНОНИМЫ ТОВАРОВ — ОБЯЗАТЕЛЬНАЯ ГЕНЕРАЦИЯ ВАРИАНТОВ:
В каталоге один и тот же товар может называться по-разному. Ты ОБЯЗАН генерировать кандидатов с РАЗНЫМИ названиями одного товара!
Примеры:
- "щиток" → кандидаты: {"query":"щиток"}, {"query":"бокс"}, {"query":"щит"}, {"query":"корпус модульный"}
- "удлинитель" → кандидаты: {"query":"удлинитель"}, {"query":"колодка"}, {"query":"сетевой фильтр"}
- "лампочка" → кандидаты: {"query":"лампа"}, {"query":"лампочка"}, {"query":"светодиодная лампа"}
- "лампа T8 18Вт 6500К" → кандидаты: {"query":"ECO T8 18Вт 6500К"}, {"query":"лампа T8 18Вт 6500К"}, {"query":"T8 линейная 18Вт"}, option_filters={"мощность":"18","цветовая_температура":"6500"}
- "лампа E27 12Вт тёплая" → кандидаты: {"query":"лампа E27 12Вт"}, {"query":"лампа светодиодная E27"}, option_filters={"мощность":"12","цоколь":"E27","цветовая_температура":"3000"}
- "автомат" → кандидаты: {"query":"автомат"}, {"query":"автоматический выключатель"}, {"query":"выключатель автоматический"}
- "болгарка" → кандидаты: {"query":"УШМ"}, {"query":"болгарка"}, {"query":"угловая шлифмашина"}
- "перфоратор" → кандидаты: {"query":"перфоратор"}, {"query":"бурильный молоток"}
- "стабилизатор" → кандидаты: {"query":"стабилизатор"}, {"query":"стабилизатор напряжения"}, {"query":"регулятор напряжения"}
- "рубильник" → кандидаты: {"query":"рубильник"}, {"query":"выключатель-разъединитель"}, {"query":"выключатель нагрузки"}

Принцип: подумай, КАК ИМЕННО этот товар может быть записан в КАТАЛОГЕ интернет-магазина электротоваров. Используй:
1. Разговорное название (как говорит покупатель): "щиток", "болгарка", "автомат"
2. Техническое/каталожное название: "бокс", "УШМ", "автоматический выключатель"
3. Альтернативные варианты из каталога: "корпус модульный", "угловая шлифмашина"

- "розетка IP65" → option_filters={"защита": "IP65"}, usage_context=null (пользователь ЗНАЕТ конкретную характеристику)

🔴 ОПРЕДЕЛИ ПРАВИЛЬНЫЙ INTENT:
- "catalog" — ищет товары/оборудование
- "brands" — спрашивает какие бренды представлены
- "info" — вопросы о компании, доставке, оплате, оферте, договоре, юридических данных (БИН, ИИН), обязанностях покупателя/продавца, возврате, гарантии, правах покупателя
- "general" — приветствия, шутки, нерелевантное (candidates=[])

🔑 АРТИКУЛЫ / SKU:
Если пользователь указывает АРТИКУЛ товара (строка вида CKK11-012-012-1-K01, MVA25-1-016-C, SQ0206-0071 или упоминает слово "артикул", "арт."):
- intent = "catalog"
- Первый кандидат: query = артикул КАК ЕСТЬ (без изменений, без синонимов!)
- НЕ генерируй дополнительных синонимов или вариаций для артикулов

🚨 Если запрос о ДОКУМЕНТАХ КОМПАНИИ (оферта, БИН, обязанности, условия) — это ВСЕГДА intent="info", НЕ "general"!
🚨 Если запрос НЕ про электроинструмент/оборудование И НЕ про компанию — это intent="general".

🔑 ВАЖНОЕ ПРАВИЛО ДЛЯ БРЕНДОВ:
Когда пользователь спрашивает о бренде В КОНТЕКСТЕ конкретной категории (например, ранее обсуждали автоматические выключатели, а теперь спрашивает "а от Philips есть?"):
- Генерируй МИНИМУМ 2 кандидата:
  1. query=<категория из контекста> + brand=<бренд> (проверяем, есть ли бренд В ЭТОЙ категории)
  2. brand=<бренд> БЕЗ query (проверяем, есть ли бренд ВООБЩЕ в каталоге)
Это критически важно! Бренд может отсутствовать в одной категории, но быть представлен в другой.

ТЕКУЩЕЕ сообщение пользователя: "${message}"`;

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

    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    if (toolCall?.function?.arguments) {
      const parsed = JSON.parse(toolCall.function.arguments);
      console.log(`[AI Candidates] Extracted:`, JSON.stringify(parsed, null, 2));
      
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
  criticalModifiers?: string[]
): Promise<{ resolved: Record<string, ResolvedFilter>; unresolved: string[] }> {
  if (!modifiers || modifiers.length === 0) return { resolved: {}, unresolved: [] };
  // Default critical = all modifiers (safe behavior)
  const criticalSet = new Set<string>((criticalModifiers && criticalModifiers.length > 0 ? criticalModifiers : modifiers).map(m => m.toLowerCase().trim()));
  const isCritical = (mod: string) => criticalSet.has(mod.toLowerCase().trim());

  // Build option schema from products
  const optionIndex: Map<string, { caption: string; values: Set<string> }> = new Map();
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
2. Пройдись по каждой характеристике в схеме. Для каждой смотри на её название (в скобках) и на все доступные значения. Определи, что эта характеристика описывает физически.
3. Для каждого модификатора найди характеристику, которая описывает то же самое свойство. Учитывай: единицы измерения, физический смысл в контексте данной категории товаров, возможные синонимы и сокращения.
4. Найдя подходящую характеристику, посмотри на формат её значений — они могут быть записаны цифрами, словами, с единицами измерения, сокращениями. Выбери из списка то значение, которое точно соответствует намерению пользователя. Возвращай значение В ТОЧНОСТИ как в схеме.
5. КРИТИЧЕСКИ ВАЖНО: Если нужного значения НЕТ в списке доступных значений — НЕ подставляй ближайшее или похожее. Оставь этот модификатор без сопоставления. Например: пользователь хочет "1 полюс", а в схеме есть только "2, 3, 4" — НЕ выбирай "2", просто пропусти этот модификатор.
6. Если модификатор не соответствует ни одной характеристике — не включай его в результат. Не угадывай.

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
          for (const mod of modifiers) {
            const nmod = norm(mod);
            const nval = norm(value);
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
            if (!matched) {
              // 4. Modifier contains root of caption or key
              const captionWords = caption.split(/[\s\-\/,()]+/).filter(w => w.length >= 3);
              const keyWords = keyLower.split(/[\s_\-]+/).filter(w => w.length >= 3);
              const roots = [...captionWords, ...keyWords].map(w => w.slice(0, Math.min(w.length, 4)));
              if (roots.some(root => nmod.includes(root))) matched = true;
            }
            if (!matched) {
              // 5. Multi-word modifier: any word matches value or caption
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

    let productContext = '';
    let foundProducts: Product[] = [];
    let brandsContext = '';
    let knowledgeContext = '';
    let articleShortCircuit = false;
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
          console.log(`[Chat] SiteId-fallback SUCCESS: found ${foundProducts.length} product(s), skipping LLM 1`);
        } else {
          console.log(`[Chat] Article-first + SiteId: no results, falling back to normal pipeline`);
        }
     }
    }

    // === TITLE-FIRST SHORT-CIRCUIT via Micro-LLM classifier ===
    // AI determines if message contains a product name and/or price intent
    let priceIntentClarify: { total: number; category: string } | null = null;
    let effectivePriceIntent: string | undefined = undefined;
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
          
          // Step 1: Fetch schema products for the category to build option schema
          const schemaProducts = await searchProductsByCandidate(
            { query: null, brand: null, category: sp.category, min_price: null, max_price: null },
            appSettings.volt220_api_token!, 50
          );
          console.log(`[Chat] Fetched ${schemaProducts.length} schema products for category="${sp.category}"`);
          
          // Step 2: Resolve the NEW modifier (user's answer) against option schema
          const modifiersToResolve = sp.refinementModifiers || [sp.refinementText];
          console.log(`[Chat] Resolving modifiers: ${JSON.stringify(modifiersToResolve)} (from classifier: ${sp.refinementModifiers ? 'yes' : 'no, fallback'})`);
          const { resolved: newFiltersRaw, unresolved: stillUnresolved } = 
            await resolveFiltersWithLLM(schemaProducts, modifiersToResolve, appSettings, classification?.critical_modifiers);
          const newFilters = flattenResolvedFilters(newFiltersRaw);
          console.log(`[Chat] FilterLLM refinement: resolved=${JSON.stringify(newFilters)}, unresolved=${JSON.stringify(stillUnresolved)}`);
          
          // Step 3: Merge with existing filters from slot
          const mergedFilters = { ...sp.resolvedFilters, ...newFilters };
          const mergedQuery = [sp.existingUnresolved, ...stillUnresolved]
            .filter(Boolean).join(' ').trim() || null;
          console.log(`[Chat] Merged filters=${JSON.stringify(mergedFilters)}, mergedQuery="${mergedQuery}"`);
          
          // Step 4: API call with structured filters
          foundProducts = await searchProductsByCandidate(
            { query: mergedQuery, brand: null, category: sp.category, min_price: null, max_price: null },
            appSettings.volt220_api_token!, 50,
            Object.keys(mergedFilters).length > 0 ? mergedFilters : undefined
          );
          foundProducts = foundProducts.slice(0, 15);
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
              console.log(`[Chat] PriceIntent SUCCESS: ${foundProducts.length} products sorted by ${effectivePriceIntent} (total ${priceResult.total})`);
              
              // Mark slot as done
              if (slotResolution) {
                dialogSlots[slotResolution.slotKey] = { ...dialogSlots[slotResolution.slotKey], status: 'done' };
                slotsUpdated = true;
              }
            } else if (priceResult.action === 'clarify') {
              priceIntentClarify = { total: priceResult.total!, category: priceResult.category! };
              articleShortCircuit = true;
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
              const catTitle = (p as any).category?.pagetitle || p.parent_name || 'unknown';
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

            for (const [catName, count] of bucketsToTry) {
              if (count < 2) continue;
              let bucketProducts = rawProducts.filter(p => 
                ((p as any).category?.pagetitle || p.parent_name || 'unknown') === catName
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
              const { resolved: br, unresolved: bu } = await resolveFiltersWithLLM(bucketProducts, modifiers, appSettings, classification?.critical_modifiers);
              console.log(`[Chat] Bucket "${catName}" (${bucketProducts.length}): resolved=${JSON.stringify(flattenResolvedFilters(br))}, unresolved=[${bu.join(', ')}]`);
              
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

              // STAGE 2: Hybrid API call — resolved → options, unresolved → query text
              // Suppress query when LLM resolved ALL modifiers (no unresolved tokens to search by name)
              const suppressQuery = unresolvedMods.length === 0 && Object.keys(resolvedFilters).length > 0;
              const queryText = suppressQuery ? null : (unresolvedMods.length > 0 ? unresolvedMods.join(' ') : null);
              if (suppressQuery) {
                console.log(`[Chat] STAGE 2 query suppressed (LLM resolved all modifiers)`);
              }
              console.log(`[Chat] Category-first STAGE 2: server options=${JSON.stringify(resolvedFilters)}, query="${queryText}"`);
              let serverFiltered = await searchProductsByCandidate(
                { query: queryText, brand: null, category: pluralCategory, min_price: null, max_price: null },
                appSettings.volt220_api_token, 50,
                Object.keys(resolvedFilters).length > 0 ? resolvedFilters : undefined
              );
              console.log(`[Chat] Category-first server-filtered: ${serverFiltered.length} products`);

              if (serverFiltered.length > 0) {
                foundProducts = serverFiltered.slice(0, 15);
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
                    ((p as any).category?.pagetitle || p.parent_name || 'unknown') === altCat
                  );
                  if (altProducts.length < 10 && appSettings.volt220_api_token) {
                    const extra = await searchProductsByCandidate(
                      { query: null, brand: null, category: altCat, min_price: null, max_price: null },
                      appSettings.volt220_api_token, 50
                    );
                    if (extra.length > altProducts.length) altProducts = extra;
                  }
                  const { resolved: altResolvedRaw, unresolved: altUnresolved } = await resolveFiltersWithLLM(altProducts, modifiers, appSettings, classification?.critical_modifiers);
                  const altResolved = flattenResolvedFilters(altResolvedRaw);
                  if (Object.keys(altResolved).length === 0) {
                    console.log(`[Chat] Alt bucket "${altCat}" resolved nothing, skip`);
                    continue;
                  }
                  const altSuppressQuery = altUnresolved.length === 0;
                  const altQuery = altSuppressQuery ? null : (altUnresolved.length > 0 ? altUnresolved.join(' ') : null);
                  if (altSuppressQuery) console.log(`[Chat] STAGE 2 query suppressed (alt-bucket, LLM resolved all)`);
                  const altServer = await searchProductsByCandidate(
                    { query: altQuery, brand: null, category: altCat, min_price: null, max_price: null },
                    appSettings.volt220_api_token, 50,
                    altResolved
                  );
                  console.log(`[Chat] Alt bucket "${altCat}" server-filtered: ${altServer.length} products`);
                  if (altServer.length > 0) {
                    foundProducts = altServer.slice(0, 15);
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
                      foundProducts = bestRelaxed.slice(0, 15);
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
                      foundProducts = textFallback.slice(0, 15);
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
              foundProducts = rawProducts.slice(0, 15);
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
            foundProducts = rawProducts.slice(0, 15);
            articleShortCircuit = true;
            const categoryElapsed = Date.now() - categoryStart;
            console.log(`[Chat] Category-first DECISION: mode=no_modifiers, count=${foundProducts.length}, elapsed=${categoryElapsed}ms`);
          } else {
            const categoryElapsed = Date.now() - categoryStart;
            console.log(`[Chat] Category-first: 0 results for "${effectiveCategory}", elapsed=${categoryElapsed}ms, proceeding to LLM 1`);
          }
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
            replCategory = (originalProduct as any).category?.pagetitle || originalProduct.parent_name || '';
            replModifiers = extractModifiersFromProduct(originalProduct);
            console.log(`[Chat] Replacement: category="${replCategory}", modifiers=[${replModifiers.join(', ')}]`);
          } else if (classification.product_name) {
            // Case 2: Product not in catalog — use classifier's category and extract modifiers from name
            replCategory = effectiveCategory || classification.search_category || '';
            // Extract specs from product name as modifiers
            const nameSpecs = classification.product_name.match(/(\d+\s*(?:Вт|W|В|V|мм|mm|А|A|IP\d+))/gi) || [];
            replModifiers = nameSpecs.map(s => s.replace(/\s+/g, ''));
            // Add type words as modifiers
            const typeWords = classification.product_name
              .replace(/\d+\s*(?:Вт|W|В|V|мм|mm|А|A)/gi, '')
              .replace(/[()[\]\-]/g, ' ')
              .split(/\s+/)
              .filter(w => w.length >= 3 && !/^\d+$/.test(w))
              .slice(0, 2);
            replModifiers.push(...typeWords);
            console.log(`[Chat] Replacement: product NOT found, category="${replCategory}", modifiers=[${replModifiers.join(', ')}]`);
          }
          
          if (replCategory) {
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
                const catTitle = (p as any).category?.pagetitle || p.parent_name || 'unknown';
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
                  ((p as any).category?.pagetitle || p.parent_name || 'unknown') === catName
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
                // STAGE 3: Hybrid API call. Suppress query when LLM resolved ALL modifiers.
                const replSuppressQuery = replUnresolvedMods.length === 0 && Object.keys(replResolvedFilters).length > 0;
                const replQueryText = replSuppressQuery ? null : (replUnresolvedMods.length > 0 ? replUnresolvedMods.join(' ') : null);
                if (replSuppressQuery) console.log(`[Chat] STAGE 2 query suppressed (replacement, LLM resolved all modifiers)`);
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
                      ((p as any).category?.pagetitle || p.parent_name || 'unknown') === altCat
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
                    const altSuppress = altUnresolved.length === 0;
                    const altQ = altSuppress ? null : (altUnresolved.length > 0 ? altUnresolved.join(' ') : null);
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
                  foundProducts = replFiltered.slice(0, 15);
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
                foundProducts = catProducts.slice(0, 15);
                articleShortCircuit = true;
                replacementMeta = { isReplacement: true, original: originalProduct, originalName: classification.product_name, noResults: foundProducts.length === 0 };
                console.log(`[Chat] Replacement: no filters resolved, showing ${foundProducts.length} category products (${Date.now() - replacementStart}ms)`);
              }
            } else if (replRawProducts.length > 0) {
              // No modifiers — show category products
              let catProducts = replRawProducts;
              const originalId = originalProduct?.id;
              if (originalId) catProducts = catProducts.filter(p => p.id !== originalId);
              foundProducts = catProducts.slice(0, 15);
              articleShortCircuit = true;
              replacementMeta = { isReplacement: true, original: originalProduct, originalName: classification.product_name, noResults: foundProducts.length === 0 };
              console.log(`[Chat] Replacement: no modifiers, showing ${foundProducts.length} category products (${Date.now() - replacementStart}ms)`);
            } else {
              replacementMeta = { isReplacement: true, original: null, originalName: classification.product_name, noResults: true };
              console.log(`[Chat] Replacement: 0 products in category "${replCategory}" (${Date.now() - replacementStart}ms)`);
            }
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
      extractedIntent = await generateSearchCandidates(userMessage, aiConfig.apiKeys, historyForContext, aiConfig.url, aiConfig.model, classification?.product_category);
    }
    console.log(`[Chat] AI Intent=${extractedIntent.intent}, Candidates: ${extractedIntent.candidates.length}, ShortCircuit: ${articleShortCircuit}`);

    // ШАГ 2: Поиск в базе знаний (параллельно с другими запросами)
    const knowledgePromise = searchKnowledgeBase(userMessage, 5, appSettings);
    const contactsPromise = (async () => {
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
    
    const [knowledgeResults, contactsInfo, geoResult] = await Promise.all([knowledgePromise, contactsPromise, detectedCityPromise]);
    const detectedCity = geoResult.city;
    const isVPN = geoResult.isVPN;
    const userCountryCode = geoResult.countryCode;
    const userCountry = geoResult.country;
    console.log(`[Chat] GeoIP: city=${detectedCity || 'unknown'}, VPN=${isVPN}, country=${userCountry || 'unknown'} (${userCountryCode || '?'})`);
    console.log(`[Chat] Contacts loaded: ${contactsInfo.length} chars`);
    
    if (knowledgeResults.length > 0) {
      const KB_TOTAL_BUDGET = 15000;
      let kbUsed = 0;
      const kbParts: string[] = [];
      
      for (const r of knowledgeResults) {
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
      
      console.log(`[Chat] Added ${knowledgeResults.length} knowledge entries to context (${kbUsed} chars, budget ${KB_TOTAL_BUDGET})`);
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
          foundProducts = rerankProducts(foundProducts, userMessage);
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
      // Title-first or price-intent answer: товар найден
      const isPriceSort = foundProducts.length > 0 && !detectedArticles.length;
      const productCount = foundProducts.length;
      const fewProducts = productCount <= 7;
      
      if (fewProducts) {
        productInstructions = `
🎯 ТОВАР НАЙДЕН ПО НАЗВАНИЮ — ПОКАЖИ ВСЕ ${productCount} ПОЗИЦИЙ:
${productContext}

🚫 АБСОЛЮТНЫЙ ЗАПРЕТ: ЗАПРЕЩЕНО задавать уточняющие вопросы! Товаров мало (${productCount}) — покажи ВСЕ найденные позиции.
- Покажи каждый товар: название, цена, наличие, ссылка
- Ссылки копируй как есть в формате [Название](URL) — НЕ МЕНЯЙ URL!
- ВАЖНО: если в названии товара есть экранированные скобки \\( и \\) — СОХРАНЯЙ их!

📈 ПОСЛЕ ИНФОРМАЦИИ О ТОВАРЕ — ДОБАВЬ КОНТЕКСТНЫЙ CROSS-SELL:
- Предложи 1 ЛОГИЧЕСКИ СВЯЗАННЫЙ аксессуар
- Тон: профессиональный, без давления`;
      } else {
        productInstructions = `
🎯 НАЙДЕНО ${productCount} ТОВАРОВ ПО НАЗВАНИЮ:
${productContext}

📋 ОБЯЗАТЕЛЬНЫЙ ФОРМАТ ОТВЕТА:
1. Покажи ПЕРВЫЕ 3 наиболее релевантных товара: название, цена, наличие, ссылка
2. Скажи: "Всего нашлось ${productCount} вариантов."
3. Предложи сузить выбор: "Если хотите, могу подобрать точнее — подскажите [тип/характеристика/бренд]"
- Ссылки копируй как есть в формате [Название](URL) — НЕ МЕНЯЙ URL!
- ВАЖНО: если в названии товара есть экранированные скобки \\( и \\) — СОХРАНЯЙ их!
- Тон: профессиональный, без давления
- 🚫 НЕ задавай уточняющий вопрос БЕЗ показа товаров. Всегда сначала показывай 3 товара!`;
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
    
    console.log(`[Chat] Streaming with reasoning: excluded (model=${aiConfig.model})`);
    console.log(`[Chat] Sampling: top_k=1 seed=42 provider=google-ai-studio`);
    const response = await callAIWithKeyFallback(aiConfig.url, aiConfig.apiKeys, {
      model: aiConfig.model,
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
