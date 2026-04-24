# План V5 — ускорение «простого» поиска (артикул / точное название)

## Что показывают логи последнего запроса `LLE-CORN-7-230-40-G9 есть в наличии?`

Реальные тайминги (по timestamp'ам edge-логов):

| Этап | Длительность |
|---|---|
| `Article-first: detected` → `ArticleSearch Found 1` | **~72 сек** (один HTTP к 220volt API) |
| Сборка контекста (knowledge + contacts + GeoIP + format) | ~1 сек |
| Стриминг ответа `google/gemini-2.5-pro` (912 симв.) | ~12 сек |
| **Итого** | **~85 сек** |

Article-first ветка **уже работает корректно**: артикул задетектирован сразу, LLM-классификатор и LLM-кандидаты пропущены. Узких мест по сути два:

1. Внешний каталожный API 220volt отвечает на `?article=...` десятками секунд (это вне нашего кода, но мы его никак не страхуем).
2. Финальный ответ генерится тяжёлой моделью `gemini-2.5-pro`, хотя для ответа «да, есть в Караганде, 203 шт., 767 ₸» хватает Flash.

Плюс есть три мелких улучшения, которые сэкономят ещё 0.5–2 сек на каждом таком запросе.

## Цель

Сократить простой артикульный/точно-именованный запрос с ~85 сек до **~5–10 сек в типичном случае**. Не трогать маршрутизацию, slot-machine, FilterLLM, CategoryMatcher, replacement, price-intent, brands-ветку — всё, что описано в `.lovable/plan.md` (V4) сохраняется.

## Что меняем

### 1. Параллелизация холодного старта (без риска)
Сейчас порядок строго последовательный:
```
getAppSettings → detectArticles → searchByArticle → hybridKnowledgeSearch → loadContacts → format → stream
```
Knowledge-search и contacts-load **никак не зависят** от результата article-search и от LLM-классификатора. Запускаем их параллельно с `searchByArticle` через `Promise.all`. На холодном запросе это даёт −0.3…−1.5 сек (knowledge hybrid search видно в логах ~325 мс, contacts ~50 мс).

Точечно: в начале handler'а сразу после `getAppSettings()` стартуют промисы:
- `searchByArticle` (если артикул есть) ИЛИ `classifyProductName` (если артикула нет — но это уже отдельная ветка, её не трогаем здесь)
- `hybridKnowledgeSearch(userMessage, ...)`
- `loadContacts(...)`
- `detectCityByIP(clientIp)` (уже параллельный)

`await Promise.all([...])` непосредственно перед сборкой `productContext`/`knowledgeContext`/`contactsContext`.

### 2. Таймаут + ретрай на `searchByArticle` и `searchBySiteId`
Сейчас `fetch` без `AbortController` — если 220volt API подвис на 70 секунд, мы тоже висим 70 секунд. Добавляем:
- `AbortController` с таймаутом 8 сек на первый вызов;
- при `AbortError` — один ретрай с таймаутом 8 сек;
- если оба упали — корректный fallback (уже есть: `siteId fallback` → `normal pipeline`).

Лог: `[ArticleSearch] timeout 8s, retrying...` / `[ArticleSearch] retry failed, falling back`.

Это страхует нас от подвисаний внешнего API. В худшем случае — артикульный запрос упадёт в обычный pipeline вместо 70-сек ожидания.

### 3. Лёгкая модель для финального ответа в short-circuit ветках
Когда сработал **article-first**, **siteId-fallback** или **price-intent short-circuit** — товар уже найден точно, нужно лишь его озвучить. Pro здесь не нужен.

Вводим переменную `responseModel`:
- `articleShortCircuit === true` → `google/gemini-2.5-flash`
- `priceIntentShortCircuit === true` → `google/gemini-2.5-flash`
- иначе → `aiConfig.model` (как сейчас, по настройкам)

Меняем только параметр `model` в финальном `streamChat` запросе (стр. ~5516). Системный промпт, формат, лимиты — без изменений. По бенчмарку Flash отвечает в 3–5 раз быстрее Pro на коротких ответах (~3 сек vs ~12 сек).

В логи: `[Chat] Response model: google/gemini-2.5-flash (reason: article-shortcircuit)`.

### 4. Ранний выход из `detectArticles`
Сейчас `detectArticles` уже первая операция после санитизации — это правильно. Дополнительно: если артикул найден — **не запускаем** `detectCityByIP` и не ждём GeoIP (она нужна только для контактов/доставки в общем потоке; для артикульного ответа город не критичен и так уже передаётся из истории/слотов). Сохраняем GeoIP как «fire-and-forget» промис на следующий ход — кэш `getAppSettings` уже его подхватит.

Маленькая экономия (~150–300 мс на холодном запросе), но без побочек.

### 5. Сокращение knowledge-context для article-shortcircuit
Сейчас `[Chat] Added 5 knowledge entries to context (15029 chars, budget 15000)` — даже на запрос «есть артикул X?» в промпт уезжает 15 КБ статей базы знаний. Это раздувает токены и увеличивает латентность LLM.

Для `articleShortCircuit === true` режем knowledge до **2 КБ** (топ-1 entry или вовсе пропускаем, если её BM25-score ниже порога). Контакты оставляем — пользователь может спросить «а где забрать?».

Лог: `[Chat] Knowledge truncated for article-shortcircuit: 15029 → 1843 chars`.

## Что НЕ трогаем (защита V4)

- Маршрутизация: slot → article-first → Classify → price-intent → title-first → category-first (matcher → bucket fallback) → replacement → AI Candidates.
- `detectArticles`, `searchByArticle`, `searchBySiteId` — сигнатуры и логика прежние, только обёртка с таймаутом.
- `resolveSlotRefinement`, `processPriceIntent`, `extractBrandsFromProducts`, replacement, cascading relax, broadCandidates, English fallback.
- CategoryMatcher Rule 7, Domain Guard, schema fallback, extractionPrompt — всё из V4 нетронуто.
- Системный промпт финального ответа.
- Provider lock на `google-ai-studio`. Меняется только `model` для short-circuit веток.
- Кэш `getAppSettings`.

## Технический разрез

| Файл | Изменение |
|---|---|
| `supabase/functions/chat-consultant/index.ts:731` | `searchByArticle` — добавить `AbortController` (8 с) + 1 ретрай |
| `…:767` | `searchBySiteId` — то же самое |
| `…:3700–3782` | После `getAppSettings()` запустить knowledge/contacts/article промисы параллельно через `Promise.all`; собирать контексты после `await` |
| `…:3724–3737` | Завести `let responseModel = aiConfig.model` |
| `…:3760, 3777` | При article/siteId success: `responseModel = 'google/gemini-2.5-flash'`; добавить лог |
| `…` (price-intent блок) | При price-intent short-circuit: `responseModel = 'google/gemini-2.5-flash'` |
| `…:5516` | `model: responseModel` вместо `aiConfig.model` |
| `…` (knowledge сборка) | `if (articleShortCircuit) knowledgeBudget = 2000` |

Никаких новых файлов, миграций, схем БД, edge-функций.

## Регрессионные сценарии

| Запрос | Ожидание |
|---|---|
| `LLE-CORN-7-230-40-G9 есть в наличии?` | total ≤ 10 сек; `responseModel=flash`; knowledge truncated |
| `16093` (цифровой артикул) | то же |
| Несуществующий артикул `XXX-999-FAKE` | timeout 8с → siteId fallback → нормальный pipeline; модель = aiConfig.model |
| `220volt API timeout` (имитация) | `[ArticleSearch] timeout 8s, retrying...` → fallback в обычный pipeline, не висим 70 с |
| `есть белые розетки на два гнезда?` (V4 кейс) | без изменений: catalog ветка, Pro/настройка, V4 Domain Guard работает |
| `какие бренды розеток?` | без изменений: brands-ветка |
| `самая дорогая бензопила` | price-intent short-circuit → Flash для ответа (быстрее), логика прежняя |
| Артикул + price-intent в одной фразе | article-first выигрывает (как сейчас), Flash |

## Ожидаемый эффект

- Артикульный запрос с быстрым 220volt API: ~85 с → **~5–8 с** (главное: −9 с за счёт Flash, −0.5 с за счёт параллели, −1 с за счёт сжатия knowledge).
- Артикульный запрос при подвисшем 220volt API: ~75+ с → **~10 с** (timeout 8 с + ретрай 8 с + fallback).
- Каталожные запросы (V4 сценарии) — без изменений.
- Никакого нового LLM-вызова, никаких новых промптов, никакой ломки контракта.
