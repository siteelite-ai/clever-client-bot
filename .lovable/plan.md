## Цель

Создать **отдельную независимую edge-функцию `chat-consultant-v2`** рядом с существующей `chat-consultant` (V1). Переключение — ручное, через тумблер в админке. Никакой автоматики, никакого canary, никакого fallback между ними. Когда V2 себя покажет — V1 удаляется одной операцией без следов.

## Принципы

- **Полная изоляция.** V2 — это `supabase/functions/chat-consultant-v2/index.ts` со своими модулями. V1-код (`supabase/functions/chat-consultant/`) **не трогается вообще** — ни одной строки.
- **Ручной тумблер.** В `app_settings` одно поле `active_pipeline = 'v1' | 'v2'`. Меняется в админке кликом. Применяется мгновенно для всех новых запросов.
- **Никакого автоматического выбора.** Нет canary %, нет cohort hashing, нет admin-override, нет per-request параметров. Что в админке — то и работает для всех.
- **Никакого fallback.** Если V2 падает — пользователь видит ошибку, админ переключает обратно на V1 руками. Это сознательный выбор: автофоллбэк маскирует баги V2.
- **Чистое удаление V1.** Когда тумблер постоянно на V2 и всё работает — удаляются папка `chat-consultant/`, поле `active_pipeline`, UI-тумблер. Один PR, чистый репозиторий.

## Архитектура

```text
                  ┌─ виджет / embed.js ─┐
                  │  читает active_pipeline из публичного config-эндпоинта
                  │  (или жёстко зашит URL — см. ниже «Маршрутизация»)
                  └──────────┬──────────┘
                             ▼
   ┌──────────────────────────────────────────────────┐
   │  active_pipeline = 'v1'  →  /chat-consultant     │  ← legacy, as-is
   │  active_pipeline = 'v2'  →  /chat-consultant-v2  │  ← новая по спеке
   └──────────────────────────────────────────────────┘
```

### Маршрутизация (как клиент узнаёт, куда идти)

Виджет не должен на каждый сабмит ходить за конфигом — это лишний RTT. Решение:
- При инициализации виджета (`embed.js` init) делается один публичный `GET /functions/v1/widget-config` (новая лёгкая edge-функция, **без auth**), возвращает `{ active_pipeline: 'v1' | 'v2' }`.
- Клиент кеширует значение на сессию и шлёт сабмиты на соответствующий URL: `/chat-consultant` или `/chat-consultant-v2`.
- Переключение в админке → следующая инициализация виджета подхватит новое значение. Уже открытые сессии доигрывают на старой ветке (это нормально для ручного тумблера).
- Админ-preview в `ChatWidget.tsx` повторно дёргает `widget-config` при mount → admin сразу видит свежую ветку.

Альтернатива «один публичный URL `/chat` с серверным редиректом внутри» — отвергнута: добавляет слой, противоречит принципу «полностью независимые функции» и мешает чистому удалению V1.

## Изменения в БД (одна миграция)

Добавить в `app_settings` одно поле:
- `active_pipeline text not null default 'v1' check (active_pipeline in ('v1','v2'))`

Всё. Никаких canary-процентов, никаких флагов «force for admin». RLS на `app_settings` уже есть — не трогаем.

## Структура файлов

```text
supabase/functions/
├── chat-consultant/         # V1 — НЕ ТРОГАЕМ
│   └── index.ts
├── chat-consultant-v2/      # V2 — новая, изолированная
│   ├── index.ts             # serve() + полный пайплайн по спеке
│   ├── category-resolver.ts # §9.2a
│   ├── query-expansion.ts   # §9.2b
│   ├── strict-search.ts     # §9.2c
│   ├── soft-fallback.ts
│   ├── envelope.ts          # data.results[] (E1–E6)
│   ├── composer.ts          # BNF §17.3
│   ├── metrics.ts           # query_expansion_*, zero_price_leak, ...
│   └── types.ts
└── widget-config/           # НОВАЯ, публичная, тривиальная
    └── index.ts             # GET → { active_pipeline }
```

V2-функция читает те же `app_settings` (volt220-токен, openrouter-ключ, system_prompt, models). Ничего из V1 не импортирует. Если что-то нужно одинаковое — переписывается заново под V2-контракты (это и есть смысл «вторая версия»).

## Изменения во фронте

### `src/pages/Settings.tsx` — карточка «Активная версия пайплайна»
- Radio / Segmented control: **V1 (стабильная)** | **V2 (по новой спеке)**.
- Большой бейдж текущего значения.
- Кнопка «Применить» → UPDATE `app_settings.active_pipeline`.
- Подсказка: «Переключение мгновенное для новых сессий виджета. Уже открытые чаты доигрывают на старой версии».
- Когда V2 = active: маленькая кнопка-ссылка «Удалить V1 навсегда» (выводит инструкцию/чек-лист, **не выполняет автоматически** — удаление делает Lovable отдельным запросом).

