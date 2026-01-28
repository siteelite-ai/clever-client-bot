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

interface ProductsResponse {
  results: Product[];
  pagination: {
    page: number;
    per_page: number;
    pages: number;
    total: number;
  };
}

// Поиск товаров в каталоге 220volt.kz
async function searchProducts(query: string, limit: number = 5): Promise<Product[]> {
  const apiToken = Deno.env.get('VOLT220_API_TOKEN');
  
  if (!apiToken) {
    console.error('VOLT220_API_TOKEN is not configured');
    return [];
  }

  try {
    const params = new URLSearchParams({
      query: query,
      per_page: limit.toString(),
    });

    console.log(`Searching products with query: ${query}`);

    const response = await fetch(`${VOLT220_API_URL}?${params}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.error(`220volt API error: ${response.status}`);
      const errorText = await response.text();
      console.error('Response:', errorText);
      return [];
    }

    const data: ProductsResponse = await response.json();
    console.log(`Found ${data.results?.length || 0} products`);
    
    return data.results || [];
  } catch (error) {
    console.error('Error searching products:', error);
    return [];
  }
}

// Форматирование товаров для AI
function formatProductsForAI(products: Product[]): string {
  if (products.length === 0) {
    return 'Товары не найдены.';
  }

  return products.map((p, i) => {
    const parts = [
      `${i + 1}. **${p.pagetitle}**`,
      `   - Цена: ${p.price.toLocaleString('ru-KZ')} ₸${p.old_price ? ` (было ${p.old_price.toLocaleString('ru-KZ')} ₸)` : ''}`,
      `   - Бренд: ${p.vendor}`,
      p.article ? `   - Артикул: ${p.article}` : '',
      `   - В наличии: ${p.amount > 0 ? 'Да' : 'Нет'}`,
      `   - Ссылка: https://220volt.kz${p.url}`,
    ].filter(Boolean);
    
    return parts.join('\n');
  }).join('\n\n');
}

// Определение намерения пользователя
function detectIntent(message: string): 'catalog' | 'info' | 'general' {
  const catalogKeywords = [
    'товар', 'цена', 'купить', 'заказать', 'найти', 'поиск', 'подобрать',
    'рекомендовать', 'посоветовать', 'нужен', 'хочу', 'ищу', 'дрель', 'перфоратор',
    'болгарка', 'шуруповерт', 'пила', 'генератор', 'насос', 'компрессор',
    'сварка', 'инструмент', 'оборудование', 'техника', 'электро', 'бензо',
    'makita', 'bosch', 'dewalt', 'metabo', 'hitachi', 'milwaukee', 'stihl',
    'husqvarna', 'karcher', 'для дома', 'для дачи', 'для стройки', 'для ремонта'
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

// Извлечение поискового запроса из сообщения
function extractSearchQuery(message: string): string {
  // Убираем общие фразы и оставляем суть запроса
  const cleaners = [
    /^(привет|здравствуйте|добрый день|доброе утро|добрый вечер)[,!.]?\s*/i,
    /^(мне нужен|хочу купить|ищу|подскажите|порекомендуйте|посоветуйте|нужна?|есть ли у вас)\s*/i,
    /^(покажи|найди|поищи)\s*/i,
    /\s*(пожалуйста|спасибо)\.?$/i,
  ];
  
  let query = message;
  for (const regex of cleaners) {
    query = query.replace(regex, '');
  }
  
  return query.trim() || message;
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
      const searchQuery = extractSearchQuery(userMessage);
      console.log(`Searching for: ${searchQuery}`);
      
      foundProducts = await searchProducts(searchQuery, 5);
      
      if (foundProducts.length > 0) {
        productContext = `\n\n**Найденные товары по запросу "${searchQuery}":**\n\n${formatProductsForAI(foundProducts)}`;
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

ПРАВИЛА ОТВЕТОВ:
1. Отвечай дружелюбно и профессионально
2. Если найдены товары - представь их клиенту с описанием и ценами
3. Если товар не найден - предложи уточнить запрос или посмотреть каталог
4. Для сложных технических вопросов - рекомендуй связаться с менеджером
5. Всегда указывай ссылки на товары
6. Отвечай на русском языке

${productContext ? `НАЙДЕННЫЕ ТОВАРЫ:\n${productContext}` : ''}`;

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
