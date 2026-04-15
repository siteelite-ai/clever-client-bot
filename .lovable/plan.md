

# План: Fallback без category при 0 resolved filters

## Проблема
Когда `resolveFiltersWithLLM` возвращает **0 resolved** и **все модификаторы unresolved** — это означает, что API нашёл товары из неправильной категории. Но все fallback-и (строки 3340, 3382) продолжают передавать `category="Автоматы"`, поэтому правильные товары из "Автоматические выключатели" никогда не находятся.

## Решение
Добавить проверку: если `resolvedFilters` пуст и ВСЕ модификаторы остались unresolved — сбросить category и искать по query-тексту (категория + модификаторы).

## Изменения

### Файл: `supabase/functions/chat-consultant/index.ts`

**Строки ~3331-3345** — после `resolveFiltersWithLLM`, перед STAGE 2:

```typescript
// If ALL modifiers unresolved and 0 resolved → wrong category detected
if (Object.keys(resolvedFilters).length === 0 && 
    unresolvedMods.length === modifiers.length && modifiers.length > 0) {
  console.log(`[Chat] Category-first: 0 resolved → wrong category, retrying WITHOUT category`);
  
  // Search by full text: category word + modifiers
  const fallbackQuery = `${effectiveCategory} ${modifiers.join(' ')}`;
  const fallbackResults = await searchProductsByCandidate(
    { query: fallbackQuery, brand: null, category: null, min_price: null, max_price: null },
    appSettings.volt220_api_token, 50
  );
  console.log(`[Chat] Category-first fallback (no category): query="${fallbackQuery}" → ${fallbackResults.length} products`);
  
  if (fallbackResults.length > 0) {
    // Re-extract dominant category from new results
    const fbBuckets: Record<string, number> = {};
    for (const p of fallbackResults) {
      const ct = (p as any).category?.pagetitle || p.parent_name || 'unknown';
      fbBuckets[ct] = (fbBuckets[ct] || 0) + 1;
    }
    console.log(`[Chat] Fallback buckets: ${JSON.stringify(fbBuckets)}`);
    
    // Use the dominant category's products for schema
    const dominantCat = Object.entries(fbBuckets).sort((a, b) => b[1] - a[1])[0]?.[0];
    const dominantProducts = dominantCat 
      ? fallbackResults.filter(p => ((p as any).category?.pagetitle || p.parent_name) === dominantCat)
      : fallbackResults;
    
    // Re-resolve filters against correct schema
    const { resolved: fbResolved, unresolved: fbUnresolved } = 
      await resolveFiltersWithLLM(dominantProducts, modifiers, appSettings);
    console.log(`[Chat] Fallback resolved: ${JSON.stringify(fbResolved)}, unresolved: [${fbUnresolved.join(', ')}]`);
    
    if (Object.keys(fbResolved).length > 0) {
      // STAGE 2 with correct category
      const fbQuery = fbUnresolved.length > 0 ? fbUnresolved.join(' ') : null;
      const fbFiltered = await searchProductsByCandidate(
        { query: fbQuery, brand: null, category: dominantCat, min_price: null, max_price: null },
        appSettings.volt220_api_token, 50, fbResolved
      );
      if (fbFiltered.length > 0) {
        foundProducts = fbFiltered.slice(0, 15);
        articleShortCircuit = true;
        resultMode = 'fallback_recategorized';
        // Update pluralCategory for slot
        pluralCategory = dominantCat || pluralCategory;
      }
    }
    
    // If still no results, use fallback products as-is
    if (foundProducts.length === 0) {
      foundProducts = fallbackResults.slice(0, 15);
      articleShortCircuit = true;
      resultMode = 'fallback_no_category';
    }
  }
}
```

Этот блок вставляется **перед** существующей логикой STAGE 2 (строка 3337). Если fallback сработал, дальнейший STAGE 2 пропускается (foundProducts уже заполнены).

**Тот же паттерн** применить в replacement-блоке (~строка 3504).

### Деплой
Edge function `chat-consultant`.

## Ожидаемый результат

Запрос "подбери автоматы 1 полюсные на 16 ампер":
1. `category="Автоматы"` → 50 товаров из "Автоматы защиты двигателя"
2. 0 resolved → **fallback без category**
3. `query="автомат 1 полюсные 16 ампер"` → товары из "Автоматические выключатели"
4. Схема правильная → `kolichestvo_polyusov=1`, `nominalynyy_tok=16` → resolved
5. STAGE 2 с `category="Автоматические выключатели"` + filters → точные результаты

## Объём
~40 строк в двух местах + деплой.

