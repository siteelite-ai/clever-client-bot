## Что починим (по фактам из логов)

Логи последнего теста показывают **2 независимые проблемы**, обе reproducible:

### Проблема 1 — КРАШ форматтера (root cause "Connection Error" в виджете)
```
TypeError: Cannot read properties of undefined (reading 'split')
  at index.ts:3883 (Array.map в formatProductsForAI)
```
`brandOption.value` приходит `undefined` у некоторых продуктов из API 220volt. Падение → 500 → SSE-стрим даже не открывается → виджет показывает "Connection Error".

### Проблема 2 — Schema "Розетки" приходит пустой (root cause "не нашёл черные двухгнездые")
```
[CategoryOptionsSchema] /categories/options error for "Розетки": The signal has been aborted
[CategoryOptionsSchemaLegacy] "Розетки": 63 keys, 0 values
[FilterLLM] cvet__tүs valid, but value "черный" NOT in schema values [...] → unresolved
```
- `/categories/options` для "Розетки" таймаутит на ~4 сек (signal aborted)
- Через 5 секунд тот же endpoint для "Розетки силовые" отвечает за **225ms** с 389 values
- Это **flaky latency на первом холодном запросе**, не сломанный endpoint

---

## План — 3 точечных фикса

### Fix 1. Null-safe форматтер (убирает "Connection Error")
В `formatProductsForAI` (строка ~3905) и хелперах `cleanOptionValue/cleanOptionCaption`:
- `brandOption?.value` через optional chain + проверка `typeof === 'string'`
- В `isExcludedOption` — guard `if (typeof key !== 'string') return true`
- Обернуть `formatProductsForAI` в `try/catch`: при крахе логировать **проблемный продукт целиком** (`[FormatCrash] product=...`) и возвращать минимальный безопасный markdown (`[Название](url) — цена`), чтобы SSE-стрим продолжил работу.

### Fix 2. Retry с экспоненциальной задержкой для `/categories/options`
В `fetchCategoryOptionsSchema`:
- Поднять timeout первого запроса с ~4с до **6с**
- При AbortError — **1 retry** через 300ms (без jitter, без circuit breaker — overkill для двух запросов в день)
- Если и retry упал — продолжаем fallback на legacy (как сейчас), но добавляем лог `[CategoryOptionsSchema] retry_failed cat="..." total_ms=...`

Обоснование: в логах виден парный успешный запрос на "Розетки силовые" за 225ms. Это classic cold-start API. Один retry решит 90% случаев.

### Fix 3. Honest UX при degraded schema
В точке `[Chat] Category-first: honest no_match` (когда schema=0 values и ничего не резолвится):
- Сейчас: ответ молчит / падает / уходит в "no match"
- Станет: явный SSE-ответ пользователю — *"Я нашёл категорию «Розетки», но прямо сейчас не могу применить фильтр по цвету/типу из-за задержки каталога. Вот первые подходящие товары — уточните, пожалуйста, что именно нужно, и я подберу точнее."* + список top-N продуктов из bucket'а без фильтров.

Это решает кейс из теста: пользователь увидит **товары + честный вопрос**, а не пустоту.

---

## Что НЕ делаем (намеренно)

- ❌ Circuit breaker — оверинженеринг для одного flaky endpoint
- ❌ Глобальный рефакторинг schema-pipeline (`getCanonicalCategorySchema` из прошлого плана) — текущий код уже логирует degraded и не кеширует мусор, этого достаточно
- ❌ Снижение timeout до 5с — наоборот, поднимаем до 6с + retry

---

## Технические детали

**Файлы:**
- `supabase/functions/chat-consultant/index.ts`
  - строки ~3881-3911: null-safe guards
  - строки ~5910-5950: try/catch вокруг formatProductsForAI
  - функция `fetchCategoryOptionsSchema` (поиском по `[CategoryOptionsSchema] /categories/options`): retry-логика
  - точка `Category-first: honest no_match`: UX fallback с продуктами

**Новые маркеры для следующего теста:**
- `[FormatCrash] product_id=... missing_field=...` — увидим точный продукт-виновник
- `[CategoryOptionsSchema] retry attempt=1 cat="..."` — увидим, спасает ли retry
- `[Path] DEGRADED_UX cat="..." products_shown=N` — увидим срабатывание UX-fallback

**Что проверим после деплоя одним тестом** ("найди черный двухгнездые розетки" → "Бытовые"):
1. Виджет получает ответ (нет "Connection Error") — Fix 1
2. В логах либо `retry attempt=1` со success, либо degraded UX с продуктами — Fix 2/3
3. Если краш повторится — лог `[FormatCrash]` покажет конкретного виновника, и мы точечно добьём

Подтверждаете — начинаю.
