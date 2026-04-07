

# План: Хранить настройки фильтра вместо кэша товаров

## Проблема

Сейчас слот `product_search` хранит **20 товаров** в `cached_products`. Это неправильно:
- В категории может быть 100+ товаров, а мы кэшируем только 20
- Электрических розеток может не оказаться в этих 20, хотя они есть в каталоге
- JSON с options раздувается до >15KB и обрезается → парсинг падает

## Правильный подход

Слот хранит **накопленные настройки фильтра**, а не товары. При каждом уточнении — новый запрос к API с полным набором фильтров.

```text
Шаг 1: "черная двухместная розетка"
  → category="розетки", resolved={razem:"2"}, query="черная"
  → API: category=розетки + options[razem]=2 + query=черная → 15 товаров
  → >7 → слот: {category:"розетки", filters:{razem:"2"}, query:"черная"}
  → бот: "Какой тип? Электрическая, компьютерная?"

Шаг 2: "электрическая"
  → слот найден → добавляем query: "черная электрическая"
  → API: category=розетки + options[razem]=2 + query="черная электрическая"
  → 5 товаров → выводим

Шаг 3 (если бы >7): "накладные"
  → query: "черная электрическая накладные"
  → API с теми же фильтрами + расширенным query
```

## Изменения

**Файл:** `supabase/functions/chat-consultant/index.ts`

### 1. Интерфейс DialogSlot — заменить cached_products на фильтры

```typescript
interface DialogSlot {
  intent: 'price_extreme' | 'product_search';
  // ... existing price fields ...
  base_category: string;
  // NEW: accumulated filter state
  resolved_filters?: string;   // JSON: {"razem":"2"}
  unresolved_query?: string;   // "черная"
  plural_category?: string;    // "розетки" (for API param)
  // REMOVE: cached_products
}
```

### 2. Создание слота (category-first, ~строка 3454)

Вместо кэширования товаров — сохраняем фильтры:

```typescript
if (foundProducts.length > 7) {
  dialogSlots[`ps_${Date.now()}`] = {
    intent: 'product_search',
    base_category: effectiveCategory,
    plural_category: pluralCategory,
    resolved_filters: JSON.stringify(resolvedFilters),
    unresolved_query: queryText || '',
    status: 'pending',
    created_turn: messages.length,
    turns_since_touched: 0,
  };
}
```

### 3. resolveSlotRefinement — перезапрос API вместо локальной фильтрации

Вместо `filterCachedProducts`:
- Берём существующие фильтры из слота
- Добавляем уточнение пользователя к `unresolved_query`
- Возвращаем **параметры для нового API-запроса**, а не готовые товары

```typescript
// product_search: return search params, not cached products
return {
  slotKey: key,
  searchParams: {
    category: slot.plural_category,
    resolvedFilters: JSON.parse(slot.resolved_filters || '{}'),
    query: `${slot.unresolved_query} ${userMessage}`.trim(),
  },
  updatedSlots,
};
```

### 4. Обработка в основном pipeline (~строка 3206)

Вместо `cachedProducts` — выполняем API-запрос с накопленными фильтрами:

```typescript
if (slotResolution && 'searchParams' in slotResolution) {
  const sp = slotResolution.searchParams;
  foundProducts = await searchProductsByCandidate(
    { query: sp.query, brand: null, category: sp.category, min_price: null, max_price: null },
    appSettings.volt220_api_token, 50,
    Object.keys(sp.resolvedFilters).length > 0 ? sp.resolvedFilters : undefined
  );
  foundProducts = foundProducts.slice(0, 15);
  articleShortCircuit = true;
  // If still >7, update slot with new query for next round
  if (foundProducts.length > 7) {
    const newSlotKey = `ps_${Date.now()}`;
    dialogSlots[newSlotKey] = {
      intent: 'product_search',
      base_category: slotResolution.updatedSlots[slotResolution.slotKey].base_category,
      plural_category: sp.category,
      resolved_filters: JSON.stringify(sp.resolvedFilters),
      unresolved_query: sp.query,
      status: 'pending',
      ...
    };
  }
}
```

### 5. Удалить ненужный код

- Удалить `filterCachedProducts` (больше не нужна)
- Удалить `cached_products` из `validateAndSanitizeSlots`
- Удалить обрезку `substring(0, 15000)` — фильтры занимают <200 байт

## Преимущества

- Фильтры занимают ~100 байт вместо 15-20KB — нет проблем с обрезкой
- Поиск идёт по **всему каталогу** (2000+ товаров), а не по 20 закэшированным
- Каждое уточнение добавляет фильтр — контекст накапливается
- Используется уже работающая инфраструктура API-фильтрации

## Объём
~50 строк изменений в одном файле. Замена логики, не добавление.

## Что НЕ трогаем
- `resolveFiltersWithLLM` — без изменений
- `searchProductsByCandidate` — уже принимает `resolvedFilters`
- Price_extreme слоты — без изменений
- Виджет — без изменений (слоты стали легче)

