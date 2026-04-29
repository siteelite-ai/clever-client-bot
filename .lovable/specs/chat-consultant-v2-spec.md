# Chat Consultant v2 — Полная спецификация

**Версия документа:** 1.0
**Дата:** 2026-04-28
**Статус:** Draft, ожидает approval перед началом разработки
**Цель:** Полная переписка движка чат-консультанта 220volt.kz с нуля для устранения накопленного технического долга и системных багов v1.

---

## 0. TL;DR

v1 (`chat-consultant`) — монолит, который рос итеративно полгода. Накоплены системные баги: утечка слотов между запросами, грязный query после уточнения категории, избыточная латентность (5-8s на простых запросах), отсутствие явной машины состояний.

v2 (`chat-consultant-v2`) — полная переписка с чистой архитектурой:
- Детерминированная машина состояний
- Модульная структура (8 файлов вместо одного монолита)
- Postgres-кэш probe и intent
- Жёсткий жизненный цикл слотов (явный consume, не таймауты)
- Реалистичный SLA: p50 < 3s SKU, < 6s фильтры

Старый движок остаётся в работе. Переключение через флаг `engine_version` в `app_settings`. Откат — одна кнопка в админке.

**Срок:** ~3 недели, 7 этапов, каждый с отдельным approval.

---

## 1. Анализ v1: что не так (диагноз)

### 1.1 Системные баги из логов

| Баг | Симптом | Корневая причина |
|---|---|---|
| Утечка слотов | Слот «розетки» жил 4 хода и попал в запрос «лампочка» | Закрытие по таймауту, а не по явному consume |
| Грязный query | «чёрные двухгнездовые бытовые» внутри категории «Розетки» → 0 результатов | После выбора опции «бытовые» слово остаётся в поисковой строке |
| Probe latency | 5.7s на запрос «лампочка» (705 товаров) | Нет кэша частых probe-запросов |
| Forced upgrade | Классификатор форсится с flash-lite на flash | Историческое решение, увеличивает latency на ~600ms |
| Pro по умолчанию | Все ответы через `gemini-2.5-pro` | Pro избыточен для коротких ответов с карточками |
| Vector search off | Knowledge ищет только через FTS | Нет Google API key и нет fallback на OpenRouter embeddings |

### 1.2 Архитектурные проблемы

- **Монолит**: классификация, поиск, слоты, knowledge, промпт, стрим — всё в одном файле `index.ts`
- **Скрытое состояние**: слоты хранятся и на клиенте, и на сервере, без явного протокола
- **Нет contract testing**: любая правка может сломать соседний модуль
- **Нет regression suite**: каждый rollout — слепой полёт

### 1.3 Что в v1 работает хорошо (переедет в v2 без изменений)

- API клиент каталога (`getCategoryOptionsSchema`, `searchProductsMulti`)
- Hybrid knowledge search (FTS + vector через RRF)
- GeoIP-определение и регион-логика (KZ/RU)
- Логирование `ai_usage_logs`
- Markdown-формат карточки товара
- Domain Guard логика (penalize telecom vs power -30 pts)
- Option-key alias collapse (`cvet__tүs` ↔ `cvet__tүsі`)
- Volume formula (`Qty * Vol * 1.2` для кабелей)

---

## 2. Цели v2 (приоритеты)

### Must have (без этого нет смысла переписывать)
1. Явная машина состояний с детерминированными переходами
2. Жёсткий жизненный цикл слотов (consume вместо таймаута)
3. Очистка query при выборе опций (никаких «бытовых» в поисковой строке)
4. Postgres-кэш probe (сейчас каждый запрос идёт в API заново)
5. Регрессионный набор из 50 эталонных запросов
6. Детальное логирование каждого перехода для трассировки

### Should have (важно, но не критично для MVP)
7. Параллельная загрузка независимых блоков (geo + knowledge prefetch)
8. Динамический выбор модели (flash-lite для классификации, flash для ответа, pro только при escalation)
9. Снижение системного промпта с 13.9KB до ≤6KB
10. A/B тестирование v1 vs v2 на реальном трафике

### Nice to have (после MVP)
11. Vector search для knowledge (через OpenRouter embeddings)
12. Прогрев кэша топ-50 запросов при деплое
13. Метрики качества (CSAT proxy, click-through по карточкам)

### Non-goals (явно НЕ в v2)
- Sync каталога в локальную БД (запрещено правилом памяти)
- Greetings от бота (запрещено правилом памяти)
- Изменение UI чата
- Изменение `embed.js`
- Изменение схемы knowledge_entries
- Новые AI-провайдеры (только OpenRouter)
- Прямые ключи Google (запрещено правилом памяти)

---

## 3. Архитектура

### 3.1 Структура файлов

```
supabase/functions/
├── chat-consultant/                # v1 — НЕ ТРОГАЕМ
└── chat-consultant-v2/
    ├── index.ts                    # HTTP entry, CORS, auth, error handling
    ├── state-machine.ts            # FSM: routing между этапами
    ├── intent-classifier.ts        # Micro-LLM на flash-lite
    ├── slot-manager.ts             # Создание/матчинг/закрытие слотов
    ├── catalog/
    │   ├── api-client.ts           # 220volt API клиент
    │   ├── search.ts               # Multi-query search + ranking
    │   ├── price-intent.ts         # cheapest/expensive логика
    │   ├── sku-detection.ts        # Regex + правила для артикулов
    │   ├── synonyms.ts             # Генерация синонимов через LLM
    │   ├── domain-guard.ts         # Telecom vs power penalty
    │   ├── replacements.ts         # Логика замен
    │   └── facets.ts               # category_facets с alias collapse
    ├── knowledge/
    │   ├── search.ts               # Hybrid FTS + vector
    │   └── temporal.ts             # valid_from/valid_until фильтр
    ├── conversation/
    │   ├── prompt-builder.ts       # Финальная сборка контекста
    │   ├── greetings-guard.ts      # Перехват и удаление приветствий
    │   ├── cross-sell.ts           # Логика soputstvuyuschiy/fayl
    │   └── escalation.ts           # Триггеры [CONTACT_MANAGER]
    ├── infra/
    │   ├── cache.ts                # Postgres-кэш (probe, intent, search)
    │   ├── geo.ts                  # GeoIP + KZ/RU regions
    │   ├── logger.ts               # Структурированные логи с traceId
    │   └── usage.ts                # ai_usage_logs writer
    ├── types.ts                    # Все TypeScript-контракты
    ├── config.ts                   # Модели, бюджеты, лимиты
    └── __tests__/
        ├── golden.json             # 50 эталонных запросов
        ├── state-machine.test.ts
        ├── slot-manager.test.ts
        └── sku-detection.test.ts
```

