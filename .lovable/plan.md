

# План: Локальная фильтрация по характеристикам как ОСНОВНОЙ механизм

## Суть проблемы

Сейчас система полагается на Pass 2 API (повторный запрос с `options[key][]=value`). Но API часто не принимает фильтры или LLM выбирает не тот ключ — и результат 0. Тогда возвращается нефильтрованный Pass 1.

Пользователь говорит: **фильтрация по характеристикам должна быть основной**, а не резервной. У нас уже есть товары из Pass 1 с полными `product.options` — нужно просто сравнить resolved фильтры с реальными характеристиками каждого товара локально.

## Новый поток (category-first)

```text
classify → category="розетка", modifiers=["черная","двухместная"]
  → Pass 1: запрос "розетка" в API → 30 товаров с полными options
  → resolveFiltersWithLLM: собирает схему из options, LLM маппит модификаторы
  → ОСНОВНОЙ ОТБОР: сравнить resolved filters с product.options каждого товара
  → Отдать только товары, где ВСЕ фильтры совпали
  → Pass 2 API — УБИРАЕМ полностью для category-first
```

## Конкретные изменения

**Файл**: `supabase/functions/chat-consultant/index.ts`

### 1. Заменить Pass 2 API на локальную фильтрацию (строки 2403-2449)

Вместо повторного запроса в API с `option_filters` — фильтруем Pass 1 результаты локально:

```
if (modifiers && modifiers.length > 0 && productMap.size > 0 && settings) {
  const resolvedFilters = await resolveFiltersWithLLM(products, modifiers, settings);
  
  if (Object.keys(resolvedFilters).length > 0) {
    // ОСНОВНОЙ ОТБОР: сравниваем resolved filters с product.options
    const matched = products.filter(product => {
      if (!product.options) return false;
      return Object.entries(resolvedFilters).every(([key, value]) => {
        const productValue = product.options[key];
        if (!productValue) return false;
        // Сравнение без учёта регистра и пробелов
        return productValue.toString().toLowerCase().trim() 
            === value.toString().toLowerCase().trim();
      });
    });
    
    if (matched.length > 0) {
      productMap.clear();
      matched.forEach(p => productMap.set(p.id, p));
      console.log(`[Search] Characteristic filter: ${matched.length} products match`);
    } else {
      console.log(`[Search] Characteristic filter: 0 exact matches, keeping Pass 1`);
    }
  }
}
```

### 2. Проверить, что product.options приходит из API

Нужно убедиться, что API возвращает `options` в ответе и мы их сохраняем в объекте Product. Если `options` — это то же поле, из которого `resolveFiltersWithLLM` строит схему, то данные уже есть.

### 3. Сортировка по количеству совпадений

Если не все фильтры совпали у всех товаров, сортировать по числу подтверждённых совпадений (больше совпадений = выше в списке).

## Что НЕ трогаем

- `resolveFiltersWithLLM` — промпт только что обновлён, работает
- Title-first, article-first, price-intent, replacement — все ветки остаются
- Pass 1 single query — работает
- Классификатор — работает (отдельно исправим контекст диалога)

## Ожидаемый результат

- «черная двухместная розетка»: Pass 1 → 30 розеток → LLM резолвит `цвет=черный` + `кол-во_разъемов=2` → локально фильтруем product.options → только черные двухместные
- Не зависим от того, примет ли API конкретный ключ фильтра — фильтруем сами
- Все остальные ветки поиска продолжают работать без изменений

## Объём: ~30 строк замены в `searchProductsMulti`

