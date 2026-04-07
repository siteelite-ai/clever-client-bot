

# План: Резолвить уточнения через фильтры, а не через query

## Проблема

При уточняющем ответе пользователя ("электрическая", "накладная", "с заземлением") система просто дописывает слово в текстовый `query`. Но это слово — характеристика товара, которую API может фильтровать через `options[key][]=value`. Текстовый `query` ищет по совпадению слов в названии/описании, а характеристики хранятся в отдельных полях — поэтому `query="электрическая"` может ничего не найти, хотя фильтр `options[tip][]=электрическая` найдёт.

## Решение

При резолве product_search слота — не просто дописывать текст, а:
1. Загрузить товары категории (schema products)
2. Прогнать новый модификатор через `resolveFiltersWithLLM`
3. Объединить новые фильтры с существующими из слота
4. Отправить API-запрос только с `options`, без query (или с минимальным query для нерезолвленных)

## Конкретные изменения

**Файл:** `supabase/functions/chat-consultant/index.ts`

### 1. Главный pipeline (строки 3189-3219): после получения searchParams — резолвить модификатор

Сейчас:
```typescript
if (slotResolution && 'searchParams' in slotResolution) {
  const sp = slotResolution.searchParams;
  foundProducts = await searchProductsByCandidate(
    { query: sp.query || null, ... }, // ← "черная электрическая" как текст
    ...sp.resolvedFilters...
  );
}
```

Станет:
```typescript
if (slotResolution && 'searchParams' in slotResolution) {
  const sp = slotResolution.searchParams;
  
  // Step 1: Fetch schema products for the category
  const schemaProducts = await searchProductsByCandidate(
    { query: null, brand: null, category: sp.category, min_price: null, max_price: null },
    appSettings.volt220_api_token!, 50
  );
  
  // Step 2: Resolve the NEW modifier (user's answer) against schema
  const newModifier = sp.refinementText; // "электрическая"
  const { resolved: newFilters, unresolved: stillUnresolved } = 
    await resolveFiltersWithLLM(schemaProducts, [newModifier], appSettings);
  
  // Step 3: Merge with existing filters from slot
  const mergedFilters = { ...sp.resolvedFilters, ...newFilters };
  // Update unresolved query: keep old unresolved + new unresolved (if any)
  const mergedQuery = [sp.existingUnresolved, ...stillUnresolved]
    .filter(Boolean).join(' ').trim() || null;
  
  // Step 4: API call with structured filters
  foundProducts = await searchProductsByCandidate(
    { query: mergedQuery, brand: null, category: sp.category, min_price: null, max_price: null },
    appSettings.volt220_api_token!, 50,
    Object.keys(mergedFilters).length > 0 ? mergedFilters : undefined
  );
  
  // If still >7, save MERGED filters (not query) in new slot
  if (foundProducts.length > 7) {
    dialogSlots[newSlotKey] = {
      resolved_filters: JSON.stringify(mergedFilters),
      unresolved_query: mergedQuery || '',
      ...
    };
  }
}
```

### 2. resolveSlotRefinement (строки 1120-1137): передавать refinementText отдельно

Сейчас: склеивает `unresolved_query + userMessage` в одну строку query.

Станет: возвращает `refinementText` (ответ пользователя) отдельно от `existingUnresolved` (старый нерезолвленный текст), чтобы pipeline мог резолвить новый модификатор отдельно.

```typescript
return { 
  slotKey: key, 
  searchParams: {
    category: slot.plural_category,
    resolvedFilters: existingFilters,
    refinementText: userMessage.trim(),      // NEW: отдельно
    existingUnresolved: slot.unresolved_query || '', // NEW: старый query
    baseCategory: slot.base_category,
  },
  updatedSlots,
};
```

## Ожидаемый результат

```
Шаг 1: "розетки Гармония"
  → category=розетки, modifiers=[Гармония]
  → resolveFiltersWithLLM: kollektsiya="Гармония" ✓
  → API: options[kollektsiya][]=Гармония → 20 розеток
  → >7 → slot: {filters: {kollektsiya:"Гармония"}, unresolved:""}

Шаг 2: "электрическая"
  → slot found → refinementText="электрическая"
  → fetch 50 розеток для схемы
  → resolveFiltersWithLLM(["электрическая"]): tip="электрическая" ✓
  → mergedFilters: {kollektsiya:"Гармония", tip:"электрическая"}
  → API: options[kollektsiya][]=Гармония + options[tip][]=электрическая → 8
  → >7 → slot: {filters: {kollektsiya:"Гармония", tip:"электрическая"}}

Шаг 3: "накладные"
  → resolveFiltersWithLLM(["накладные"]): montazh="накладной" ✓
  → mergedFilters: {kollektsiya, tip, montazh}
  → API: 3 фильтра → 3 розетки → выводим
```

## Объём
~25 строк изменений в 2 местах одного файла.

## Что НЕ трогаем
- `resolveFiltersWithLLM` — без изменений, уже работает
- Category-first первый проход — без изменений
- Price slots — без изменений