### 3.2 Машина состояний (полная)

```
┌─────────────────────────────────────────────────────────────────┐
│                       INCOMING REQUEST                           │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌────────────────────────────────────────────────────────────────┐
│ S0: PRE-PROCESS                                                 │
│   - Strip greetings from user message                           │
│   - Detect language (assume RU)                                 │
│   - Load conversation history (last 8 msgs)                     │
│   - Resolve GeoIP (parallel, non-blocking)                      │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌────────────────────────────────────────────────────────────────┐
│ S1: SLOT RESOLVER                                               │
│   Active slot exists?                                           │
│   ├─ YES → match user input against options                     │
│   │        ├─ MATCH → consume slot, route to S3 with cleaned    │
│   │        │           query (modifiers preserved, option-text  │
│   │        │           removed)                                  │
│   │        └─ NO MATCH → mark slot stale, close it, fall to S2  │
│   └─ NO → S2                                                    │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌────────────────────────────────────────────────────────────────┐
│ S2: INTENT CLASSIFIER (flash-lite, ≤500ms budget)               │
│   Returns JSON:                                                 │
│   {                                                             │
│     intent: 'catalog' | 'knowledge' | 'contact' |              │
│             'escalation' | 'smalltalk' | 'greeting',           │
│     has_sku: boolean,                                          │
│     sku_candidate: string | null,                              │
│     price_intent: 'cheapest' | 'expensive' | 'range' | null,   │
│     category_hint: string | null,                              │
│     search_modifiers: string[],                                │
│     critical_modifiers: string[],                              │
│     is_replacement: boolean,                                   │
│     domain_check: 'in_domain' | 'out_of_domain' | 'ambiguous'  │
│   }                                                             │
│   Cached in Postgres for 24h by query_hash.                    │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌────────────────────────────────────────────────────────────────┐
│ S3: ROUTING                                                     │
│                                                                 │
│   greeting     → S_GREETING (silent ack, no greeting back)     │
│   smalltalk    → S_PERSONA (short expert-seller reply)         │
│   contact      → S_CONTACT (load contacts, format card)        │
│   knowledge    → S_KNOWLEDGE                                    │
│   escalation   → S_ESCALATION ([CONTACT_MANAGER] block)        │
│   catalog      → S_CATALOG                                     │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌────────────────────────────────────────────────────────────────┐
│ S_CATALOG (детальная схема)                                     │
│                                                                 │
│   1. Domain check (out_of_domain → soft 404 + suggest alt)     │
│   2. has_sku?                                                   │
│      ├─ YES → SKU direct fetch (target <2s)                    │
│      │        ├─ FOUND → format card, S_OUTPUT                 │
│      │        └─ NOT FOUND → soft 404 + nearest matches        │
│      └─ NO → continue                                          │
│   3. is_replacement?                                            │
│      └─ YES → extract traits, multi-query, LLM-compare         │
│   4. price_intent?                                              │
│      └─ YES → probe with cache                                 │
│         ├─ total ≤ 7 → fetch all, sort, output                 │
│         ├─ 7 < total ≤ 50 → fetch top, sort, show top 3       │
│         └─ total > 50 → CREATE CLARIFY SLOT, ask to narrow     │
│   5. category_hint + modifiers?                                 │
│      └─ Multi-bucket search (category-first branch from v1)    │
│         ├─ resolveFiltersWithLLM per bucket                    │
│         ├─ if multiple buckets → CREATE DISAMBIG SLOT          │
│         └─ if one bucket → output                              │
│   6. Free text search → multi-query, rank, output              │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌────────────────────────────────────────────────────────────────┐
│ S_OUTPUT (Prompt Builder + Streaming)                           │
│   - Build minimal context: system_prompt + knowledge?          │
│     + products + contacts? + history (8 msgs trimmed)          │
│   - Total budget: ≤6000 tokens IN, ≤800 tokens OUT             │
│   - Stream via OpenRouter Gemini Flash                         │
│   - Strip <think> blocks, strip greetings on output            │
│   - Log usage to ai_usage_logs                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 Контракты данных (TypeScript)

```typescript
// ─── Slot ───────────────────────────────────────────────────
export type SlotType =
  | 'category_disambiguation'   // выбор между похожими категориями
  | 'price_clarify'             // сужение перед сортировкой по цене
  | 'replacement_offer'         // выбор замены
  | 'contact_collect';          // сбор контактов для эскалации

export interface SlotOption {
  label: string;                // что показываем пользователю
  value: string;                // что подставляем во внутреннюю логику
  payload?: Record<string, unknown>; // для category_disambiguation: pagetitle, categoryId
}

export interface Slot {
  id: string;                   // slot_<timestamp>_<rand>
  type: SlotType;
  created_at: number;           // unix ms
  expires_at: number;           // hard TTL: created_at + 5*60*1000
  ttl_turns: number;            // 2 хода без матча → close
  turns_since_created: number;  // инкрементируется на каждом запросе

  options: SlotOption[];
  pending_query: string;        // оригинальный запрос пользователя
  pending_modifiers: string[];  // модификаторы вне категории
  pending_filters: Record<string, string[]> | null; // уже выбранные фильтры

  consumed: boolean;            // true → удалить из state
  closed_reason?: 'matched' | 'no_match' | 'ttl_turns' | 'ttl_time' | 'new_intent';
}

// ─── SlotState (катящееся состояние ветки, §5.6) ────────────
// Не путать со Slot (вопрос-уточнение). SlotState — счётчики ветки,
// живут между ходами в ConversationState. Поля data-agnostic.
export interface SlotState {
  soft404_streak: 0 | 1 | 2;    // §5.6 state-machine: 0→1→2 → CONTACT_MANAGER
  // расширяется по мере необходимости (см. §11)
}

// ─── Intent ─────────────────────────────────────────────────
export type IntentType =
  | 'catalog'
  | 'knowledge'
  | 'contact'
  | 'escalation'
  | 'smalltalk'
  | 'greeting';

