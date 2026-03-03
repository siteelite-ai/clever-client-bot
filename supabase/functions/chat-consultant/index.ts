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

// Determine AI endpoint and key based on settings
function getAIConfig(settings: CachedSettings): { url: string; apiKey: string; model: string } {
  if (settings.ai_provider === 'google') {
    if (!settings.google_api_key) {
      throw new Error('Google AI Studio API key не настроен. Добавьте ключ в Настройках.');
    }
    // Google AI Studio uses OpenAI-compatible endpoint
    return {
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      apiKey: settings.google_api_key,
      model: settings.ai_model || 'gemini-2.0-flash',
    };
  }

  // Default: OpenRouter
  if (!settings.openrouter_api_key) {
    throw new Error('OpenRouter API key не настроен. Добавьте ключ в Настройках.');
  }

  return {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    apiKey: settings.openrouter_api_key,
    model: settings.ai_model,
  };
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

// Search knowledge base for relevant context using full-text search
async function searchKnowledgeBase(
  query: string, 
  limit: number = 3
): Promise<KnowledgeResult[]> {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.log('[Knowledge] Supabase not configured, skipping knowledge search');
    return [];
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    
    console.log(`[Knowledge] Searching for: "${query.substring(0, 50)}..."`);
    
    // Use full-text search function
    const { data, error } = await supabase.rpc('search_knowledge_fulltext', {
      search_query: query,
      match_count: limit,
    });

    if (error) {
      console.error('[Knowledge] Search error:', error);
      return [];
    }

    console.log(`[Knowledge] Found ${data?.length || 0} relevant entries`);
    
    // Map to expected interface
    return (data || []).map((row: { id: string; title: string; content: string; type: string; source_url: string | null; rank: number }) => ({
      id: row.id,
      title: row.title,
      content: row.content,
      type: row.type,
      source_url: row.source_url,
      similarity: row.rank, // Use rank as similarity score
    }));
  } catch (error) {
    console.error('[Knowledge] Search error:', error);
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
}

interface ExtractedIntent {
  intent: 'catalog' | 'brands' | 'info' | 'general';
  candidates: SearchCandidate[];
  originalQuery: string;
}

// Генерация поисковых кандидатов через AI с учётом контекста разговора
async function generateSearchCandidates(
  message: string, 
  apiKey: string,
  conversationHistory: Array<{ role: string; content: string }> = [],
  aiUrl: string = 'https://openrouter.ai/api/v1/chat/completions',
  aiModel: string = 'meta-llama/llama-3.3-70b-instruct:free'
): Promise<ExtractedIntent> {
  console.log(`[AI Candidates] Extracting search intent from: "${message}"`);
  
  // Формируем контекст из последних сообщений (максимум 6)
  const recentHistory = conversationHistory.slice(-6);
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

📖 ДОКУМЕНТАЦИЯ API КАТАЛОГА (220volt.kz/api/products):
Ты ДОЛЖЕН формировать корректные запросы к API. Вот доступные параметры:

| Параметр | Описание | Пример |
|----------|----------|--------|
| query | Текстовый поиск по названию и описанию товара. КОРОТКИЕ запросы (1-2 слова) работают лучше. НЕ передавай общие слова вроде "товары", "продукция", "изделия" — они бесполезны | "дрель", "УШМ", "кабель 3x2.5" |
| options[brend__brend][] | Фильтр по бренду. Значение = точное название бренда ЛАТИНИЦЕЙ с заглавной буквы | "Philips", "Bosch", "Makita" |
| category | Фильтр по категории (pagetitle родительского ресурса) | "Светильники", "Перфораторы" |
| min_price | Минимальная цена в тенге | 5000 |
| max_price | Максимальная цена в тенге | 50000 |

⚠️ ПРАВИЛА СОСТАВЛЕНИЯ ЗАПРОСОВ:
1. Если пользователь спрашивает о БРЕНДЕ ("есть Philips?", "покажи Makita") — используй ТОЛЬКО фильтр brand, БЕЗ query. API найдёт все товары бренда.
2. Если пользователь ищет КАТЕГОРИЮ товаров ("дрели", "розетки") — используй query с техническим названием. НЕ используй параметр category!
3. Если пользователь ищет ТОВАР КОНКРЕТНОГО БРЕНДА ("дрель Bosch", "светильник Philips") — используй И query, И brand.
4. query должен содержать ТЕХНИЧЕСКИЕ термины каталога, не разговорные слова.
5. Бренды ВСЕГДА латиницей: "филипс" → brand="Philips", "бош" → brand="Bosch", "макита" → brand="Makita"
6. НЕ ИСПОЛЬЗУЙ параметр category! Ты не знаешь точные названия категорий в каталоге. Используй только query для текстового поиска.

🧠 СЕМАНТИЧЕСКАЯ ТРАНСФОРМАЦИЯ:
Пользователь говорит РАЗГОВОРНЫМ языком, каталог использует ТЕХНИЧЕСКИЕ термины:
- "болгарка" → query="УШМ" (+ вариант "болгарка")
- "рамка на 2 слота" → query="рамка 2-местная"
- "дырка под розетку" → query="подрозетник"
- "провод трёхжильный 2.5" → query="кабель 3x2.5"
- "перфораторы" → query="перфоратор" (единственное число работает лучше для поиска!)

⚠️ ВАЖНО: Всегда генерируй МИНИМУМ 2 кандидата с разными вариантами написания:
- Один с техническим названием в единственном числе
- Один с разговорным вариантом или синонимом
- query должен содержать ТОЛЬКО тип/название товара (1-2 слова). Характеристики (размер, мощность, цоколь, ампераж и т.д.) будут автоматически отфильтрованы на следующем этапе — НЕ включай их в query.

🔴 ОПРЕДЕЛИ ПРАВИЛЬНЫЙ INTENT:
- "catalog" — ищет товары/оборудование
- "brands" — спрашивает какие бренды представлены
- "info" — вопросы о компании, доставке, оплате
- "general" — приветствия, шутки, нерелевантное (candidates=[])

🚨 Если запрос НЕ про электроинструмент/оборудование — это ВСЕГДА intent="general".

🔑 ВАЖНОЕ ПРАВИЛО ДЛЯ БРЕНДОВ:
Когда пользователь спрашивает о бренде В КОНТЕКСТЕ конкретной категории (например, ранее обсуждали автоматические выключатели, а теперь спрашивает "а от Philips есть?"):
- Генерируй МИНИМУМ 2 кандидата:
  1. query=<категория из контекста> + brand=<бренд> (проверяем, есть ли бренд В ЭТОЙ категории)
  2. brand=<бренд> БЕЗ query (проверяем, есть ли бренд ВООБЩЕ в каталоге)
Это критически важно! Бренд может отсутствовать в одной категории, но быть представлен в другой.

ТЕКУЩЕЕ сообщение пользователя: "${message}"`;

  try {
    const response = await fetch(aiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
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
                        }
                      },
                      additionalProperties: false
                    },
                    description: 'Массив вариантов запросов к API (2-5 штук с разными query-вариациями)'
                  }
                },
                required: ['intent', 'candidates'],
                additionalProperties: false
              }
            }
          }
        ],
        tool_choice: { type: 'function', function: { name: 'extract_search_intent' } },
      }),
    });

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
      
      const candidates = (parsed.candidates || []).map((c: any) => ({
        query: c.query || null,
        brand: c.brand || null,
        category: c.category || null,
        min_price: c.min_price || null,
        max_price: c.max_price || null,
      }));
      
      // SYSTEMIC: Always add broad candidates by extracting core product nouns
      const broadened = generateBroadCandidates(candidates);
      
      return {
        intent: parsed.intent || 'general',
        candidates: broadened,
        originalQuery: message
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
function generateBroadCandidates(candidates: SearchCandidate[]): SearchCandidate[] {
  const existingQueries = new Set(
    candidates.map(c => c.query?.toLowerCase().trim()).filter(Boolean)
  );
  
  const broadCandidates: SearchCandidate[] = [...candidates];
  
  for (const candidate of candidates) {
    if (!candidate.query) continue;
    
    const query = candidate.query.trim();
    
    // Split query into words and try progressively shorter versions
    const words = query.split(/\s+/);
    
    if (words.length <= 1) continue; // Already as short as possible
    
    // Strategy 1: First word only (core product noun: "лампа", "удлинитель", "дрель")
    const firstWord = words[0];
    if (firstWord.length >= 3 && !existingQueries.has(firstWord.toLowerCase())) {
      existingQueries.add(firstWord.toLowerCase());
      broadCandidates.push({
        query: firstWord,
        brand: candidate.brand,
        category: null,
        min_price: candidate.min_price,
        max_price: candidate.max_price,
      });
      console.log(`[Broad Candidate] Added "${firstWord}" from "${query}"`);
    }
    
    // Strategy 2: First two words if query has 3+ words (e.g. "лампа свеча" from "лампа свеча E14")
    if (words.length >= 3) {
      const twoWords = words.slice(0, 2).join(' ');
      if (!existingQueries.has(twoWords.toLowerCase())) {
        existingQueries.add(twoWords.toLowerCase());
        broadCandidates.push({
          query: twoWords,
          brand: candidate.brand,
          category: null,
          min_price: candidate.min_price,
          max_price: candidate.max_price,
        });
        console.log(`[Broad Candidate] Added "${twoWords}" from "${query}"`);
      }
    }
  }
  
  console.log(`[Broad Candidates] ${candidates.length} original → ${broadCandidates.length} total candidates`);
  return broadCandidates;
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
async function searchProductsByCandidate(
  candidate: SearchCandidate, 
  apiToken: string,
  limit: number = 20
): Promise<Product[]> {
  try {
    const params = new URLSearchParams();
    
    // AI уже решил какие параметры нужны — просто передаём их в API
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

// Параллельный поиск по всем кандидатам с дедупликацией
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

  // Убираем category из всех кандидатов — AI не знает точных названий категорий
  const cleanedCandidates = candidates.map(c => ({ ...c, category: null }));
  
  console.log(`[Search] Searching ${cleanedCandidates.length} candidates in parallel...`);

  // Параллельный поиск
  const searchPromises = cleanedCandidates.map(candidate => 
    searchProductsByCandidate(candidate, apiToken, limit)
  );
  
  const results = await Promise.all(searchPromises);
  
  // Объединяем и дедуплицируем по ID
  const productMap = new Map<number, Product>();
  
  for (const products of results) {
    for (const product of products) {
      if (!productMap.has(product.id)) {
        productMap.set(product.id, product);
      }
    }
  }
  
  // Если 0 результатов и были фильтры (brand/price), попробуем fallback только с query
  if (productMap.size === 0) {
    const queryOnlyCandidates = cleanedCandidates.filter(c => c.query && (c.brand || c.min_price || c.max_price));
    if (queryOnlyCandidates.length > 0) {
      console.log(`[Search] 0 results with filters, trying fallback with query only...`);
      const fallbackPromises = queryOnlyCandidates.map(c => 
        searchProductsByCandidate({ query: c.query, brand: null, category: null, min_price: null, max_price: null }, apiToken, limit)
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
  
  // Сортируем: приоритет товарам с query в названии, затем по наличию и цене
  const queryWords = candidates
    .map(c => c.query?.toLowerCase())
    .filter(Boolean) as string[];
  
  uniqueProducts.sort((a, b) => {
    // Приоритет: query-слово в pagetitle (основной товар, а не аксессуар)
    const aInTitle = queryWords.some(q => a.pagetitle.toLowerCase().includes(q));
    const bInTitle = queryWords.some(q => b.pagetitle.toLowerCase().includes(q));
    if (aInTitle && !bInTitle) return -1;
    if (!aInTitle && bInTitle) return 1;
    // Затем товары в наличии
    if (a.amount > 0 && b.amount === 0) return -1;
    if (a.amount === 0 && b.amount > 0) return 1;
    // Затем по цене (дешевле первыми)
    return a.price - b.price;
  });
  
  return uniqueProducts.slice(0, limit);
}

// Возвращает URL как есть (тестовый домен для тестирования)
function toProductionUrl(url: string): string {
  return url;
}

// Keys to exclude from product characteristics (service/internal fields)
const EXCLUDED_OPTION_KEYS = new Set([
  'kodnomenklatury', 'identifikator_sayta__sayt_identifikatory',
  'edinica_izmereniya__Өlsheu_bіrlіgі', 'garantiynyy_srok__let__kepіldіk_merzіmі__ghyl_',
  'brend__brend', // already shown separately as brand
  'fayl', // internal file path
  'kod_tn_ved__kod_tn_syed', // customs code
  'poiskovyy_zapros', // internal search terms
  'novinka', // internal flag
  'obem', // internal volume
  'ogranichennyy_prosmotr__sheқtelgen_қarau', // internal flag
  'populyarnyy', // internal flag
  'prodaetsya_tolko_v_gruppovoy_upakovke__tek_toptyқ_қaptamada_ғana_satylady', // internal flag
]);

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
    const productUrl = toProductionUrl(p.url);
    const nameWithLink = `[${p.pagetitle}](${productUrl})`;
    
    const parts = [
      `${i + 1}. **${nameWithLink}**`,
      `   - Цена: ${p.price.toLocaleString('ru-KZ')} ₸${p.old_price && p.old_price > p.price ? ` ~~${p.old_price.toLocaleString('ru-KZ')} ₸~~` : ''}`,
      brand ? `   - Бренд: ${brand}` : '',
      p.article ? `   - Артикул: ${p.article}` : '',
      `   - В наличии: ${p.amount > 0 ? 'Да' : 'Под заказ'}`,
      p.category ? `   - Категория: [${p.category.pagetitle}](https://220volt.kz/catalog/${p.category.id})` : '',
    ];
    
    // Add product characteristics from options (excluding service fields)
    if (p.options && p.options.length > 0) {
      const specs = p.options
        .filter(o => !EXCLUDED_OPTION_KEYS.has(o.key))
        .map(o => `${cleanOptionCaption(o.caption)}: ${cleanOptionValue(o.value)}`)
        .slice(0, 10); // max 10 characteristics per product
      
      if (specs.length > 0) {
        parts.push(`   - Характеристики: ${specs.join('; ')}`);
      }
    }
    
    return parts.filter(Boolean).join('\n');
  }).join('\n\n');
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


