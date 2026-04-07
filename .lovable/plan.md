

# План: Прямой фильтр по категории + поэтапная фильтрация характеристик

## Проблема

Разведка (recon) ненадежна — запрос `query="розетка" per_page=1` вернул товар из категории "Светильники" (видимо, в описании упоминается слово "розетка"). Дальше `category="Светильники"` → 0 результатов → полный провал ветки.

## Решение

Убрать recon. Вместо этого:

1. **Сразу генерировать множественное число** из `effectiveCategory` и отправлять как API-параметр `category`
2. **Известные фильтры (цвет) — сразу в API-запрос** через `options[]`
3. **Неизвестные модификаторы — резолвить через характеристики** полученных товаров

### Пайплайн

```text
"черная двухместная розетка"
  ↓
classify → category="розетка", modifiers=["черная","двухместная"]
  ↓
Шаг 1: Генерация множественного числа: "розетка" → "Розетки"
  (простая таблица окончаний: а→и, ь→и, к→ки, ор→оры, ль→ли, etc.)
  ↓
Шаг 2: API запрос category="Розетки", per_page=50
  → ТОЛЬКО розетки (30+ штук), без рамок и трубок
  ↓
Шаг 3: Быстрые фильтры — "черная" → ищем option с caption содержащим "цвет"
  → находим key="tsvet__tsvet", фильтруем локально: оставляем только чёрные
  ↓
Шаг 4: Оставшиеся модификаторы ("двухместная") → resolveFiltersWithLLM
  по схеме характеристик УЖЕ отфильтрованных товаров
  → key="kolichestvo_razemov", value="2"
  ↓
Шаг 5: Локальный AND-фильтр: цвет=чёрный И кол-во_разъемов=2
  → только чёрные двухместные розетки
```

## Изменения

**Файл**: `supabase/functions/chat-consultant/index.ts`

### 1. Функция `toPluralCategory(word)` (~15 строк)

Простое преобразование единственного числа во множественное с заглавной буквы:
- розетка → Розетки, рамка → Рамки, лампа → Лампы
- удлинитель → Удлинители, выключатель → Выключатели
- кабель → Кабели, провод → Провода
- Если слово уже во множественном (оканчивается на -ы, -и) — оставить как есть

### 2. Функция `extractQuickFilters(modifiers)` (~10 строк)

Разделяет модификаторы на "быстрые" (которые сразу понятны) и "остальные":
- Цветовые слова (черная, белая, красная, синяя, кремовая...) → `{key: "цвет", value: "чёрный"}`
- Остальные модификаторы → передаются в `resolveFiltersWithLLM`

### 3. Category-first ветка (строки 3114-3160): замена recon на прямой запрос

Убрать recon-шаг. Вместо этого:

```typescript
// Шаг 1: множественное число
const pluralCategory = toPluralCategory(effectiveCategory);

// Шаг 2: API запрос по категории
const categoryCandidate = { query: null, category: pluralCategory, ... };
const rawProducts = await searchProductsByCandidate(categoryCandidate, token, 50);

// Если 0 — попробовать с оригинальным словом как query (fallback)
if (rawProducts.length === 0) {
  rawProducts = await searchProductsByCandidate({ query: effectiveCategory, ... }, token, 50);
}

// Шаг 3: быстрые фильтры (цвет)
const { quickFilters, remainingModifiers } = extractQuickFilters(modifiers);
let filtered = rawProducts;
for (const qf of quickFilters) {
  filtered = filtered.filter(p => matchOption(p, qf));
}

// Шаг 4: оставшиеся модификаторы через resolveFiltersWithLLM
if (remainingModifiers.length > 0 && filtered.length > 0) {
  const resolved = await resolveFiltersWithLLM(filtered, remainingModifiers, settings);
  // Шаг 5: AND-фильтрация
  filtered = filtered.filter(p => matchesAllFilters(p, resolved));
}

foundProducts = filtered;
```

### 4. Fallback на оригинальное название

Если `category="Розетки"` вернул 0 (неизвестная категория в каталоге), попробовать `query="розетка"` как текстовый поиск + локальная фильтрация по `product.category.pagetitle`.

## Что НЕ трогаем

- `resolveFiltersWithLLM` — используется для сложных модификаторов
- Title-first, article-first, price-intent, replacement — без изменений
- Классификатор — работает, выдаёт правильную category и modifiers
- Scoring логику — заменяем на простой AND-фильтр

## Ожидаемый результат

- `category="Розетки"` → API вернёт только розетки
- Быстрый фильтр по цвету → только чёрные розетки
- LLM-резолв "двухместная" → `кол-во_разъемов=2`
- AND-фильтр → только чёрные двухместные розетки

## Объём: ~50 строк новых + замена ~40 строк в category-first ветке

