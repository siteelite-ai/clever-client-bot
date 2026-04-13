

# План: Микро-LLM как единый интент-классификатор

## Суть идеи

Сейчас архитектура такая:
```text
Сообщение пользователя
  ↓
  classifyProductName (микро-LLM, Flash Lite, ~0.3-0.5 сек)
  → product_category, has_product_name, modifiers
  ↓
  generateSearchCandidates (Gemini Pro, ~2-4 сек)
  → intent (catalog/brands/info/general) + candidates[]
  ↓
  Финальный ответ (Gemini Pro, ~3-5 сек)
```

Проблема: `generateSearchCandidates` вызывается **всегда** (кроме article short-circuit), даже для вопросов типа "есть общий прайс?", "как оплатить?", "привет". Это 2-4 секунды впустую на Gemini Pro.

Предлагаемая архитектура:
```text
Сообщение пользователя
  ↓
  classifyProductName (микро-LLM, Flash Lite, ~0.3-0.5 сек)
  → intent + product_category + has_product_name + modifiers
  ↓
  intent = "info" или "general"?
    → ПРОПУСКАЕМ generateSearchCandidates (экономия 2-4 сек)
    → Сразу к финальному ответу
  intent = "catalog" или "brands"?
    → generateSearchCandidates (Gemini Pro)
    → Поиск товаров → Финальный ответ
```

## Что конкретно меняем

### 1. Расширяем промпт классификатора (строка 580-600)

Добавляем поле `intent` в JSON-ответ микро-LLM:
```json
{
  "intent": "catalog|brands|info|general",
  "has_product_name": true,
  "product_name": "...",
  "product_category": "розетка",
  "search_modifiers": ["черная", "двухместная"],
  "price_intent": null,
  "is_replacement": false
}
```

Правила для `intent` берём из уже существующего промпта `generateSearchCandidates` (строки 1778-1791), но в упрощённом виде:
- `catalog` — ищет товары/оборудование
- `brands` — спрашивает какие бренды представлены
- `info` — вопросы о компании, доставке, оплате, оферте, контактах, прайсе
- `general` — приветствия, шутки, нерелевантное

### 2. Условный вызов generateSearchCandidates (строка 3629-3631)

Сейчас:
```typescript
extractedIntent = await generateSearchCandidates(
  userMessage, aiConfig.apiKeys, historyForContext, 
  aiConfig.url, aiConfig.model, classification?.product_category
);
```

Станет:
```typescript
if (classification?.intent === 'info' || classification?.intent === 'general') {
  // Микро-LLM уже определил intent — Pro не нужна
  extractedIntent = {
    intent: classification.intent,
    candidates: [],
    originalQuery: userMessage,
  };
} else {
  // catalog/brands — нужен Gemini Pro для генерации candidates
  extractedIntent = await generateSearchCandidates(...);
}
```

### 3. Fallback-защита

Если микро-LLM не вернула `intent` (таймаут, ошибка парсинга) — вызываем `generateSearchCandidates` как раньше. Текущий fallback (`fallbackParseQuery`) тоже умеет определять intent по regex.

## Что это даёт

- **Для info/general запросов**: экономия 2-4 сек (пропуск Gemini Pro вызова)
- **Для товарных запросов**: без изменений, Gemini Pro по-прежнему генерирует candidates
- **Стоимость**: микро-LLM и так вызывается, добавляется только 1 поле в JSON (~10 токенов)
- **Риск**: минимальный — если микро-LLM ошибётся с intent, fallback на полный пайплайн

## Риски и митигация

| Риск | Вероятность | Митигация |
|------|-------------|-----------|
| Микро-LLM ошибочно классифицирует товарный запрос как `info` | Низкая | Fallback: если `intent=info` но `product_category` заполнена — переопределить на `catalog` |
| Микро-LLM ошибочно классифицирует `info` как `catalog` | Низкая | Не критично: Pro просто не найдёт товары, KB-контекст всё равно подключится |
| Уточняющие ответы ("черную", "IP44") без intent | Средняя | Если intent отсутствует и message < 4 слов — fallback на полный пайплайн |

## Объём изменений

- 1 файл: `supabase/functions/chat-consultant/index.ts`
- ~15 строк в промпте классификатора (добавить intent)
- ~15 строк в основном flow (условный вызов)
- ~5 строк fallback-логика
- 1 деплой edge function

