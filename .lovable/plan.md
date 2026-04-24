# План реализован

## Что сделано в `supabase/functions/chat-consultant/index.ts`

### 1. CategoryMatcher (стр. 304–310)
Правило 2 переписано через общий принцип «компонент/деталь/аксессуар vs самостоятельный товар» вместо хардкод-перечисления (рамки, коробки, заглушки).

### 2. AI Candidates → артикулы (стр. 2093–2099)
Артикул теперь — любой непрерывный токен из букв (лат/кир) + цифр + точек/дефисов длиной ≥4 без пробелов внутри. Не только числовые 4–8 цифр. Примеры включают `CKK11-012-012-1-K01`, `ВА47-29`, `09-0201`, `16093`.

### 3. AI Candidates → бренды (стр. 2108, 2128–2136)
Убрано требование «бренды ВСЕГДА латиницей». Бренд передаётся в той форме, как написал пользователь (кириллица или латиница). Нормализация регистра/раскладки выполняется на сервере (`extractBrandsFromProducts` + API).

### 4. FilterLLM → семантический маппинг (стр. 2699–2710)
Добавлен новый шаг 2: «определи физическое свойство, описываемое модификатором, до поиска характеристики». Числительные-прилагательные («одинарный/двойной/трёхполюсный/четырёхместная») явно маркированы как количественная семантика. Без хардкод-примеров.

## Что НЕ тронуто (важно)

Полностью сохранены:
- Маршрутизация: slot → article-first → Classify → price-intent → title-first → category-first (matcher → bucket fallback) → replacement → AI Candidates fallback
- `resolveSlotRefinement` со всем merge-механизмом (`resolved_filters` JSON + `unresolved_query` + повторный API-запрос с реальной схемой категории)
- Цены: `processPriceIntent`, `effectivePriceIntent`, `price_extreme` slot, `min_price`/`max_price`, локальная сортировка перед rerank
- Brands-ветка: `extractBrandsFromProducts` из option `brend__brend`/vendor, `brandsContext` для общих запросов, прямой поиск с brand-фильтром если бренд указан
- Replacement: matcher → bucket → исключение оригинала → re-create slot
- Cascading relax non-critical фильтров, domain guard, telecom penalty, broadCandidates, English fallback, rerank
- JSON-схема `extract_search_intent` как контракт
- Provider lock на google-ai-studio + хардкод Flash для AI Candidates
- Список бренда «латиницей» в primary `Classify`-промпте уже отсутствует — там бренд классифицируется без принудительной транслитерации

## Что проверять по логам после деплоя

| Сценарий | Ожидание в логах |
|---|---|
| `чёрная двухместная розетка` | `[CategoryMatcher]` → 2 категории, `[FilterLLM]` резолвит цвет=чёрный + количество_постов=2, `Filters extracted: {...}` непустой |
| `16093 есть?` | `[ArticleDetect] Found 1 article(s): 16093`, `[ArticleSearch]` |
| `09-0201-002` | `[ArticleDetect]` ловит токен (≥4 симв., буквы+цифры+дефис) |
| `CKK11-012-012-1-K01` | `[ArticleDetect]` ловит, `[Chat] Article-first: detected 1 article(s)` |
| `у вас Werkel есть?` | Classify intent=brands + `hasSpecificBrand=true` → searchProductsMulti с brand=Werkel |
| `какие бренды розеток?` | Classify intent=brands, brand=null → широкий поиск 50 → `extractBrandsFromProducts` → `brandsContext` |
| `розетки бош` (бренд кириллицей) | brand=`бош` (как написал), API нормализует |
| `самая дорогая бензопила` | `[Chat] Price intent detected: most_expensive`, `processPriceIntent` |
| `а подешевле?` (после товара за 15 000) | AI Candidates: `max_price=14999` + восстановленная категория |
| `розетки` → 30+ → `белые` | `[Slots] product_search slot resolved`, `[Chat] FilterLLM refinement: resolved={цвет:...}` |

При регрессии любого сценария — откатывается только соответствующий промпт-блок.
