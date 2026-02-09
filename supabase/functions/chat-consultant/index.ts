import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const VOLT220_API_URL = 'https://220volt.testdevops.ru/api/products';

// Cached settings from DB
interface CachedSettings {
  volt220_api_token: string | null;
  openrouter_api_key: string | null;
  ai_model: string;
}

async function getAppSettings(): Promise<CachedSettings> {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.log('[Settings] Supabase not configured, using env vars');
    return {
      volt220_api_token: Deno.env.get('VOLT220_API_TOKEN') || null,
      openrouter_api_key: null,
      ai_model: 'meta-llama/llama-3.3-70b-instruct:free',
    };
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase
      .from('app_settings')
      .select('volt220_api_token, openrouter_api_key, ai_model')
      .limit(1)
      .single();

    if (error || !data) {
      console.error('[Settings] Error reading settings:', error);
      return {
        volt220_api_token: Deno.env.get('VOLT220_API_TOKEN') || null,
        openrouter_api_key: null,
        ai_model: 'meta-llama/llama-3.3-70b-instruct:free',
      };
    }

    // Fallback to env vars if DB values are empty
    return {
      volt220_api_token: data.volt220_api_token || Deno.env.get('VOLT220_API_TOKEN') || null,
      openrouter_api_key: data.openrouter_api_key || null,
      ai_model: data.ai_model || 'meta-llama/llama-3.3-70b-instruct:free',
    };
  } catch (e) {
    console.error('[Settings] Failed to load settings:', e);
    return {
      volt220_api_token: Deno.env.get('VOLT220_API_TOKEN') || null,
      openrouter_api_key: null,
      ai_model: 'meta-llama/llama-3.3-70b-instruct:free',
    };
  }
}

