# План V5 — реализован (ускорение простого поиска)

## Что сделано в `supabase/functions/chat-consultant/index.ts`

### 1. `fetchCatalogWithRetry` — таймаут + ретрай (стр. ~731)
Новый общий хелпер: `AbortController` с таймаутом 8 сек, при `AbortError` ровно один ретрай. Используется в:
- `searchByArticle` (стр. ~772)
- `searchBySiteId` (стр. ~801)

Логи: `[ArticleSearch] timeout 8000ms (attempt 1), retrying...` / `[SiteIdSearch] ...`. Раньше при подвисшем 220volt API мы ждали до 70+ сек (видно в реальных логах: `22:01:22 → 22:02:34`). Теперь максимум 16 сек, дальше fallback в обычный pipeline.

### 2. Pre-warm knowledge & contacts (стр. ~3753)
Промисы `earlyKnowledgePromise` и `earlyContactsPromise` стартуют сразу после `getAppSettings()` — параллельно с `searchByArticle`/`classifyProductName`. Раньше эти запросы ждали окончания всей LLM-цепочки. Старый `knowledgePromise`/`contactsPromise` блок (был на строке ~5034) удалён, ниже только `await Promise.all([earlyKnowledgePromise, earlyContactsPromise, detectedCityPromise])`.

### 3. `responseModel` для финального стрима (стр. ~3766, ~5570)
- Новые переменные `responseModel = aiConfig.model` (default) и `responseModelReason = 'default'`.
- При **article-first SUCCESS** (~3812): `responseModel = 'google/gemini-2.5-flash'`, `reason = 'article-shortcircuit'`.
- При **siteId-fallback SUCCESS** (~3835): `reason = 'siteid-shortcircuit'`.
- При **price-intent SUCCESS** (~4014): `reason = 'price-shortcircuit'`.
- При **price-intent CLARIFY** (~4029): `reason = 'price-clarify'`.
- В финальном `callAIWithKeyFallback` (~5573) `model: responseModel` вместо `aiConfig.model`.
- Лог: `[Chat] Response model: google/gemini-2.5-flash (reason: article-shortcircuit)`.

Pro (~12 сек на 900 симв.) сменяется Flash (~3 сек) для коротких подтверждающих ответов. Catalog/brands/replacement-ветки не задеты — там `responseModel` остаётся `aiConfig.model`.

### 4. Сжатие knowledge для article-shortcircuit (стр. ~5045)
В блоке формирования `knowledgeContext`:
- `KB_TOTAL_BUDGET = articleShortCircuit ? 2000 : 15000`
- `KB_MAX_ENTRIES = articleShortCircuit ? 1 : knowledgeResults.length`
- Для article-shortcircuit берём только топ-1 BM25-релевантную запись.
- Лог: `[Chat] Knowledge truncated for article-shortcircuit: top-1 entry, N chars (budget 2000)`.

Раньше в article-ответ улетало 15029 chars — почти 5К токенов баласта.

## Ожидаемый эффект

| Сценарий | Было | Стало |
|---|---|---|
| `LLE-CORN-7-230-40-G9 есть в наличии?` (быстрый API) | ~85 сек (12 сек Pro + 70 сек API) | ~5–8 сек (Flash + меньше токенов) |
| Артикул при подвисшем API | ~75+ сек | ~10 сек (timeout+retry → fallback) |
| `самая дорогая бензопила` | Pro ~12 сек на ответ | Flash ~3 сек |
| `розетка` (catalog) | без изменений | без изменений |

## Что НЕ тронуто (защита V4 + базовая архитектура)

- Маршрутизация: slot → article-first → Classify → price-intent → title-first → category-first (matcher → bucket fallback) → replacement → AI Candidates.
- Все промпты V4 (`extractionPrompt`, `matchCategoriesWithLLM` Rule 7).
- Domain Guard (`allowedCategoryTitles`, `rerankProducts`).
- Schema fallback в slot refinement.
- `resolveSlotRefinement`, `processPriceIntent`, `extractBrandsFromProducts`, replacement, cascading relax, broadCandidates, English fallback.
- JSON-схема `extract_search_intent`, provider lock на `google-ai-studio`.
- Системный промпт финального ответа, `DETERMINISTIC_SAMPLING`, `max_tokens: 4096`, `reasoning: { exclude: true }`.
- Кэш `getAppSettings`, GeoIP, контакты-блок (контент остался прежним).
- `aiConfig.model` — настройка пользователя по-прежнему respected для всех catalog/brands/general ответов.
- `logTokenUsage` использует `aiConfig.model` для аналитики «настроенной модели» — это намеренно (отдельная задача — учитывать реальную `responseModel`).

## Известные ограничения

Pre-existing TS warnings (21 шт., как в V4) сохраняются — `parent_name`, `slotPrebuilt` тип, `isReplacement`, `price_dir` enum mismatch. На рантайм Deno они не влияют, edge function задеплоен.

## Регрессионные сценарии

| Запрос | Ожидание |
|---|---|
| `LLE-CORN-7-230-40-G9 есть в наличии?` | total ≤ 10 сек; `[Chat] Response model: google/gemini-2.5-flash (reason: article-shortcircuit)`; `[Chat] Knowledge truncated for article-shortcircuit` |
| `16093` (числовой артикул) | то же |
| Несуществующий артикул `XXX-FAKE-999` | timeout 8с (если API подвис) → siteId fallback → нормальный pipeline; `responseModel = aiConfig.model` |
| `самая дорогая бензопила` | `responseModel = flash, reason = price-shortcircuit` |
| `есть белые розетки на два гнезда?` | без изменений: catalog ветка, `responseModel = aiConfig.model`, V4 Domain Guard работает |
| `какие бренды розеток?` | brands-ветка, `responseModel = aiConfig.model` |
| `розетки промышленные на 32А` | V4 CategoryMatcher Rule 7 — силовые |
