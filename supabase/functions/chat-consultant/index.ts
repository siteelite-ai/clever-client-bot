import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const VOLT220_API_URL = 'https://220volt.kz/api/products';

// Cached settings from DB
interface CachedSettings {
  volt220_api_token: string | null;
  openrouter_api_key: string | null;
  google_api_key: string | null;
  ai_provider: string;
  ai_model: string;
  system_prompt: string | null;
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
    };
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase
      .from('app_settings')
      .select('volt220_api_token, openrouter_api_key, google_api_key, ai_provider, ai_model, system_prompt')
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
      };
  }
}

// Determine AI endpoint and keys based on settings
// For Google AI Studio, supports multiple comma-separated keys for automatic fallback
function getAIConfig(settings: CachedSettings): { url: string; apiKeys: string[]; model: string } {
  if (settings.ai_provider === 'google') {
    if (!settings.google_api_key) {
      throw new Error('Google AI Studio API key не настроен. Добавьте ключ в Настройках.');
    }
    // Parse comma/newline-separated keys, trim whitespace, filter empty
    const keys = settings.google_api_key
      .split(/[,\n]/)
      .map(k => k.trim())
      .filter(k => k.length > 0);
    if (keys.length === 0) {
      throw new Error('Google AI Studio API key не настроен. Добавьте ключ в Настройках.');
    }
    console.log(`[AIConfig] Google AI Studio: ${keys.length} key(s) configured`);
    return {
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      apiKeys: keys,
      model: settings.ai_model || 'gemini-2.0-flash',
    };
  }

  // Default: OpenRouter (single key)
  if (!settings.openrouter_api_key) {
    throw new Error('OpenRouter API key не настроен. Добавьте ключ в Настройках.');
  }

  return {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    apiKeys: [settings.openrouter_api_key],
    model: settings.ai_model,
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
 * 
 * Pattern: 5+ chars with letters + digits + dashes/dots (e.g. CKK11-012-012-1-K01, MVA25-1-016-C, SQ0206-0071)
 * Also triggered by keywords: "артикул", "арт.", "код товара", "SKU"
 * 
 * Exclusions: IP ratings (IP20, IP44, IP65, IP67, IP68), voltage specs, etc.
 */
function detectArticles(message: string): string[] {
  const exclusions = new Set([
    'ip20', 'ip21', 'ip23', 'ip40', 'ip41', 'ip44', 'ip54', 'ip55', 'ip65', 'ip66', 'ip67', 'ip68',
    'din', 'led', 'usb', 'type', 'wifi', 'hdmi',
  ]);
  
  // Pattern: alphanumeric string with at least one letter AND one digit, containing dashes or dots, 5+ chars total
  // Examples: CKK11-012-012-1-K01, MVA25-1-016-C, SQ0206-0071, ВА47-29
  const articlePattern = /\b([A-ZА-ЯЁa-zа-яё0-9][A-ZА-ЯЁa-zа-яё0-9.\-]{3,}[A-ZА-ЯЁa-zа-яё0-9])\b/g;
  
  const results: string[] = [];
  let match;
  
  // Check for keyword triggers that boost confidence
  const hasKeyword = /артикул|арт\.|код\s*товар|sku/i.test(message);
  
  while ((match = articlePattern.exec(message)) !== null) {
    const candidate = match[1];
    const lower = candidate.toLowerCase();
    
    // Skip exclusions
    if (exclusions.has(lower)) continue;
    
    // Must contain at least one letter AND one digit
    const hasLetter = /[a-zA-ZА-ЯЁа-яё]/.test(candidate);
    const hasDigit = /\d/.test(candidate);
    if (!hasLetter || !hasDigit) continue;
    
    // Must contain at least one dash or dot (SKU separator) OR be preceded by a keyword
    const hasSeparator = /[-.]/.test(candidate);
    if (!hasSeparator && !hasKeyword) continue;
    
    // Must be 5+ characters
    if (candidate.length < 5) continue;
    
    // Skip pure numbers with dots (prices like 5000.00)
    if (/^\d+\.\d+$/.test(candidate)) continue;
    
    results.push(candidate);
  }
  
  if (results.length > 0) {
    console.log(`[ArticleDetect] Found ${results.length} article(s): ${results.join(', ')} (keyword=${hasKeyword})`);
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
}

interface SearchCandidate {
  query: string | null;
  brand: string | null;
  category: string | null;
  min_price: number | null;
  max_price: number | null;
  option_filters?: Record<string, string>; // API option key → value for filtering by characteristics
}

// NO hardcoded option keys! We discover them dynamically from API results.
// See discoverOptionKeys() and two-pass search in searchProductsMulti().

interface ExtractedIntent {
  intent: 'catalog' | 'brands' | 'info' | 'general';
  candidates: SearchCandidate[];
  originalQuery: string;
  usage_context?: string; // Abstract usage context like "для улицы", "в ванную" — passed to final LLM for inline filtering
  english_queries?: string[]; // English translations of search terms generated by intent extractor (eliminates separate translation call)
}

// Генерация поисковых кандидатов через AI с учётом контекста разговора
async function generateSearchCandidates(
  message: string, 
  apiKeys: string[],
  conversationHistory: Array<{ role: string; content: string }> = [],
  aiUrl: string = 'https://openrouter.ai/api/v1/chat/completions',
  aiModel: string = 'meta-llama/llama-3.3-70b-instruct:free'
): Promise<ExtractedIntent> {
  console.log(`[AI Candidates] Extracting search intent from: "${message}"`);
  
  // Формируем контекст из последних сообщений (максимум 6)
  const recentHistory = conversationHistory.slice(-10);
  let historyContext = '';
  if (recentHistory.length > 0) {
    historyContext = `
КОНТЕКСТ РАЗГОВОРА (учитывай при генерации кандидатов!):
${recentHistory.map(m => `${m.role === 'user' ? 'Клиент' : 'Консультант'}: ${m.content.substring(0, 200)}`).join('\n')}

`;
  }
  
  const extractionPrompt = `Ты — система извлечения поисковых намерений для интернет-магазина электроинструментов 220volt.kz.
${historyContext}
АНАЛИЗИРУЙ ТЕКУЩЕЕ сообщение С УЧЁТОМ КОНТЕКСТА РАЗГОВОРА!

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

📖 ДОКУМЕНТАЦИЯ API КАТАЛОГА (220volt.kz/api/products):
Ты ДОЛЖЕН формировать корректные запросы к API. Вот доступные параметры:

| Параметр | Описание | Пример |
|----------|----------|--------|
| query | Текстовый поиск по названию и описанию товара. КОРОТКИЕ запросы (1-2 слова) работают лучше. НЕ передавай общие слова вроде "товары", "продукция", "изделия" — они бесполезны | "дрель", "УШМ", "кабель 3x2.5" |
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
7. Если пользователь упоминает ХАРАКТЕРИСТИКУ — ОБЯЗАТЕЛЬНО помести её в option_filters! НЕ включай характеристики в query!
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

🔄 СИНОНИМЫ ТОВАРОВ — ОБЯЗАТЕЛЬНАЯ ГЕНЕРАЦИЯ ВАРИАНТОВ:
В каталоге один и тот же товар может называться по-разному. Ты ОБЯЗАН генерировать кандидатов с РАЗНЫМИ названиями одного товара!
Примеры:
- "щиток" → кандидаты: {"query":"щиток"}, {"query":"бокс"}, {"query":"щит"}, {"query":"корпус модульный"}
- "удлинитель" → кандидаты: {"query":"удлинитель"}, {"query":"колодка"}, {"query":"сетевой фильтр"}
- "лампочка" → кандидаты: {"query":"лампа"}, {"query":"лампочка"}, {"query":"светодиодная лампа"}
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
        // Store option_filters as-is (human-readable keys like "страна", "цоколь")
        // They will be resolved to actual API keys dynamically via two-pass search
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
      
      // English translations — stored for fallback use only (NOT added to candidates)
      const englishQueries = parsed.english_queries || [];
      if (englishQueries.length > 0) {
        console.log(`[AI Candidates] English queries available for fallback: ${englishQueries.join(', ')}`);
      }
      
      return {
        intent: parsed.intent || 'general',
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
 * SYSTEMIC BROAD CANDIDATE GENERATION
 * 
 * Problem: AI sometimes includes characteristics (E14, 5м, 800Вт) in the query,
 * but the API only searches by product name/description, not by option values.
 * This means "лампа свеча E14" → 0 results, while "лампа свеча" → 142 results.
 * 
 * Solution: Programmatically generate "broad" candidates by stripping queries
 * down to just the core product noun(s). This runs AFTER AI extraction,
 * so it works for ANY query without needing to enumerate characteristics.
 */
/**
/**
 * SYSTEMIC BROAD CANDIDATE GENERATION v3
 * 
 * Two-layer safety net (NO hardcoded option keys!):
 * 1. Strip AI-generated queries to core nouns
 * 2. Extract meaningful product terms directly from the user's ORIGINAL message
 * 
 * option_filters are kept as human-readable keys — they'll be resolved
 * dynamically in searchProductsMulti via two-pass search.
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
    // Context/location words — they belong in usage_context, NOT as search candidates
    'улица', 'улицы', 'улицу', 'улиц', 'баня', 'бани', 'баню', 'бань', 'ванная', 'ванной', 'ванну', 'ванную',
    'гараж', 'гаража', 'гаражу', 'детская', 'детской', 'детскую', 'кухня', 'кухни', 'кухню',
    'производство', 'подвал', 'подвала', 'двор', 'двора', 'сад', 'сада',
    'подойдут', 'подойдет', 'подходит', 'подходят', 'посоветуй', 'посоветуйте', 'порекомендуй',
  ]);
  
  // Normalize: "лампу-свечу" → "лампу свечу", remove punctuation
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
  
  // Extract meaningful words (≥3 chars, not stop words, not numbers/specs)
  const specPattern = /^[a-zA-Z]?\d+[а-яa-z]*$/;
  // Also filter out adjective forms of countries/characteristics — they belong in option_filters
  const adjectivePattern = /^(белорус|росси|кита|казахстан|туре|неме|итальян|польск|японск|накладн|встраив|подвесн|потолочн|настенн)/i;
  const msgWords = normalized.split(' ')
    .filter(w => w.length >= 3 && !stopWords.has(w) && !specPattern.test(w) && !adjectivePattern.test(w));
  
  // Lemmatize
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
 * 
 * Given products with options and human-readable filter requirements,
 * discover the actual API option keys by fuzzy-matching captions.
 * 
 * Example: human filter {"страна": "Беларусь"} + product option {key: "strana_proishoghdeniya__...", caption: "Страна происхождения//..."} 
 * → resolved: {"strana_proishoghdeniya__...": "БЕЛАРУСЬ"}
 */
function discoverOptionKeys(
  products: Product[], 
  humanFilters: Record<string, string>
): Record<string, string> {
  if (!humanFilters || Object.keys(humanFilters).length === 0) return {};
  
  // Collect all unique option keys with their captions and values
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
      // Clean the caption: "Страна происхождения//Өндірілген мемлекеті" → "страна происхождения"
      const cleanCaption = (info.caption.split('//')[0] || '').toLowerCase().trim().replace(/[_\s]+/g, '');
      
      // Score: how well does the human key match the caption?
      let score = 0;
      if (cleanCaption === normalizedKey) {
        score = 100; // exact match
      } else if (cleanCaption.includes(normalizedKey) || normalizedKey.includes(cleanCaption)) {
        score = 80; // substring match
      } else {
        // Check if key words overlap (e.g. "страна" matches "странапроисхождения")
        const keyWords = normalizedKey.split(/[^а-яёa-z0-9]/i).filter(w => w.length >= 3);
        for (const kw of keyWords) {
          if (cleanCaption.includes(kw)) score += 30;
        }
        // Also check API key itself (transliterated): "strana" ≈ "страна"
        const apiKeyLower = apiKey.toLowerCase();
        for (const kw of keyWords) {
          // Simple transliteration check: first 4 chars
          if (apiKeyLower.includes(kw.substring(0, 4).replace(/а/g, 'a').replace(/с/g, 's').replace(/т/g, 't').replace(/р/g, 'r').replace(/н/g, 'n'))) {
            score += 20;
          }
        }
      }
      
      if (score <= 0) continue;
      
      // Now find the best matching value
      for (const rawVal of info.values) {
        const cleanVal = (rawVal.split('//')[0] || '').trim();
        const lowerVal = cleanVal.toLowerCase();
        
        let valScore = 0;
        if (lowerVal === normalizedValue) {
          valScore = 100;
        } else if (lowerVal.includes(normalizedValue) || normalizedValue.includes(lowerVal)) {
          valScore = 80;
        } else if (lowerVal.toUpperCase() === humanValue.toUpperCase()) {
          valScore = 90;
        }
        
        const totalScore = score + valScore;
        if (totalScore > (bestMatch?.score || 0) && valScore > 0) {
          bestMatch = { apiKey, matchedValue: cleanVal, score: totalScore };
        }
      }
      
      // If we matched the KEY but couldn't match the VALUE, still use the key with original value
      if (score >= 80 && !bestMatch) {
        bestMatch = { apiKey, matchedValue: humanValue.toUpperCase(), score };
      }
    }
    
    if (bestMatch) {
      resolved[bestMatch.apiKey] = bestMatch.matchedValue;
      console.log(`[Discovery] "${humanKey}=${humanValue}" → API key "${bestMatch.apiKey}"="${bestMatch.matchedValue}" (score=${bestMatch.score})`);
    } else {
      console.log(`[Discovery] "${humanKey}=${humanValue}" → no matching API key found among ${optionIndex.size} options`);
    }
  }
  
  return resolved;
}

// Простой fallback если AI недоступен — передаём запрос как есть
function fallbackParseQuery(message: string): ExtractedIntent {
  const lowerMessage = message.toLowerCase();
  
  const infoKeywords = ['доставка', 'оплата', 'гарантия', 'возврат', 'адрес', 'телефон', 'контакт', 'режим работы', 'филиал', 'самовывоз', 'пункт выдачи', 'где находи'];
  const greetingWords = ['привет', 'здравствуй', 'добрый', 'хай', 'hello', 'hi', 'салем'];
  
  if (greetingWords.some(g => lowerMessage.startsWith(g)) && message.length < 30) {
    return { intent: 'general', candidates: [], originalQuery: message };
  }
  
  if (infoKeywords.some(k => lowerMessage.includes(k))) {
    return { intent: 'info', candidates: [], originalQuery: message };
  }
  
  const cleanQuery = message.replace(/[?!.,]+/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    intent: 'catalog',
    candidates: cleanQuery.length > 1 ? [{ query: cleanQuery, brand: null, category: null, min_price: null, max_price: null }] : [],
    originalQuery: message
  };
}


// Поиск товаров по одному кандидату — параметры уже сформированы AI
// resolvedApiFilters are ACTUAL API keys (discovered dynamically), not human-readable
async function searchProductsByCandidate(
  candidate: SearchCandidate, 
  apiToken: string,
  limit: number = 20,
  resolvedApiFilters?: Record<string, string>
): Promise<Product[]> {
  try {
    const params = new URLSearchParams();
    
    if (candidate.query) {
      params.append('query', candidate.query);
    }
    params.append('per_page', limit.toString());
    
    if (candidate.brand) {
      params.append('options[brend__brend][]', candidate.brand);
    }
    
    if (candidate.category) {
      params.append('category', candidate.category);
    }
    
    if (candidate.min_price) {
      params.append('min_price', candidate.min_price.toString());
    }
    
    if (candidate.max_price) {
      params.append('max_price', candidate.max_price.toString());
    }
    
    // Pass RESOLVED (actual API) option filters — these come from dynamic discovery
    if (resolvedApiFilters) {
      for (const [optionKey, optionValue] of Object.entries(resolvedApiFilters)) {
        params.append(`options[${optionKey}][]`, optionValue);
        console.log(`[Search] API option filter: ${optionKey}=${optionValue}`);
      }
    }
    
    console.log(`[Search] API params: ${params.toString()}`);

    const response = await fetch(`${VOLT220_API_URL}?${params}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.error(`[Search] API error: ${response.status}`);
      return [];
    }

    const rawData = await response.json();
    const data = rawData.data || rawData;
    
    console.log(`[Search] Found ${data.results?.length || 0} products for "${candidate.query}"`);
    
    return data.results || [];
  } catch (error) {
    console.error(`[Search] Error for "${candidate.query}":`, error);
    return [];
  }
}

/**
 * TWO-PASS SEARCH with dynamic option key discovery
 * 
 * Pass 1: Broad search WITHOUT option filters → get products with their options
 * Pass 2: Discover actual API keys from product options, then re-search WITH filters
 * 
 * This means we NEVER need to hardcode any option key mappings!
 */
async function searchProductsMulti(
  candidates: SearchCandidate[],
  limit: number = 10,
  apiTokenOverride?: string
): Promise<Product[]> {
  const apiToken = apiTokenOverride || Deno.env.get('VOLT220_API_TOKEN');
  
  if (!apiToken) {
    console.error('[Search] VOLT220_API_TOKEN is not configured');
    return [];
  }

  if (candidates.length === 0) {
    console.log('[Search] No candidates to search');
    return [];
  }

  // per_page for each API call — cast a wide net, then deduplicate & slice at the end
  const perPage = Math.max(limit, 30);

  // Убираем category из всех кандидатов
  const cleanedCandidates = candidates.map(c => ({ ...c, category: null }));
  
  // Check if any candidates have human-readable option_filters that need resolution
  const humanFilters = cleanedCandidates.find(c => c.option_filters)?.option_filters || {};
  const hasHumanFilters = Object.keys(humanFilters).length > 0;
  
  console.log(`[Search] Searching ${cleanedCandidates.length} candidates (perPage=${perPage}, finalLimit=${limit}), humanFilters: ${JSON.stringify(humanFilters)}`);

  // === PASS 1: Broad search WITHOUT option filters ===
  // This gets us products whose `options` we can inspect to discover real API keys
  const pass1Candidates = cleanedCandidates.map(c => ({ ...c, option_filters: undefined }));
  // Deduplicate pass1 candidates by query+brand
  const seen1 = new Set<string>();
  const uniquePass1 = pass1Candidates.filter(c => {
    const key = `${c.query || ''}|${c.brand || ''}`;
    if (seen1.has(key)) return false;
    seen1.add(key);
    return true;
  });
  
  // === OPTIMIZATION: Limit parallel API calls to max 6 to avoid overload ===
  const cappedPass1 = uniquePass1.slice(0, 6);
  if (uniquePass1.length > 6) {
    console.log(`[Search] Capped candidates from ${uniquePass1.length} to 6`);
  }
  
  const pass1Promises = cappedPass1.map(candidate => 
    searchProductsByCandidate(candidate, apiToken, perPage)
  );
  const pass1Results = await Promise.all(pass1Promises);
  
  // Collect all products from pass 1
  const productMap = new Map<number, Product>();
  for (const products of pass1Results) {
    for (const product of products) {
      if (!productMap.has(product.id)) {
        productMap.set(product.id, product);
      }
    }
  }
  
  console.log(`[Search] Pass 1 (broad): ${productMap.size} unique products`);
  
  // === PASS 2: If we have human filters, discover API keys and re-search ===
  if (hasHumanFilters && productMap.size > 0) {
    const resolvedFilters = discoverOptionKeys(Array.from(productMap.values()), humanFilters);
    
    if (Object.keys(resolvedFilters).length > 0) {
      console.log(`[Search] Pass 2: Discovered ${Object.keys(resolvedFilters).length} API filters, re-searching...`);
      
      // Store resolved filters on candidates for describeAppliedFilters
      for (const c of cleanedCandidates) {
        c.option_filters = resolvedFilters;
      }
      
      // Re-search with actual API filters — only unique query+brand combos
      const seen2 = new Set<string>();
      const pass2Candidates = cleanedCandidates.filter(c => {
        if (!c.query && !c.brand) return false;
        const key = `${c.query || ''}|${c.brand || ''}`;
        if (seen2.has(key)) return false;
        seen2.add(key);
        return true;
      });
      
      const pass2Promises = pass2Candidates.map(candidate => 
        searchProductsByCandidate(candidate, apiToken, perPage, resolvedFilters)
      );
      const pass2Results = await Promise.all(pass2Promises);
      
      // Replace results with filtered ones (pass 2 is more precise)
      const filteredMap = new Map<number, Product>();
      for (const products of pass2Results) {
        for (const product of products) {
          if (!filteredMap.has(product.id)) {
            filteredMap.set(product.id, product);
          }
        }
      }
      
      if (filteredMap.size > 0) {
        console.log(`[Search] Pass 2 (filtered): ${filteredMap.size} products (replaced pass 1 results)`);
        productMap.clear();
        for (const [id, product] of filteredMap) {
          productMap.set(id, product);
        }
      } else {
        console.log(`[Search] Pass 2 returned 0 results, keeping pass 1 results (AI will post-filter by characteristics)`);
      }
    } else {
      console.log(`[Search] Could not discover API keys for filters, AI will post-filter by characteristics`);
    }
  }
  
  // Fallback: if 0 results and had brand/price filters, try without
  if (productMap.size === 0) {
    const queryOnlyCandidates = cleanedCandidates.filter(c => c.query && (c.brand || c.min_price || c.max_price));
    if (queryOnlyCandidates.length > 0) {
      console.log(`[Search] 0 results with filters, trying fallback with query only...`);
      const fallbackPromises = queryOnlyCandidates.map(c => 
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
  
  const uniqueProducts = Array.from(productMap.values());
  console.log(`[Search] Total unique products: ${uniqueProducts.length}`);
  
  // Sort: priority to products with query in title, then availability, then price
  const queryWords = candidates
    .map(c => c.query?.toLowerCase())
    .filter(Boolean) as string[];
  
  uniqueProducts.sort((a, b) => {
    const aInTitle = queryWords.some(q => a.pagetitle.toLowerCase().includes(q));
    const bInTitle = queryWords.some(q => b.pagetitle.toLowerCase().includes(q));
    if (aInTitle && !bInTitle) return -1;
    if (!aInTitle && bInTitle) return 1;
    if (a.amount > 0 && b.amount === 0) return -1;
    if (a.amount === 0 && b.amount > 0) return 1;
    return a.price - b.price;
  });
  
  return uniqueProducts.slice(0, limit);
}

/**
 * TRANSLATION FALLBACK: Translate Russian search terms to English
 * 
 * Some products in the catalog use English names (e.g. "corn" for кукуруза-type lamps).
 * When Russian search yields 0 results, we translate and retry.
 * Uses AI for accurate contextual translation.
 */
async function translateSearchTerms(
  queries: string[],
  aiUrl: string,
  apiKeys: string[],
  aiModel: string
): Promise<string[]> {
  if (queries.length === 0) return [];
  
  const uniqueQueries = [...new Set(queries.filter(q => q && q.trim().length > 0))];
  if (uniqueQueries.length === 0) return [];
  
  // Skip if queries are already in English
  const hasRussian = uniqueQueries.some(q => /[а-яёА-ЯЁ]/.test(q));
  if (!hasRussian) {
    console.log(`[Translate] Queries already in English, skipping`);
    return [];
  }
  
  console.log(`[Translate] Translating ${uniqueQueries.length} queries to English: ${uniqueQueries.join(', ')}`);
  
  try {
    const response = await callAIWithKeyFallback(aiUrl, apiKeys, {
      model: aiModel,
      messages: [
        { 
          role: 'system', 
          content: `Ты переводчик терминов для поиска товаров в каталоге электроинструментов и оборудования. 
Переведи каждый поисковый запрос на английский язык. 
Учитывай контекст электротоваров: "кукуруза" → "corn" (тип лампы), "свеча" → "candle" (тип лампы), "груша" → "pear" (тип лампы).
Возвращай ТОЛЬКО переводы, по одному на строку, в том же порядке что и входные запросы.
Если слово уже на английском — верни его как есть.
Если у термина есть несколько возможных переводов — верни самый вероятный для контекста электротоваров.`
        },
        { role: 'user', content: uniqueQueries.join('\n') }
      ],
    }, 'Translate');
    
    if (!response.ok) {
      console.error(`[Translate] AI error: ${response.status}`);
      return [];
    }
    
    const data = await response.json();
    const translatedText = data.choices?.[0]?.message?.content || '';
    const translated = translatedText
      .split('\n')
      .map((line: string) => line.trim().toLowerCase())
      .filter((line: string) => line.length > 0 && /[a-z]/.test(line));
    
    console.log(`[Translate] Results: ${translated.join(', ')}`);
    return translated;
  } catch (error) {
    console.error(`[Translate] Error:`, error);
    return [];
  }
}

/**
 * Search with English translation fallback.
 * 
 * Instead of only triggering when ALL results are 0, we check which individual
 * query terms returned 0 results. If any "zero-result" terms exist, we translate
 * them to English and merge additional results.
 */
async function searchWithTranslationFallback(
  candidates: SearchCandidate[],
  limit: number,
  apiToken: string | undefined,
  aiUrl: string,
  apiKeys: string[],
  aiModel: string
): Promise<Product[]> {
  // First: normal search
  const results = await searchProductsMulti(candidates, limit, apiToken);
  
  // === OPTIMIZATION: Skip translation if we already have enough products ===
  // Translation is only useful when the main search found NOTHING or very little.
  // If we have ≥3 products, translation won't add meaningful value — it just wastes 4-6 seconds.
  if (results.length >= 3) {
    console.log(`[Translate] Skipping — already found ${results.length} products`);
    return results;
  }
  
  // Extract unique query terms to check which ones found nothing
  const queries = candidates
    .map(c => c.query)
    .filter((q): q is string => q !== null && q !== undefined && q.trim().length > 0);
  
  if (queries.length === 0) return results;
  
  // Find terms that individually returned 0 results by testing each unique word
  const allWords = new Set<string>();
  for (const q of queries) {
    for (const word of q.toLowerCase().split(/\s+/)) {
      const cleaned = word.replace(/[^а-яёa-z0-9]/gi, '');
      if (cleaned.length > 2) allWords.add(cleaned);
    }
  }
  
  // Check which words appear in ANY result title/content
  const resultTitles = results.map(p => p.pagetitle.toLowerCase()).join(' ');
  const resultContent = results.map(p => (p.content || '').toLowerCase()).join(' ');
  const allResultText = resultTitles + ' ' + resultContent;
  
  // Words that didn't match anything in results — these are candidates for translation
  const zeroMatchWords = [...allWords].filter(word => {
    const stem = word.replace(/(а|у|ы|и|е|о|ё|я|ь|ъ|ой|ий|ый|ая|ое|ые)$/i, '');
    return !allResultText.includes(word) && (stem.length < 3 || !allResultText.includes(stem));
  });
  
  if (zeroMatchWords.length === 0) {
    return results; // All terms matched something
  }
  
  // Skip common Russian words that are NOT product names — these waste translation time
  const skipWords = new Set([
    'лампа', 'лампы', 'ламп', 'светильник', 'кабель', 'провод', 'розетк', 'выключател', 'автомат', 'щит',
    // Pronouns, verbs, prepositions — NEVER translate these
    'какую', 'какой', 'какая', 'какие', 'каком', 'каких', 'какого',
    'купить', 'покупк', 'нужен', 'нужна', 'нужно', 'подбер', 'подобр', 'покажи', 'найди',
    'улиц', 'улице', 'улицы', 'ванну', 'ванной', 'гараж', 'дачи', 'дачу', 'кухни', 'кухню',
    'дома', 'домой', 'квартир', 'офис', 'склад', 'цеха', 'цехе',
    'хочу', 'можно', 'лучше', 'подходит', 'стоит', 'посоветуй',
  ]);
  const wordsToTranslate = zeroMatchWords.filter(w => !skipWords.has(w));
  
  if (wordsToTranslate.length === 0) {
    return results;
  }
  
  console.log(`[Translate] Zero-match words found: ${wordsToTranslate.join(', ')} — translating to English`);
  
  const translatedQueries = await translateSearchTerms(wordsToTranslate, aiUrl, apiKeys, aiModel);
  if (translatedQueries.length === 0) return results;
  
  const translatedCandidates: SearchCandidate[] = translatedQueries.map(q => ({
    query: q,
    brand: candidates[0]?.brand || null,
    category: null,
    min_price: candidates[0]?.min_price || null,
    max_price: candidates[0]?.max_price || null,
    option_filters: candidates[0]?.option_filters,
  }));
  
  const commonProductWords = [...allWords].filter(w => !wordsToTranslate.includes(w));
  if (commonProductWords.length > 0 && translatedQueries.length > 0) {
    for (const translated of translatedQueries) {
      for (const productWord of commonProductWords.slice(0, 2)) {
        translatedCandidates.push({
          query: `${productWord} ${translated}`,
          brand: candidates[0]?.brand || null,
          category: null,
          min_price: candidates[0]?.min_price || null,
          max_price: candidates[0]?.max_price || null,
        });
      }
    }
  }
  
  console.log(`[Search] Retrying with English translations: ${translatedCandidates.map(c => c.query).join(', ')}`);
  const translatedResults = await searchProductsMulti(translatedCandidates, limit, apiToken);
  
  if (translatedResults.length > 0) {
    console.log(`[Search] Translation fallback found ${translatedResults.length} products!`);
    const mergedMap = new Map<number, Product>();
    for (const p of translatedResults) mergedMap.set(p.id, p);
    for (const p of results) { if (!mergedMap.has(p.id)) mergedMap.set(p.id, p); }
    return Array.from(mergedMap.values()).slice(0, limit);
  }
  
  return results;
}

// Возвращает URL как есть (тестовый домен для тестирования)
function toProductionUrl(url: string): string {
  return url;
}

// Prefixes to exclude from product characteristics (service/internal fields)
// Using prefix matching to handle bilingual key suffixes (e.g. novinka__ghaңa)
const EXCLUDED_OPTION_PREFIXES = [
  'kodnomenklatury',          // internal ID
  'identifikator_sayta',      // site identifier  
  'edinica_izmereniya',       // unit of measurement
  'garantiynyy_srok',         // warranty (shown separately if needed)
  'brend__brend',             // already shown separately as brand
  'fayl',                     // internal file path
  'kod_tn_ved',               // customs code
  'poiskovyy_zapros',         // internal search terms
  'novinka',                  // internal flag
  'obyem',                    // internal volume
  'obem',                     // internal volume (alt spelling)
  'ogranichennyy_prosmotr',   // internal flag
  'populyarnyy',              // internal flag
  'prodaetsya_to',            // "sold only in group packaging" flag
  'tovar_internet_magazina',  // internal flag
  'soputstvuyuschiy',         // related product ID
  'opisaniefayla',            // file description
  'naimenovanie_na_kazahskom', // Kazakh name (redundant)
];

function isExcludedOption(key: string): boolean {
  return EXCLUDED_OPTION_PREFIXES.some(prefix => key.startsWith(prefix));
}

// Clean bilingual option values: "Нет//Жоқ" → "Нет", "ПВХ пластикат//ПВХ пластикат" → "ПВХ пластикат"
function cleanOptionValue(value: string): string {
  if (!value) return value;
  const parts = value.split('//');
  return parts[0].trim();
}

// Clean bilingual caption: "Бронированный//Сауытты" → "Бронированный"
function cleanOptionCaption(caption: string): string {
  if (!caption) return caption;
  const parts = caption.split('//');
  return parts[0].trim();
}

/**
 * AI POST-FILTERING BY USAGE CONTEXT (Dynamic Intent Mapping)
 * 
 * When user specifies an abstract usage context ("для улицы", "в ванную"),
 * we can't pre-guess which specific option values match. Instead:
 * 1. Broad search returns products with ALL their options
 * 2. We extract ALL unique option key→values from results
 * 3. AI analyzes which products match the usage context based on real data
 */
async function aiFilterProductsByIntent(
  products: Product[],
  usageContext: string,
  originalQuery: string,
  aiUrl: string,
  apiKeys: string[],
  aiModel: string
): Promise<{ filtered: Product[]; reasoning: string }> {
  if (products.length === 0 || !usageContext) return { filtered: products, reasoning: '' };
  
  console.log(`[AI Filter] Filtering ${products.length} products by usage context: "${usageContext}"`);
  
  // Build compact product list with ONLY relevant options (max 8 per product)
  const productList = products.map((p) => {
    const opts = (p.options || [])
      .filter(o => !isExcludedOption(o.key))
      .map(o => `${cleanOptionCaption(o.caption)}=${cleanOptionValue(o.value)}`)
      .slice(0, 8);
    return `ID=${p.id}: "${p.pagetitle}" | ${opts.join('; ')}`;
  }).join('\n');
  
  console.log(`[AI Filter] Sending ${products.length} products for filtering`);
  
  const filterPrompt = `Ты эксперт по электротоварам. Выбери товары подходящие для контекста: ${usageContext}

ТОВАРЫ:
${productList}

Выбери ТОЛЬКО подходящие (минимум 2 если есть). Если невозможно определить — верни все.`;

  try {
    const response = await callAIWithKeyFallback(aiUrl, apiKeys, {
      model: aiModel,
      messages: [
        { role: 'system', content: filterPrompt },
        { role: 'user', content: `Выбери подходящие товары для контекста: ${usageContext}` }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'filter_products',
            description: 'Возвращает список ID товаров, подходящих для указанного контекста использования',
            parameters: {
              type: 'object',
              properties: {
                suitable_product_ids: {
                  type: 'array',
                  items: { type: 'number' },
                  description: 'Массив ID товаров, подходящих для контекста использования'
                },
                reasoning: {
                  type: 'string',
                  description: 'Краткое объяснение, по каким характеристикам были отобраны товары (1-2 предложения на русском)'
                }
              },
              required: ['suitable_product_ids', 'reasoning'],
              additionalProperties: false
            }
          }
        }
      ],
      tool_choice: { type: 'function', function: { name: 'filter_products' } },
    }, 'AI Filter');

    if (!response.ok) {
      console.error(`[AI Filter] API error: ${response.status}`);
      return { filtered: products, reasoning: '' };
    }

    const data = await response.json();
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    
    if (toolCall?.function?.arguments) {
      const parsed = JSON.parse(toolCall.function.arguments);
      const suitableIds = new Set<number>(parsed.suitable_product_ids || []);
      const reasoning = parsed.reasoning || '';
      
      console.log(`[AI Filter] AI selected ${suitableIds.size}/${products.length} products. Reasoning: ${reasoning}`);
      
      if (suitableIds.size === 0) {
        console.log(`[AI Filter] AI returned 0 — safety fallback to all`);
        return { filtered: products, reasoning: '' };
      }
      
      const filtered = products.filter(p => suitableIds.has(p.id));
      
      if (filtered.length === 0) {
        console.log(`[AI Filter] No ID matches — safety fallback to all`);
        return { filtered: products, reasoning: '' };
      }
      
      console.log(`[AI Filter] Result: ${filtered.length} products match usage context`);
      return { filtered, reasoning };
    }
    
    return { filtered: products, reasoning: '' };
  } catch (error) {
    console.error(`[AI Filter] Error:`, error);
    return { filtered: products, reasoning: '' };
  }
}

// Форматирование товаров для AI с кликабельными ссылками и характеристиками
function formatProductsForAI(products: Product[]): string {
  if (products.length === 0) {
    return 'Товары не найдены в каталоге.';
  }

  return products.map((p, i) => {
    // Приоритет: brend__brend (бренд) > vendor (производитель/завод)
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
    
    // Формируем название как ссылку в markdown (заменяем тестовый домен на продакшн)
    // Экранируем скобки в названии товара, чтобы не ломать markdown-ссылку
    const productUrl = toProductionUrl(p.url).replace(/\(/g, '%28').replace(/\)/g, '%29');
    const safeName = p.pagetitle.replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    const nameWithLink = `[${safeName}](${productUrl})`;
    
    const parts = [
      `${i + 1}. **${nameWithLink}**`,
      `   - Цена: ${p.price.toLocaleString('ru-KZ')} ₸${p.old_price && p.old_price > p.price ? ` ~~${p.old_price.toLocaleString('ru-KZ')} ₸~~` : ''}`,
      brand ? `   - Бренд: ${brand}` : '',
      p.article ? `   - Артикул: ${p.article}` : '',
      `   - В наличии: ${p.amount > 0 ? `Да (${p.amount} шт.)` : 'Под заказ'}`,
      p.category ? `   - Категория: [${p.category.pagetitle}](https://220volt.kz/catalog/${p.category.id})` : '',
    ];
    
    // Add product characteristics from options (excluding service fields)
    if (p.options && p.options.length > 0) {
      const specs = p.options
        .filter(o => !isExcludedOption(o.key))
        .map(o => `${cleanOptionCaption(o.caption)}: ${cleanOptionValue(o.value)}`)
        .slice(0, 15); // max 15 characteristics per product (increased from 10)
      
      if (specs.length > 0) {
        parts.push(`   - Характеристики: ${specs.join('; ')}`);
      }
    }
    
    return parts.filter(Boolean).join('\n');
  }).join('\n\n');
}

// Describe which option filters were applied to help AI explain results to user
function describeAppliedFilters(candidates: SearchCandidate[]): string {
  const filters: string[] = [];
  const seen = new Set<string>();
  
  for (const candidate of candidates) {
    if (!candidate.option_filters) continue;
    for (const [key, value] of Object.entries(candidate.option_filters)) {
      // Clean the key for display: remove transliterated suffixes
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

// Извлекаем уникальные бренды из товаров
function extractBrandsFromProducts(products: Product[]): string[] {
  const brands = new Set<string>();
  
  for (const product of products) {
    // Приоритет: brend__brend (настоящий бренд) > vendor (завод-производитель)
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
    // Только если нет brend__brend — используем vendor
    if (!found && product.vendor && product.vendor.trim()) {
      brands.add(product.vendor.trim());
    }
  }
  
  return Array.from(brands).sort();
}

// Format contacts from knowledge base text into clean display format with clickable links
// IMPORTANT: Show only GENERAL company contacts (main phones, WhatsApp, email), NOT all branch details
function formatContactsForDisplay(contactsText: string): string | null {
  if (!contactsText || contactsText.trim().length === 0) return null;
  
  const lines: string[] = [];
  const seen = new Set<string>(); // deduplicate
  
  // Extract unique phones — make them clickable tel: links
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
      if (lines.filter(l => l.startsWith('📞')).length >= 2) break; // max 2 phones
    }
  }
  
  // Extract WhatsApp — deduplicated
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
  
  // Extract unique email — max 1
  const emailMatch = contactsText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) {
    lines.push(`📧 [${emailMatch[0]}](mailto:${emailMatch[0]})`);
  }
  
  if (lines.length === 0) return null;
  
  return `**Наши контакты:**\n${lines.join('\n')}`;
}

// Simple in-memory rate limiter (per IP, resets on cold start)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 20; // max requests per window
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute

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

// === SECURITY: Input sanitization ===
function sanitizeUserInput(input: string): string {
  if (!input || typeof input !== 'string') return '';
  
  let sanitized = input;
  
  // Remove HTML tags (script, iframe, img with onerror, svg with onload, etc.)
  sanitized = sanitized.replace(/<\/?[a-z][^>]*>/gi, '');
  
  // Remove event handlers (onerror=, onload=, onclick=, etc.)
  sanitized = sanitized.replace(/\bon\w+\s*=/gi, '');
  
  // Remove javascript: protocol
  sanitized = sanitized.replace(/javascript\s*:/gi, '');
  
  // Remove data: protocol (can be used for XSS)
  sanitized = sanitized.replace(/data\s*:\s*text\/html/gi, '');
  
  // Limit message length (prevent abuse)
  sanitized = sanitized.substring(0, 2000);
  
  // Trim whitespace
  sanitized = sanitized.trim();
  
  return sanitized;
}

// IP-based city detection with VPN/proxy awareness
interface GeoResult {
  city: string | null;
  isVPN: boolean;
  country: string | null;      // e.g. "Россия", "Казахстан"
  countryCode: string | null;  // e.g. "RU", "KZ"
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
    
    // Если VPN/прокси обнаружен — не доверяем геолокации
    if (isVPN) {
      console.log(`[GeoIP] VPN/proxy detected for IP ${ip} (proxy=${data.proxy}, hosting=${data.hosting}), city=${data.city}`);
      return { city: null, isVPN: true, country: data.country || null, countryCode: data.countryCode || null };
    }
    
    // Россия — реальный пользователь, но из другой страны
    if (data.countryCode === 'RU') {
      console.log(`[GeoIP] Russian user detected: ${data.city}, ${data.country}`);
      return { city: data.city || null, isVPN: false, country: data.country, countryCode: 'RU' };
    }
    
    // Другие страны (не KZ, не RU) — скорее всего VPN
    if (data.countryCode && data.countryCode !== 'KZ') {
      console.log(`[GeoIP] Non-KZ/RU country detected: ${data.country} (${data.countryCode}), city=${data.city} — treating as VPN`);
      return { city: null, isVPN: true, country: data.country || null, countryCode: data.countryCode || null };
    }
    
    if (data.status === 'success' && data.city) {
      console.log(`[GeoIP] Detected city: ${data.city}, region: ${data.regionName}, country: ${data.country}`);
      return { city: data.city, isVPN: false, country: data.country, countryCode: 'KZ' };
    }
    return empty;
  } catch (e) {
    console.warn('[GeoIP] Detection failed:', e);
    return { city: null, isVPN: false, country: null, countryCode: null };
  }
}


// Smart excerpt extraction: find the MOST RELEVANT sections of a long document
// For long documents, extracts MULTIPLE non-overlapping windows to cover different sections
function extractRelevantExcerpt(content: string, query: string, maxLen: number = 2000): string {
  // If content is short enough, return as-is
  if (content.length <= maxLen) return content;

  // Extract meaningful keywords from the query (>2 chars, no stop words)
  const stopWords = new Set(['как', 'что', 'где', 'когда', 'почему', 'какой', 'какая', 'какие', 'это', 'для', 'при', 'или', 'так', 'вот', 'можно', 'есть', 'ваш', 'мне', 'вам', 'нас', 'вас', 'они', 'она', 'оно', 'его', 'неё', 'них', 'будет', 'быть', 'если', 'уже', 'ещё', 'еще', 'тоже', 'также', 'только', 'очень', 'просто', 'нужно', 'надо']);
  const words = query.toLowerCase()
    .split(/[^а-яёa-z0-9]+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  if (words.length === 0) return content.substring(0, maxLen);

  // Score each window position by keyword density
  const lowerContent = content.toLowerCase();
  const windowSize = 1500; // each window
  const step = 200;
  
  // Collect all scored windows
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

  // Sort by score descending
  scoredWindows.sort((a, b) => b.score - a.score);

  // For long documents (>10K), take up to 3 non-overlapping windows
  // For shorter ones, take 1 window
  const numWindows = content.length > 10000 ? 3 : 1;
  const totalBudget = maxLen; // total chars budget
  const perWindowBudget = Math.floor(totalBudget / numWindows);

  const selectedWindows: { start: number; score: number }[] = [];
  
  for (const w of scoredWindows) {
    if (selectedWindows.length >= numWindows) break;
    // Check non-overlap with already selected windows
    const overlaps = selectedWindows.some(sel => 
      Math.abs(sel.start - w.start) < perWindowBudget
    );
    if (!overlaps) {
      selectedWindows.push(w);
    }
  }

  // Sort selected windows by position in document (for coherent reading order)
  selectedWindows.sort((a, b) => a.start - b.start);

  // Build the final excerpt from multiple windows
  const parts: string[] = [];
  for (const w of selectedWindows) {
    // Snap to nearest paragraph boundary
    let snapStart = w.start;
    if (snapStart > 0) {
      const lookBack = content.substring(Math.max(0, snapStart - 200), snapStart);
      const sectionMatch = lookBack.lastIndexOf('\n\n');
      if (sectionMatch >= 0) {
        snapStart = Math.max(0, snapStart - 200) + sectionMatch + 2;
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

  // Rate limiting by IP
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
    const useStreaming = body.stream !== false; // Default to streaming, but allow non-streaming
    
    // Support both formats: { messages } and { message, history, sessionId }
    let messages: Array<{ role: string; content: string }>;
    let conversationId: string;
    
    if (body.messages) {
      // Format from admin panel / internal calls
      messages = body.messages;
      conversationId = body.conversationId || Date.now().toString();
    } else if (body.message) {
      // Format from embed widget
      const history = body.history || [];
      messages = [...history, { role: 'user', content: body.message }];
      conversationId = body.sessionId || Date.now().toString();
    } else {
      throw new Error('Invalid request format: missing messages or message');
    }
    
    // Load settings from DB (API keys, model selection)
    const appSettings = await getAppSettings();
    const aiConfig = getAIConfig(appSettings);
    
    console.log(`[Chat] AI Provider: ${aiConfig.url.includes('openrouter') ? 'OpenRouter' : 'Lovable AI'}, Model: ${aiConfig.model}`);

    const lastMessage = messages[messages.length - 1];
    const rawUserMessage = lastMessage?.content || '';
    
    // === SECURITY: Sanitize user input ===
    const userMessage = sanitizeUserInput(rawUserMessage);
    
    // Sanitize all history messages from user
    messages = messages.map(m => ({
      ...m,
      content: m.role === 'user' ? sanitizeUserInput(m.content) : m.content
    }));
    
    console.log(`[Chat] Processing: "${userMessage.substring(0, 100)}"`);
    console.log(`[Chat] Conversation ID: ${conversationId}`);

    // Подготавливаем историю для контекста (без текущего сообщения)
    const historyForContext = messages.slice(0, -1);

    // Геолокация по IP (параллельно с остальными запросами)
    const detectedCityPromise = detectCityByIP(clientIp);

    // ШАГ 1: AI определяет интент и генерирует поисковые кандидаты (никакого хардкода)
    const extractedIntent = await generateSearchCandidates(userMessage, aiConfig.apiKeys, historyForContext, aiConfig.url, aiConfig.model);
    console.log(`[Chat] AI Intent=${extractedIntent.intent}, Candidates: ${extractedIntent.candidates.length}`);

    let productContext = '';
    let foundProducts: Product[] = [];
    let brandsContext = '';
    let knowledgeContext = '';

    // ШАГ 2: Поиск в базе знаний (параллельно с другими запросами)
    // Ищем для ВСЕХ запросов — статьи могут быть полезны даже когда товаров нет в каталоге
    const knowledgePromise = searchKnowledgeBase(userMessage, 5, appSettings);
    // Загружаем контакты из ОБОИХ записей: структурированные + скрапнутые с сайта
    const contactsPromise = (async () => {
      const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
      const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return '';
      try {
        const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        // Ищем все записи с контактами (структурированные + с сайта)
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
      knowledgeContext = `
📚 ИНФОРМАЦИЯ ИЗ БАЗЫ ЗНАНИЙ (используй для ответа!):

${knowledgeResults.map((r, i) => {
        // Send FULL content — no truncation, LLM can handle it
        return `--- ${r.title} ---
${r.content}
${r.source_url ? `Источник: ${r.source_url}` : ''}`;
      }).join('\n\n')}

ИНСТРУКЦИЯ: Используй информацию выше для ответа клиенту. Если информация релевантна вопросу — цитируй её, ссылайся на конкретные пункты.`;
      
      console.log(`[Chat] Added ${knowledgeResults.length} knowledge entries to context`);
    }
    if (extractedIntent.intent === 'brands' && extractedIntent.candidates.length > 0) {
      // Проверяем: если кандидаты содержат конкретный бренд — это запрос ТОВАРОВ бренда, а не "какие бренды есть"
      const hasSpecificBrand = extractedIntent.candidates.some(c => c.brand && c.brand.trim().length > 0);
      
      if (hasSpecificBrand) {
        // Пользователь спрашивает "а Philips есть?" — это каталожный запрос, а не запрос списка брендов!
        console.log(`[Chat] "brands" intent with specific brand → treating as catalog search`);
        foundProducts = await searchProductsMulti(extractedIntent.candidates, 8, appSettings.volt220_api_token || undefined);
        
        if (foundProducts.length > 0) {
          const candidateQueries = extractedIntent.candidates.map(c => c.query).join(', ');
          const formattedProducts = formatProductsForAI(foundProducts);
          console.log(`[Chat] Formatted products for AI:\n${formattedProducts}`);
          productContext = `\n\n**Найденные товары (поиск по: ${candidateQueries}):**\n\n${formattedProducts}`;
        }
      } else {
        // Общий вопрос "какие бренды есть?" — ищем товары и извлекаем бренды
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
    } else if (extractedIntent.intent === 'catalog' && extractedIntent.candidates.length > 0) {
      // Обычный каталожный запрос
      const searchLimit = extractedIntent.usage_context ? 25 : 15;
      foundProducts = await searchProductsMulti(extractedIntent.candidates, searchLimit, appSettings.volt220_api_token || undefined);
      
      // === ENGLISH FALLBACK: если мало результатов и есть английские переводы ===
      if (foundProducts.length < 3 && extractedIntent.english_queries && extractedIntent.english_queries.length > 0) {
        console.log(`[Chat] Only ${foundProducts.length} products found, trying English fallback: ${extractedIntent.english_queries.join(', ')}`);
        const englishCandidates: SearchCandidate[] = extractedIntent.english_queries.map(eq => ({
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
          // Merge: English results first (they matched translation), then existing
          const mergedMap = new Map<number, Product>();
          for (const p of englishResults) mergedMap.set(p.id, p);
          for (const p of foundProducts) { if (!mergedMap.has(p.id)) mergedMap.set(p.id, p); }
          foundProducts = Array.from(mergedMap.values()).slice(0, searchLimit);
        }
      }
      
      if (foundProducts.length > 0) {
        const candidateQueries = extractedIntent.candidates.map(c => c.query).join(', ');
        const formattedProducts = formatProductsForAI(foundProducts);
        console.log(`[Chat] Formatted products for AI:\n${formattedProducts}`);
        
        const appliedFilters = describeAppliedFilters(extractedIntent.candidates);
        const filterNote = appliedFilters ? `\n⚠️ ПРИМЕНЁННЫЕ ФИЛЬТРЫ: ${appliedFilters}\nВсе товары ниже УЖЕ отфильтрованы по этим характеристикам — ты можешь уверенно это сообщить клиенту!\n` : '';
        
        const contextNote = extractedIntent.usage_context 
          ? `\n🎯 КОНТЕКСТ ИСПОЛЬЗОВАНИЯ: "${extractedIntent.usage_context}"\nСреди товаров ниже ВЫБЕРИ ТОЛЬКО подходящие для этого контекста на основе их характеристик (степень защиты, тип монтажа и т.д.). Объясни клиенту ПОЧЕМУ выбранные товары подходят для его задачи. Если не можешь определить — покажи все.\n` 
          : '';
        
        productContext = `\n\n**Найденные товары (поиск по: ${candidateQueries}):**${filterNote}${contextNote}\n${formattedProducts}`;
      }
    }

    // ШАГ 3: Системный промпт с контекстом товаров
    const greetingRegex = /^(привет|здравствуй|добрый|хай|hello|hi|хеллоу|салем)/i;
    const greetingMatch = greetingRegex.test(userMessage.trim());
    const isGreeting = extractedIntent.intent === 'general' && greetingMatch;
    
    console.log(`[Chat] userMessage: "${userMessage}", greetingMatch: ${greetingMatch}, isGreeting: ${isGreeting}`);
    
    // Проверяем, было ли уже приветствие в истории (виджет добавляет его первым сообщением)
    const hasAssistantGreeting = messages.some((m, i) => 
      i < messages.length - 1 && // Не текущее сообщение
      m.role === 'assistant' && 
      m.content &&
      /здравствуйте|привет|добр(ый|ое|ая)|рад.*видеть/i.test(m.content)
    );
    
    console.log(`[Chat] hasAssistantGreeting: ${hasAssistantGreeting}`);
    
    let productInstructions = '';
    if (brandsContext) {
      // Запрос о брендах — показываем список брендов
      productInstructions = `
${brandsContext}

ТВОЙ ОТВЕТ:
1. Перечисли найденные бренды списком
2. Спроси, какой бренд интересует клиента — ты подберёшь лучшие модели
3. Предложи ссылку на каталог: https://220volt.kz/catalog/`;
    } else if (productContext) {
      productInstructions = `
НАЙДЕННЫЕ ТОВАРЫ (КОПИРУЙ ССЫЛКИ ТОЧНО КАК ДАНО — НЕ МОДИФИЦИРУЙ!):
${productContext}

⚠️ СТРОГОЕ ПРАВИЛО ДЛЯ ССЫЛОК: 
- Ссылки в данных выше уже готовы! Просто скопируй их как есть в формате [Название](URL)
- НЕ МЕНЯЙ URL! НЕ ПРИДУМЫВАЙ URL! 
- Используй ТОЛЬКО те ссылки, которые даны выше
- Если хочешь упомянуть товар — бери ссылку ТОЛЬКО из списка выше
- ВАЖНО: если в названии товара есть экранированные скобки \\( и \\) — СОХРАНЯЙ их! Не убирай обратные слэши! Пример: [Розетка \\(белый\\)](url) — это ПРАВИЛЬНО. [Розетка (белый)](url) — это НЕПРАВИЛЬНО, сломает ссылку!`;
    } else if (isGreeting) {
      productInstructions = ''; // Для приветствий ничего не пишем о товарах
    } else if (extractedIntent.intent === 'info') {
      // ИНТЕНТ: INFO — вопрос о компании, оферте, условиях, юридических данных
      // Всегда используем базу знаний для этого интента
      if (knowledgeResults.length > 0) {
        productInstructions = `
💡 ВОПРОС О КОМПАНИИ / УСЛОВИЯХ / ДОКУМЕНТАХ

Клиент написал: "${extractedIntent.originalQuery}"

В БАЗЕ ЗНАНИЙ НАЙДЕНА РЕЛЕВАНТНАЯ ИНФОРМАЦИЯ (см. раздел "ИНФОРМАЦИЯ ИЗ БАЗЫ ЗНАНИЙ" выше).

ТВОЙ ОТВЕТ:
1. Ответь на вопрос клиента, ИСПОЛЬЗУЯ информацию из Базы Знаний
2. Цитируй конкретные пункты, если они есть (например, "Согласно п. 11.16 договора оферты...")
3. Если вопрос о юридических данных (БИН, ИИН, названия юрлиц) — ОБЯЗАТЕЛЬНО предоставь их из Базы Знаний
4. Если вопрос об обязанностях, правах, условиях — перечисли ключевые пункты кратко и понятно
5. Если информации в Базе Знаний недостаточно — честно скажи и предложи связаться с менеджером

СТРОГО ЗАПРЕЩЕНО:
- НЕ говори "я не могу предоставить такую информацию" если она ЕСТЬ в Базе Знаний!
- НЕ отказывайся отвечать на вопросы об оферте, БИН, юрлицах — это публичная информация!
- НЕ переключай тему на товары, если клиент спрашивает о документах/условиях`;
      } else {
        // intent=info, но в БЗ ничего не нашлось
        productInstructions = `
💡 ВОПРОС О КОМПАНИИ / УСЛОВИЯХ

Клиент написал: "${extractedIntent.originalQuery}"

К сожалению, в Базе Знаний не найдено релевантной информации по этому вопросу.

ТВОЙ ОТВЕТ:
1. Честно скажи, что у тебя нет точной информации по этому вопросу
2. Предложи связаться с менеджером для уточнения
3. НЕ выдумывай данные!`;
      }
    } else if (extractedIntent.intent === 'general') {
      // ИНТЕНТ: GENERAL — приветствия, шутки, нерелевантное, продолжение диалога
      const hasProductContext = historyForContext.some(m => 
        m.role === 'assistant' && (
          /₸|цена|бренд|в наличии/i.test(m.content) ||
          /\[.*\]\(https?:\/\/.*\)/i.test(m.content)
        )
      );
      
      if (hasProductContext) {
        productInstructions = `
💡 ПРОДОЛЖЕНИЕ ДИАЛОГА О ТОВАРАХ

Клиент написал: "${extractedIntent.originalQuery}"

ВАЖНО: Ранее в диалоге вы обсуждали товары! Клиент скорее всего продолжает тот же разговор.

ТВОЙ ОТВЕТ:
1. Свяжи текущее сообщение с ПРЕДЫДУЩЕЙ темой разговора
2. Уточни потребность в контексте ранее обсуждавшихся товаров
3. НЕ переключайся на другую тему, пока клиент явно не попросит

ЗАПРЕЩЕНО:
- НЕ теряй контекст разговора!
- НЕ переключайся на другие инструменты без причины`;
      } else {
        productInstructions = `
💡 НЕРЕЛЕВАНТНЫЙ ЗАПРОС ИЛИ ВОПРОС ОБ УСЛУГАХ

Клиент написал: "${extractedIntent.originalQuery}"

Это НЕ запрос товара из каталога. Отвечай дружелюбно и с юмором!

ТВОЙ ОТВЕТ:
1. Вежливо и с улыбкой объясни, что ты — консультант магазина электроинструментов
2. ЕСЛИ УМЕСТНО — сделай креативную ассоциацию с товарами магазина
3. Спроси, чем можешь помочь по части инструментов

ВАЖНО:
- НЕ говори "товар не найден в каталоге"
- Будь остроумным и дружелюбным`;
      }
    } else if (extractedIntent.candidates.length > 0) {
      // Был поиск в каталоге, но товары не найдены
      // Определяем, искали ли конкретный бренд
      const searchedBrands = extractedIntent.candidates
        .map(c => c.brand)
        .filter((b): b is string => b !== null && b !== undefined);
      const uniqueBrands = [...new Set(searchedBrands)];
      
      if (uniqueBrands.length > 0) {
        // Искали конкретный бренд — его НЕТ в каталоге
        // FALLBACK: ищем без бренда чтобы показать альтернативы!
        console.log(`[Chat] Brand ${uniqueBrands.join(', ')} not found. Doing fallback search without brand...`);
        
        // Убираем бренд И из параметра brand, И из текста query
        const brandPattern = new RegExp(`\\b(${uniqueBrands.join('|')})\\b`, 'gi');
        const candidatesWithoutBrand = extractedIntent.candidates.map(c => ({
          ...c,
          brand: null,
          query: (c.query || '').replace(brandPattern, '').replace(/\s+/g, ' ').trim()
        })).filter(c => (c.query || '').length > 1);
        
        console.log(`[Chat] Fallback candidates:`, candidatesWithoutBrand.map(c => c.query));
        
        const fallbackProducts = await searchWithTranslationFallback(candidatesWithoutBrand, 6, appSettings.volt220_api_token || undefined, aiConfig.url, aiConfig.apiKeys, aiConfig.model);
        
        if (fallbackProducts.length > 0) {
          // Нашли альтернативы! Показываем их
          const availableBrands = extractBrandsFromProducts(fallbackProducts);
          const formattedAlternatives = formatProductsForAI(fallbackProducts);
          
          console.log(`[Chat] Fallback found ${fallbackProducts.length} alternatives from brands: ${availableBrands.join(', ')}`);
          
          productInstructions = `
🚨 БРЕНД НЕ НАЙДЕН, НО ЕСТЬ АЛЬТЕРНАТИВЫ!

Клиент спросил о бренде: ${uniqueBrands.join(', ')}
Товаров этого бренда НЕТ В КАТАЛОГЕ.

✅ НО НАШЛИСЬ АНАЛОГИ ОТ ДРУГИХ ПРОИЗВОДИТЕЛЕЙ:
${formattedAlternatives}

Доступные бренды в этой категории: ${availableBrands.join(', ')}

ТВОЙ ОТВЕТ ДОЛЖЕН БЫТЬ ТАКИМ:
1. ЧЕСТНО скажи: "К сожалению, товаров бренда ${uniqueBrands.join('/')} сейчас нет в нашем каталоге."
2. СРАЗУ предложи альтернативы: "Но у нас есть отличные аналоги от ${availableBrands.slice(0, 3).join(', ')}!" 
3. Покажи 2-3 товара из списка выше с ценами и ссылками
4. Спроси, какой вариант интересует

⚠️ СТРОГОЕ ПРАВИЛО: 
- Ссылки уже готовы! Копируй их как есть в формате [Название](URL)
- НЕ МЕНЯЙ URL! НЕ ПРИДУМЫВАЙ URL!`;
        } else {
          // Даже fallback не нашёл ничего
          const hasArticlesForBrand = knowledgeResults.length > 0;
          const brandArticlesHint = hasArticlesForBrand
            ? `\n\n✅ ОДНАКО, В БАЗЕ ЗНАНИЙ НАЙДЕНЫ СТАТЬИ ПО ЭТОЙ ТЕМЕ!
Смотри раздел "ИНФОРМАЦИЯ ИЗ БАЗЫ ЗНАНИЙ" выше.
УПОМЯНИ статью: "Хотя товара сейчас нет в наличии, у нас есть полезная информация по этой теме — подробнее здесь: [ссылка из source_url]"
Предложи связаться с менеджером для уточнения наличия.`
            : '';
          
          productInstructions = `
🚨 КРИТИЧЕСКИ ВАЖНО — БРЕНД НЕ НАЙДЕН И НЕТ АЛЬТЕРНАТИВ!

Клиент спросил о бренде: ${uniqueBrands.join(', ')}
Мы выполнили поиск в каталоге — ТОВАРОВ ЭТОГО БРЕНДА И ПОХОЖИХ КАТЕГОРИЙ НЕТ!
${brandArticlesHint}

${!hasArticlesForBrand ? `ТВОЙ ОТВЕТ ДОЛЖЕН БЫТЬ ТАКИМ:
1. ЧЕСТНО скажи: "К сожалению, товаров бренда ${uniqueBrands.join('/')} сейчас нет в нашем каталоге."
2. Предложи: "Расскажите подробнее, какой инструмент вам нужен — попробую подобрать из доступных."
3. Или предложи посмотреть каталог: https://220volt.kz/catalog/` : ''}

СТРОГО ЗАПРЕЩЕНО:
- НЕ ДЕЛАЙ ВИД что бренд есть!
- НЕ ПРИДУМЫВАЙ товары!`;
        }
      } else {
        // Общий запрос без бренда — товары не найдены
        // Определяем категорию из кандидатов
        const searchedCategories = extractedIntent.candidates
          .map(c => c.category || c.query)
          .filter(Boolean);
        const uniqueCategories = [...new Set(searchedCategories)];
        const categoryText = uniqueCategories.length > 0 ? uniqueCategories.join(', ') : extractedIntent.originalQuery;
        
        // Проверяем, есть ли статьи в базе знаний по этой теме
        const hasRelevantArticles = knowledgeResults.length > 0;
        const articlesHint = hasRelevantArticles 
          ? `\n\n✅ ОДНАКО, В БАЗЕ ЗНАНИЙ НАЙДЕНЫ СТАТЬИ ПО ЭТОЙ ТЕМЕ!
Смотри раздел "ИНФОРМАЦИЯ ИЗ БАЗЫ ЗНАНИЙ" выше. 

ТВОЙ ОТВЕТ ДОЛЖЕН ВКЛЮЧАТЬ:
1. ЧЕСТНО скажи что товара сейчас нет в наличии в каталоге
2. НО УПОМЯНИ статью/информацию из Базы Знаний: "Однако у нас есть полезная информация по этой теме — вы можете почитать подробнее здесь: [ссылка из source_url]"
3. Предложи связаться с менеджером для уточнения наличия и заказа`
          : '';
        
        productInstructions = `
🚨 КРИТИЧЕСКИ ВАЖНО — ТОВАР/КАТЕГОРИЯ НЕ НАЙДЕНА В КАТАЛОГЕ!

Клиент искал: "${categoryText}"
Мы выполнили поиск в каталоге — ТАКИХ ТОВАРОВ НЕТ В НАЛИЧИИ!
${articlesHint}

${!hasRelevantArticles ? `ТВОЙ ОТВЕТ ДОЛЖЕН БЫТЬ ТАКИМ:
1. ЧЕСТНО скажи: "К сожалению, ${categoryText} сейчас нет в нашем каталоге."
2. Предложи альтернативу: "Могу подобрать другой инструмент. Расскажите, какую задачу вы хотите решить?"
3. Или предложи посмотреть каталог: https://220volt.kz/catalog/` : ''}

СТРОГО ЗАПРЕЩЕНО:
- НЕ ДЕЛАЙ ВИД что товар есть!
- НЕ ПРОСИ уточнить бюджет или тип патрона для товара, которого НЕТ!
- НЕ ПРИДУМЫВАЙ товары, названия, цены или URL!
- НЕ ГОВОРИ "у нас есть аналоги" — если товара нет, аналогов тоже нет!
- НЕ СОЗДАВАЙ ссылки на несуществующие разделы типа https://220volt.kz/catalog/perforatory/`;
      }
    }
    
    // --- Контекстные блоки для промпта ---
    
    // Приветствие: уже здоровались или нет
    const greetingContext = hasAssistantGreeting 
      ? 'ПРИВЕТСТВИЕ: Ты уже поздоровался ранее. Начинай сразу с сути.'
      : isGreeting 
        ? 'ПРИВЕТСТВИЕ: Клиент здоровается впервые. Ответь коротким приветствием и сразу переходи к ответу на вопрос (если он есть в том же сообщении).'
        : '';

    // Геолокация — проверяем, упоминалась ли уже в диалоге (чтобы не повторять "Я вижу, что вы из...")
    const geoAlreadyMentioned = historyForContext.some(m => 
      m.role === 'assistant' && /я вижу.*что вы из|ваш город|ближайший.*филиал/i.test(m.content)
    );
    
    let geoContext = '';
    if (detectedCity && userCountryCode === 'KZ') {
      if (geoAlreadyMentioned) {
        // Город уже озвучен ранее — просто передаём как факт, БЕЗ инструкции объявлять
        geoContext = `ГЕОЛОКАЦИЯ (уже сообщено клиенту): Город клиента — ${detectedCity} (Казахстан). Ты УЖЕ говорил клиенту его город ранее в диалоге. НЕ повторяй "Я вижу, что вы из...". Просто используй город для подбора ближайшего филиала, если нужно.`;
      } else {
        // Первое упоминание — можно объявить
        geoContext = `ГЕОЛОКАЦИЯ: Город клиента определён автоматически — ${detectedCity} (Казахстан). Когда клиент спрашивает про филиалы/адреса — скажи: "Я вижу, что вы из ${detectedCity}! Ближайший к вам филиал: [данные филиала этого города]." Затем добавь: "Также мы представлены и в других городах Казахстана — подсказать?" НЕ спрашивай город — ты его уже знаешь.`;
      }
    } else if (userCountryCode === 'RU') {
      if (geoAlreadyMentioned) {
        geoContext = `ГЕОЛОКАЦИЯ (уже сообщено клиенту): Клиент из России. Ты УЖЕ сообщил ему об этом. НЕ повторяй. Если он назвал город — используй его.`;
      } else {
        geoContext = `ГЕОЛОКАЦИЯ: Клиент из России${detectedCity ? ` (город: ${detectedCity})` : ''}. Когда речь о филиалах — скажи: "Я вижу, что вы из России${detectedCity ? ` (${detectedCity})` : ''}! Наши магазины расположены в Казахстане. Подскажите, какой город в Казахстане вас интересует?" Предложи помощь с доставкой.`;
      }
    } else if (isVPN) {
      geoContext = `ГЕОЛОКАЦИЯ: Город не удалось определить (возможно VPN). Если клиент спрашивает про филиалы — уточни город.`;
    } else {
      geoContext = `ГЕОЛОКАЦИЯ: Город не определён. Если клиент спрашивает про филиалы — уточни город.`;
    }
    
    // Custom tone of voice from settings
    const toneOfVoice = appSettings.system_prompt || '';

    const systemPrompt = `# Роль
Ты — консультант интернет-магазина 220volt.kz (электроинструменты и оборудование, Казахстан).
${toneOfVoice ? `\nТон общения: ${toneOfVoice}` : ''}

# Принципы
1. **Краткость**: 2-4 предложения, если вопрос не требует развёрнутого ответа.
2. **Контекст диалога**: читай предыдущие сообщения. Если клиент уже назвал город — просто покажи данные без "Я вижу, что вы из...".
3. **Источники данных**: товары — только из раздела «НАЙДЕННЫЕ ТОВАРЫ»; информация о компании — только из «БАЗА ЗНАНИЙ»; контакты филиалов — только из «ДАННЫЕ ФИЛИАЛОВ» ниже.
4. **Честность**: если данных нет — скажи об этом. Предложи связаться с менеджером (маркер [CONTACT_MANAGER] в конце сообщения).
5. **Без приветствий и представлений**: НИКОГДА не здоровайся («Здравствуйте», «Привет», «Добрый день») и не представляйся («Я AI-консультант», «Я консультант магазина»). Приветствие уже автоматически показано клиенту в интерфейсе чата. Начинай СРАЗУ с сути ответа.
6. **Остатки и склады**: В данных о товарах указано ОБЩЕЕ количество на всех складах (поле «В наличии: Да (X шт.)»). Показывай клиенту точное количество. Если клиент спрашивает о наличии на КОНКРЕТНОМ складе или в конкретном филиале — объясни, что у тебя есть только общий остаток по всей сети, и предложи уточнить наличие в нужном филиале у менеджера [CONTACT_MANAGER].

# ${greetingContext}

# ${geoContext}

# Формат ответа: товары
Если товары найдены — покажи топ-3:

**[Название](ссылка_из_данных)** — *цена* ₸, бренд

Ссылки копируй точно из данных. Если товаров нет — задай уточняющие вопросы.

# Уточняющие вопросы на основе характеристик товаров
ПОСЛЕ первой выдачи товаров ты ОБЯЗАН проанализировать характеристики (options) всех найденных товаров и выявить 1-2 КЛЮЧЕВЫХ параметра, по которым товары РАЗЛИЧАЮТСЯ между собой.

Алгоритм:
1. Собери все значения каждой характеристики по всем найденным товарам
2. Найди характеристики, где есть 2+ РАЗНЫХ значения (например: тип монтажа: «внутренний» у одних, «наружный» у других)
3. Выбери 1-2 САМЫХ ВАЖНЫХ для выбора (приоритет: тип монтажа, степень защиты IP, мощность, количество модулей, материал, напряжение)
4. Сформулируй КОНКРЕТНЫЙ уточняющий вопрос с вариантами из реальных данных

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

${knowledgeContext}

${productInstructions}`;

    console.log(`[Chat] System prompt length: ${systemPrompt.length}, productInstructions included: ${productInstructions.length > 0}`);

    // ШАГ 4: Финальный ответ от AI
    const messagesForAI = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];
    
    // Call AI with automatic key rotation on errors
    const response = await callAIWithKeyFallback(aiConfig.url, aiConfig.apiKeys, {
      model: aiConfig.model,
      messages: messagesForAI,
      stream: useStreaming,
    }, 'Chat');

    if (!response.ok) {
      if (response.status === 429) {
        const providerName = aiConfig.url.includes('google') ? 'Google AI Studio' : aiConfig.url.includes('openrouter') ? 'OpenRouter' : 'AI';
        console.error(`[Chat] Rate limit 429 after all keys exhausted (${providerName})`);
        return new Response(
          JSON.stringify({ error: `Превышен лимит запросов к ${providerName}. Подождите 1-2 минуты и попробуйте снова, или смените провайдера/модель в настройках.` }),
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

    // Format contacts for display as a separate message
    const formattedContacts = formatContactsForDisplay(contactsInfo);

    // Helper: log token usage to ai_usage_logs (fire-and-forget)
    const logTokenUsage = async (inputTokens: number, outputTokens: number, model: string) => {
      try {
        const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
        const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
        
        const totalTokens = inputTokens + outputTokens;
        // Gemini 2.5 Flash pricing: input $0.30/1M, output $2.50/1M
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

    // NON-STREAMING MODE: collect full response and return as JSON
    if (!useStreaming) {
      try {
        const aiData = await response.json();
        let content = aiData.choices?.[0]?.message?.content || '';
        console.log(`[Chat] Non-streaming response length: ${content.length}`);
        
        // Log token usage from API response
        const usage = aiData.usage;
        if (usage) {
          logTokenUsage(usage.prompt_tokens || 0, usage.completion_tokens || 0, aiConfig.model);
        }
        
        // Check if AI included escalation marker
        const shouldShowContacts = content.includes('[CONTACT_MANAGER]');
        content = content.replace(/\s*\[CONTACT_MANAGER\]\s*/g, '').trim();
        
        const responseBody: { content: string; contacts?: string | null } = { content };
        if (shouldShowContacts && formattedContacts) {
          responseBody.contacts = formattedContacts;
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

    // STREAMING MODE: forward SSE stream
    // Если это повторное приветствие, фильтруем начальные приветствия из ответа
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
      
      const stream = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            // Flush buffered chunks, stripping [CONTACT_MANAGER] marker
            for (const chunk of bufferedChunks) {
              let text = decoder.decode(chunk);
              text = text.replace(/\[CONTACT_MANAGER\]/g, '');
              controller.enqueue(encoder.encode(text));
            }
            // Only send contacts if marker was found
            if (fullContent.includes('[CONTACT_MANAGER]') && formattedContacts) {
              const contactsEvent = `data: ${JSON.stringify({ contacts: formattedContacts })}\n\n`;
              controller.enqueue(encoder.encode(contactsEvent));
            }
            // Log estimated token usage for streaming (rough: 1 token ≈ 3 chars for Russian)
            const estInputTokens = Math.ceil(systemPrompt.length / 3);
            const estOutputTokens = Math.ceil(fullContent.length / 3);
            logTokenUsage(estInputTokens, estOutputTokens, aiConfig.model);
            controller.close();
            return;
          }
          
          let text = decoder.decode(value, { stream: true });
          
          // Track full content for marker detection
          try {
            const contentMatch = text.match(/"content":"([^"]*)"/g);
            if (contentMatch) {
              for (const m of contentMatch) {
                fullContent += m.replace(/"content":"/, '').replace(/"$/, '');
              }
            }
          } catch {}
          
          // Удаляем приветствие только из первого data-чанка с content
          if (!greetingRemoved && text.includes('content')) {
            const before = text;
            const greetings = ['Здравствуйте', 'Привет', 'Добрый день', 'Добрый вечер', 'Доброе утро', 'Hello', 'Hi', 'Хай'];
            
            for (const greeting of greetings) {
              const pattern = new RegExp(
                `"content":"${greeting}[!.,]?\\s*(?:👋|🛠️|😊)?\\s*`,
                'gi'
              );
              text = text.replace(pattern, '"content":"');
            }
            
            if (before !== text) {
              greetingRemoved = true;
            }
          }
          
          // Strip marker and thinking tokens from chunks
          text = text.replace(/\[CONTACT_MANAGER\]/g, '');
          text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
          text = text.replace(/ТИХОЕ РАЗМЫШЛЕНИЕ[\s\S]*?(?=data:|$)/g, '');
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

    // For streaming: wrap original stream to append contacts event at the end
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
    
    const streamWithContacts = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader2.read();
        if (done) {
          // Only send contacts if marker was found in the response
          if (fullContent2.includes('[CONTACT_MANAGER]') && formattedContacts) {
            const contactsEvent = `data: ${JSON.stringify({ contacts: formattedContacts })}\n\n`;
            controller.enqueue(encoder.encode(contactsEvent));
          }
          // Log estimated token usage
          const estInputTokens = Math.ceil(systemPrompt.length / 3);
          const estOutputTokens = Math.ceil(fullContent2.length / 3);
          logTokenUsage(estInputTokens, estOutputTokens, aiConfig.model);
          controller.close();
          return;
        }
        
        let text = decoder2.decode(value, { stream: true });
        
        // Track full content for marker detection
        try {
          const contentMatch = text.match(/"content":"([^"]*)"/g);
          if (contentMatch) {
            for (const m of contentMatch) {
              fullContent2 += m.replace(/"content":"/, '').replace(/"$/, '');
            }
          }
        } catch {}
        
        // Strip marker and thinking tokens from output
        text = text.replace(/\[CONTACT_MANAGER\]/g, '');
        text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
        text = text.replace(/ТИХОЕ РАЗМЫШЛЕНИЕ[\s\S]*?(?=data:|$)/g, '');
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
