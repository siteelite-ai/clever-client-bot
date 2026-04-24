# План V4 — реализован

## Что сделано в `supabase/functions/chat-consultant/index.ts`

### 1. AI Candidates → системный промпт без few-shot шума (промпт)
`extractionPrompt` (стр. 2062–2147) полностью переписан:
- Принцип «модификатор → option_filters» сформулирован как одно жёсткое правило для всех типов признаков (визуальные, количественные, функциональные, происхождение).
- Числительные-прилагательные («одинарный», «двойной», «двухместный», «трёхполюсный», «четырёхмодульный») явно маркированы как количественная характеристика, обязательная к выносу в option_filters.
- Удалены длинные блоки few-shot-примеров (usage_context, IP44, лампы E27, цены конкретных товаров) — Flash на длинном промпте теряет инструкции.
- Убран повторяющийся шум 🚨/⚠️ блоков и дублирующийся раздел про артикулы.
- Сохранены: контракт JSON-схемы, поля article/query/brand/usage_context/option_filters/min_price/max_price, иерархия кандидатов, правила брендов и полного названия.

### 2. CategoryMatcher → бытовое по умолчанию (промпт + сигнатура)
`matchCategoriesWithLLM` (стр. 286–319):
- Добавлен **параметр `historyContext?: string`** (опциональный) — последние 3 пользовательские реплики.
- Добавлено **Правило 7**: если для одного предмета есть бытовая и узко-специализированная (промышленная/силовая/профессиональная) категория — выбирай бытовую. Специализированную включай только при явном маркере в запросе или истории (промышленность, цех, трёхфазная сеть, конкретный высокий номинал, специальные стандарты CEE/IP67+, профессиональный класс).
- Без хардкод-списков. Принцип, который Flash применяет к любой паре «бытовое vs промышленное».
- На стороне вызова (стр. ~4035) собирается `historyContextForMatcher` из `historyForContext.filter(role==='user').slice(-3)` и пробрасывается в matcher.

### 3. Schema fallback в slot refinement (алгоритм)
В блоке `product_search slot resolved` (стр. ~3803):
- Если и `slotPrebuilt`, и выборка `schemaProducts` пусты — FilterLLM **не вызывается вслепую**, модификаторы переходят в `unresolved`, а `sp.resolvedFilters` из открытого slot переиспользуются как есть.
- Лог: `[Chat] [FilterLLM-skip] schema empty for "<category>" → reusing prior resolved_filters (N keys)`.

### 4. Domain Guard в rerank (алгоритм)
`rerankProducts` (стр. 1936–1974):
- Новый параметр `allowedPagetitles?: Set<string>`.
- Если множество задано и непустое — товары, чей `category.pagetitle` (или `parent_name`) в нём не присутствует, **полностью отбрасываются** до скоринга.
- Лог: `[DomainGuard] dropped X/Y items from non-allowed categories. Sample: ...`
- Новая верхнеуровневая переменная `allowedCategoryTitles: Set<string>` (стр. ~3727), заполняется при WIN CategoryMatcher (стр. ~4048) и пробрасывается в `rerankProducts(foundProducts, userMessage, allowedCategoryTitles)` (стр. 5093).
- Если множество пусто (Classify не дал effectiveCategory, или CategoryMatcher промахнулся, или price-intent ветка) — фильтр не применяется → старое поведение сохранено.

## Что НЕ тронуто (защищено)

- Маршрутизация: slot → article-first → Classify → price-intent → title-first → category-first (matcher → bucket fallback) → replacement → AI Candidates.
- `resolveSlotRefinement` со всем merge-механизмом.
- `processPriceIntent`, `effectivePriceIntent`, `price_extreme` slot, локальная сортировка по цене перед rerank.
- Brands-ветка (`extractBrandsFromProducts`, `brandsContext`).
- Replacement: matcher → bucket → исключение оригинала → re-create slot.
- Cascading relax non-critical, broadCandidates, English fallback.
- JSON-схема `extract_search_intent` как контракт; provider lock на google-ai-studio + Flash.
- Article-first детекция (буквы/цифры/точки/дефисы ≥4 симв.).
- Бренды передаются в исходной форме пользователя (кириллица/латиница).
- Двухшаговый семантический маппинг в `resolveFiltersWithLLM` («модификатор → физическое свойство → значение схемы»).

## Регрессионные сценарии

| Запрос | Ожидание в логах |
|---|---|
| `есть чёрные розетки на два гнезда?` | `[CategoryMatcher]` → бытовые «Розетки» (не «Силовые»); `[DomainGuard] dropped N items` (перчатки/клеммники); `[AI Candidates] Filters extracted` непустой |
| `розетки промышленные на 32А` | `[CategoryMatcher]` → силовые (есть маркеры «промышленные» + «32А») |
| `розетки` (без контекста) | бытовые |
| `розетки` после реплики «у нас цех» | `historyContext` содержит «цех» → силовые |
| Пустая схема категории | `[FilterLLM-skip] schema empty → reusing prior resolved_filters` |
| `чёрная двухместная розетка` (slot открыт) | FilterLLM работает по-старому, двухшаговый маппинг не сломан |
| `16093 есть?` | article-first, AI Candidates не вызывается |
| `какие бренды розеток?` | brands-ветка, `extractBrandsFromProducts` |
| `самая дорогая бензопила` | `processPriceIntent` |

## Известные ограничения

Pre-existing TS warnings (21 шт.) сохраняются — `parent_name`, `slotPrebuilt` тип, `isReplacement` и др. На рантайм Deno они не влияют, edge function задеплоен и работает. Это карма прошлых правок, не относится к V4.

При регрессии любого сценария — откатывается только соответствующий блок (промпт или функция).
