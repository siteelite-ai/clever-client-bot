

# Финальный план — архитектурная экспертиза и реализация

## Архитектурный аудит (роль Архитектора)

Прогнал план через критический анализ с учётом всех боковых эффектов и текущей структуры pipeline:

### Что меня устраивает в плане

1. **Источник правды правильный.** `/api/categories` возвращает дерево с `pagetitle`, и эта строка идентична тому, что принимает `/api/products?category=…` и тому, что лежит в `category.pagetitle` товара. Один словарь — три точки использования. Морфологический ад с `toPluralCategory` (строка 3531, 3845) уходит в небытие.

2. **Семантический матчинг через LLM решает оба твоих вопроса:**
   - «розетка» vs «Розетки скрытой установки» — морфология решена, потому что matcher оперирует смыслом, а не подстрокой.
   - «свет в коридор» → «Светильники потолочные», «Бра», «Люстры» — даже если в названии каталога нет корня запроса, matcher понимает класс предмета.
   - Запрос вне каталога («гироскутер») → matcher возвращает `[]` → честный fallback.

3. **Старая bucket-логика остаётся как страховка.** Это критично: если matcher промахнётся или OpenRouter ляжет — pipeline не теряет работоспособность.

### Риски, которые я нашёл и закрываю в плане

| Риск | Митигация |
|---|---|
| Matcher вернёт нерелевантные категории, но в них найдутся товары → плохой ответ выглядит «успешным» | После поиска по matched-категориям: если 0 товаров → fallback. Но если товары есть — мы им доверяем. Защита на уровне промта: явные правила «не аксессуары, не комплектующие, не рамки» |
| LLM medium (gemini-flash) подтянет похожее название без смысла («Розетки» при запросе «розетки коннекторы RJ45») | Промт требует возвращать категории, где товар — самостоятельная позиция запрошенного класса. RJ45 — это «Кабельная продукция», не силовая розетка. Matcher это различает |
| Кеш категорий устарел (новая категория появилась за час) | TTL 1ч приемлем — категории каталога меняются крайне редко. Если matcher не нашёл и упадёт fallback — старая логика всё равно поймает по `query=` |
| Холодный старт edge-функции = первый пользователь ждёт загрузку каталога | Загрузка `/api/categories` за 1 запрос (`per_page=200&depth=10`) — ~300-500ms. Допустимо. Параллельно с classifier |
| OpenRouter timeout на matcher → вся ветка зависает | `Promise.race` с timeout 10с. При срабатывании — fallback на старую логику. Никаких 26-секундных хвостов |
| `effectiveCategory` от classifier'а сам по себе мусорный (классификатор ошибся) | Matcher вернёт `[]` → fallback на старую bucket-логику, поведение как сейчас. Регрессии нет |
| Параллельный `query=`-запрос (страховка от пропуска) | Сохраняем `Promise.all([category-search, query-search])` внутри новой ветки на случай, если matcher вернул мало категорий, но фактическая выдача API богаче. Дедупликация по id уже есть |

### Вердикт Архитектора

План **применим как есть**, риски управляемы, регрессий по построению нет (старая логика сохранена как fallback). Переходим к реализации.

---

## План реализации

### Шаг 1. `search-products/index.ts` — ветка `action: "list_categories"`

- При `body.action === "list_categories"` вызываем `GET /api/categories?parent=0&depth=10&per_page=200` с Bearer-токеном
- Если `pagination.pages > 1` — параллельно дотягиваем оставшиеся страницы
- Рекурсивно обходим дерево (`results[].children[].children…`), собираем `Set<string>` всех `pagetitle`
- Возвращаем `{ categories: string[] }`
- Module-level кеш `Map`, TTL 1 час
- При первом запуске — лог сырого ответа для верификации формата (одноразовая диагностика)

~50 строк.

### Шаг 2. `chat-consultant/index.ts` — `getCategoriesCache()`

- Module-level `Map` с TTL 1 час
- Lazy fetch через `search-products?action=list_categories`
- Возвращает `string[]` (плоский список pagetitle)
- При ошибке — возвращает `[]` (matcher вернёт пустой результат → fallback)

~25 строк.

### Шаг 3. `chat-consultant/index.ts` — `matchCategoriesWithLLM()`

- Gemini-2.5-flash через OpenRouter (тот же стек, что у других micro-LLM)
- Structured tool call: `select_categories({ matches: string[] })`
- Системный промт без хардкод-примеров и чёрных списков. Только формальные правила:
  - Категория релевантна, если её товары — это тот самый предмет, который запрашивает пользователь
  - Не подбирать аксессуары, комплектующие, рамки, монтажные элементы
  - Учитывать морфологию русского языка
  - Если в каталоге несколько подкатегорий одного семейства — включать все
  - Если ни одна не подходит — вернуть `[]`, не угадывать
- Вход: `{ query_word: string, catalog: string[] }`, выход: `{ matches: string[] }` (точные строки из переданного списка)
- Логирование: `[CategoryMatcher] "розетка" → ["Розетки скрытой установки", "Розетки накладные"]`