export interface Intent {
  intent: IntentType;
  has_sku: boolean;
  sku_candidate: string | null;
  price_intent: 'cheapest' | 'expensive' | 'range' | null;
  price_range?: { min?: number; max?: number };
  category_hint: string | null;
  search_modifiers: string[];
  critical_modifiers: string[];
  is_replacement: boolean;
  domain_check: 'in_domain' | 'out_of_domain' | 'ambiguous';
}

// ─── Product (упрощённая карточка) ──────────────────────────
export interface Product {
  id: number;
  name: string;
  url: string;
  price: number;
  currency: 'KZT';
  brand: string | null;
  sku: string | null;
  category_path: { name: string; url: string }[];
  warehouses: { city: string; qty: number }[];
  soputstvuyuschiy?: string[];  // SKU сопутствующих
  fayl?: string[];              // PDF/файлы
}

// ─── ConversationState (передаётся клиентом) ────────────────
export interface ConversationState {
  conversation_id: string;
  slots: Slot[];                // активные слоты, max 3
  slot_state: SlotState;        // катящиеся счётчики ветки (§5.6)
  last_intent?: IntentType;
  last_category_hint?: string;
  user_city?: string;
  user_country?: string;
}

// ─── ChatRequest / ChatResponse ─────────────────────────────
export interface ChatRequest {
  message: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  state: ConversationState;
  client_meta: {
    ip?: string;
    user_agent?: string;
    referer?: string;
  };
}

export interface ChatResponseSSE {
  // SSE stream events:
  // event: slot_update     data: { slots: Slot[] }
  // event: thinking        data: { phrase: string }
  // event: chunk           data: { delta: string }
  // event: done            data: { usage: {...}, traceId: string }
  // event: error           data: { code: string, message: string }
}
```

---

## 4. Поисковая логика (детально)

### 4.1 SKU Detection

```typescript
const SKU_REGEX = /\b([A-Z]{1,4}[-/]?\d{2,}[-/]?[A-Z0-9]*|[А-Я]{1,4}[-/]?\d{2,}[-/]?[А-Я0-9]*|\d{4,}[A-Za-z]?)\b/i;

function detectSKU(message: string): { isSku: boolean; sku: string | null } {
  const cleaned = message.trim();
  // 1. Если сообщение состоит почти только из артикула
  if (cleaned.length < 30 && SKU_REGEX.test(cleaned)) {
    return { isSku: true, sku: cleaned.match(SKU_REGEX)![0] };
  }
  // 2. Если есть явный маркер: "артикул XXX", "код XXX"
  const marker = cleaned.match(/(?:артикул|код|sku|арт\.?)\s*([A-Z0-9А-Я-/]+)/i);
  if (marker) return { isSku: true, sku: marker[1] };
  return { isSku: false, sku: null };
}
```

Подтверждается через micro-LLM (`has_sku: true`). Если LLM и regex расходятся — приоритет regex.

### 4.2 Synonyms

- Генерация — **один раз** через `gemini-2.5-flash-lite` с детерминированным сэмплингом (`top_k=1, seed=42`)
- Кэшируется в Postgres на 24 часа по `query_hash`
- Максимум 4 варианта (не 8 как в v1)
- Если кэш есть — без LLM, чистая выборка

```typescript
async function getSynonyms(query: string): Promise<string[]> {
  const cached = await cache.get(`syn:${hash(query)}`);
  if (cached) return cached;

  const variants = await llmCall({
    model: 'google/gemini-2.5-flash-lite',
    system: SYNONYMS_PROMPT,
    user: query,
    maxTokens: 100,
    temperature: 0,
  });

  const result = parseSynonyms(variants).slice(0, 4);
  await cache.set(`syn:${hash(query)}`, result, 86400);
  return result;
}
```

### 4.3 Ranking (формула)

После multi-query поиска все товары ранжируются единой формулой:

```
score = 0.5 * relevance_score          // позиция в API-ответе (1.0 для первого)
      + 0.2 * city_availability_bonus  // 1.0 если есть в городе пользователя
      + 0.15 * stock_bonus             // 1.0 если total_qty > 10
      + 0.1 * price_match_bonus        // 1.0 если попадает в price_range
      + 0.05 * brand_diversity         // штраф за повтор бренда
```

Domain Guard penalty применяется ПОСЛЕ ranking:
- `-0.30` если категория содержит TELECOM_KEYWORDS, а запрос про power
- `-0.30` обратно

### 4.4 Price Intent

Пороги уточнения:
- `total ≤ 7` → показать все, отсортировать
- `7 < total ≤ 50` → показать top 3 + "всего N товаров", без слота
- `total > 50` → создать `price_clarify` слот с топ-5 категорий из API facets

Сортировка: `cheapest` → `ASC by price`, `expensive` → `DESC by price`. Локальная сортировка после fetch (API не гарантирует порядок).

### 4.5 Category-First Branch (из v1)

Без изменений: parallel category + query search → bucketize → resolveFiltersWithLLM per bucket → pick best. Малые buckets (<10) автоматически расширяются дополнительным API-вызовом.

### 4.6 Similar / Replacement Branch

Единая ветка для запросов «аналог / замена / похожий товар». Терминологически
объединяет понятия Replacement (замена снятого с производства) и Similar
(похожий по характеристикам) — это **один концепт, одна ветка, одно имя
модуля `s-similar.ts`**. Cross-sell для этой ветки **запрещён всегда**
(`disallowCrosssell=true`, см. §11.5).

#### 4.6.1 Trigger (state-machine, нормативно)

Ветка активируется в `s3-router` тогда и только тогда, когда выполнено ВСЁ:

```
intent.intent === 'catalog'
  AND intent.is_replacement === true
  AND intent.domain_check !== 'out_of_domain'
  AND intent.price_intent === null
```

Приоритет в роутере: `S_CATALOG_OOD` > `S_PRICE` > `S_SIMILAR` > `S_CATALOG`.
Никаких авто-эскалаций в similar (например, из Soft-404) — это нарушило бы
инвариант «Bot NEVER self-narrows funnel» (Core Memory).

#### 4.6.2 Anchor Resolution (детерминированно, в порядке приоритета)

```
1. anchor_sku   ← intent.sku_candidate            (если has_sku === true)
2. anchor_sku   ← state.last_shown_product_sku    (если бот в предыдущем
                                                    ходе показал ровно одну
                                                    карточку)