### `public/embed.js` и `src/components/widget/ChatWidget.tsx`
- При init: `fetch('/functions/v1/widget-config')` → сохранить `active_pipeline` в локальном состоянии.
- Все последующие сабмиты идут на `/functions/v1/chat-consultant` или `/functions/v1/chat-consultant-v2` в зависимости от значения.
- Никаких изменений в SSE-контракте на стороне клиента. V1 продолжает отдавать свой формат, V2 — расширенный envelope (E1–E6). Клиент ест оба (расширения обратно-совместимы).

## Этапы реализации (с подтверждением между каждым)

### Этап A — Инфраструктура переключения (V2 = заглушка)
1. Миграция: `active_pipeline` в `app_settings`.
2. Edge-функция `widget-config` (публичная, без auth, GET → `{ active_pipeline }`).
3. Edge-функция `chat-consultant-v2` со скелетом: тот же CORS, тот же SSE-контракт, отвечает «V2 пайплайн ещё не реализован» одной строкой и закрывает поток. Никакой логики поиска.
4. `embed.js` + `ChatWidget.tsx`: чтение `widget-config` на init, маршрутизация.
5. Карточка в `/settings` с тумблером V1/V2.

Проверка: переключаю в админке → виджет на новой сессии бьёт в правильный URL → V1 при `v1` работает как сейчас, V2 при `v2` отдаёт «не реализовано». **Стоп → твой ок.**

### Этап B — V2: каркас пайплайна + Category Resolver (§9.2a, C1–C4)
В `chat-consultant-v2/index.ts`: чтение настроек, аутентификация SSE-канала, базовый Intent-LLM round-trip.
В `category-resolver.ts`: live `/api/categories` + TTL-кэш 60s, инварианты C1–C4, метрика `category_hallucination_total`.

Проверка: 3 пробы через `?pipeline=v2`-сценарий (то есть: переключаю тумблер → пробую). Стоп.

### Этап C — V2: Query Expansion (§9.2b)
`query-expansion.ts`: `as_is_ru → lexicon_canonical → en_translation → kk_translation` (последние два — внутри Intent-LLM tool-call). Lexicon из `app_settings.lexicon_json` (добавим колонку, если ещё нет, в этой же миграции). Метрики `query_expansion_*`.

Проверка: 3 пробы (RU/EN/KK термин). Стоп.

### Этап D — V2: Strict Search Multi-Attempt + Word-Boundary (§9.2c)
`strict-search.ts`: цикл по `query_attempts`, regex `\b<token>\b` (`iu`), hard-filter `price>0`, recovery-then-degrade на non-ASCII facet keys. Метрики `query_word_boundary_filtered_total`, `zero_price_leak`.

Проверка: 5 проб. Стоп.

### Этап E — V2: Envelope E1–E6 + Soft Fallback + Composer BNF (§17.3, §25.2)
`envelope.ts`, `soft-fallback.ts`, `composer.ts` строго по спеке.

Проверка: 4 пробы, включая «нет результата». Стоп.

### Этап F — Прогон §25 на живом API через V2
10–12 ключевых TC, отчёт в `.lovable/fixtures/probe-results-v2-2026-04-28.md`.

### Этап G (опционально, по твоей команде после успеха V2) — Удаление V1
- Удалить папку `supabase/functions/chat-consultant/` (+ `supabase--delete_edge_functions(['chat-consultant'])`).
- Удалить колонку `active_pipeline` (миграция: drop column).
- Удалить `widget-config` функцию и тумблер в `/settings`.
- `embed.js` бьёт напрямую в `/chat-consultant-v2` (или переименовать функцию обратно в `chat-consultant` отдельной операцией — на твоё решение).

## Что НЕ делаем

- Не трогаем ни одной строки в `supabase/functions/chat-consultant/`.
- Не делаем автоматическое переключение/canary/fallback.
- Не дублируем код «общими хелперами» между V1 и V2 — это снова свяжет их. Что нужно — переписываем в V2 заново под новые контракты.
- Не меняем виджет визуально. Меняется только URL-маршрутизация и init-fetch конфига.

## Старт

После твоего «ок» — **только Этап A** (инфраструктура: миграция + `widget-config` + скелет `chat-consultant-v2` + UI-тумблер). V1 продолжает работать как сейчас, V2 при включении отвечает «не реализовано».
