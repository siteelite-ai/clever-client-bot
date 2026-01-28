import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const VOLT220_API_URL = 'https://220volt.kz/api/products';

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
  intent: 'catalog' | 'info' | 'general';
  candidates: SearchCandidate[];
  originalQuery: string;
}

// Генерация поисковых кандидатов через AI
async function generateSearchCandidates(
  message: string, 
  apiKey: string
): Promise<ExtractedIntent> {
  console.log(`[AI Candidates] Extracting search intent from: "${message}"`);
  
  const extractionPrompt = `Ты — система извлечения поисковых намерений для интернет-магазина электроинструментов 220volt.kz.

Проанализируй сообщение пользователя и определи:
1. Тип намерения (intent):
   - "catalog" — пользователь ищет товары, хочет купить, интересуется ценами/наличием
   - "info" — вопросы о доставке, оплате, гарантии, контактах
   - "general" — приветствие, благодарность, общие вопросы

2. Если intent="catalog", сгенерируй 2-5 поисковых запросов-кандидатов для API каталога:
   - Основной запрос (как написал пользователь, очищенный)
   - Синонимы и вариации (например: "дрель" -> ["дрель", "шуруповерт", "дрель-шуруповерт"])
   - Если упомянут бренд — включи его отдельно
   - Если можно определить категорию — укажи её

ВАЖНО: 
- Кандидаты должны быть короткими (1-3 слова)
- Не добавляй вспомогательные слова (нужен, хочу, купить)
- Бренды выделяй отдельно (Makita, Bosch, DeWalt, Metabo и т.д.)

Сообщение пользователя: "${message}"`;

  try {
    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
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
                    enum: ['catalog', 'info', 'general'],
                    description: 'Тип намерения пользователя'
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
                    description: 'Массив поисковых кандидатов (2-5 штук)'
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

// Fallback парсинг если AI недоступен
function fallbackParseQuery(message: string): ExtractedIntent {
  const KNOWN_BRANDS = [
    'makita', 'bosch', 'dewalt', 'metabo', 'hitachi', 'milwaukee', 'stihl',
    'husqvarna', 'karcher', 'вихрь', 'patriot', 'зубр', 'интерскол', 'elitech',
    'fubag', 'huter', 'champion', 'denzel', 'sturm', 'fit'
  ];
  
  const catalogKeywords = [
    'товар', 'цена', 'купить', 'заказать', 'найти', 'дрель', 'перфоратор',
    'болгарка', 'шуруповерт', 'пила', 'генератор', 'насос', 'компрессор', 
    'кабель', 'сварка', 'инструмент', 'провод', 'есть', 'какие', ...KNOWN_BRANDS
  ];
  
  const infoKeywords = ['доставка', 'оплата', 'гарантия', 'возврат', 'адрес', 'телефон', 'контакт'];
  
  const lowerMessage = message.toLowerCase();
  let product = message.replace(/[?!.,]+/g, ' ').replace(/\s+/g, ' ').trim();
  
  // Убираем общие фразы
  const cleaners = [
    /^(привет|здравствуйте|добрый день|мне нужен|мне нужна|хочу купить|ищу|нужен|есть ли|какие есть|есть|покажи|найди)\s*/gi,
    /\s*(пожалуйста|спасибо|есть|в наличии|у вас)$/gi,
  ];
  for (const regex of cleaners) {
    product = product.replace(regex, '').trim();
  }
  
  // Определяем бренд
  let foundBrand: string | null = null;
  for (const brand of KNOWN_BRANDS) {
    if (lowerMessage.includes(brand)) {
      foundBrand = brand;
      product = product.replace(new RegExp(brand, 'gi'), '').trim();
      break;
    }
  }
  
  const isCatalog = catalogKeywords.some(k => lowerMessage.includes(k));
  const isInfo = infoKeywords.some(k => lowerMessage.includes(k));
  
  const intent = isCatalog ? 'catalog' : isInfo ? 'info' : 'general';
  
  console.log(`[Fallback] intent=${intent}, query="${product}", brand="${foundBrand}"`);
  
  return {
    intent,
    candidates: product ? [{ query: product, brand: foundBrand, category: null }] : [],
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
    
    if (candidate.category) {
      params.append('category', candidate.category);
    }

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
  limit: number = 10
): Promise<Product[]> {
  const apiToken = Deno.env.get('VOLT220_API_TOKEN');
  
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

// Форматирование товаров для AI
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
    
    const parts = [
      `${i + 1}. **${p.pagetitle}**`,
      `   - Цена: ${p.price.toLocaleString('ru-KZ')} ₸${p.old_price && p.old_price > 0 ? ` (было ${p.old_price.toLocaleString('ru-KZ')} ₸)` : ''}`,
      brand ? `   - Бренд: ${brand}` : '',
      p.article ? `   - Артикул: ${p.article}` : '',
      `   - В наличии: ${p.amount > 0 ? `Да (${p.amount} шт.)` : 'Под заказ'}`,
      p.category ? `   - Категория: ${p.category.pagetitle}` : '',
      `   - Ссылка: ${p.url}`,
    ].filter(Boolean);
    
    return parts.join('\n');
  }).join('\n\n');
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
    
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      throw new Error('LOVABLE_API_KEY is not configured');
    }

    const lastMessage = messages[messages.length - 1];
    const userMessage = lastMessage?.content || '';
    
    console.log(`[Chat] Processing: "${userMessage}"`);
    console.log(`[Chat] Conversation ID: ${conversationId}`);

    // ШАГ 1: AI генерирует поисковые кандидаты
    const extractedIntent = await generateSearchCandidates(userMessage, LOVABLE_API_KEY);
    console.log(`[Chat] Intent: ${extractedIntent.intent}, Candidates: ${extractedIntent.candidates.length}`);

    let productContext = '';
    let foundProducts: Product[] = [];

    // ШАГ 2: Если каталожный запрос — параллельный поиск по всем кандидатам
    if (extractedIntent.intent === 'catalog' && extractedIntent.candidates.length > 0) {
      foundProducts = await searchProductsMulti(extractedIntent.candidates, 8);
      
      if (foundProducts.length > 0) {
        const candidateQueries = extractedIntent.candidates.map(c => c.query).join(', ');
        productContext = `\n\n**Найденные товары (поиск по: ${candidateQueries}):**\n\n${formatProductsForAI(foundProducts)}`;
      }
    }

    // ШАГ 3: Системный промпт с контекстом товаров
    const systemPrompt = `Ты — AI-консультант интернет-магазина 220volt.kz, крупнейшего магазина электроинструментов и оборудования в Казахстане.

ТВОЯ РОЛЬ:
- Помогаешь клиентам выбрать подходящий инструмент или оборудование
- Отвечаешь на вопросы о товарах, доставке, оплате и гарантии
- Рекомендуешь товары на основе потребностей клиента

ИНФОРМАЦИЯ О КОМПАНИИ:
- Название: 220volt.kz
- Специализация: электроинструменты, бензоинструменты, садовая техника, сварочное оборудование, компрессоры, насосы, генераторы
- Бренды: Makita, Bosch, DeWalt, Metabo, Hitachi, Milwaukee, Stihl, Husqvarna, Karcher и другие
- Доставка: по всему Казахстану, бесплатно при заказе от 50 000 ₸
- Оплата: наличными, картой, безналичный расчёт, рассрочка
- Гарантия: официальная гарантия производителя на весь товар
- Сайт: https://220volt.kz
- Телефон: 8 (727) 350-52-52

КРИТИЧЕСКИЕ ПРАВИЛА:
1. ВСЕГДА используй ТОЛЬКО товары из раздела "НАЙДЕННЫЕ ТОВАРЫ" ниже
2. НИКОГДА не выдумывай товары, цены или ссылки
3. Если товары не найдены - честно скажи об этом и предложи уточнить запрос
4. Используй ТОЛЬКО ссылки из данных товаров, не придумывай URL
5. Отвечай дружелюбно и профессионально на русском языке
6. Если найдено много товаров — предложи топ-3 и спроси, нужно ли показать больше

${productContext ? `НАЙДЕННЫЕ ТОВАРЫ (используй ТОЛЬКО эти данные):${productContext}` : 'ТОВАРЫ НЕ НАЙДЕНЫ. Предложи клиенту уточнить запрос или посмотреть каталог на сайте https://220volt.kz'}`;

    // ШАГ 4: Финальный ответ от AI
    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-3-flash-preview',
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
        stream: true,
      }),
    });

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
