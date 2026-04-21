

# Архитектурный аудит v2 + полный прогон пользовательского сценария

## Часть 1. Аудит фикса через корректность Micro-LLM

### Scope аудита (все pipeline'ы проекта)

| Pipeline / модуль | Затрагивается? | Комментарий |
|---|---|---|
| Article-first (точный артикул) | Нет | Ветка отрабатывает до classifier, новые поля игнорируются |
| Name-first (`has_product_name=true`, `is_replacement=false`) | Нет | Short-circuit на найденном товаре, до STAGE 2 не доходит |
| Category-first | **Да** | Основная цель фикса |
| Replacement (`is_replacement=true`) | **Да** | Симметрия фикса в STAGE 3 |
| Knowledge / RAG / FAQ | Нет | Отдельный pipeline, classifier-output не читает |
| Cross-sell / promotion bucket | Нет | Пост-обработка после STAGE 2, читает только финальный список |
| Persona / greetings ban / markdown | Нет | System prompt основной модели не трогаем |
| Widget / SSE / embed.js | Нет | Фронт |
| `prioritizeBuckets` | Переиспользуется | Уже считает `priority=2` для корневого матча |

### Проверка каждого изменения

**Изменение 1 (classifier: `critical_modifiers`)**
- Риск: classifier может ошибаться в разметке критичности
- Митигация: примеры в prompt покрывают 3 кейса (категоричный / «примерно» / без модификаторов); fallback — если поле отсутствует, считаем все modifiers критичными (безопасное поведение по умолчанию)
- Регрессия в других pipeline'ах: нулевая, поле опциональное и читается только в category-first/replacement

**Изменение 2 (`resolveFiltersWithLLM`: `is_critical` per-resolved)**
- Риск: изменение JSON-схемы ответа сломает текущих читателей
- Митигация: pipeline-парсер делает `typeof resolved[key] === 'object' ? resolved[key].value : resolved[key]` — обратно-совместимо
- Регрессия: нулевая

**Изменение 3 (STAGE 2 query suppression)**
- Риск: потеря бренда/серии в title-поиске
- Митигация: условие срабатывает ТОЛЬКО при `unresolvedMods.length === 0`. Бренд/серия, которых нет в схеме options, остаются в unresolved → попадают в query
- Регрессия: «розетка legrand белая» → `legrand` в unresolved, query=«legrand», options[cvet]=белый — корректно

**Изменение 4 (relaxed-fallback по `is_critical`)**
- Риск: переблокировка полезного relaxed для лампочек/проводов
- Митигация: `is_critical` решает LLM на основе `critical_modifiers` от classifier'а, который учитывает «примерно»/«около»/«желательно»
- Регрессия: «лампочка примерно 9 ватт E27» → classifier пометит E27 critical, мощность нет → relaxed по мощности РАЗРЕШЁН

**Изменение 5 (fallback на bucket-2 с priority=2)**
- Риск: показ товаров из чужой категории
- Митигация: используем существующий `priority=2` из `prioritizeBuckets` (корневой матч с `classifier.category`). Bucket с priority=1 НЕ берём
- Регрессия: «розетка» → bucket-2 «Рамки» имеет priority=1 (нет корневого матча «розетк»), не возьмём

**Изменение 6 (логи)** — нулевой риск

### Итоговые риски

| Риск | Вероятность | Тяжесть | Митигация |
|---|---|---|---|
| Classifier неверно разметит критичность | Средняя | Низкая | Default = всё критично; deploy-after-canary |
| JSON-схема LLM-ответа сломает парсер | Низкая | Высокая | Обратно-совместимый парсер `typeof === 'object'` |
| Latency +200ms на повторный resolveFiltersWithLLM для bucket-2 | Высокая | Низкая | Только при STAGE 2 = 0, т.е. редкий путь |
| Юзер увидит no_match вместо relaxed | Средняя | Средняя | Это **желаемое** поведение для критичных атрибутов; сообщение содержит CTA на оператора |

**Вердикт архитектора: можно деплоить.** Все митигации встроены в дизайн, хардкод-списков нет, все решения принимает Micro-LLM, обратная совместимость сохранена.

---

## Часть 2. Полный прогон пользовательского сценария

### Сценарий: «нужна черная двухместная розетка»

