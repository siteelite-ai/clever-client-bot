# Expert Orchestrator — V3 Specification

> **§0 Data-agnostic.** Эта спека НЕ содержит реальных категорий, брендов, моделей, артикулов, материалов и единиц 220volt.kz. Все примеры — либо абстрактные плейсхолдеры (`<noun>`, `<facet_key>`, `<value>`), либо синтетика. Реальные fixtures — отдельно в `.lovable/fixtures/v3-*`.

> **Статус:** DRAFT. Требует согласования до начала реализации.

---

## §1 Цель и инвариант

V3 заменяет детерминированный конвейер V1/V2 (`classify → router → branch → composer`) на **agentic-оркестратор**: одна LLM («Эксперт») получает входящее сообщение пользователя и стримит ход разговора, **сама** решая когда и какой тул вызвать.

### Главный инвариант
> **Эксперт = единственный автор пользовательских реплик.**
> Эксперт = НЕ автор URL/цен/SKU/наличия товаров — это **исключительно** функция тула `render_products` (детерминированный рендер из API-ответа).

### Принципы (нерушимые)
1. **Real-time catalog only.** Никакой синхронизации каталога в БД. Все факты о товарах — из живого API в момент вызова тула.
2. **Anti-hallucination для товаров.** Эксперт обращается к товарам ТОЛЬКО через id/pagetitle, никогда не цитирует ссылку/цену словами. Рендер карточек — отдельная функция, не LLM.
3. **HARD BAN price=0** на всех уровнях (catalog tool + render).
4. **NO greetings.** Эксперт говорит как продавец у прилавка (см. промпт-контракт §6).
5. **NO self-narrowing.** Эксперт не сужает выдачу скрытыми фильтрами. Любое сужение объявляется клиенту.
6. **Tool-determinism для побочных эффектов.** Все запросы к каталогу/БД проходят через тулы. Эксперт не имеет прямого доступа к `fetch`.

---

## §2 Архитектурный контур

```
┌──────────────┐
│   Widget     │
│  (ChatWidget │
│   + embed.js)│
└──────┬───────┘
       │ SSE (расширенный контракт §5)
       ▼
┌──────────────────────────────────────────────┐
│  edge function: chat-consultant-v3           │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │  Expert Loop                           │  │
│  │  (streamText + tools, stepCountIs(N))  │  │
│  └──┬───────┬────────────────┬────────────┘  │
│     │       │                │                │
│     ▼       ▼                ▼                │
│  [text]  [tool_call]    [tool_call]           │
│   stream  search_*       render_products      │
└─────┬─────────┬──────────────┬────────────────┘
      │         │              │
      │         ▼              ▼
      │  ┌─────────────┐  ┌──────────────┐
      │  │ shared      │  │ deterministic│
      │  │ search core │  │ render core  │
      │  │ (QFv2 etc.) │  │ (BNF §17.3)  │
      │  └─────────────┘  └──────────────┘
      │
      ▼
   chat_request_logs (полная трассировка хода)
```

### Размещение кода
- `supabase/functions/chat-consultant-v3/index.ts` — оркестратор + SSE.
- `supabase/functions/_shared/v3-tools/*.ts` — реализация каждого тула.
- `supabase/functions/_shared/*` — переиспользуется как было (QFv2 модули, jargon-fallback, accessory-for, knowledge-search, render). Их публичные функции не меняются; v3 импортирует их.

### Тумблер пайплайна
- `app_settings.active_pipeline ∈ {'v1','v2','v3'}`. Default остаётся `'v1'` до завершения стабилизации.
- Никакого auto-canary/fallback (правило проекта).

---

## §3 Tool Catalog

### Общие правила
- Каждый тул — чистая функция: `(input: JsonSchema) → Promise<Output>`.
- Все тулы возвращают `{ ok: true, ... } | { ok: false, error_code: string, message: string }`.
- Идемпотентны (повторный вызов с теми же аргументами даёт тот же результат в пределах ~30с TTL real-time API).
- `error_code` — стабильное короткое имя (`catalog_timeout`, `bad_input`, `transport_5xx`, ...). Эксперт МОЖЕТ ретраить ТОЛЬКО по `error_code ∈ retryable_codes` (см. §3.10).
- Все тулы пишут шаг в `chat_request_logs.steps` (см. §7).

