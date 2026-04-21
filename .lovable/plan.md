

# Срочный фикс: вернуть OpenRouter как ЕДИНСТВЕННЫЙ AI-провайдер

## Что нашёл при проверке кода

В `supabase/functions/chat-consultant/index.ts` действительно есть **нарушение core-правила** проекта (`mem://index.md`: «Exclusively use OpenRouter (Gemini models). No direct Google keys»):

| Место в коде | Что используется сейчас | Нарушение |
|---|---|---|
| Classifier (~702-743) | Cascade: Google API → OpenRouter → Lovable AI Gateway | ❌ Google + Gateway |
| `resolveFiltersWithLLM` (~2200) | Та же cascade-логика | ❌ Google + Gateway |
| `extract_search_intent` | Cascade-логика | ❌ Google + Gateway |
| Основная Gemini-стрим (финальный ответ) | Cascade-логика | ❌ Google + Gateway |

Cascade-фоллбэки и были одной из причин «лотереи» из прошлого аудита (Фикс A): при таймауте primary запрос уходил то на Google API напрямую, то на Lovable Gateway, и каждый провайдер возвращал слегка разную разметку → разные ответы юзерам.

**Правильно:** ВСЕ LLM-вызовы идут только через OpenRouter с моделями `google/gemini-2.5-*`. Никаких прямых Google API-ключей, никакого Lovable AI Gateway.

## Что внедряем

### Файл: `supabase/functions/chat-consultant/index.ts`

**Удалить полностью:**
- Все ветки cascade-fallback на `https://generativelanguage.googleapis.com/...` (Google API напрямую)
- Все ветки cascade-fallback на `https://ai.gateway.lovable.dev/...` (Lovable AI Gateway)
- Чтение и использование секретов `GOOGLE_API_KEY` / `GEMINI_API_KEY` / `LOVABLE_API_KEY` для LLM-вызовов

**Оставить только:**
- Единый helper `callOpenRouter({model, messages, ...opts})`, который шлёт POST на `https://openrouter.ai/api/v1/chat/completions` с заголовком `Authorization: Bearer ${OPENROUTER_API_KEY}`
- Все 4 точки вызова LLM (classifier, `resolveFiltersWithLLM`, `extract_search_intent`, основная стрим-модель) идут через этот helper
- Модели: `google/gemini-2.5-flash-lite` для micro-LLM (classifier/resolver/intent), `google/gemini-2.5-pro` для основного ответа — **в формате OpenRouter** (с префиксом `google/`)
- Таймаут 12с (как в прошлом плане Фикс A) на classifier; на ошибку OpenRouter — детерминированный фолбэк значений (`critical_modifiers = search_modifiers`, `is_replacement = false`), а НЕ переключение на другого провайдера
- Стрим основной модели работает по OpenRouter SSE (он API-совместим с OpenAI completions)

### Логи для контроля
- `[LLM] OpenRouter call: model=... purpose=classifier|resolver|intent|main`
- `[LLM] OpenRouter response: status=... latency=...ms`
- На ошибке: `[LLM] OpenRouter FAILED, applying deterministic fallback`

### Что НЕ трогаем

- Pipeline category-first / replacement / name-first / article-first — логика остаётся
- Все фиксы из предыдущих планов (critical_modifiers, query suppression, bucket-2 fallback, prioritizeBuckets tie-break) — сохраняются
- Persona, greetings ban, markdown rules
- Knowledge / RAG / FAQ
- Widget, embed.js, миграции БД
- Другие edge-функции (`knowledge-process`, `search-products`, `admin-users`) — там LLM-вызовов нет, проверил

## Секреты

- **Нужно:** `OPENROUTER_API_KEY` (наверняка уже есть — он использовался в одной из веток cascade). Проверю на этапе внедрения через `fetch_secrets`; если нет — попрошу добавить ДО кода.
- **Удалить из использования (но не из секретов):** `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `LOVABLE_API_KEY` — больше не читаются из кода. Сами секреты в Supabase оставим (вдруг где-то ещё пригодятся), но code path к ним обрублен.

## Объём и деплой

- ~80 строк правок в одном файле `chat-consultant/index.ts` (удаление 3 веток cascade × 4 точек вызова + единый helper + переключение моделей на формат OpenRouter)
- Деплой: только `chat-consultant` edge function

## Риски

| Риск | Митигация |
|---|---|
| OpenRouter временно недоступен → весь чат лежит | Детерминированный fallback на статичные значения classifier'а + сообщение юзеру «временные проблемы, попробуйте позже»; никакого переключения на других провайдеров (это и было источником лотереи) |
| Latency OpenRouter выше Google API | Таймаут 12с покрывает 99% запросов; если регулярно тормозит — отдельный тикет на смену модели |
| Иной формат ответа модели через OpenRouter | OpenRouter API-совместим с OpenAI completions; формат `choices[0].delta.content` идентичен — изменений в SSE-парсере виджета не нужно |

## Регрессионный тест-набор

1. «нужна черная двухместная розетка» × 5 → одинаковый ответ каждый раз
2. «светильник ДКУ-LED-03-100W (ЭТФ) предложи замену» × 5 → стабильно
3. Артикул «ABB-S201-C16» → article-first
4. «как оформить возврат» → RAG
5. «привет» → greetings ban
6. Логи проверить: ВСЕ строки `[LLM] OpenRouter call` присутствуют, НЕТ обращений к `generativelanguage.googleapis.com` или `ai.gateway.lovable.dev`