```text
┌─────────────────────────────────────────────────────────────┐
│ 1. ВИДЖЕТ (frontend, ChatWidget.tsx)                        │
│    Юзер вводит "нужна черная двухместная розетка"           │
│    POST /functions/v1/chat-consultant                       │
│    body: { messages: [...history, {role:"user", content}] } │
└────────────────────────┬────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. EDGE FUNCTION chat-consultant (entry point)              │
│    - Достаёт user_message                                   │
│    - Проверяет greeting/knowledge интенты                   │
│    - Вызывает Micro-LLM Classifier                          │
└────────────────────────┬────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. MICRO-LLM CLASSIFIER (новый prompt, измен. 1)            │
│    Вход:  "нужна черная двухместная розетка"                │
│    Выход: {                                                 │
│      "category": "розетка",                                 │
│      "search_modifiers": ["черная","двухместная"],          │
│      "critical_modifiers": ["черная","двухместная"], ← НОВОЕ│
│      "is_replacement": false,                               │
│      "has_product_name": false                              │
│    }                                                        │
│    Лог: [Chat] Classifier critical_modifiers: [черная,...] │
└────────────────────────┬────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. CATEGORY-FIRST PIPELINE                                  │
│    a) 2 параллельных запроса к 220volt API:                 │
│       GET /products?category=розетки&per_page=50            │
│       GET /products?query=розетка&per_page=50               │
│    b) Merge → 77 уникальных товаров                         │
│    c) Бакетизация по category из товара:                    │
│       Розетки:26, Розетки силовые:24, Рамки:9, ...          │
│    d) prioritizeBuckets → "Розетки"(p=2,26),                │
│                          "Розетки силовые"(p=2,24),         │
│                          "Рамки"(p=1,9)                     │
└────────────────────────┬────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. ДЛЯ КАЖДОГО ТОП-5 БАКЕТА: Schema → resolveFiltersWithLLM │
│    Bucket "Розетки" (26):                                   │
│      Schema: cvet={белый,кремовый,бежевый}, kol_razyemov={1,2}│
│      Micro-LLM (измен. 2) получает:                         │
│        - modifiers: [черная,двухместная]                    │
│        - critical_modifiers: [черная,двухместная]           │
│        - schema: {...}                                      │
│      Возвращает: {                                          │
│        resolved: {                                          │
│          kol_razyemov: {value:"2", is_critical:true,        │
│                         source_modifier:"двухместная"}      │
│        },                                                   │
│        unresolved: ["черная"] ← цвета нет в schema          │
│      }                                                      │
│                                                             │
│    Bucket "Розетки силовые" (24):                           │
│      Schema: cvet={красный,белый,синий,чёрный},             │
│              kol_polyusov={2,3,4,5}                         │
│      Возвращает: {                                          │
│        resolved: {                                          │
│          cvet: {value:"чёрный", is_critical:true,           │
│                 source_modifier:"черная"},                  │
│          kol_polyusov: {value:"2", is_critical:true,        │
│                         source_modifier:"двухместная"}      │
│        },                                                   │
│        unresolved: []                                       │
│      }                                                      │
│    Лог: [FilterLLM] Resolved with criticality: {...}        │
└────────────────────────┬────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ 6. ВЫБОР ПОБЕДИВШЕГО БАКЕТА                                 │
│    Сортировка по resolved-count, при равенстве — по priority│
│    Победитель: "Розетки силовые" (resolved 2/2)             │
└────────────────────────┬────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ 7. STAGE 2 — точный API-запрос (измен. 3)                   │
│    Условие: unresolved.length===0 && resolved.length>0      │
│    → query SUPPRESSED                                       │
│    GET /products                                            │
│      ?category=Розетки силовые                              │
│      &options[cvet]=чёрный                                  │
│      &options[kol_polyusov]=2                               │
│      (НЕТ &query=черная — это и был баг!)                   │
│    Лог: [Chat] STAGE 2 query suppressed (LLM resolved all)  │
└────────────────────────┬────────────────────────────────────┘
                         ▼
              ┌──────────┴──────────┐
              │  Результат: N > 0?  │
              └──────────┬──────────┘
                  ┌──────┴──────┐
                ДА│             │НЕТ (=0)
                  ▼             ▼
        ┌─────────────┐  ┌────────────────────────────────────┐
        │ Возврат     │  │ 8. FALLBACK на bucket-2 (измен. 5) │
        │ N товаров   │  │   Берём след. bucket из sortedBuck.│
        │ юзеру       │  │   с priority=2 → "Розетки"(быт)    │
        └─────────────┘  │   Повторно resolveFiltersWithLLM   │
                         │   на расширенной schema того бакета│
                         │   STAGE 2 на нём                   │
                         │   Лог: STAGE 2 fallback to bucket-2│
                         └──────────┬─────────────────────────┘
                                    ▼
                          ┌─────────┴─────────┐
                          │ Bucket-2: N > 0?  │
                          └─────────┬─────────┘
                              ┌─────┴─────┐
                            ДА│           │НЕТ
                              ▼           ▼
                       ┌──────────┐ ┌─────────────────────────┐
                       │ Возврат  │ │ 9. RELAXED по is_critical│
                       │ юзеру    │ │    (измен. 4)           │
                       └──────────┘ │  Пробуем дроп НЕ-крит.  │
                                    │  атрибутов              │
                                    │  Все критичные? → НЕТ   │
                                    │  релакса                │
                                    │  Лог: Relaxed BLOCKED   │
                                    │       (critical: cvet)  │
                                    └────────┬────────────────┘
                                             ▼
                                    ┌────────────────────────┐
                                    │ 10. NO_MATCH ответ:    │
                                    │ "По вашим точным       │
                                    │ параметрам не нашлось. │
                                    │ Уточните или нажмите   │
                                    │ кнопку оператора."     │
                                    └────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ 11. ОСНОВНАЯ МОДЕЛЬ (Gemini 2.5 Pro)                        │
│     Получает контекст: { products: [...], user_query: ...}  │
│     Применяет persona / markdown / cross-sell rules         │
│     Стримит ответ через SSE → виджет                        │
└────────────────────────┬────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ 12. ВИДЖЕТ рендерит markdown с продуктами                   │
└─────────────────────────────────────────────────────────────┘
```