### §3.1 `search_catalog`
**Назначение:** универсальный поиск товаров. Параметризуется «способом поиска».

```ts
input = {
  mode: "by_article" | "by_pagetitle" | "by_query",
  // ровно один из нижеследующих, в зависимости от mode:
  article?: string,         // mode=by_article
  pagetitle?: string,       // mode=by_pagetitle (EXACT product name)
  query?: string,           // mode=by_query (полнотекстовый)
  // опциональные:
  category?: string,        // pagetitle категории
  min_price?: number,
  max_price?: number,
  brand?: string,           // → options[<brand_key>][] под капотом
  options?: Record<string, string[]>, // any facet
  page?: number,            // default 1
  per_page?: number,        // default 10, max 50
  sort_cheapest?: boolean   // → min_price=1 quirk
}

output_ok = {
  ok: true,
  mode: <same>,
  total: number,
  page: number,
  per_page: number,
  results: ProductRef[]    // см. §3.11
}

output_error = {
  ok: false,
  error_code: "catalog_timeout" | "transport_5xx" | "bad_input" | "rate_limited",
  message: string
}
```

**Инварианты:**
- `price=0` отфильтровываются ДО возврата (Hard-Ban §0 core).
- Если `mode=by_pagetitle` нашёл 0 — это легальный `total=0`, не ошибка.
- `query` НЕ обогащается модификаторами внутри тула. Эксперт сам формирует строку.

### §3.2 `expand_search_to_pool`
**Назначение:** обёртка над текущим QFv2 (noun→pool(100)→Self-Bootstrap→options→final). Используется когда `search_catalog` дал 0, или эксперт изначально знает, что нужен «широкий» промпт-зависимый поиск.

```ts
input = {
  noun: string,                       // productNoun
  modifiers: string[],                // токены-ограничители
  price_intent?: "cheapest" | "most_expensive" | null,
  min_price?: number,
  max_price?: number,
  brand?: string
}

output_ok = {
  ok: true,
  total: number,
  results: ProductRef[],
  branch_tag: "qfv2_final" | "qfv2_pool_rescue" | "qfv2_honest_empty" | "qfv2_jargon_recovery",
  applied_facets?: Array<{key, values, alternative_values?: string[]}>, // для honest-empty
}
output_error = { ok: false, error_code, message }
```

**Инварианты:**
- Внутри сохраняются все правила QFv2: Pool Rescue, Honest-Empty, Jargon-Recovery, has_product_name bridge — БЕЗ изменений. v3 их не воспроизводит, а делегирует.
- `branch_tag` пробрасывается обратно эксперту — он решает как сформулировать ответ (например `qfv2_honest_empty` → честно сказать какие фасеты не сработали, предложить `alternative_values`).

### §3.3 `try_jargon_alternatives`
**Назначение:** прямой вызов `tryJargonFallback` когда эксперт сам подозревает жаргон («кукурузная лампа» → «corn lamp»). НЕ обязателен — `expand_search_to_pool` уже включает jargon-recovery внутри QFv2.

```ts
input = { original_query: string, hint_category?: string }
output_ok = { ok: true, candidates: string[] }   // 1-3 альтернативных термина
output_error = { ok: false, error_code, message }
```

