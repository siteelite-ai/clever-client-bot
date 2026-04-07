

# План: Расширить dialogSlots для product_search (кэш + follow-up фильтрация)

## Проблема

DialogSlots работают только для `price_extreme`. Когда category-first находит >7 товаров и бот задаёт уточняющий вопрос ("электрическая, компьютерная или телефонная?"), при ответе пользователя pipeline стартует заново, теряя контекст и результаты.

## Решение

Использовать уже существующую инфраструктуру dialogSlots для `product_search` интента:

### 1. Создание слота при уточняющем вопросе

Когда category-first находит >7 товаров, перед отправкой уточняющего вопроса — создать слот:

```
{
  intent: 'product_search',
  base_category: 'розетка',
  refinement: null,
  status: 'pending',
  cached_products: [...найденные товары (до 20)...]
}
```

### 2. Расширить resolveSlotRefinement

Сейчас функция обрабатывает только `price_extreme`. Добавить обработку `product_search`:
- Найти pending слот с `intent === 'product_search'`
- Извлечь уточнение пользователя ("электрическая")
- Отфильтровать cached_products по уточнению (по названию, характеристикам)
- Вернуть отфильтрованный список без нового API-запроса

### 3. Фильтрация кэшированных товаров

Простая функция: проверяет ответ пользователя по `pagetitle` и `options` каждого товара. Без LLM — строковое вхождение.

```text
cached: 20 розеток Гармония (электрические + компьютерные + телефонные)
ответ: "электрическая"
→ filter: p.pagetitle или p.options содержит "электрич"
→ результат: 10 электрических розеток Гармония
```

### 4. Ограничение размера

dialogSlots передаются через SSE и sessionStorage. Кэшировать только ключевые поля каждого товара (id, pagetitle, price, url, image, amount) — без полного options. Максимум 20 товаров.

## Файлы

**supabase/functions/chat-consultant/index.ts**:
- Интерфейс DialogSlot: добавить `cached_products?: string` (JSON-строка)
- `resolveSlotRefinement`: добавить ветку для `product_search`
- Category-first блок: создавать слот при >7 результатах
- Новая функция `filterCachedProducts(products, userAnswer)`

## Что НЕ трогаем
- Виджет (ChatWidget.tsx, embed.js) — dialogSlots уже синхронизируются
- Price_extreme логику — без изменений
- Pipeline classify/filter — без изменений

## Объём
~40-50 строк изменений в одном файле.