### Ключевые точки контроля для пользователя

| Шаг | Что должно произойти | Лог-маркер для проверки |
|---|---|---|
| 3 | Classifier вернул `critical_modifiers` непустым | `[Chat] Classifier critical_modifiers:` |
| 5 | LLM пометила resolved-фильтры `is_critical=true` | `[FilterLLM] Resolved with criticality:` |
| 7 | STAGE 2 НЕ содержит `query=черная` | `[Chat] STAGE 2 query suppressed` |
| 8 | Если 0 — пробуем bucket-2 ДО relaxed | `[Chat] STAGE 2 fallback to bucket-2:` |
| 9 | Relaxed заблокирован, если дропнул бы критичный | `[Chat] Relaxed BLOCKED (critical: ...)` |
| 10 | Юзер видит честный no_match, а не мусор | Финальное сообщение с CTA |

---

## Часть 3. Что внедряем (финальный список)

**Файл:** `supabase/functions/chat-consultant/index.ts`

1. Classifier prompt (~615–683): добавить поле `critical_modifiers` в JSON-схему + 3 примера в инструкции
2. `resolveFiltersWithLLM` prompt (~2200): принимать `critical_modifiers` на входе, возвращать `resolved[key] = {value, is_critical, source_modifier}`
3. Парсер ответа `resolveFiltersWithLLM`: обратно-совместимое чтение через `typeof === 'object'`
4. STAGE 2 category-first (~3536): suppress query при `unresolved===0 && resolved>0`
5. STAGE 2 replacement (~3759): то же
6. Relaxed-loop (~3550): пропускать ключи с `is_critical=true`; если все критичны → `no_match`
7. После STAGE 2 = 0 (~3545): цикл по `sortedBuckets.filter(b => b.priority===2).slice(1, 3)` с повторным `resolveFiltersWithLLM`
8. Логи: 5 строк `console.log` (Classifier critical_modifiers, FilterLLM criticality, STAGE 2 query suppressed, STAGE 2 fallback to bucket-N, Relaxed BLOCKED)

**Деплой:** только `chat-consultant`.
**Объём:** ~50 строк суммарно.
**Откат:** один git revert + redeploy edge function.

---

## Часть 4. Регрессионный набор (что прогнать после деплоя)

| # | Запрос | Ожидание |
|---|---|---|
| 1 | «нужна черная двухместная розетка» | Чёрные двухместные ИЛИ no_match (НЕ розетки др. цвета) |
| 2 | «розетки накладные с заземлением» | Server-match по `montazh`+`zazemlenie` |
| 3 | «белая розетка с USB» | `cvet=белый`+`kol_usb>=1` |
| 4 | «лампочка примерно 9 ватт E27» | E27 critical, мощность нет → relaxed по мощности РАЗРЕШЁН |
| 5 | «розетка legrand белая» | `legrand` в query, `cvet=белый` в options |
| 6 | «автоматы 1 полюсные на 16А» | Регрессия — как сейчас |
| 7 | Артикул «ABB-S201-C16» | Article-first, без изменений |
| 8 | «светильник ДКУ-LED-03-100W (ЭТФ) предложи замену» | Replacement STAGE 3 с фиксами |
| 9 | «как оформить возврат» | RAG, без изменений |
| 10 | «привет» | Greetings ban активен |