// Determine AI endpoint and key based on settings
function getAIConfig(settings: CachedSettings): { url: string; apiKey: string; model: string } {
  if (settings.openrouter_api_key) {
    // Strip :free suffix for OpenRouter API call — it's a UI hint only
    const model = settings.ai_model;
    return {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: settings.openrouter_api_key,
      model,
    };
  }

  // Fallback to Lovable AI Gateway
  const lovableKey = Deno.env.get('LOVABLE_API_KEY');
  if (lovableKey) {
    return {
      url: 'https://ai.gateway.lovable.dev/v1/chat/completions',
      apiKey: lovableKey,
      model: 'google/gemini-3-flash-preview',
    };
  }

  throw new Error('No AI provider configured. Set OpenRouter API key in Settings or configure LOVABLE_API_KEY.');
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
  query: string;
  brand: string | null;
  category: string | null;
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
  
  const extractionPrompt = `Ты — система извлечения поисковых намерений для интернет-магазина электроинструментов 220volt.testdevops.ru (тестовая среда).
${historyContext}
АНАЛИЗИРУЙ ТЕКУЩЕЕ сообщение С УЧЁТОМ КОНТЕКСТА РАЗГОВОРА!

🔴 КРИТИЧЕСКИ ВАЖНО — ОПРЕДЕЛИ ПРАВИЛЬНЫЙ INTENT:

1. Тип намерения (intent):
   - "catalog" — пользователь ЯВНО ищет электроинструмент, оборудование, товары магазина:
     * Примеры: "дрель", "перфоратор", "болгарка", "шуруповерт", "генератор", "насос", "кабель", "сварка", "розетка", "выключатель", "автомат"
     * "есть ли Makita?", "покажи дрели", "сколько стоит перфоратор?"
   
   - "brands" — пользователь спрашивает КАКИЕ БРЕНДЫ представлены:
     * "какие бренды?", "какие марки?", "какие производители?"
   
   - "info" — вопросы о компании, доставке, оплате, гарантии, контактах
   
   - "general" — ВСЁ ОСТАЛЬНОЕ! Приветствия, благодарности, шутки, нерелевантные запросы:
     * "привет", "спасибо", "пока"
     * "хочу в кино", "закажи пиццу", "какая погода?" — это НЕ каталог!
     * Любые запросы НЕ связанные с электроинструментом = general

🚨 ВАЖНОЕ ПРАВИЛО:
Если запрос НЕ про электроинструмент/оборудование — это ВСЕГДА intent="general", даже если содержит слова "хочу", "купить", "есть".
Примеры general: "хочу в кино", "купи мне пиццу", "есть ли у вас кофе" — это НЕ catalog!

КОНТЕКСТ РАЗГОВОРА:
Если ранее обсуждали конкретный товар и пользователь спрашивает "какие бренды?" или "а дешевле?" — используй категорию из контекста.

🔴 КРИТИЧЕСКИ ВАЖНО — ПРАВИЛА ГЕНЕРАЦИИ КАНДИДАТОВ:

🧠 ПРИНЦИП СЕМАНТИЧЕСКОЙ ТРАНСФОРМАЦИИ:
Ты понимаешь естественный язык. Пользователь говорит РАЗГОВОРНЫМ языком, а каталог использует ТЕХНИЧЕСКИЕ термины.
Твоя задача — ПОНЯТЬ смысл запроса и ПЕРЕВЕСТИ его на язык каталога электротоваров.

Примеры трансформации (ты должен делать это для ЛЮБЫХ терминов, не только этих):
- "рамка на 2 слота" → ты понимаешь: пользователь имеет в виду рамку на 2 места/поста → генерируй: "рамка 2-местная", "рамка двухместная"
- "болгарка" → ты знаешь: это разговорное название УШМ → генерируй: "УШМ", "угловая шлифмашина", "болгарка"
- "тройник для розетки" → ты понимаешь: это разветвитель/удлинитель → генерируй: "разветвитель", "удлинитель", "колодка"

НЕ КОПИРУЙ разговорные слова пользователя напрямую! ПЕРЕВОДИ их в технические термины каталога.

Для intent="catalog" или "brands":
- ПЕРВЫЙ кандидат = главный технический термин товара (как он называется В КАТАЛОГЕ)
- Остальные 2-4 кандидата = вариации технических названий и синонимы из профессиональной лексики
- КОРОТКИЕ запросы (1-2 слова) работают лучше! API плохо ищет длинные фразы

Примеры правильной генерации:
- Запрос: "рамка для розетки на 2 слота" → Кандидаты: ["рамка 2-местная", "рамка двухместная", "рамка 2 поста"]
- Запрос: "провод трёхжильный 2.5" → Кандидаты: ["кабель 3x2.5", "ВВГ 3x2.5", "провод 3x2.5"]
- Запрос: "дырка под розетку" → Кандидаты: ["подрозетник", "установочная коробка", "монтажная коробка"]

Для intent="general" или "info":
- candidates = [] (пустой массив!)

ТЕКУЩЕЕ сообщение пользователя: "${message}"`;

  // Extract model from special :free suffix format
  const model = apiKey.startsWith('sk-or-') ? aiModel : 'google/gemini-3-flash-preview';
  
  try {
    const response = await fetch(aiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        model: 'google/gemini-3-flash-preview',
        messages: [
          { role: 'system', content: extractionPrompt },
          { role: 'user', content: message }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'extract_search_intent',
              description: 'Извлекает намерение пользователя и генерирует поисковые кандидаты',
              parameters: {
                type: 'object',
                properties: {
                  intent: { 
                    type: 'string', 
                    enum: ['catalog', 'brands', 'info', 'general'],
                    description: 'Тип намерения: brands — спрашивает какие бренды есть, catalog — ищет товары'
                  },
                  candidates: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        query: { 
                          type: 'string',
                          description: 'Поисковый запрос для API (1-3 слова)'
                        },
                        brand: { 
                          type: 'string',
                          nullable: true,
                          description: 'Бренд если указан (Makita, Bosch и т.д.)'
                        },
                        category: {
                          type: 'string', 
                          nullable: true,
                          description: 'Категория товара если определена'
                        }
                      },
                      required: ['query'],
                      additionalProperties: false
                    },
                    description: 'Массив поисковых кандидатов (3-6 штук, включая синонимы и вариации)'
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
      // Fallback на простой парсинг
      return fallbackParseQuery(message);
    }

    const data = await response.json();
    console.log(`[AI Candidates] Raw response:`, JSON.stringify(data, null, 2));

    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    if (toolCall?.function?.arguments) {
      const parsed = JSON.parse(toolCall.function.arguments);
      console.log(`[AI Candidates] Extracted:`, JSON.stringify(parsed, null, 2));
      
      return {
        intent: parsed.intent || 'general',
        candidates: parsed.candidates || [],
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

// Быстрый regex-парсинг для простых запросов (экономит ~2 сек на AI-вызове)
function fastParseQuery(message: string): ExtractedIntent | null {
  const KNOWN_BRANDS = [
    'makita', 'bosch', 'dewalt', 'metabo', 'hitachi', 'milwaukee', 'stihl',
    'husqvarna', 'karcher', 'вихрь', 'patriot', 'зубр', 'интерскол', 'elitech',
    'fubag', 'huter', 'champion', 'denzel', 'sturm', 'fit', 'legrand', 'abb',
    'schneider', 'iek', 'ekf', 'chint', 'navigator', 'rexant', 'tdm'
  ];
  
  // Ключевые слова товаров с синонимами
  const PRODUCT_KEYWORDS: Record<string, string[]> = {
    'дрель': ['дрель', 'дрели', 'дрелью'],
    'перфоратор': ['перфоратор', 'перфораторы', 'перфа'],
    'шуруповерт': ['шуруповерт', 'шуруповёрт', 'шурик', 'винтоверт'],
    'болгарка': ['болгарка', 'ушм', 'угловая шлифовальная'],
    'пила': ['пила', 'пилы', 'лобзик', 'циркулярка', 'торцовка'],
    'генератор': ['генератор', 'электростанция', 'бензогенератор'],
    'насос': ['насос', 'помпа', 'мотопомпа'],
    'компрессор': ['компрессор', 'компрессоры'],
    'сварка': ['сварка', 'сварочный', 'инвертор', 'электроды'],
    'розетка': ['розетка', 'розетки', 'розеток'],
    'выключатель': ['выключатель', 'выключатели', 'клавиша'],
    'автомат': ['автомат', 'автоматы', 'автоматический выключатель', 'узо', 'диф'],
    'кабель': ['кабель', 'провод', 'провода', 'пвс', 'ввг'],
    'удлинитель': ['удлинитель', 'переноска', 'колодка'],
    'светильник': ['светильник', 'лампа', 'люстра', 'прожектор', 'led'],
    'щит': ['щит', 'щиток', 'бокс', 'шкаф электрический'],
    'клемма': ['клемма', 'клеммы', 'зажим', 'wago'],
    'инструмент': ['инструмент', 'инструменты', 'набор']
  };
  
  const INFO_KEYWORDS = ['доставка', 'оплата', 'гарантия', 'возврат', 'адрес', 'телефон', 'контакт', 'режим работы', 'часы работы'];
  const GREETING_WORDS = ['привет', 'здравствуй', 'добрый', 'хай', 'hello', 'hi', 'салем', 'hey'];
  
  const lowerMessage = message.toLowerCase();
  
  // Быстрая проверка на приветствие
  if (GREETING_WORDS.some(g => lowerMessage.startsWith(g)) && message.length < 30) {
    console.log(`[FastParse] Quick greeting detected: "${message}"`);
    return { intent: 'general', candidates: [], originalQuery: message };
  }
  
  // Быстрая проверка на info
  if (INFO_KEYWORDS.some(k => lowerMessage.includes(k))) {
    console.log(`[FastParse] Info query detected: "${message}"`);
    return { intent: 'info', candidates: [], originalQuery: message };
  }
  
  // Ищем продуктовые ключевые слова
  let foundProduct: string | null = null;
  let foundCategory: string | null = null;
  
  for (const [category, keywords] of Object.entries(PRODUCT_KEYWORDS)) {
    for (const kw of keywords) {
      if (lowerMessage.includes(kw)) {
        foundProduct = kw;
        foundCategory = category;
        break;
      }
    }
    if (foundProduct) break;
  }
  
  // Ищем бренд
  let foundBrand: string | null = null;
  for (const brand of KNOWN_BRANDS) {
    if (lowerMessage.includes(brand.toLowerCase())) {
      foundBrand = brand;
      break;
    }
  }
  
  // Если нашли товар или бренд — это catalog запрос
  if (foundProduct || foundBrand) {
    // Генерируем кандидаты
    const candidates: SearchCandidate[] = [];
    
    // Первый кандидат — базовое слово
    if (foundCategory) {
      candidates.push({ query: foundCategory, brand: foundBrand, category: foundCategory });
    }
    
    // Второй кандидат — с брендом если есть
    if (foundBrand && foundCategory) {
      candidates.push({ query: `${foundCategory} ${foundBrand}`, brand: foundBrand, category: foundCategory });
    }
    
    // Третий — только бренд
    if (foundBrand && !foundCategory) {
      candidates.push({ query: foundBrand, brand: foundBrand, category: null });
    }
    
    // Если ничего не нашли через ключевые слова, пробуем очистить запрос
    if (candidates.length === 0) {
      let cleanQuery = message
        .replace(/[?!.,]+/g, ' ')
        .replace(/^(мне нужен|мне нужна|нужен|нужна|хочу|ищу|есть ли|покажи|найди|подскажите)\s*/gi, '')
        .replace(/\s*(пожалуйста|спасибо|есть|в наличии|у вас)$/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
      
      if (cleanQuery.length > 2) {
        // Берём первое слово как базовый запрос
        const firstWord = cleanQuery.split(/\s+/)[0];
        candidates.push({ query: firstWord, brand: foundBrand, category: null });
        if (cleanQuery !== firstWord) {
          candidates.push({ query: cleanQuery.split(/\s+/).slice(0, 2).join(' '), brand: foundBrand, category: null });
        }
      }
    }
    
    console.log(`[FastParse] Catalog query: "${message}" → candidates: ${candidates.map(c => c.query).join(', ')}`);
    return { intent: 'catalog', candidates, originalQuery: message };
  }
  
  // Проверяем на вопрос о бренде
  if (/какие (бренды|марки|производители)/i.test(message)) {
    console.log(`[FastParse] Brands query detected: "${message}"`);
    return { intent: 'brands', candidates: [{ query: 'инструмент', brand: null, category: null }], originalQuery: message };
  }
  
  // Если ничего не распознали — возвращаем null, будем использовать AI
  return null;
}

// Fallback парсинг если AI недоступен (полная версия)
function fallbackParseQuery(message: string): ExtractedIntent {
  // Сначала пробуем быстрый парсинг
  const fastResult = fastParseQuery(message);
  if (fastResult) return fastResult;
  
  // Если быстрый не справился — базовый fallback
  const lowerMessage = message.toLowerCase();
  
  const catalogKeywords = ['товар', 'цена', 'купить', 'заказать', 'найти', 'есть', 'какие', 'покажи'];
  const infoKeywords = ['доставка', 'оплата', 'гарантия', 'возврат', 'адрес', 'телефон', 'контакт'];
  
  let product = message.replace(/[?!.,]+/g, ' ').replace(/\s+/g, ' ').trim();
  
  // Убираем общие фразы
  product = product
    .replace(/^(привет|здравствуйте|добрый день|мне нужен|мне нужна|хочу купить|ищу|нужен|есть ли|какие есть|есть|покажи|найди)\s*/gi, '')
    .replace(/\s*(пожалуйста|спасибо|есть|в наличии|у вас)$/gi, '')
    .trim();
  
  const isCatalog = catalogKeywords.some(k => lowerMessage.includes(k)) && product.length > 2;
  const isInfo = infoKeywords.some(k => lowerMessage.includes(k));
  
  const intent = isCatalog ? 'catalog' : isInfo ? 'info' : 'general';
  
  console.log(`[Fallback] intent=${intent}, query="${product}"`);
  
  return {
    intent,
    candidates: product && intent === 'catalog' ? [{ query: product, brand: null, category: null }] : [],
    originalQuery: message
  };
}

// Поиск товаров по одному кандидату
async function searchProductsByCandidate(
  candidate: SearchCandidate, 
  apiToken: string,
  limit: number = 5
): Promise<Product[]> {
  try {
    const params = new URLSearchParams();
    
    if (candidate.query) {
      params.append('query', candidate.query);
    }
    params.append('per_page', limit.toString());
    
    if (candidate.brand) {
      const brandCapitalized = candidate.brand.charAt(0).toUpperCase() + candidate.brand.slice(1).toLowerCase();
      params.append('options[brend__brend][]', brandCapitalized);
    }
    
    // НЕ передаём category в API — query уже содержит нужный текст
    // API фильтрует по category как по точному названию, что ломает поиск

    console.log(`[Search] Candidate: query="${candidate.query}", brand="${candidate.brand}", category="${candidate.category}"`);

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

  console.log(`[Search] Searching ${candidates.length} candidates in parallel...`);

  // Параллельный поиск
  const searchPromises = candidates.map(candidate => 
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
  
  const uniqueProducts = Array.from(productMap.values());
  console.log(`[Search] Total unique products: ${uniqueProducts.length}`);
  
  // Сортируем по наличию и цене
  uniqueProducts.sort((a, b) => {
    // Сначала товары в наличии
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

// Форматирование товаров для AI с кликабельными ссылками
function formatProductsForAI(products: Product[]): string {
  if (products.length === 0) {
    return 'Товары не найдены в каталоге.';
  }

  return products.map((p, i) => {
    let brand = p.vendor;
    if (!brand && p.options) {
      const brandOption = p.options.find(o => o.key === 'brend__brend');
      if (brandOption) {
        brand = brandOption.value.split('//')[0];
      }
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
      p.category ? `   - Категория: [${p.category.pagetitle}](https://220volt.testdevops.ru/catalog/${p.category.id})` : '',
    ].filter(Boolean);
    
    return parts.join('\n');
  }).join('\n\n');
}

// Извлекаем уникальные бренды из товаров
function extractBrandsFromProducts(products: Product[]): string[] {
  const brands = new Set<string>();
  
  for (const product of products) {
    // Пробуем vendor
    if (product.vendor && product.vendor.trim()) {
      brands.add(product.vendor.trim());
    }
    // Пробуем options[brend__brend]
    if (product.options) {
      const brandOption = product.options.find(o => o.key === 'brend__brend');
      if (brandOption && brandOption.value) {
        // Берём только русскую часть (до //)
        const brandName = brandOption.value.split('//')[0].trim();
        if (brandName) {
          brands.add(brandName);
        }
      }
    }
  }
  
  return Array.from(brands).sort();
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    
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
    const userMessage = lastMessage?.content || '';
    
    console.log(`[Chat] Processing: "${userMessage}"`);
    console.log(`[Chat] Conversation ID: ${conversationId}`);

    // Подготавливаем историю для контекста (без текущего сообщения)
    const historyForContext = messages.slice(0, -1);

    // ШАГ 1: Сначала пробуем быстрый парсинг (экономит ~2 сек)
    let extractedIntent = fastParseQuery(userMessage);
    
    if (extractedIntent) {
      console.log(`[Chat] FastParse: Intent=${extractedIntent.intent}, Candidates: ${extractedIntent.candidates.length}`);
    } else {
      // Быстрый парсинг не справился — используем AI (сложные запросы)
      console.log(`[Chat] FastParse failed, using AI for: "${userMessage}"`);
      extractedIntent = await generateSearchCandidates(userMessage, aiConfig.apiKey, historyForContext, aiConfig.url, aiConfig.model);
      console.log(`[Chat] AI: Intent=${extractedIntent.intent}, Candidates: ${extractedIntent.candidates.length}`);
    }

    let productContext = '';
    let foundProducts: Product[] = [];
    let brandsContext = '';
    let knowledgeContext = '';

    // ШАГ 2: Поиск в базе знаний (параллельно с другими запросами)
    // Ищем для info запросов или общих вопросов
    if (extractedIntent.intent === 'info' || extractedIntent.intent === 'general') {
      const knowledgeResults = await searchKnowledgeBase(userMessage, 3);
      
      if (knowledgeResults.length > 0) {
        knowledgeContext = `
📚 ИНФОРМАЦИЯ ИЗ БАЗЫ ЗНАНИЙ (используй для ответа!):

${knowledgeResults.map((r, i) => `--- ${r.title} ---
${r.content.substring(0, 1500)}
${r.source_url ? `Источник: ${r.source_url}` : ''}
`).join('\n')}

ИНСТРУКЦИЯ: Используй информацию выше для ответа клиенту. Если информация релевантна вопросу — цитируй её.`;
        
        console.log(`[Chat] Added ${knowledgeResults.length} knowledge entries to context`);
      }
    }
    if (extractedIntent.intent === 'brands' && extractedIntent.candidates.length > 0) {
      // Запрос о брендах — ищем товары и извлекаем бренды
      foundProducts = await searchProductsMulti(extractedIntent.candidates, 50, appSettings.volt220_api_token || undefined); // Берём больше для полноты брендов
      
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
3. Предложи ссылку на каталог: https://220volt.testdevops.ru/catalog/`;
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
          brand: null, // Убираем бренд для fallback поиска
          query: c.query.replace(brandPattern, '').replace(/\s+/g, ' ').trim() // Убираем бренд из query
        })).filter(c => c.query.length > 1); // Фильтруем пустые query
        
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
          productInstructions = `
🚨 КРИТИЧЕСКИ ВАЖНО — БРЕНД НЕ НАЙДЕН И НЕТ АЛЬТЕРНАТИВ!

Клиент спросил о бренде: ${uniqueBrands.join(', ')}
Мы выполнили поиск в каталоге — ТОВАРОВ ЭТОГО БРЕНДА И ПОХОЖИХ КАТЕГОРИЙ НЕТ!

ТВОЙ ОТВЕТ ДОЛЖЕН БЫТЬ ТАКИМ:
1. ЧЕСТНО скажи: "К сожалению, товаров бренда ${uniqueBrands.join('/')} сейчас нет в нашем каталоге."
2. Предложи: "Расскажите подробнее, какой инструмент вам нужен — попробую подобрать из доступных."
3. Или предложи посмотреть каталог: https://220volt.testdevops.ru/catalog/

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
        
        productInstructions = `
🚨 КРИТИЧЕСКИ ВАЖНО — ТОВАР/КАТЕГОРИЯ НЕ НАЙДЕНА!

Клиент искал: "${categoryText}"
Мы выполнили поиск в каталоге — ТАКИХ ТОВАРОВ НЕТ В НАЛИЧИИ!

ТВОЙ ОТВЕТ ДОЛЖЕН БЫТЬ ТАКИМ:
1. ЧЕСТНО скажи: "К сожалению, ${categoryText} сейчас нет в нашем каталоге."
2. Предложи альтернативу: "Могу подобрать другой инструмент. Расскажите, какую задачу вы хотите решить?"
3. Или предложи посмотреть каталог: https://220volt.testdevops.ru/catalog/

СТРОГО ЗАПРЕЩЕНО:
- НЕ ДЕЛАЙ ВИД что товар есть!
- НЕ ПРОСИ уточнить бюджет или тип патрона для товара, которого НЕТ!
- НЕ ПРИДУМЫВАЙ товары, названия, цены или URL!
- НЕ ГОВОРИ "у нас есть аналоги" — если товара нет, аналогов тоже нет!
- НЕ СОЗДАВАЙ ссылки на несуществующие разделы типа https://220volt.testdevops.ru/catalog/perforatory/`;
      }
    }
    
    // Правило о приветствии
    let greetingRule = '';
    if (hasAssistantGreeting && isGreeting) {
      // Бот уже поздоровался раньше — нельзя здороваться снова
      greetingRule = `

⚠️ КРИТИЧЕСКИ ВАЖНО — НЕ ЗДОРОВАЙСЯ!
Ты УЖЕ поздоровался с клиентом в начале диалога. Повторное приветствие запрещено!

ТВОЙ ОТВЕТ ДОЛЖЕН НАЧИНАТЬСЯ С:
- "Рад вас видеть снова! Чем могу помочь?"
- "Какой инструмент вас интересует?"
- "Отлично! Что будем искать сегодня?"

ЗАПРЕЩЕНО НАЧИНАТЬ С: "Здравствуйте", "Привет", "Добрый день", "Hello", "Hi"
НЕ УПОМИНАЙ: "товары не найдены", "уточните запрос"`;
    } else if (isGreeting) {
      // Первое сообщение — можно поздороваться
      greetingRule = `

Это первое приветствие от клиента. Поприветствуй тепло и спроси, что он ищет.
НЕ УПОМИНАЙ: "товары не найдены", "уточните запрос"`;
    }
    
    const systemPrompt = `Ты — AI-консультант интернет-магазина 220volt.testdevops.ru (тестовая среда), крупнейшего магазина электроинструментов и оборудования в Казахстане.

ТВОЯ РОЛЬ:
- Помогаешь клиентам выбрать подходящий инструмент или оборудование
- Отвечаешь на вопросы о товарах, доставке, оплате и гарантии  
- Рекомендуешь ТОЛЬКО те товары, которые найдены в каталоге

ПРАВИЛА ПО БРЕНДАМ:
- Можешь предлагать и упоминать бренды, но ТОЛЬКО те, что есть в разделе "НАЙДЕННЫЕ ТОВАРЫ"
- Если товары найдены — смело рекомендуй бренды из результатов
- Если клиент спрашивает бренд, а товаров НЕ найдено — скажи что по этому бренду сейчас ничего не нашлось, и предложи альтернативы из найденных товаров
- НЕ выдумывай бренды "из головы" — только из реальных данных API

ФОРМАТ ОТВЕТА ДЛЯ ТОВАРОВ (ТОЛЬКО если товары найдены):
1. **[Название товара](ТОЧНАЯ_ССЫЛКА_ИЗ_ДАННЫХ)**
   - Цена: XXX ₸
   - Бренд: YYY

🚨 АБСОЛЮТНЫЙ ЗАПРЕТ ГАЛЛЮЦИНАЦИЙ:
- НИКОГДА не выдумывай URL, товары, цены, артикулы или модели!
- НИКОГДА не создавай ссылки которых нет в разделе "НАЙДЕННЫЕ ТОВАРЫ"
- Если создаёшь ссылку — она ОБЯЗАНА быть скопирована из данных выше
- Любая ссылка вида [Товар](https://220volt.testdevops.ru/...) БЕЗ точного совпадения с данными = ОШИБКА!
- Если товаров нет в данных — НЕ УПОМИНАЙ конкретные модели, просто задай уточняющие вопросы
- НЕ ВЫДУМЫВАЙ информацию о доставке, оплате, гарантии — ТОЛЬКО из БАЗЫ ЗНАНИЙ!

ПРАВИЛА:
- Используй ТОЛЬКО данные из раздела "НАЙДЕННЫЕ ТОВАРЫ" для товаров
- Предлагай топ-3 товара, спрашивай нужно ли показать больше
- Для вопросов о доставке, оплате, гарантии, контактах — используй ТОЛЬКО информацию из БАЗЫ ЗНАНИЙ
- Если нужной информации нет в БАЗЕ ЗНАНИЙ — честно скажи "У меня нет информации об этом" и предложи связаться по телефону с сайта${greetingRule}

${knowledgeContext}

${productInstructions}`;

    console.log(`[Chat] System prompt length: ${systemPrompt.length}, productInstructions included: ${productInstructions.length > 0}`);

    // ШАГ 4: Финальный ответ от AI
    const messagesForAI = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];
    
    let response = await fetch(aiConfig.url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${aiConfig.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: aiConfig.model,
        messages: messagesForAI,
        stream: true,
      }),
    });

    // Fallback to Lovable AI Gateway if OpenRouter fails (model not found, etc.)
    if (!response.ok && aiConfig.url.includes('openrouter.ai')) {
      const errorText = await response.text();
      console.warn('[Chat] OpenRouter error:', response.status, errorText, '— falling back to Lovable AI Gateway');
      
      const lovableKey = Deno.env.get('LOVABLE_API_KEY');
      if (lovableKey) {
        response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${lovableKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'google/gemini-3-flash-preview',
            messages: messagesForAI,
            stream: true,
          }),
        });
        console.log('[Chat] Lovable AI Gateway fallback response:', response.status);
      }
    }

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: 'Превышен лимит запросов. Попробуйте позже.' }),
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
      
      const stream = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          
          let text = decoder.decode(value, { stream: true });
          
          // Удаляем приветствие только из первого data-чанка с content
          if (!greetingRemoved && text.includes('content')) {
            console.log('[Greeting Filter] Checking chunk:', text.substring(0, 200));
            
            const before = text;
            
            // Грубая замена приветствий в начале content
            // Паттерны: "content":"Здравствуйте! ...", "content":"Привет! ..."
            const greetings = ['Здравствуйте', 'Привет', 'Добрый день', 'Добрый вечер', 'Доброе утро', 'Hello', 'Hi', 'Хай'];
            
            for (const greeting of greetings) {
              // Ищем "content":"Greeting" с возможными знаками препинания и эмоджи после
              const pattern = new RegExp(
                `"content":"${greeting}[!.,]?\\s*(?:👋|🛠️|😊)?\\s*`,
                'gi'
              );
              const matched = text.match(pattern);
              if (matched) {
                console.log('[Greeting Filter] Found match:', matched[0]);
              }
              text = text.replace(pattern, '"content":"');
            }
            
            if (before !== text) {
              greetingRemoved = true;
              console.log('[Greeting Filter] Removed greeting from response');
            } else {
              console.log('[Greeting Filter] No greeting match found');
            }
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

    return new Response(response.body, {
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
