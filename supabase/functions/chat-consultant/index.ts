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

// Известные бренды для фильтрации
const KNOWN_BRANDS = [
  'makita', 'bosch', 'dewalt', 'metabo', 'hitachi', 'milwaukee', 'stihl',
  'husqvarna', 'karcher', 'вихрь', 'patriot', 'зубр', 'интерскол', 'elitech',
  'fubag', 'huter', 'champion', 'denzel', 'sturm', 'fit'
];

// Извлечение продукта и бренда из запроса
function parseQuery(message: string): { product: string; brand: string | null } {
  const lowerMessage = message.toLowerCase();
  
  // Ищем бренд в сообщении
  let foundBrand: string | null = null;
  for (const brand of KNOWN_BRANDS) {
    if (lowerMessage.includes(brand)) {
      foundBrand = brand;
      break;
    }
  }
  
  // Чистим от общих фраз СНАЧАЛА
  let product = message;
  const cleaners = [
    /^(привет|здравствуйте|добрый день|доброе утро|добрый вечер)[,!.]?\s*/i,
    /^(мне нужен|мне нужна|мне нужно|хочу купить|ищу|подскажите|порекомендуйте|посоветуйте|нужен|нужна|нужно|есть ли у вас)\s*/i,
    /^(покажи|найди|поищи|подбери|выбери)\s*/i,
    /\s*(пожалуйста|спасибо)\.?$/i,
    /^(какие есть|что есть|есть|какой)\s*/i,
  ];
  
  for (const regex of cleaners) {
    product = product.replace(regex, '');
  }
  
  // Убираем бренд из запроса, оставляя только продукт
  if (foundBrand) {
    product = product.replace(new RegExp(foundBrand, 'gi'), '').trim();
  }
  
  return {
    product: product.trim() || message,
    brand: foundBrand,
  };
}