~55 строк.

### Шаг 4. Новая главная ветка в category-first блоке (`chat-consultant/index.ts` ~стр. 3525–3545)

Перед существующей логикой (`toPluralCategory` + два параллельных поиска) добавляется новый главный путь, обёрнутый в `Promise.race(timeout=10с)`:

```text
catalog = getCategoriesCache()
matches = matchCategoriesWithLLM(effectiveCategory, catalog)

если matches.length > 0:
  параллельно для каждого matches[i]:
    GET /api/products?category=<точный pagetitle>&per_page=20
  + параллельно: GET ?query=<effectiveCategory> (страховка)
  мёрж + дедуп по id
  
  если результат > 0:
    resolveFiltersWithLLM 1 раз на всей выборке (с критическими модификаторами)
    параллельно для matched категорий: GET с category= + options[…]
    если 0 → relaxed (drop некритичных) → повтор
    если опять 0 → text-fallback → soft 404
    логи: path=WIN
    
иначе (matches пустой ИЛИ timeout):
  логи: path=FALLBACK_TO_BUCKETS reason=...
  переход к существующей старой логике (toPluralCategory + bucket-конкурс)
```

Старые строки 3531–3802 **не удаляются** — становятся блоком `else`. ~80 строк новой логики поверх.

### Шаг 5. Симметрично в replacement-блоке (~стр. 3805–3960)

- Если `originalProduct` найден → его `category.pagetitle` уже точная строка → matcher пропускается, идём прямо в финальный поиск с этой категорией
- Если не найден → matcher по `replCategory` → тот же путь, что в Этапе 4
- Параллельный `query=`-запрос остаётся
- Старая replacement bucket-логика — fallback

~50 строк.

### Шаг 6. Мониторинг (1–2 недели после деплоя)

В каждом ключевом узле — структурированный лог `[Path] WIN | FALLBACK_TO_BUCKETS reason=...`. По логам считаем долю `WIN` vs `FALLBACK`. При `WIN ≥ 95%` отдельным планом удаляем `prioritizeBuckets`, `toPluralCategory` и весь старый bucket-конкурс. До этого — оставляем.

## Что НЕ трогаем

- Classifier, `resolveFiltersWithLLM`, title-first, article-first, price-intent ветки
- `searchProductsByCandidate`, `searchProductsMulti` — без изменений
- `prioritizeBuckets`, `toPluralCategory` — остаются как fallback
- Виджет, embed.js, knowledge base, persona, conversational rules, slot-state machine
- RLS, миграции, auth

## Файлы

| Файл | Изменения |
|---|---|
| `supabase/functions/search-products/index.ts` | +ветка `action: "list_categories"` с обходом дерева и кешем 1ч. ~50 строк |
| `supabase/functions/chat-consultant/index.ts` — `getCategoriesCache()` | Новая, ~25 строк |
| `supabase/functions/chat-consultant/index.ts` — `matchCategoriesWithLLM()` | Новая, без хардкод-примеров. ~55 строк |
| `supabase/functions/chat-consultant/index.ts` ~стр. 3525 | +новый главный путь поверх старого. ~80 строк |
| `supabase/functions/chat-consultant/index.ts` ~стр. 3805 (replacement) | Симметрично. ~50 строк |

Деплой: автодеплой обоих edge-функций.

## Регрессионный тест

| # | Сценарий | Ожидание |
|---|---|---|
| 1 | «нужна чёрная двухместная розетка» | `[CategoryMatcher] "розетка" → [Розетки скрытой установки, Розетки накладные]`, без колодок/рамок, count > 0, elapsed < 8с, `path=WIN` |
| 2 | Холодный старт инстанса | `[Cache] miss, fetched N categories from /api/categories`. Дальше `hit` |
| 3 | «нужен свет в коридор» | matcher вернёт `[Светильники потолочные, Бра, Люстры]` — без слова «свет» в части названий |
| 4 | «выключатель Schneider Atlas» | matcher вернёт выключательные категории |
| 5 | «квантовый телепортер» / «корм для попугая» | matcher → `[]` → bucket-fallback → text-fallback → soft 404 |
| 6 | matcher промахнулся, в найденных категориях 0 товаров под фильтры | `path=FALLBACK_TO_BUCKETS reason=zero_after_filters`, старая логика ловит |
| 7 | Критичный фильтр отсутствует в схеме | relaxed дропает некритичные → товары находятся |
| 8 | «чем заменить розетку Legrand X» | originalProduct найден → `category.pagetitle` напрямую, matcher пропускается |
| 9 | API timeout > 10с / OpenRouter лёг | `Promise.race` → fallback. Никаких 26с-зависаний |
| 10 | Любой ранее работавший запрос | matcher лучше или равно; промах ловит fallback. Регрессий нет по построению |

После деплоя — повторяем запрос со скриншота. Ожидание в логах: `[Cache] hit N`, `[CategoryMatcher] "розетка" → [...розеточные категории...]` без «Колодок» и «Рамок», `path=WIN`, `count > 0`, `elapsed < 8с`.

