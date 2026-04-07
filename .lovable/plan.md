

# План: Валидация значений + гибридный query/options

## Суть проблемы

Текущий pipeline делает правильные шаги, но ломается на одном месте: LLM резолвит значение (например `cvet = "черный"`), которого **нет в первых 50 товарах** (там только белый, кремовый). API требует **точное** совпадение значения в `options[cvet][]=...`. Значение не совпадает → 0 результатов.

Твоя логика абсолютно верная:
1. Нашли розетки ✓
2. Смотрим какие цвета есть → если "черный" есть в списке значений → используем как точный фильтр. Если нет → отправляем "черная" как текстовый поиск (query), API сам найдет
3. Смотрим разъемы → "2" есть в списке → точный фильтр
4. Если результатов >7 → уточняем

## Что конкретно менять

**Файл:** `supabase/functions/chat-consultant/index.ts`

### Изменение 1: resolveFiltersWithLLM возвращает два набора (строки 2232-2252)

Сейчас функция возвращает `Record<string, string>` — все фильтры в одну кучу. Нужно разделить:

- **validated** (значение ЕСТЬ в schema) → пойдут в `options[key][]=value`
- **unresolved** (ключ найден, но значения нет в выборке) → пойдут в текстовый `query`

```typescript
// После проверки ключа — проверить значение
if (optionIndex.has(resolvedKey)) {
  const knownValues = optionIndex.get(resolvedKey)!.values;
  const norm = (s: string) => s.replace(/ё/g, 'е').toLowerCase().trim();
  const match = [...knownValues].find(v => norm(v) === norm(value));
  
  if (match) {
    validated[resolvedKey] = match; // точное значение из schema
  } else {
    unresolved.push(originalModifier); // вернём модификатор для query
  }
}
```

Возврат: `{ resolved: Record<string,string>, unresolved: string[] }`

### Изменение 2: Гибридный API-запрос в category-first (строки 3268-3275)

```typescript
const { resolved, unresolved } = await resolveFiltersWithLLM(...);

// resolved → серверные options (точные)
// unresolved → текстовый query (API сам найдёт)
const queryText = unresolved.length > 0 ? unresolved.join(' ') : null;

const serverFiltered = await searchProductsByCandidate(
  { query: queryText, category: pluralCategory, ... },
  token, 50,
  resolved
);
```

### Изменение 3: Обновить все вызовы resolveFiltersWithLLM

Функция вызывается в нескольких местах — везде обновить деструктуризацию.

## Ожидаемый результат

Запрос "черная двухместная розетка":

```text
1. category="розетки" → 50 товаров для схемы
2. FilterLLM:
   - cvet = "черный" → в schema есть только "белый", "кремовый" → UNRESOLVED → query
   - kolichestvo_razyemov = "2" → "2" ЕСТЬ в schema → RESOLVED → options
3. API: query="черная" + category="розетки" + options[kolichestvo_razyemov][]=2
   → сервер ищет по ВСЕМ 2336: текст "черная" + разъемов=2
4. Результат: чёрные двухместные розетки
5. Если >7 → бот уточняет
```

## Объём
~20 строк изменений в `resolveFiltersWithLLM` + ~5 строк в category-first блоке.

## Что НЕ трогаем
- Промпт FilterLLM — работает правильно
- Classify — работает
- Другие ветки — без изменений
- Каскадный fallback — сохраняется

