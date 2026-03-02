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
      
      return {
        intent: parsed.intent || 'general',
        candidates: (parsed.candidates || []).map((c: any) => ({
          query: c.query || null,
          brand: c.brand || null,
          category: c.category || null,
          min_price: c.min_price || null,
          max_price: c.max_price || null,
        })),
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

// Форматирование товаров для AI с кликабельными ссылками
function formatProductsForAI(products: Product[]): string {
  if (products.length === 0) {
    return 'Товары не найдены в каталоге.';
  }

  return products.map((p, i) => {
    // Приоритет: brend__brend (бренд) > vendor (производитель/завод)
    // Пример: бренд = "Philips", vendor = "Shanghai Bipeng Lighting Company Limited"
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
    ].filter(Boolean);
    
    return parts.join('\n');
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
function formatContactsForDisplay(contactsText: string): string | null {
  if (!contactsText || contactsText.trim().length === 0) return null;
  
  const lines: string[] = [];
  
  // Extract phones — make them clickable tel: links
  const phoneMatches = contactsText.match(/(?:телефон[^:]*:\s*)([\+\d\s\(\)\-]+)/gi);
  if (phoneMatches) {
    for (const match of phoneMatches) {
      const number = match.replace(/телефон[^:]*:\s*/i, '').trim();
      if (number) {
        const telNumber = number.replace(/[\s\(\)\-]/g, '');
        lines.push(`📞 [${number}](tel:${telNumber})`);
      }
    }
  }
  
  // Extract messengers (WhatsApp, Telegram, etc.) — make clickable
  const messengerPatterns = [
    { regex: /WhatsApp[^:]*:\s*(https?:\/\/[^\s,]+|[\+\d\s]+)/gi, icon: '💬', label: 'WhatsApp', urlPrefix: 'https://wa.me/' },
    { regex: /Telegram[^:]*:\s*(https?:\/\/[^\s,]+|@[^\s,]+)/gi, icon: '💬', label: 'Telegram', urlPrefix: 'https://t.me/' },
    { regex: /Viber[^:]*:\s*([\+\d\s]+)/gi, icon: '💬', label: 'Viber', urlPrefix: 'viber://chat?number=' },
    { regex: /Instagram[^:]*:\s*(https?:\/\/[^\s,]+|@[^\s,]+)/gi, icon: '📷', label: 'Instagram', urlPrefix: 'https://instagram.com/' },
  ];
  
  for (const { regex, icon, label, urlPrefix } of messengerPatterns) {
    const matches = contactsText.match(regex);
    if (matches) {
      for (const match of matches) {
        const value = match.substring(match.indexOf(':') + 1).trim();
        if (value) {
          let url = value;
          if (value.startsWith('http')) {
            url = value;
          } else if (value.startsWith('@')) {
            url = urlPrefix + value.substring(1);
          } else {
            url = urlPrefix + value.replace(/[\s\(\)\-]/g, '');
          }
          lines.push(`${icon} [${label}](${url})`);
        }
      }
    }
  }
  
  // Extract email — make clickable mailto:
  const emailMatches = contactsText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
  if (emailMatches) {
    for (const email of emailMatches) {
      lines.push(`📧 [${email}](mailto:${email})`);
    }
  }
  
  // Extract working hours
  const hoursMatch = contactsText.match(/режим работы[^:]*:\s*([^\n]+)/i) 
    || contactsText.match(/график[^:]*:\s*([^\n]+)/i)
    || contactsText.match(/(Пн[^\n]+)/i);
  if (hoursMatch) {
    lines.push(`🕐 ${hoursMatch[1].trim()}`);
  }
  
  // Extract address
  const addressMatch = contactsText.match(/адрес[^:]*:\s*([^\n]+)/i);
  if (addressMatch) {
    lines.push(`📍 ${addressMatch[1].trim()}`);
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
    // Всегда ищем контакты — пригодятся если товары не найдены
    const contactsPromise = searchKnowledgeBase('контакты телефон WhatsApp режим работы менеджер', 2);
    
    const [knowledgeResults, contactResults] = await Promise.all([knowledgePromise, contactsPromise]);
    
    let contactsInfo = '';
    if (contactResults.length > 0) {
      contactsInfo = contactResults.map(r => r.content.substring(0, 500)).join('\n');
      console.log(`[Chat] Found contacts info in knowledge base`);
    }
    
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
    
    // Правило о приветствии
    let greetingRule = '';
    if (hasAssistantGreeting && isGreeting) {
      // Бот уже поздоровался раньше — нельзя здороваться снова
      greetingRule = `

⚠️ КРИТИЧЕСКИ ВАЖНО — НЕ ЗДОРОВАЙСЯ!
Ты УЖЕ поздоровался с клиентом в начале диалога. Повторное приветствие запрещено!

ТВОЙ ОТВЕТ ДОЛЖЕН НАЧИНАТЬСЯ С:
- "Чем могу помочь?"
- "Какой инструмент вас интересует?"
- "Отлично! Что будем искать сегодня?"

ЗАПРЕЩЕНО НАЧИНАТЬ С: "Здравствуйте", "Привет", "Добрый день", "Hello", "Hi"
ЗАПРЕЩЕНО ИСПОЛЬЗОВАТЬ: "Рад вас видеть снова" — ты НЕ знаешь, был ли клиент раньше!
НЕ УПОМИНАЙ: "товары не найдены", "уточните запрос"`;
    } else if (isGreeting) {
      // Первое сообщение — можно поздороваться
      greetingRule = `

Это первое приветствие от клиента. Поприветствуй тепло и спроси, что он ищет.
НЕ ИСПОЛЬЗУЙ: "Рад вас видеть снова" — это первое обращение клиента!
НЕ УПОМИНАЙ: "товары не найдены", "уточните запрос"`;
    }
    
    // Custom tone of voice from settings
    const toneOfVoice = appSettings.system_prompt 
      ? `\nТОН ОБЩЕНИЯ (настроен администратором):\n${appSettings.system_prompt}\n`
      : '';

    const systemPrompt = `Ты — AI-консультант интернет-магазина 220volt.kz, крупнейшего магазина электроинструментов и оборудования в Казахстане.
${toneOfVoice}

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
- Любая ссылка вида [Товар](https://220volt.kz/...) БЕЗ точного совпадения с данными = ОШИБКА!
- Если товаров нет в данных — НЕ УПОМИНАЙ конкретные модели, просто задай уточняющие вопросы
- НЕ ВЫДУМЫВАЙ информацию о доставке, оплате, гарантии — ТОЛЬКО из БАЗЫ ЗНАНИЙ!

ПРАВИЛА:
- Используй ТОЛЬКО данные из раздела "НАЙДЕННЫЕ ТОВАРЫ" для товаров
- Предлагай топ-3 товара, спрашивай нужно ли показать больше
- Для вопросов о доставке, оплате, гарантии, контактах — используй ТОЛЬКО информацию из БАЗЫ ЗНАНИЙ
- Если нужной информации нет в БАЗЕ ЗНАНИЙ — честно скажи "У меня нет информации об этом" и предложи связаться с менеджером

🆘 СВЯЗЬ С МЕНЕДЖЕРОМ (крайние случаи):
Предлагай связаться с менеджером ТОЛЬКО когда:
- Товар НЕ найден в каталоге и альтернатив тоже нет
- Вопрос требует индивидуального расчёта, проектирования или подбора комплекта
- Клиент спрашивает о возврате, рекламации или гарантийном случае
- Ты НЕ знаешь ответа и в Базе Знаний информации тоже нет
- Клиент повторно задаёт тот же вопрос (явно неудовлетворён ответом)

НЕ предлагай менеджера при обычных вопросах, когда ты можешь помочь сам!

📍 ФИЛИАЛЫ И АДРЕСА:
Когда клиент спрашивает о филиалах, адресах, пунктах выдачи, самовывозе или "где вы находитесь":
- Уточни, из какого он города
- Дай СТРУКТУРИРОВАННЫЙ список адресов из БАЗЫ ЗНАНИЙ (запись "Филиалы и адреса")
- Группируй по городам, каждый адрес отдельной строкой
- Если клиент назвал город — покажи только адреса в его городе

Когда предлагаешь связаться с менеджером — добавь в КОНЕЦ своего сообщения маркер [CONTACT_MANAGER] (он будет скрыт от пользователя и заменён на карточку с контактами). НЕ ПЕРЕЧИСЛЯЙ контактные данные сам — они подставятся автоматически.
${greetingRule}

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
