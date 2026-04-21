

# Точечный фикс: OpenRouter + Gemini-2.5 reasoning ломает SSE-парсер и резолвер

## Что нашёл в логах

Бывший Lovable Gateway / Google direct присылали в SSE только `"content":"..."`. **OpenRouter с моделями Gemini-2.5 (pro и flash-lite)** включает thinking по умолчанию и в каждом чанке стрима добавляет ещё поля: `"reasoning":"..."`, `"reasoning_details":[...]`, `"refusal":null`, `"native_finish_reason":"STOP"`. А в финальном `message` у tool-call'ов `content: null` + полностью забитый `reasoning`.

В коде есть **regex-парсер SSE**, который ловит «любой content» в чанке:

```js
const contentMatch = text.match(/"content":"([^"]*)"/g); // строки 4641 и 4734
```

Этот же regex ловит и поля с `content` внутри `reasoning_details`, и пустые `"content":""` рядом с reasoning. Дальше чанк целиком пересылается клиенту через `controller.enqueue(encoder.encode(text))` — то есть юзер получает в стриме reasoning-мусор + пустой content. А `<think>...</think>` стриппер строки 4667/4743 не работает, потому что reasoning приходит в JSON-поле, а не в HTML-тегах.

Параллельно в `resolveFiltersWithLLM` (строка 2180-2210):
- `max_tokens: 200` — gemini-2.5-flash-lite через OpenRouter **сжирает все 200 токенов на reasoning** и возвращает пустой `content` → `JSON.parse('')` падает → все модификаторы становятся `unresolved` → STAGE 1/2/3 не находят бакеты.

Это объясняет лог: для бакета «Светильники (44 товара)» резолв вернул `{}` и ушёл на «Люстры», где придумал случайный `максимальная_площадь_освещения=10`.

## Что чиним (минимально, без переделки логики)

### Фикс 1. Отключить reasoning у всех LLM-вызовов через OpenRouter

OpenRouter поддерживает параметр `reasoning: { exclude: true }` или `reasoning: { enabled: false }` — модель не будет отдавать reasoning в ответе и не будет тратить на него токены. Добавить в **все 4 точки вызова** в `supabase/functions/chat-consultant/index.ts`:

| Точка | Строка | Изменение в `body` |
|---|---|---|
| Classifier (`classifyProductName`) | ~916-919 | `reasoning: { exclude: true }` |
| Resolver (`resolveFiltersWithLLM`) | ~2180-2186 | `reasoning: { exclude: true }` + поднять `max_tokens` 200 → 500 на всякий случай |
| Extract intent (`extractSearchIntent`) | ~651-654 | `reasoning: { exclude: true }` |
| Main stream (Chat) | ~4504-4509 | `reasoning: { exclude: true }` |

Это вернёт SSE-формат, **идентичный** прежнему Lovable Gateway → весь старый код парсинга снова работает корректно.

### Фикс 2. Защитить regex-парсер на случай если OpenRouter всё равно пришлёт reasoning

В обоих местах (строки 4641 и 4734) перед извлечением `"content":"..."` **вырезать** из чанка JSON-поле `"reasoning":"..."` и `"reasoning_details":[...]`. Простыми replace'ами:

```js
text = text.replace(/"reasoning":\s*"(?:[^"\\]|\\.)*"/g, '"reasoning":""');
text = text.replace(/"reasoning_details":\s*\[[\s\S]*?\]/g, '"reasoning_details":[]');
```

Делается ДО извлечения content и ДО enqueue. Это safety net на случай, если у конкретной модели reasoning нельзя выключить.

### Фикс 3. Защитить `JSON.parse` в резолвере от пустого content

В `resolveFiltersWithLLM` (строка 2210): обернуть `JSON.parse(content)` в try/catch и при ошибке/пустом контенте логировать `[FilterLLM] Empty content (likely reasoning consumed all tokens)` и возвращать `{ resolved: {}, unresolved: [...modifiers] }` — это уже поведение по умолчанию, просто без падения функции.

### Фикс 4. Логи для верификации

Добавить:
- `[Chat] Streaming with reasoning: excluded` (один раз перед стримом)  
- `[FilterLLM] Tokens used: prompt=X completion=Y` если OpenRouter отдаёт `usage` в ответе

## Что НЕ трогаем

- Pipeline replacement / category-first / name-first / article-first
- Persona, greetings ban, markdown rules, RAG
- Widget, embed.js, миграции БД
- Модели в `app_settings` (gemini-2.5-pro / flash-lite остаются)
- Cascade удалили в прошлом фиксе — оставляем «strict OpenRouter»

## Файлы

| Файл | Изменения |
|---|---|
| `supabase/functions/chat-consultant/index.ts` | +4 строки `reasoning: { exclude: true }` в 4 reqBody; +2 replace для очистки SSE; +try/catch в резолвере; +1 лог. Итого ~15 строк |

Деплой: только `chat-consultant` edge function.

## Риски

| Риск | Митигация |
|---|---|
| OpenRouter не поддерживает `reasoning: {exclude:true}` для конкретной модели | Фикс 2 (вырезание reasoning из SSE) работает как safety net |
| Без reasoning gemini-2.5-pro будет отвечать хуже на сложные вопросы | Контекст у нас всегда подаётся жёстко структурированным (формат товаров уже в промпте), reasoning тут не помогает — наоборот мешает. Если вдруг качество упадёт на сложных кейсах — включим обратно `reasoning: {effort: "low"}` |
| Поднятие `max_tokens` резолвера до 500 даст больше latency | На 1 запрос +50-100мс, незаметно |

## Регрессионный тест

| # | Запрос | Ожидание |
|---|---|---|
| 1 | «светильник ДКУ-LED-03-100W (ЭТФ) предложи замену» × 3 | 10 товаров аналогов в ответе (как было до OpenRouter) |
| 2 | «нужна черная двухместная розетка» × 3 | Стабильно товары, без «не нашлось» |
| 3 | Артикул «ABB-S201-C16» | Article-first, без изменений |
| 4 | «как оформить возврат» | RAG, без изменений |
| 5 | «привет» | Greetings ban активен |
| 6 | Логи: `[FilterLLM] Resolved with criticality: {…}` непустой для основных запросов; нет `Raw response: ` (пустой) |

После деплоя: открыть виджет, повторить запрос #1 5 раз — должны стабильно приходить аналоги.

