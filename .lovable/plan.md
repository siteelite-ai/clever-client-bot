

# План: фикс «ошибки соединения» в виджете + idempotency на сервере

## Что чиним

Симптом: бот сгенерировал ответ, edge-функция отработала **дважды**, юзер увидел «Извините, произошла ошибка соединения».

Причина:
1. **Дубль fallback-блока** в `public/embed.js` (стр. 964–974 — копия 952–962) → виджет дёргает edge несколько раз подряд.
2. **Гонка стрим/fallback** — fallback стартует, даже если стрим успел получить токены.
3. **Нет idempotency на сервере** — каждый дубль-вызов исполняет полный pipeline (~9700 токенов на пустом месте).
4. **Слепая зона диагностики** — при ошибке в консоли браузера тихо.

## Правки

### `public/embed.js`

| # | Где | Что |
|---|---|---|
| 1 | стр. 964–974 | Удалить дублирующийся fallback-блок |
| 2 | стр. 952–962 | Условие `if (!result && !firstTokenArrived)` перед fallback |
| 3 | стр. 791–816 (`tryStreamEndpoint`) | try/catch вокруг финальной валидации: если `firstTokenReceived === true` — вернуть частичный `fullContent` с флагом `partial: true` вместо throw |
| 4 | catch-блоки стрима и fallback | `console.warn('[Widget] <label> failed: ' + err.message)` |
| 5 | начало `sendMessage` | `var messageId = crypto.randomUUID()`, передавать в body обоих endpoints |
| 6 | верх IIFE | `var WIDGET_VERSION = '<date>'; console.info('[Widget] v=' + WIDGET_VERSION)` |

### `supabase/functions/chat-consultant/index.ts`

| # | Где | Что |
|---|---|---|
| 7 | стр. 3380–3395 (старт обработки запроса) | In-memory `Map<string, {timestamp, response?}>` с TTL 60 сек по `messageId` из body. Если id уже в кэше — ранний `return new Response(..., { status: 200 })` с логом `[Chat] Duplicate blocked: <uuid>`. Без classifier, без FilterLLM, без LLM-генерации |

## Что НЕ трогаем

- Pipeline поиска (classifier, FilterLLM, replacement-ветка, бренды) — работает корректно после прошлого фикса
- Persona, markdown товаров, knowledge base, slot state
- Таймауты (90 сек stream, 60 сек non-stream)
- Список endpoints (direct + proxy)
- Логика thinking-фраз, контактов, истории сообщений

## Файлы

| Файл | Изменения |
|---|---|
| `public/embed.js` | ~25 строк затронуто, удаление дубль-блока, новый messageId, версия, console.warn, частичный возврат |
| `supabase/functions/chat-consultant/index.ts` | ~15 новых строк: idempotency Map + ранний return |

Деплой: `chat-consultant` автодеплоится. `embed.js` — через пересборку проекта (виджет встроен на чужих сайтах через `<script src="...embed.js">`, кэш браузера до 24 ч).

## Регрессионный тест

| # | Сценарий | Ожидание |
|---|---|---|
| 1 | Запрос «нужна белая двухгнёздая розетка» (тот, что сломался) | **Один** edge-вызов в логах. Либо стрим, либо чистый fallback. Без «ошибки соединения» |
| 2 | Стрим оборвался после первых токенов | Виджет показывает частичный ответ. Fallback не запускается. Один edge-вызов |
| 3 | Двойной клик «Send» за 200 мс | Один полный pipeline + один `[Chat] Duplicate blocked: <uuid>`. Один счёт токенов |
| 4 | Браузерный ретрай после 504 от Cloudflare | Тот же `messageId` → второй вызов отбит на сервере мгновенно |
| 5 | Edge упала с 500 / таймаут | Стрим → catch → fallback **один** раз → если тоже упал → «ошибка соединения». В консоли `console.warn` с label |
| 6 | Нормальный быстрый запрос «розетки IEK» | Стрим работает, fallback не задействуется. Без регрессий |
| 7 | Открытие виджета на сайте-партнёре | В консоли: `[Widget] v=<date>` — видно версию |
| 8 | Network drop в середине стрима | Если был хоть один токен — частичный ответ, fallback не стартует. Если ни одного — fallback один раз |

После деплоя — повтор того же запроса. Ожидание в логах:
- Edge: один `[Chat] Non-streaming response length`, один `[Usage] Logged`
- Браузер: `[Widget] v=...`, либо чистый ответ, либо `[Widget] stream failed: <reason>` + успешный fallback