### §3.4 `find_accessories_for`
**Назначение:** ветка accessory-for (см. mem://features/accessory-for) как тул.

```ts
input = {
  anchor_product_query: string,  // как клиент назвал якорь
  target_noun: string             // что ищем (напр. «насадки»)
}
output_ok = {
  ok: true,
  anchor: ProductRef | null,
  results: ProductRef[],
  branch_tag: "collection" | "brand_fallback" | "all_fallback" | "incompatible_collection"
}
output_error = { ok: false, error_code, message }
```

**Инвариант:** Family-Guard сохраняется внутри (data-driven пересечение options anchor.options ∩ target.options).

### §3.5 `lookup_knowledge`
**Назначение:** гибридный поиск по `knowledge_entries/knowledge_chunks` (FAQ, доставка, политики, «как выбрать X»).

```ts
input = { query: string, top_k?: number }   // default top_k=5
output_ok = {
  ok: true,
  hits: Array<{ title, snippet, source_url?, type, score }>
}
output_error = { ok: false, error_code, message }
```

**Инвариант:** эксперт МОЖЕТ цитировать `snippet`/`title`, но ссылки выводит только если `source_url` присутствует в hit.

### §3.6 `render_products`
**Назначение:** ЕДИНСТВЕННЫЙ способ показать товары клиенту. Принимает массив `ProductRef.id`, возвращает финальный markdown-блок (BNF §17.3) и параллельно эмитит SSE-событие `products_block` (см. §5).

```ts
input = {
  product_ids: string[],      // максимум 10
  total_available?: number,   // показать «и ещё N» если > product_ids.length
  intro_line?: string         // одна короткая строка-подводка от эксперта; опционально
}
output_ok = {
  ok: true,
  rendered_count: number,
  blocked_by_zero_price: number  // diagnostics
}
output_error = { ok: false, error_code: "no_products" | "all_zero_price", message }
```

**Инварианты:**
- Рендер использует **дословные** `pagetitle`, `url`, `price`, `vendor`, `stock` из последнего `ProductRef`-кэша текущей сессии (см. §3.11). Никаких LLM-перезаписей.
- `price=0` отбрасываются повторно (double-filter).
- Если после фильтра `rendered_count=0` → возвращает `error_code='all_zero_price'`, эксперт должен перейти в `escalate_to_manager` или объяснить пустоту.

### §3.7 `propose_clarification`
**Назначение:** когда эксперт хочет задать структурированный уточняющий вопрос с quick-replies (например выбор фасета). Аналог текущего `price_clarify`/`dialogSlot`.

```ts
input = {
  question: string,                          // одна строка для клиента
  facet_key: string,
  options: Array<{ value: string, label?: string, count?: number }>  // 2-5
}
output_ok = { ok: true, slot_id: string }
output_error = { ok: false, error_code, message }
```

**Эффект:** эмитит SSE `quick_replies` и `slot_update`. Эксперт после этого ОБЯЗАН завершить ход (нельзя задавать вопрос и одновременно показывать товары).

### §3.8 `escalate_to_manager`
**Назначение:** контакт менеджера (Soft-404 финальная стадия).

```ts
input = { reason: "not_found" | "out_of_domain" | "error" | "user_request", note?: string }
output_ok = { ok: true }
output_error = { ok: false, error_code, message }
```

**Эффект:** эмитит SSE `contacts` с реквизитами из `app_settings`.

### §3.9 `note_state`
**Назначение:** служебный — эксперт фиксирует факт для следующего хода в `dialogSlots` (например «клиент попросил китайские бренды» — на следующее сообщение применить).

```ts
input = { key: string, value: string | number | boolean | null, ttl_turns?: number }
output_ok = { ok: true }
```

### §3.10 Retry-policy
- `retryable_codes = ["catalog_timeout", "transport_5xx", "rate_limited"]`.
- Эксперт может ретраить ОДИН раз тот же тул с теми же аргументами. Второй раз — должен изменить аргументы или сменить тул.
- Жёсткий лимит на цикл: `stepCountIs(8)` + общий timeout 30с. При исчерпании — эмитим Soft-404 «техническая пауза» и контакт менеджера.

### §3.11 `ProductRef`
Минимальный объект, видимый эксперту:
```ts
ProductRef = {
  id: string,            // стабильный id товара в каталоге
  pagetitle: string,
  vendor: string | null,
  price: number,         // > 0 (price=0 отфильтрованы)
  stock: "in_stock" | "low" | "out" | "unknown",
  short_traits: string[] // 0-5 коротких ключ-значений ("3 жилы", "16 А")
  // НЕТ url, НЕТ image, НЕТ длинного описания — чтобы эксперт не зацитировал
}
```
Полные данные (`url`, `image`, `options[]`) держим **серверно** в `productCache` сессии. `render_products` берёт их оттуда по `id`.

---

## §4 State Machine разговора

```
       ┌─────────────────────────────────────────┐
       │ user message arrived                    │
       └────────────────┬────────────────────────┘
                        ▼
       ┌─────────────────────────────────────────┐
       │ EXPERT_TURN_START                       │
       │ streamText with tools, system + history │
       └────────────────┬────────────────────────┘
                        ▼
              ┌─────────┴─────────┐
              │ stream tokens     │
              │ (text deltas)     │  ← клиент получает live-текст
              └─────────┬─────────┘
                        ▼
             ┌──────────┴──────────┐
             │ tool_call requested?│
             └─┬──────────────┬────┘
               │ yes          │ no (text-only)
               ▼              ▼
   ┌───────────────────┐   ┌─────────────────┐
   │ execute tool      │   │ TURN_END        │
   │ stream tool_event │   │ emit done       │
   │ (status indicator)│   └─────────────────┘
   └────────┬──────────┘
            ▼
   ┌───────────────────────────┐
   │ feed tool_result back to  │
   │ expert; loop continues    │
   └────────┬──────────────────┘
            ▼
   ┌───────────────────┐
   │ if stepCount<8    │ → back to "stream tokens"
   │ else FORCE_END    │ → emit soft-404 + escalate_to_manager
   └───────────────────┘
```

### Допустимые tool-последовательности (примеры контрактов, не сценарии)
- `[search_catalog by_query] → render_products` — happy path
- `[search_catalog by_query=0] → [expand_search_to_pool] → render_products`
- `[search_catalog by_article] → render_products`
- `[lookup_knowledge] → (no render)` — чисто текстовый ответ
- `[find_accessories_for] → render_products`
- `[search_catalog 0] → [try_jargon_alternatives] → [search_catalog with candidate] → render_products`
- `[propose_clarification]` — конец хода, ждём следующее сообщение
- `[escalate_to_manager]` — конец хода
- `[]` (smalltalk/out_of_domain) — text-only

### Запрещённые комбинации
- `render_products` + `propose_clarification` в одном ходе.
- `render_products` без предшествующего `search_catalog`/`expand_search_to_pool`/`find_accessories_for`/`try_jargon_alternatives` в этом ходе (anti-hallucination).
- Эксперт пишет URL/цену в тексте вне `render_products`.

### Force-end условия
- `stepCount >= 8` → forced TURN_END с `escalate_to_manager(reason="error")`.
- Общий timeout 30с → то же.
- Любой не-retryable `error_code` от тула, который эксперт не обработал текстом → forced TURN_END.

---

## §5 SSE-контракт (расширение)

V3 расширяет SSE-формат V1/V2 (`choices[].delta.content`) дополнительными side-каналами. Все сообщения — `event: message; data: <json>\n\n`. Клиент мультиплексирует.

| Событие | Когда | Полезная нагрузка | Поведение клиента |
|---|---|---|---|
| `choices[].delta.content` | при стриме токенов эксперта | OpenAI-style chunk | append к текущему message-bubble |
| `assistant_turn_break` | перед началом нового assistant-сообщения внутри одного хода | `{ reason: "tool_pending" \| "after_render" }` | финализирует текущий bubble, последующие `delta.content` идут в **новый** bubble |
| `tool_event` | вокруг исполнения тула | `{ tool: string, phase: "start" \| "result", duration_ms?: number, summary?: string }` | показать индикатор «<summary>…» (напр. «Ищу в каталоге…»), убрать на `result` |
| `products_block` | при `render_products` | `{ markdown: string, count: number, total_available?: number }` | финализированное assistant-сообщение с карточками, НЕ склеивается с предыдущим |
| `slot_update` | при `note_state` / `propose_clarification` | `{ slots: DialogSlots }` | как в V1 |
| `quick_replies` | при `propose_clarification` | `{ replies: Array<{value,label}> }` | как в V1 |
| `contacts` | при `escalate_to_manager` | `{ html: string }` | как в V1 |
| `followup` | при cross-sell (см. §6) | `{ text: string }` | отдельный bubble через 1с (как в V1) |
| `[DONE]` | конец хода | — | turn complete, разблокировать composer |

### Пример хода (sequence)
```
delta.content("Возьму ")
delta.content("ВВГнг ")
delta.content("2.5 мм² — стандарт для 3 кВт. ")
delta.content("Сейчас гляну, что есть на складе.")
assistant_turn_break {reason:"tool_pending"}
tool_event {tool:"search_catalog", phase:"start", summary:"Ищу в каталоге"}
tool_event {tool:"search_catalog", phase:"result", duration_ms:1840, summary:"Нашёл 23"}
delta.content("Вот три варианта по нашему профилю:")
assistant_turn_break {reason:"after_render"}
products_block {markdown:"- **[...](...)** ...", count:3, total_available:23}
[DONE]
```

Клиент при `assistant_turn_break` или `products_block` финализирует предыдущее сообщение и создаёт новое — итог 2–4 пузыря, как просил пользователь.

---

## §6 Промпт-контракт эксперта

System-prompt состоит из 5 блоков (порядок жёсткий, для anchor-friendly token attribution):

1. **Роль и голос** — «продавец-консультант 220volt.kz, говорит как живой человек, без канцелярита, без приветствий, без эмодзи».
2. **API-словарь** — компактное описание каждого тула (1 строка): когда применять, что вернёт. Подробные JSON-схемы — в `tools=[...]` стандарта tool-calling, не в prompt.
3. **Правила речи** —
   - reasoning-формат (рекомендация + опц. альтернатива + опц. уточнение), уже зафиксировано в shared `expert-first.ts`;
   - запрет цитировать URL/цены вне `render_products`;
   - запрет приветствий;
   - cross-sell — 1-3 предложения, только текст, после `render_products` (опционально).
4. **State machine** — словесная формулировка §4 (когда break, когда end).
5. **Anti-pattern список** — что НЕЛЬЗЯ (примеры запрещённых ходов в формате `BAD:` / `GOOD:`).

### Модель
- `anthropic/claude-sonnet-4.5` через OpenRouter (соответствует mem-правилу LLM via OpenRouter only).
- `temperature: 0.2`, `max_tokens: 1500` на ход (с запасом на цепочки tool-calls).
- `tools=[...]` — JSON-схемы §3.

---

## §7 Логирование и метрики

В `chat_request_logs.steps[]` добавляются записи:

```ts
{ step: "v3_turn_start", ms: 0, meta: { user_message, dialog_slots_in } }
{ step: "v3_tool_call", ms, meta: { tool, input, output_summary, ok, error_code? } }
{ step: "v3_assistant_text", ms, meta: { chars, fragment_index } }  // на каждый assistant_turn_break
{ step: "v3_render", ms, meta: { count, total_available, blocked_zero: n } }
{ step: "v3_turn_end", ms, meta: { reason: "ok"|"forced_stepcount"|"forced_timeout"|"error", step_count } }
```

### Метрики (агрегаты для дашборда `/logs`)
- `v3_turns_total`
- `v3_tool_calls_total{tool}`
- `v3_steps_per_turn` (p50/p95)
- `v3_turn_duration_ms` (p50/p95)
- `v3_forced_end_total{reason}`  — должно быть < 1% турнов
- `v3_zero_price_leak_total` — ОБЯЗАНО быть 0
- `v3_hallucinated_url_total` — детектится post-render diff'ом (см. §8) — ОБЯЗАНО быть 0

---

## §8 Acceptance criteria (gate перед переключением active_pipeline → v3)

### 8.1 Контрактные тесты (Deno test)
- Каждый тул из §3 имеет unit-тест: happy + 2 error paths.
- Mock LLM-реплеи (canned tool_calls JSON) для проверки SSE-последовательности §5.
- Регрессионный набор из 30+ синтетических диалогов (не упоминает реальных категорий) — см. `.lovable/fixtures/v3-dialog-cases/*.jsonl`.

### 8.2 Invariants (runtime assertions)
- `v3_zero_price_leak_total == 0` на 200 последовательных продакшен-запросах.
- `v3_hallucinated_url_total == 0` (post-render: каждый URL в финальном markdown должен присутствовать в `productCache`).
- `v3_forced_end_total / v3_turns_total < 0.01`.

### 8.3 Latency
- `v3_turn_duration_ms p95 < 12s`.
- Time-to-first-token p95 < 2s.

### 8.4 Качество (ручной QA-набор)
- 20 эталонных запросов разной сложности (catalog/price/accessory_for/spec_query/knowledge/smalltalk/out_of_domain), проверка человеком: ход выглядит как живой консультант, товары релевантны, нет двойных приветствий.

---

## §9 Что НЕ входит в V3 (явно отложено)

- Multi-turn клиентских правок reasoning эксперта (фича 3c из обсуждения) — отдельная спека.
- Голосовой/мультимодальный ввод.
- Auto-A/B между v1/v2/v3 — переключение только ручное.
- Каскад моделей (cheaper-for-simple, expensive-for-hard) — на будущее.

---

## §10 План реализации (для последующих коммитов)

Каждый пункт = отдельный коммит, ждёт «давай» от пользователя.

1. **Каркас v3** — `chat-consultant-v3/index.ts` с echo-эспертом (без тулов), SSE-контракт §5 (`assistant_turn_break`, `tool_event`, `products_block`), v3-канал в `chat_request_logs`. Только синтетический ответ. Цель: проверить транспорт.
2. **Тулы R/O** — `search_catalog`, `lookup_knowledge` как обёртки. Эксперт-промпт §6 минимальный. Цель: первый сквозной кейс «catalog by_query → render».
3. **Тул `render_products` + ProductRef-кэш сессии** + post-render anti-hallucination assertion. Цель: invariants 8.2 проходят.
4. **Тулы поиска**: `expand_search_to_pool`, `try_jargon_alternatives`, `find_accessories_for`. Цель: parity с V1 по сложным кейсам.
5. **Тулы диалога**: `propose_clarification`, `escalate_to_manager`, `note_state`. Цель: state-machine §4 закрыта.
6. **Клиент** — `ChatWidget.tsx` + `public/embed.js`: парсинг новых SSE-событий, рендер нескольких пузырей в одном ходе.
7. **QA-набор** §8.4, прогон 20 запросов вручную, разбор логов.
8. **Включение v3** через `UPDATE app_settings SET active_pipeline='v3'` (никакого автоматического переключения).

---

## §11 Открытые вопросы (требуют ответа до коммита #1)

1. **Persistent slots между ходами** — V1 хранит slots в `chat_cache_v2`. V3 наследует ту же таблицу или заводит свою? **Предложение:** наследует, ключ `slot:v3:<sessionId>`.
2. **Cross-sell** — оставляем как в V1 (отдельный followup-SSE после render), или эксперт сам решает добавить text-paragraph? **Предложение:** эксперт сам, в том же ходе после `render_products` (один или два предложения текста). Тогда followup-канал не используется в v3.
3. **Knowledge ответ + товары в одном ходе** — допустимо? Пример: «как выбрать УЗО?» → эксперт отвечает текстом (knowledge), и в конце предлагает посмотреть наш ассортимент (`search_catalog` → `render_products`). **Предложение:** разрешено, ограничение `stepCount<=8` достаточно.
4. **Что с `intro_line` у render_products** — нужно ли вообще? Эксперт уже может стримить текст перед `assistant_turn_break`. **Предложение:** убрать `intro_line`, упрощает контракт.
5. **Confidence-gate перед showing reasoning** — если эксперт не уверен (низкая subj. конфиденс), стоит ли показывать reasoning или сразу задавать `propose_clarification`? **Предложение:** доверяем модели — она и так выберет тул `propose_clarification` если нужно.

---

_End of spec._