// Smart excerpt extraction: find the most relevant section of a long document
// instead of blindly taking the first N chars
function extractRelevantExcerpt(content: string, query: string, maxLen: number = 2000): string {
  // If content is short enough, return as-is
  if (content.length <= maxLen) return content;

  // Extract meaningful keywords from the query (>2 chars, no stop words)
  const stopWords = new Set(['как', 'что', 'где', 'когда', 'почему', 'какой', 'какая', 'какие', 'это', 'для', 'при', 'или', 'так', 'вот', 'можно', 'есть', 'ваш', 'мне', 'вам', 'нас', 'вас', 'они', 'она', 'оно', 'его', 'неё', 'них', 'будет', 'быть', 'если', 'уже', 'ещё', 'еще', 'тоже', 'также', 'только', 'очень', 'просто', 'нужно', 'надо']);
  const words = query.toLowerCase()
    .split(/[^а-яёa-z0-9]+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  if (words.length === 0) return content.substring(0, maxLen);

  // Find the best window: score each position by keyword density
  const lowerContent = content.toLowerCase();
  const windowSize = maxLen;
  const step = 200; // slide by 200 chars
  
  let bestStart = 0;
  let bestScore = -1;

  for (let start = 0; start < content.length - step; start += step) {
    const end = Math.min(start + windowSize, content.length);
    const window = lowerContent.substring(start, end);
    
    let score = 0;
    for (const word of words) {
      // Count occurrences of each keyword in this window
      let idx = 0;
      while ((idx = window.indexOf(word, idx)) !== -1) {
        score += 1;
        idx += word.length;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }

  // If no keywords found at all, return the beginning
  if (bestScore <= 0) return content.substring(0, maxLen);

  // Snap to nearest paragraph/section boundary for cleaner cuts
  let snapStart = bestStart;
  if (snapStart > 0) {
    // Look back up to 200 chars for a section header or double newline
    const lookBack = content.substring(Math.max(0, snapStart - 200), snapStart);
    const sectionMatch = lookBack.lastIndexOf('\n\n');
    if (sectionMatch >= 0) {
      snapStart = Math.max(0, snapStart - 200) + sectionMatch + 2;
    }
  }

  const excerpt = content.substring(snapStart, snapStart + maxLen);
  
  // Add ellipsis indicators
  const prefix = snapStart > 0 ? '...\n' : '';
  const suffix = (snapStart + maxLen) < content.length ? '\n...' : '';
  
  return prefix + excerpt.trim() + suffix;
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
    const extractedIntent = await generateSearchCandidates(userMessage, aiConfig.apiKey, historyForContext, aiConfig.url, aiConfig.model);
    console.log(`[Chat] AI Intent=${extractedIntent.intent}, Candidates: ${extractedIntent.candidates.length}`);

    let productContext = '';
    let foundProducts: Product[] = [];
    let brandsContext = '';
    let knowledgeContext = '';

    // ШАГ 2: Поиск в базе знаний (параллельно с другими запросами)
    // Ищем для ВСЕХ запросов — статьи могут быть полезны даже когда товаров нет в каталоге
    const knowledgePromise = searchKnowledgeBase(userMessage, 3);
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
        // Smart extraction: find the most relevant section of the content
        const excerpt = extractRelevantExcerpt(r.content, userMessage, 2000);
        return `--- ${r.title} ---
${excerpt}
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
      foundProducts = await searchProductsMulti(extractedIntent.candidates, 8, appSettings.volt220_api_token || undefined);
      
      if (foundProducts.length > 0) {
        const candidateQueries = extractedIntent.candidates.map(c => c.query).join(', ');
        const formattedProducts = formatProductsForAI(foundProducts);
        console.log(`[Chat] Formatted products for AI:\n${formattedProducts}`);
        productContext = `\n\n**Найденные товары (поиск по: ${candidateQueries}):**\n\n${formattedProducts}`;
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

⚠️ СТРОГОЕ ПРАВИЛО: 
- Ссылки в данных выше уже готовы! Просто скопируй их как есть в формате [Название](URL)
- НЕ МЕНЯЙ URL! НЕ ПРИДУМЫВАЙ URL! 
- Используй ТОЛЬКО те ссылки, которые даны выше
- Если хочешь упомянуть товар — бери ссылку ТОЛЬКО из списка выше`;
    } else if (isGreeting) {
      productInstructions = ''; // Для приветствий ничего не пишем о товарах
    } else if (extractedIntent.intent === 'general' || extractedIntent.intent === 'info') {
      // Проверяем, есть ли контекст разговора о товарах — возможно, клиент продолжает обсуждение
      const hasProductContext = historyForContext.some(m => 
        m.role === 'assistant' && (
          /₸|цена|бренд|в наличии|каталог|товар/i.test(m.content) ||
          /\[.*\]\(https?:\/\/.*\)/i.test(m.content) // markdown ссылки на товары
        )
      );
      
      if (hasProductContext) {
        // Есть контекст обсуждения товаров — клиент скорее всего продолжает разговор
        productInstructions = `
💡 ПРОДОЛЖЕНИЕ ДИАЛОГА О ТОВАРАХ

Клиент написал: "${extractedIntent.originalQuery}"

ВАЖНО: Ранее в диалоге вы обсуждали товары! Клиент скорее всего продолжает тот же разговор.
Например, если обсуждали кабели и клиент сказал "он мне нужен на кухню" — он имеет в виду кабель для кухни!

ТВОЙ ОТВЕТ:
1. Свяжи текущее сообщение с ПРЕДЫДУЩЕЙ темой разговора
2. Уточни потребность в контексте ранее обсуждавшихся товаров
3. Если клиент уточняет назначение (напр. "на кухню", "для ванной", "в гараж") — помоги подобрать подходящий вариант из той же категории
4. НЕ переключайся на другую тему, пока клиент явно не попросит

ЗАПРЕЩЕНО:
- НЕ теряй контекст разговора!
- НЕ переключайся на другие инструменты без причины
- НЕ шути про "я не повар/дизайнер" если клиент уточняет применение товара`;
      } else {
        // Нерелевантный запрос или вопрос об услугах — НЕ ищем в каталоге
        productInstructions = `
💡 НЕРЕЛЕВАНТНЫЙ ЗАПРОС ИЛИ ВОПРОС ОБ УСЛУГАХ

Клиент написал: "${extractedIntent.originalQuery}"

Это НЕ запрос товара из каталога. Отвечай дружелюбно и с юмором!

ТВОЙ ОТВЕТ:
1. Вежливо и с улыбкой объясни, что ты — консультант магазина электроинструментов
2. ЕСЛИ УМЕСТНО — сделай креативную ассоциацию с товарами магазина:
   - "хочу в кино" → "Билеты в кино не продаём 😊 Но для домашнего кинотеатра могу предложить кабели, удлинители или генератор на случай отключения света!"
   - "закажи пиццу" → "Пиццу доставить не могу, но могу помочь с электропечью или грилем для готовки дома! 🍕"
   - "какая погода" → "Прогноз погоды не моя специальность, но если планируете работать на улице — у нас есть отличные генераторы и садовая техника!"
3. Спроси, чем можешь помочь по части инструментов

ВАЖНО:
- НЕ говори "товар не найден в каталоге" — это звучит глупо для запроса типа "хочу в кино"
- Будь остроумным и дружелюбным
- Делай ненавязчивые ассоциации с товарами магазина`;
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
        
        const fallbackProducts = await searchProductsMulti(candidatesWithoutBrand, 6, appSettings.volt220_api_token || undefined);
        
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

# ${greetingContext}

# ${geoContext}

# Формат ответа: товары
Если товары найдены — покажи топ-3:

**[Название](ссылка_из_данных)** — *цена* ₸, бренд

Ссылки копируй точно из данных. Если товаров нет — задай уточняющие вопросы.

# Фильтрация по характеристикам
Каждый товар содержит раздел «Характеристики» (длина, мощность, сечение, количество розеток и т.д.).
Когда клиент указывает конкретные параметры (например, «5 метров», «2000 Вт», «3 розетки»):
1. Просмотри характеристики ВСЕХ найденных товаров
2. Отбери ТОЛЬКО те, что соответствуют запрошенным параметрам
3. Если подходящих товаров нет среди найденных — честно скажи и предложи ближайшие варианты
4. НЕ выдумывай характеристики — бери ТОЛЬКО из данных

# Формат ответа: филиалы и контакты
Когда клиент спрашивает про филиалы, адреса, контакты:
- Если город определён по геолокации — СРАЗУ покажи ближайший филиал этого города. Затем кратко упомяни: "Мы также представлены в других городах Казахстана — если интересно, подскажу!"
- Если город НЕ определён — уточни: "В каком городе вам удобнее?"
- НЕ выдавай все 10 филиалов сразу! Показывай только по запрошенному городу.

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
    
    // Retry logic for rate-limited free models
    const MAX_RETRIES = 3;
    const RETRY_DELAYS = [2000, 5000, 10000]; // 2s, 5s, 10s
    let response: Response | null = null;
    
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      response = await fetch(aiConfig.url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${aiConfig.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: aiConfig.model,
          messages: messagesForAI,
          stream: useStreaming,
        }),
      });

      if (response.status !== 429 || attempt === MAX_RETRIES) break;
      
      const errorBody = await response.text();
      console.log(`[Chat] Rate limit 429 (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${RETRY_DELAYS[attempt]}ms...`, errorBody);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempt]));
    }

    if (!response || !response.ok) {
      if (response?.status === 429) {
        const errorBody = await response.text();
        const providerName = aiConfig.url.includes('google') ? 'Google AI Studio' : aiConfig.url.includes('openrouter') ? 'OpenRouter' : 'AI';
        console.error(`[Chat] Rate limit 429 after all retries (${providerName}):`, errorBody);
        return new Response(
          JSON.stringify({ error: `Превышен лимит запросов к ${providerName}. Подождите 1-2 минуты и попробуйте снова, или смените провайдера/модель в настройках.` }),
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      if (response?.status === 402) {
        return new Response(
          JSON.stringify({ error: 'Требуется пополнение баланса AI.' }),
          { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      const errorText = await response?.text();
      console.error('[Chat] AI Gateway error:', response?.status, errorText);
      return new Response(
        JSON.stringify({ error: 'Ошибка AI сервиса' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Format contacts for display as a separate message
    const formattedContacts = formatContactsForDisplay(contactsInfo);

    // NON-STREAMING MODE: collect full response and return as JSON
    if (!useStreaming) {
      try {
        const aiData = await response.json();
        let content = aiData.choices?.[0]?.message?.content || '';
        console.log(`[Chat] Non-streaming response length: ${content.length}`);
        
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
          
          // Strip marker from chunks as they pass through
          text = text.replace(/\[CONTACT_MANAGER\]/g, '');
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
        
        // Strip marker from output
        text = text.replace(/\[CONTACT_MANAGER\]/g, '');
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