3. action       ← 'clarify_anchor'                (иначе)
```

`last_shown_product_sku` — новое опциональное поле `ConversationState`,
выставляется композером при `scenario='normal' AND products.length === 1`.
Используется ИСКЛЮЧИТЕЛЬНО similar-веткой; не влияет на другие ветки.

При `action='clarify_anchor'` ветка возвращает один уточняющий вопрос
(«Подскажите артикул или название товара, к которому подобрать аналог»)
и НЕ создаёт slot — это разовый вопрос, а не facet-уточнение.

#### 4.6.2.1 Anchor Lifecycle (нормативно)

Полный жизненный цикл `state.last_shown_product_sku` определяется
детерминированной функцией от результата текущего хода. Реализация:
`anchor-tracker.ts::computeNextAnchor`. Caller вызывает её ровно один
раз — после композера, перед формированием SSE `done`-события.

```
WRITE     ← composerOutcome.outcome.products[0].article
            WHEN composerOutcome.kind ∈ {'search','price'}
             AND scenario === 'normal'
             AND products.length === 1
             AND products[0].article != null

PRESERVE  ← prev
            WHEN composerOutcome === null  (lightweight-ветка:
                 greeting / knowledge / contacts / escalation / OOD-shortcut)

RESET     ← null
            WHEN scenario != 'normal'
                 (soft_fallback / soft_404 / all_zero_price / error / clarify)
             ИЛИ products.length !== 1
                 (включая 0 и >1)
             ИЛИ products[0].article отсутствует
```

Обоснование (§4.6.2 + Core Memory «Bot NEVER self-narrows funnel»):
- При `products.length > 1` референт «похожие на это» неоднозначен.
  Записать `products[0]` = молчаливо угадать выбор пользователя.
  Корректный путь — `clarify_anchor` в s-similar на следующем ходу.
- `scenario='soft_fallback'` означает дрейф (мы сняли facet-ограничение).
  Делать дрейфовавший товар якорем = усугубить дрейф в следующем «похожие».
- Lightweight-ветки не меняют каталоговый контекст → якорь сохраняется
  через всю not-catalog паузу (юзер может вернуться к диалогу).

State-machine тесты: `anchor-tracker_test.ts` (10 кейсов, покрывают все
ветви WRITE/PRESERVE/RESET).

#### 4.6.3 `classify_traits` Tool Calling Contract

Структурный экстрактор характеристик якоря. Вызывается через OpenRouter
tool calling (Gemini), `tool_choice` = принудительный.

**JSON Schema (нормативно):**

```json
{
  "name": "classify_traits",
  "description": "Extract structured traits from the anchor product to drive similarity search.",
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "required": ["category_pagetitle", "traits"],
    "properties": {
      "category_pagetitle": {
        "type": "string",
        "minLength": 1,
        "description": "Pagetitle of the anchor's category (resolved via Catalog API)."
      },
      "traits": {
        "type": "array",
        "minItems": 1,
        "maxItems": 8,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["key", "value", "weight"],
          "properties": {
            "key":    { "type": "string", "minLength": 1 },
            "value":  { "type": "string", "minLength": 1 },
            "weight": { "type": "string", "enum": ["must", "should", "nice"] }
          }
        }
      }
    }
  }
}
```

Маппинг weight → search behaviour (детерминированно):
- `must`   → жёсткий фильтр в Catalog Search (`filter[<facetKey>]=<value>`).
  Если по `must` не нашлось ни одного товара → degrade: понизить
  младший по порядку `must` до `should` и повторить (max 2 итерации).
- `should` → soft scoring при ranking (бонус +0.10 за каждый матч).
- `nice`   → информативно, не влияет на поиск (используется в карточке
  «Рекомендую X, потому что …»).

**Ключи `key` / `value`** обязаны мапиться на реальные facets из
`getCategoryOptionsSchema` через `facet-matcher.ts` (тот же модуль, что
используется в основном поиске). Несматчившиеся traits **молча
отбрасываются** (zero-config, no whitelists — §0).

#### 4.6.4 Алгоритм ветки (E2E)

```
1. Resolve anchor             →  anchor_sku | clarify_anchor
2. Fetch anchor product       →  Catalog API getProduct(anchor_sku)
3. Resolve category           →  Category Resolver (live API only)
4. Fetch category options     →  getCategoryOptionsSchema(categoryId)
5. classify_traits (LLM tool) →  {category_pagetitle, traits[]}
6. Match traits → facets      →  facet-matcher (must/should/nice split)
7. Strict Search Multi-Attempt with must-filters
   (degrade must→should on zero-result, max 2 iterations)
8. Word-boundary post-filter (общий с §4.3)
9. Rank: base score + 0.10 × matched_should_traits
10. Top-3 + composer scenario='similar'
    disallowCrosssell = true (всегда)
```

Если шаг 2 вернул `null` (SKU не существует) → composer scenario =
`'all_zero_price'` ветви аналог: `scenario='similar_anchor_not_found'` +
`contactManager=true` (§5.6.1 path B).

#### 4.6.5 Инварианты (нормативно, проверяются тестами)

- **INV-S1:** ровно один вызов `classify_traits` за один ход similar-ветки.
- **INV-S2:** `disallowCrosssell === true` всегда, без исключений.
- **INV-S3:** при отсутствии anchor НЕ создаётся slot — только разовый
  `clarify_anchor` ответ (slot-state не меняется).
- **INV-S4:** `auto_narrowing_attempts_total` не растёт от similar-ветки
  (degrade must→should — это recovery, не narrowing).
- **INV-S5:** ноль hardcoded категорий/traits в коде ветки (data-agnostic).

### 4.7 Domain Guard

Список доменов и keywords хранится в `config.ts`:

```typescript
export const DOMAIN_KEYWORDS = {
  POWER: ['розетка', 'выключатель', 'кабель', 'провод', 'лампа', ...],
  TELECOM: ['rj45', 'utp', 'патч-корд', 'оптоволокно', 'витая пара', ...],
  AUTO: ['шина', 'покрышка', 'аккумулятор автомобильный', ...],
  HOUSEHOLD: ['посуда', 'мебель', 'одежда', ...],
};