// Поиск товаров в каталоге 220volt.kz с опциональным фильтром по бренду
async function searchProducts(query: string, brand: string | null, limit: number = 5): Promise<Product[]> {
  const apiToken = Deno.env.get('VOLT220_API_TOKEN');
  
  if (!apiToken) {
    console.error('VOLT220_API_TOKEN is not configured');
    return [];
  }

  async function doSearch(searchQuery: string, brandFilter: string | null): Promise<Product[]> {
    try {
      const params = new URLSearchParams();
      
      // Добавляем поисковый запрос если есть
      if (searchQuery) {
        params.append('query', searchQuery);
      }
      params.append('per_page', limit.toString());
      
      // Добавляем фильтр по бренду если указан
      if (brandFilter) {
        const brandCapitalized = brandFilter.charAt(0).toUpperCase() + brandFilter.slice(1);
        params.append('options[brend__brend][]', brandCapitalized);
      }

      console.log(`Searching products: query="${searchQuery}", brand="${brandFilter}"`);
      console.log(`API params: ${params.toString()}`);

      const response = await fetch(`${VOLT220_API_URL}?${params}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        console.error(`220volt API error: ${response.status}`);
        return [];
      }

      const rawData = await response.json();
      const data = rawData.data || rawData;
      
      console.log(`Found ${data.results?.length || 0} products`);
      
      return data.results || [];
    } catch (error) {
      console.error('Error searching products:', error);
      return [];
    }
  }

  // Первая попытка - поиск с брендом
  let products = await doSearch(query, brand);
  
  // Если ничего не найдено с брендом, пробуем без бренда
  if (products.length === 0 && brand) {
    console.log(`No products found with brand "${brand}", trying without brand filter`);
    products = await doSearch(query, null);
  }
  
  // Если запрос пустой или ничего не найдено, попробуем без запроса
  if (products.length === 0 && !query) {
    console.log('No products found, trying generic search');
    products = await doSearch('', null);
  }
  
  return products;
}

// Форматирование товаров для AI
function formatProductsForAI(products: Product[]): string {
  if (products.length === 0) {
    return 'Товары не найдены в каталоге.';
  }

  return products.map((p, i) => {
    // Извлекаем бренд из options если vendor пустой
    let brand = p.vendor;
    if (!brand && p.options) {
      const brandOption = p.options.find(o => o.key === 'brend__brend');
      if (brandOption) {
        brand = brandOption.value.split('//')[0]; // Берем только русскую версию
      }
    }
    
    const parts = [
      `${i + 1}. **${p.pagetitle}**`,
      `   - Цена: ${p.price.toLocaleString('ru-KZ')} ₸${p.old_price && p.old_price > 0 ? ` (было ${p.old_price.toLocaleString('ru-KZ')} ₸)` : ''}`,
      brand ? `   - Бренд: ${brand}` : '',
      p.article ? `   - Артикул: ${p.article}` : '',
      `   - В наличии: ${p.amount > 0 ? `Да (${p.amount} шт.)` : 'Под заказ'}`,
      p.category ? `   - Категория: ${p.category.pagetitle}` : '',
      `   - Ссылка: ${p.url}`, // Используем готовый URL из API
    ].filter(Boolean);
    
    return parts.join('\n');
  }).join('\n\n');
}

// Определение намерения пользователя
function detectIntent(message: string): 'catalog' | 'info' | 'general' {
  const catalogKeywords = [
    'товар', 'цена', 'купить', 'заказать', 'найти', 'поиск', 'подобрать',
    'рекомендовать', 'посоветовать', 'нужен', 'хочу', 'ищу', 'дрель', 'перфоратор',
    'болгарка', 'шуруповерт', 'пила', 'генератор', 'насос', 'компрессор', 'кабель',
    'сварка', 'инструмент', 'оборудование', 'техника', 'электро', 'бензо', 'провод',
    ...KNOWN_BRANDS, 'для дома', 'для дачи', 'для стройки', 'для ремонта', 'покажи'
  ];
  
  const infoKeywords = [
    'доставка', 'оплата', 'гарантия', 'возврат', 'адрес', 'телефон',
    'контакт', 'работаете', 'график', 'время', 'магазин', 'самовывоз',
    'кредит', 'рассрочка'
  ];
  
  const lowerMessage = message.toLowerCase();
  
  if (catalogKeywords.some(k => lowerMessage.includes(k))) {
    return 'catalog';
  }
  
  if (infoKeywords.some(k => lowerMessage.includes(k))) {
    return 'info';
  }
  
  return 'general';
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { messages, conversationId } = await req.json();
    
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      throw new Error('LOVABLE_API_KEY is not configured');
    }

    const lastMessage = messages[messages.length - 1];
    const userMessage = lastMessage?.content || '';
    
    console.log(`Processing message: ${userMessage}`);
    console.log(`Conversation ID: ${conversationId}`);

    // Определяем намерение
    const intent = detectIntent(userMessage);
    console.log(`Detected intent: ${intent}`);

    let productContext = '';
    let foundProducts: Product[] = [];

    // Если пользователь ищет товары - делаем поиск
    if (intent === 'catalog') {
      const { product, brand } = parseQuery(userMessage);
      console.log(`Parsed query: product="${product}", brand="${brand}"`);
      
      foundProducts = await searchProducts(product, brand, 5);
      
      if (foundProducts.length > 0) {
        const queryDesc = brand ? `${product} ${brand}` : product;
        productContext = `\n\n**Найденные товары по запросу "${queryDesc}":**\n\n${formatProductsForAI(foundProducts)}`;
      }
    }

    // Системный промпт для AI
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

${productContext ? `НАЙДЕННЫЕ ТОВАРЫ (используй ТОЛЬКО эти данные):${productContext}` : 'ТОВАРЫ НЕ НАЙДЕНЫ. Предложи клиенту уточнить запрос или посмотреть каталог на сайте https://220volt.kz'}`;

    // Отправляем запрос к AI
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
      console.error('AI Gateway error:', response.status, errorText);
      return new Response(
        JSON.stringify({ error: 'Ошибка AI сервиса' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Возвращаем стриминг ответ
    return new Response(response.body, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
      },
    });

  } catch (error) {
    console.error('Chat consultant error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Неизвестная ошибка' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
