

# План: Пересоздание слота после follow-up фильтрации

## Проблема

Слот `product_search` правильно создается при первом поиске (>7 товаров) и правильно фильтруется при первом уточнении ("электрическая"). Но после фильтрации слот помечается как `done` и удаляется. Новый слот **не создается**, потому что код создания слотов находится только внутри ветки category-first (строка 3434), а при slot-resolution эта ветка пропускается (`articleShortCircuit = true`).

```text
Шаг 1: "розетки Гармония" → 20 товаров → slot created (pending)
Шаг 2: "электрическая" → slot resolved → 10 товаров → slot = done → УДАЛЁН
        ↑ Новый слот НЕ создан, потому что category-first не выполнялся
Шаг 3: "накладные" → нет pending слота → pipeline с нуля → контекст потерян
```

## Решение

После slot-resolution, если отфильтрованных товаров снова >7, создать **новый** pending слот с отфильтрованными товарами. Это одно добавление ~10 строк.

## Конкретное изменение

**Файл:** `supabase/functions/chat-consultant/index.ts`, строки 3206-3212

После строки 3212 (`console.log(...product_search slot resolved...)`), добавить:

```typescript
// If still >7, create a new slot for the next refinement round
if (foundProducts.length > 7) {
  const compactProducts = foundProducts.slice(0, 20).map(p => ({
    id: p.id, pagetitle: p.pagetitle, price: p.price,
    url: p.url, image: p.image, amount: (p as any).amount,
    parent_name: p.parent_name, options: (p as any).options,
  }));
  const newSlotKey = `ps_${Date.now()}`;
  dialogSlots[newSlotKey] = {
    intent: 'product_search',
    base_category: slotResolution.updatedSlots[slotResolution.slotKey]?.base_category 
      || effectiveCategory,
    status: 'pending',
    created_turn: messages.length,
    turns_since_touched: 0,
    cached_products: JSON.stringify(compactProducts),
  };
  console.log(`[Chat] Re-created product_search slot "${newSlotKey}": ${compactProducts.length} products for next refinement`);
}
```

## Ожидаемый результат

```text
Шаг 1: "розетки Гармония" → 20 → slot_1 (pending, 20 cached)
Шаг 2: "электрическая" → slot_1 resolved → 10 → slot_1 = done → slot_2 (pending, 10 cached)
Шаг 3: "накладные" → slot_2 resolved → фильтр по "накладн" → 3 накладных электрических розетки Гармония
```

## Объём
~12 строк в одном месте одного файла.

## Что НЕ трогаем
- resolveSlotRefinement — работает правильно
- filterCachedProducts — работает правильно
- Category-first ветка — без изменений
- Виджет — без изменений