export const ALLOWED_DOMAINS: Domain[] = ['POWER', 'TELECOM', 'TOOLS', 'LIGHTING', ...];
```

Если запрос явно вне `ALLOWED_DOMAINS` → `intent.domain_check = 'out_of_domain'` → `S_CATALOG` сразу возвращает soft 404 без вызова API.

### 4.8 Soft Fallback

Если 0 результатов после strict-поиска с фасет-фильтрами:
1. Снять последний применённый фасет-фильтр (`droppedFacetCaption` — человекочитаемое имя фасета).
2. Повторить запрос без этого фильтра.
3. Если ≥1 товар → status=`soft_fallback`, в `SearchOutcome.softFallbackContext.droppedFacetCaption` записывается имя снятого фасета.
4. Если снова 0 → status=`empty`, soft404 state-machine инкрементится (§5.6.1).
5. Никогда не «молча» отбрасывать модификаторы — композер обязан показать tail-line с упоминанием снятого фасета.

#### 4.8.1 Контракт `softFallbackContext` (инвариант для Soft Fallback)

Поле `SearchOutcome.softFallbackContext`:

| Поле | Тип | Семантика |
|---|---|---|
| `droppedFacetCaption` | `string` | Человекочитаемое имя фасета, который был снят (UI-caption из `RawOption.caption`, не raw-key). НЕ пусто, НЕ data-agnostic-нарушение, т.к. caption приходит из живого API. |

Заполнение:
- Только при `status === 'soft_fallback'`.
- При других статусах поле = `null`.

Использование композером (§5.4.1, §11.2a-rev): tail-line формируется как
`Если важно уточнить *<droppedFacetCaption>* — напишите.`
(маркер курсива `*…*` обязателен, текст-обвязка — фиксированный шаблон).

---

## 5. Conversational Rules

### 5.1 Persona (зашитый системный промпт)

Эксперт-продавец сети 220volt.kz с 10-летним опытом. Профессиональный тон, без восклицательных знаков, без эмодзи. Обращение на «вы». Краткость: 2-4 предложения + карточки товаров.

### 5.2 Greetings Guard (двухуровневая защита)

**Уровень 1 — на входе** (от пользователя):
- Регексп срезает «здравствуйте», «добрый день», «привет» в начале сообщения
- Если после срезания осталось <3 символов → перехватываем без вызова LLM, отвечаем шаблоном «Что вас интересует?»

**Уровень 2 — на выходе** (от бота):
- Регексп проверяет первые 100 символов ответа
- Если содержит приветственные паттерны → вырезаем
- Логируем как `[GreetingsGuard] stripped: "..."`

### 5.3 Markdown Format (строго)

```
**[Название товара](https://220volt.kz/url)** — *123 456* ₸, БрендName
```

- Никакого backslash-escaping в названиях
- Скобки в URL кодируются как `%28`, `%29`
- Цена выделена курсивом для визуального акцента
- Между ценой и брендом — запятая, не «—» (не путать с разделителем после URL)
- Бренд опционален; если нет — вырезается с ведущей запятой

### 5.4 Cross-sell

Триггер: в ответе API товара есть непустой `soputstvuyuschiy` (массив SKU) или `fayl` (PDF).

Логика:
- После основной карточки добавить блок «**Может пригодиться:**» с до 3 сопутствующими
- Если есть PDF — отдельная строка «📎 [Документация](url)»
- Никогда не выдумывать сопутствующие товары (если поле пустое — ничего не добавлять)

### 5.5 Stock Display

- Сортировка `warehouses` по городу пользователя (из GeoIP)
- Скрывать склады с `qty == 0`
- Если все склады с нулём → метка «Под заказ» вместо списка
- Формат: «Караганда: 75 шт., Астана: 12 шт.»
- Максимум 3 города в строке (остальное → «и ещё в N городах»)

### 5.6 Escalation Triggers

Бот выводит блок `[CONTACT_MANAGER]` (виджет рендерит контактную карточку) при:

| Триггер | Условие |
|---|---|
| Прямой запрос | «менеджер», «оператор», «связаться», «позвонить» |
| Двойной 0-результат | Подряд 2 запроса с soft 404 в одной сессии |
| Out of domain | `intent.domain_check === 'out_of_domain'` (после soft 404) |
| Сложный технический | LLM `escalation_score > 0.7` (отдельный JSON-запрос на flash-lite) |
| Жалоба | Тональность негативная (детектируется в classifier) |
| Длинная сессия без покупки | >15 turns без клика по карточке (метрика на клиенте) |

#### 5.6.1 Soft 404 state-machine (контракт)

Поле: `ConversationState.slot_state.soft404_streak ∈ {0, 1, 2}`.

Переходы (детерминированные, без LLM):

| Текущее | Событие | Новое | Действие композера |
|---|---|---|---|
| `0` | catalog-ход: `SearchOutcome.status ∈ {empty, empty_degraded}` | `1` | Soft 404 текст: одна короткая фраза + просьба переформулировать. БЕЗ `[CONTACT_MANAGER]`. |
| `1` | следующий catalog-ход: `status ∈ {empty, empty_degraded}` | `2` | Вывести `[CONTACT_MANAGER]`. |
| `2` | следующий catalog-ход: `status ∈ {empty, empty_degraded}` | `2` | clamp; `[CONTACT_MANAGER]` остаётся. |
| `0\|1\|2` | catalog-ход вернул ≥1 товар (`status ∈ {ok, soft_fallback}` И `products.length > 0`) | `0` | Сброс. |
| любое | `intent.domain_check === 'out_of_domain'` | без изменения | Сразу `[CONTACT_MANAGER]`, минуя streak. |
| любое | `intent.intent !== 'catalog'` (knowledge/contact/...) | без изменения | streak не трогаем. |
| любое | `SearchOutcome.status === 'all_zero_price'` | без изменения | Сразу `[CONTACT_MANAGER]`, минуя streak. Без товаров. |
| любое | `SearchOutcome.status === 'error'` (HTTP/timeout/network) | без изменения | Сразу `[CONTACT_MANAGER]`, минуя streak. Инфраструктурный сбой ≠ «ничего нет». |

Инварианты:
1. `soft404_streak` обновляется ровно один раз за catalog-ход, ПОСЛЕ финального счёта товаров (после Recovery и Soft Fallback).
2. Флаг `contactManager` композера выставляется в `true` **двумя независимыми путями**:
   - **через streak**: `nextStreak === 2`
   - **через scenario** (минуя streak): `status ∈ {all_zero_price, error}` ИЛИ `intent.domain_check === 'out_of_domain'`
3. State-machine покрывается тестами `soft404-streak.test.ts` и `s-catalog-composer_test.ts`.

Структура карточки контактов из `mem://features/conversational-rules`:
- WhatsApp (primary)
- Email
- Phone
- Часы работы
- Город пользователя → ближайший филиал

#### 5.4.1 Cross-sell composer-контракт (инвариант разделителя)

Композер S_CATALOG ОБЯЗАН вернуть LLM-стрим в виде двух секций, разделённых детерминированным маркером, согласованным между генератором и парсером:

```
<intro-section>
<MARKER>
<crosssell-section>
```

Требования:
- Маркер — фиксированная строка, заданная в коде; в финальный текст пользователю НЕ попадает (вырезается парсером).
- Карточки товаров (§17.3 BNF в Core Memory) инжектятся `formatter.ts` между intro и cross-sell, НЕ генерируются LLM.
- Cross-sell-секция проходит regex-инварианты §11.5b: запрет цен, SKU, brand-литералов, ссылок, CTA. При нарушении — секция вырезается целиком.
- Конкретное значение маркера — деталь реализации (не фиксируется в спеке, §0 data-agnostic).

##### Контракт входа композера: `disallowCrosssell`

Композер принимает явный флаг `disallowCrosssell: boolean` (часть `ComposeCatalogInput`).
Семантика:

| Сценарий | `disallowCrosssell` | Действие композера |
|---|---|---|
| Обычная товарная выдача (`scenario === 'normal'`) | `false` | Cross-sell разрешён, валидируется по §11.5b. |
| Soft Fallback (`scenario === 'soft_fallback'`) | `true` (внутренне форсится композером) | Cross-sell вырезается всегда, добавляется tail-line §4.8.1. |
| No-results (`scenario ∈ {soft_404, all_zero_price, error}`) | `true` (внутренне форсится композером) | Cross-sell вырезается. Маркер от LLM игнорируется. |
| Similar-ветка (§11.6) | `true` (выставляется оркестратором) | Cross-sell вырезается. Совместимо с правилом «cross-sell для similar НЕ выводится» (Core Memory). |
| Любая другая ветка, где cross-sell нежелателен | `true` (выставляется оркестратором) | Cross-sell вырезается. |

Инвариант: оркестратор ОБЯЗАН выставлять `disallowCrosssell=true` для similar-ветки. Композер ОБЯЗАН считать `disallowCrosssell=true` для всех scenario, кроме `normal`. При двойном источнике запрета (флаг от оркестратора + scenario-правило) приоритет — у запрета (логическое OR).

Метрика `crosssell_invariant_violation_total` инкрементируется при любом срабатывании запрета на cross-sell, который при этом был сгенерирован LLM (для отладки промпта и валидации флагов оркестратора).

---

## 6. Кэширование (Postgres вместо Deno KV)

### 6.1 Решение

Deno KV **недоступен** в Supabase Edge Runtime (только в Deno Deploy). Используем Postgres-таблицу `chat_cache_v2`.

### 6.2 Миграция

```sql
CREATE TABLE public.chat_cache_v2 (
  cache_key TEXT PRIMARY KEY,
  cache_value JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hit_count INT NOT NULL DEFAULT 0
);

CREATE INDEX idx_chat_cache_v2_expires ON public.chat_cache_v2 (expires_at);

-- RLS: только service_role
ALTER TABLE public.chat_cache_v2 ENABLE ROW LEVEL SECURITY;
-- Политики не нужны — доступ только из edge functions через service_role

-- GC: удалять просроченные записи
CREATE OR REPLACE FUNCTION public.gc_chat_cache_v2()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.chat_cache_v2 WHERE expires_at < now();
$$;
```

GC вызывается лениво: 1% запросов запускают `gc_chat_cache_v2()` параллельно с основным flow.

### 6.3 Что кэшируем

| Ключ | TTL | Что хранит |
|---|---|---|
| `probe:<hash>` | 1ч | `{ total: number, sample_skus: string[] }` |
| `intent:<hash>` | 24ч | Полный JSON `Intent` |
| `syn:<hash>` | 24ч | `string[]` синонимов |
| `search:<hash>` | 15м | Топ-20 товаров |
| `facets:<pagetitle>` | 1ч | Схема опций категории |
| `kb:<hash>` | 1ч | Топ-5 knowledge chunks |

### 6.4 Что НЕ кэшируем

- PII пользователя (никогда)
- GeoIP результаты (привязаны к IP)
- Финальный LLM-ответ (он зависит от всего контекста)

### 6.5 Хеш-функция

`hash = sha256(normalize(query) + locale + version_tag).slice(0, 16)`

`normalize` = lowercase + trim + collapse multiple spaces + remove punctuation

`version_tag` инкрементируется при изменении схемы кэша (для invalidation).

---

## 7. Бюджеты и SLA (реалистичные)

### 7.1 Latency targets

| Сценарий | p50 | p95 | Notes |
|---|---|---|---|
| SKU direct fetch (cache hit) | 800ms | 1.5s | Только API + format |
| SKU direct fetch (cache miss) | 2.5s | 4s | + classifier + API |
| Catalog search (cache hit) | 1.2s | 2s | LLM ответ + кэш |
| Catalog search (cache miss) | 4-6s | 9s | + probe + multi-query |
| Knowledge query | 2s | 4s | FTS only пока без vector |
| Greeting/smalltalk | 600ms | 1s | Без LLM, шаблон |

### 7.2 Token budgets

| Блок | Budget | Notes |
|---|---|---|
| System prompt | 1500 | Сейчас 13.9KB, надо ≤1500 токенов |
| Knowledge | 1500 | Top-3 chunks |
| Products | 2500 | До 10 товаров с полными данными |
| Contacts | 500 | Только если intent=contact |
| History | 600 | 8 msgs, агрессивный trim |
| **Total IN** | **≤6000** | |
| **Total OUT** | **≤800** | |

### 7.3 Model selection

| Этап | Модель | Reason |
|---|---|---|
| Intent classifier | `google/gemini-2.5-flash-lite` | Быстро, дёшево, JSON-mode |
| Synonyms | `google/gemini-2.5-flash-lite` | Только при cache miss |
| Replacement comparison | `google/gemini-2.5-flash` | Нужно лучшее понимание |
| Final response | `google/gemini-2.5-flash` | Streaming, основной ответ |
| Escalation detection | `google/gemini-2.5-flash-lite` | Простой score 0-1 |

`gemini-2.5-pro` НЕ используется в v2.

### 7.4 Cost estimate

При средних 5000 in / 600 out на Flash:
- Cost per request: ~$0.001
- При 10K запросов/мес: ~$10/мес
- v1 сейчас: ~$25/мес (из-за pro и forced upgrades)

---

## 8. Роли бота (User Personas Bot Should Serve)

### 8.1 Роли пользователей

| Роль | Поведение | Что бот должен делать |
|---|---|---|
| **Точечный покупатель** | Знает SKU/название | SKU direct fetch, карточка, в 1 клик |
| **Сравниватель** | Знает категорию, выбирает | Multi-bucket, 3 варианта с разницей в цене/характеристиках |
| **Экономный** | «самое дешёвое X» | Price intent + clarify если >50 |
| **Профи** | Технические требования (сечение, мощность) | Парсинг параметров → точный фильтр |
| **Растерянный** | «нужно что-то для дома» | Уточняющие вопросы, не сразу карточки |
| **Информационный** | «как подключить», «гарантия» | Knowledge branch, не каталог |
| **Эскалирующий** | Хочет менеджера | `[CONTACT_MANAGER]` без вопросов |

### 8.2 Тон в зависимости от роли

- **Профи** → терминологичный, краткий, без объяснений базовых вещей
- **Растерянный** → вопросы по очереди, без лавины опций
- **Эскалирующий** → не блокировать, не предлагать «давайте сначала уточним»

Детекция роли — эвристика по первому сообщению сессии (классификатор возвращает `user_persona_hint` опционально).

---

## 9. Пользовательские сценарии (User Journeys)

### 9.1 Сценарий A: Точечный SKU

```
U: "Лампа Б 230-60-2"
B: [intent=catalog, has_sku=true]
   → SKU lookup → найдено
   → Карточка
   "**[Лампа Б 230-60-2](url)** — *108* ₸, САРАНСКИЙ ССЗ
    Артикул: Б 230-60-2
    Караганда: 4800 шт., Астана: 179 шт."
   Время: 1.5s p50
```

### 9.2 Сценарий B: Категория с выбором

```
U: "розетки чёрные двухгнездовые"
B: [intent=catalog, category_hint='розетки', modifiers=['чёрные','двухгнездовые']]
   → category_facets("Розетки") → 3 подкатегории
   → CREATE category_disambiguation slot
   "Уточните, какие розетки вас интересуют:
    • Бытовые для дома
    • Силовые промышленные
    • Блоки с розетками"

U: "бытовые"
B: [Slot S1 active] → match "бытовые" → consume slot
   → query cleaned: "чёрные двухгнездовые" (БЕЗ "бытовые")
   → category="Розетки бытовые" + filters from modifiers
   → Результаты
```

### 9.3 Сценарий C: Цена с уточнением

```
U: "найди самую дешёвую лампочку"
B: [intent=catalog, price_intent=cheapest, category_hint='лампочка']
   → probe: 705 товаров
   → CREATE price_clarify slot
   "В категории 'Лампочки' 705 товаров. Уточните:
    • Светодиодные
    • Накаливания
    • Энергосберегающие
    • Галогенные"

U: "светодиодные"
B: [Slot S2 active] → match → consume
   → query="светодиодная лампочка" cheapest
   → probe: 67 → fetch top 10 → sort → output
```

### 9.4 Сценарий D: Knowledge

```
U: "какая у вас гарантия на электроинструмент"
B: [intent=knowledge]
   → hybrid search → 2 chunks
   → No catalog search
   → Прямой ответ из БЗ
```

### 9.5 Сценарий E: Out of domain

```
U: "автомобильные шины"
B: [intent=catalog, domain_check='out_of_domain']
   → No API call
   "К сожалению, мы не торгуем автомобильными шинами.
    Наш профиль — электротовары.
    Если ищете аккумуляторы для авто — могу подсказать."
```

### 9.6 Сценарий F: Escalation

```
U: "ничего не понимаю, дайте менеджера"
B: [intent=escalation, trigger='direct_request']
   → [CONTACT_MANAGER]
   "Передаю вас менеджеру:
    📱 WhatsApp: +7 XXX
    📧 email@220volt.kz
    📞 +7 XXX
    Часы: 9:00-18:00 (UTC+5)"
```

### 9.7 Сценарий G: Replacement

```
U: "Б 230-60-2 уже не выпускается, что вместо?"
B: [intent=catalog, is_replacement=true]
   → Lookup original → extract traits (E27, 60W, 230V)
   → Multi-query по характеристикам
   → LLM-compare top 5
   "Рекомендую **[Лампа LED A60 9W E27](url)** — *480* ₸
    Это современная замена: тот же цоколь E27, 9W LED ≈ 60W накаливания,
    срок службы в 10 раз больше."
```

---

## 10. План rollout (7 этапов)

| # | Этап | Срок | Deliverable | Approval gate |
|---|---|---|---|---|
| 1 | Спека + миграция + скелет | 2 дня | spec.md, миграции БД, пустые модули, флаг переключения | Спека утверждена |
| 2 | State machine + slots + classifier | 3 дня | Работающие S0-S3 без catalog, тесты | 10/10 unit-тестов проходят |
| 3 | Catalog branch | 4 дня | SKU, price intent, multi-bucket, replacements | 30/50 golden tests |
| 4 | Knowledge + Contact + Escalation | 2 дня | S_KNOWLEDGE, S_CONTACT, S_ESCALATION | 45/50 golden tests |
| 5 | Prompt builder + streaming | 1 день | Полный flow end-to-end | 50/50 golden tests |
| 6 | Параллельный прогон v1 vs v2 | 2 дня | beta_search_runs reports, side-by-side | Качество ≥ v1 |
| 7 | Rollout | 1 день | Тестовый домен → A/B → прод | User approval |

**Итого: 15 рабочих дней (~3 недели)**

Каждый этап завершается:
- Деплоем в preview
- Демо тебе
- Письменным approval перед следующим этапом

---

## 11. Эталонный набор тестов (`golden.json`)

50 запросов, каждый с ожидаемым результатом:

```json
[
  {
    "id": "sku-001",
    "query": "Б 230-60-2",
    "expected": {
      "intent": "catalog",
      "has_sku": true,
      "min_results": 1,
      "max_latency_ms": 2500,
      "must_contain_in_response": ["Б 230-60-2", "₸"]
    }
  },
  {
    "id": "category-disambig-001",
    "query": "розетки чёрные двухгнездовые",
    "expected": {
      "intent": "catalog",
      "creates_slot": "category_disambiguation",
      "slot_options_min": 2
    }
  },
  {
    "id": "out-of-domain-001",
    "query": "автомобильные шины зимние",
    "expected": {
      "intent": "catalog",
      "domain_check": "out_of_domain",
      "no_api_call": true,
      "must_contain_in_response": ["не торгуем"]
    }
  }
  // ... 47 ещё
]
```

Категории тестов:
- 10 SKU lookups
- 10 category searches
- 10 price intents
- 5 replacements
- 5 knowledge queries
- 5 escalations
- 5 out-of-domain

---

## 12. Критерии успешности

### 12.1 Технические (объективные, измеримые)

| Метрика | v1 baseline | v2 target |
|---|---|---|
| p50 latency SKU | 3.5s | <2.5s |
| p50 latency search | 6s | <4s |
| p95 latency search | 12s | <8s |
| Cost per request | $0.0026 | <$0.0012 |
| Cache hit rate | 0% | >40% после прогрева |
| 0-result rate | ~12% | <8% |
| System prompt size | 13.9KB | <6KB |

### 12.2 Качественные (golden tests)

- 50/50 golden tests проходят на v2 (с теми же или лучшими ответами что v1)
- 0 случаев утечки слотов между запросами
- 0 случаев «грязный query → 0 результатов»

### 12.3 Продуктовые (отслеживаются после rollout)

- Click-through rate по карточкам товаров (отслеживать в `embed.js`, новый event)
- Доля сессий с `[CONTACT_MANAGER]` (должна снизиться или остаться на уровне v1)
- Доля сессий >5 turns без покупки (proxy для «бот не помог»)
- Жалобы в чат (ручной мониторинг первые 2 недели)

### 12.4 Критерий полного перехода с v1 на v2

- Все 50 golden tests pass
- 7 дней A/B без жалоб
- Метрики не хуже v1 ни по одному параметру

---

## 13. Риски и митигация

| Риск | Вероятность | Impact | Митигация |
|---|---|---|---|
| Edge cases v1 не перенесены | High | Medium | Golden tests + параллельный прогон |
| Postgres-кэш медленнее KV | Medium | Low | Замер на этапе 2; fallback на in-memory |
| LLM-ответы хуже на flash vs pro | Medium | Medium | A/B на этапе 6, можно вернуть pro для отдельных веток |
| Срок 3 недели → 4-5 недель | High | Low | План разбит на этапы, можно остановиться на любом |
| Регрессия в SKU-поиске | Low | High | Отдельный suite + canary deploy |
| Слот закроется когда не надо | Medium | Medium | Логирование каждого consume + метрика «слотов закрыто/протекло» |
| Domain Guard слишком строгий | Medium | Medium | Whitelist + ручной override через ambiguous |

---

## 14. Откат (Rollback Plan)

### 14.1 Быстрый откат
1. Админка → AI Settings → переключатель `engine_version: v1`
2. Все новые запросы идут на старый движок
3. Активные слоты v2 теряются (acceptable, в худшем случае пользователь повторит запрос)

### 14.2 Полный rollback
1. Установить флаг `v1`
2. Удалить функцию `chat-consultant-v2` (опционально)
3. Удалить миграцию `chat_cache_v2` (опционально, не мешает)

### 14.3 Что нельзя откатить
- Изменения в БД через миграции (только новой миграцией)
- Удаленные данные `chat_cache_v2` (не критично, перенаполнится)

---

## 15. Что НЕ входит в v2 (явный scope)

| Не делаем | Почему |
|---|---|
| Sync каталога в локальную БД | Запрещено правилом памяти |
| Greetings от бота | Запрещено правилом памяти |
| Изменения в `embed.js` | Out of scope, отдельная задача |
| Изменения в UI чата | Out of scope |
| Изменения в knowledge_entries схеме | Не требуется |
| Новые AI-провайдеры | Только OpenRouter |
| Прямые ключи Google | Запрещено правилом памяти |
| Vector search для KB | Перенесено в Phase 2 после MVP |
| Аналитика конверсий | Phase 2 |
| Multi-language (kz, en) | Phase 2 |

---

## 16. Открытые вопросы (требуют решения до этапа 1)

| # | Вопрос | Варианты | Рекомендация |
|---|---|---|---|
| Q1 | Где хранить активные слоты — клиент или сервер? | (a) sessionStorage клиента (b) Postgres conversations | (a) — stateless edge function, проще, текущий подход |
| Q2 | Сохранять ли LLM-ответы в БД? | (a) Нет (b) Да, для последующего анализа | (a) MVP, потом можно добавить |
| Q3 | Прогрев кэша топ-50 запросов? | (a) Сразу при деплое (b) Лениво (c) Cron | (b) для MVP, (c) если нужно |
| Q4 | Streaming или non-streaming? | (a) SSE как сейчас (b) Только finished response | (a) UX лучше |
| Q5 | Сколько слотов max одновременно? | 1, 2, 3 | 2 (price + disambig могут сосуществовать) |
| Q6 | Логирование каждого turn в БД? | (a) Только usage (b) Полные turns | (a) MVP |

---

## 17. Approval Checklist

Перед началом этапа 1 нужно подтвердить:

- [ ] Архитектура (раздел 3) одобрена
- [ ] Контракты данных (раздел 3.3) одобрены
- [ ] Поисковая логика (раздел 4) одобрена
- [ ] Conversational rules (раздел 5) одобрены
- [ ] Кэширование через Postgres (раздел 6) одобрено
- [ ] Бюджеты и SLA (раздел 7) одобрены
- [ ] User journeys (раздел 9) одобрены
- [ ] План rollout (раздел 10) одобрен
- [ ] Критерии успешности (раздел 12) одобрены
- [ ] Открытые вопросы (раздел 16) закрыты

---

## 18. Глоссарий

- **Slot** — открытый вопрос к пользователю с фиксированным набором опций
- **Intent** — намерение пользователя, классифицированное micro-LLM
- **Probe** — лёгкий API-запрос для оценки количества результатов без полной выгрузки
- **Multi-bucket** — параллельные поиски по разным критериям с последующим merge
- **Domain Guard** — защита от поисков вне профиля компании (электротовары)
- **Soft 404** — вежливый ответ «не нашлось» с предложением альтернатив
- **Cross-sell** — предложение сопутствующих товаров из поля `soputstvuyuschiy`
- **Escalation** — передача диалога живому менеджеру через `[CONTACT_MANAGER]`
- **Golden tests** — эталонный набор регрессионных тестов
- **Consume slot** — явное закрытие слота после успешного матча

---

**Конец документа.**
