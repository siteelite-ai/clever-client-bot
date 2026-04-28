
# Архитектурный вердикт по pipeline разрешения категории и характеристик

## 1. Ответ на вопрос пользователя

**Текущая спецификация — частично правильная, но в ней зашит системный дефект.** Она формализует только два «крайних» случая: явный SKU (`sku_lookup`) и multi-bucket поиск, когда категория «всплывает» из выдачи API. Ваш сценарий «найди чёрные двугнёздные розетки» формально проходит через multi-bucket, что:

- (а) тратит лишний API-запрос «на удачу» с `query=`,
- (б) подмешивает мусор в bucket'ы из-за токена «чёрный» в названиях товаров других категорий,
- (в) не гарантирует, что matching трейтов на facets произойдёт по правильной схеме (LLM может «угадать» bucket с неполным набором характеристик).

Корень проблемы: в §9 нет фазы **«определи категорию → загрузи её схему характеристик → сматчь трейты на схему»** как первоклассного, отдельного шага. Эта фаза размазана по `resolveFiltersWithLLM` (внутри bucket'а) и не имеет своего контракта.

**Ваш описанный flow идеологически верен.** Архитектор подтверждает: категория → её facets → семантический матчинг трейтов на значения схемы → строгий запрос — это правильный системный путь. Прогон опечаток через `query=` (как сейчас в §9.4) — патч, а не решение, и он действительно ломается на «ё/е», синонимах и бытовых названиях.

## 2. Вердикт по предложенным мной ранее вариантам

| Вопрос | Решение архитектора | Обоснование |
|---|---|---|
| Matcher трейтов | **LLM по полной схеме facets, в один проход, со строгим JSON-выходом** (вариант 1, расширенный) | Embeddings (вариант 3) дают шум на коротких лексемах («2», «двойная»), требуют прекомпьюта и инвалидации при drift. Гибрид правил+LLM (вариант 2) масштабируется плохо: каждая новая категория = новые правила. Один детерминированный LLM-проход универсален, типобезопасен (через JSON schema) и закрывает «ё/е», опечатки, числовые↔словесные эквиваленты единым контрактом. |
| Identity категории | **Pre-step «Category Resolver» по flat-списку pagetitle с явным confidence** (вариант 1) | Это и есть ваш описанный flow. Multi-bucket остаётся **fallback'ом** при `confidence < 0.7` или при гибридных запросах («розетки и удлинители»). Текущий §9.4 не отменяется, но понижается в правах: из дефолта в страховку. |
| Fallback при unresolved facet | **Спросить уточнение у пользователя**, показав доступные значения (вариант 1) | Системно — единственный вариант, не нарушающий инвариант «не выдумывать данные». Soft-match с предупреждением допустим только когда `confidence ≥ 0.6` и значение является фонетическим/морфологическим вариантом (например «графитовый»→«серый» — НЕТ; «двугнёздная»→«2 гнезда» — ДА, это лексический эквивалент). Развести два сценария формально. |

## 3. Системные изменения в спецификации

### 3.1 Новый этап в Turn Pipeline (§6.1)

Между шагами **[5] FSM** и **[6a] Catalog Branch** добавить подэтап:

```
[6a.1] Category Resolver       ── LLM(query, slot, listCategories) → { pagetitle, confidence }
[6a.2] Facet Schema Loader     ── category_facets(pagetitle) → OptionSchema (cache 1ч)
[6a.3] Facet Matcher (LLM)     ── LLM(traits, OptionSchema) → { resolved[], unresolved[], soft_matches[] }
[6a.4] Strict API Search       ── GET /api/products?category=...&options[k][]=v ...
```

`[6a.5]` (fallback) остаётся текущий multi-bucket — срабатывает, когда `[6a.1].confidence < 0.7` ИЛИ `[6a.3].resolved.length == 0` для основного трейта.

### 3.2 Новый раздел §9.2a «Category Resolver» (между §9.2 и §9.3)

Контракт:
```ts
function resolveCategory(input: {
  user_query: string;
  active_slot?: Slot;
  categories_flat: string[];   // из listCategories(), кэш 1ч
}): Promise<{
  pagetitle: string | null;
  confidence: number;          // 0..1
  reasoning: string;           // для трейса
  alternatives: { pagetitle: string; confidence: number }[]; // топ-3
}>;
```

Правила:
- если `active_slot.category_pagetitle` существует и `intent ∈ {refine_filter}` — Resolver пропускается, используется текущая категория;
- если `confidence ≥ 0.7` — single-category branch ([6a.2]+);
- если `0.4 ≤ confidence < 0.7` — single-category branch + флаг `category_uncertain=true` (Composer добавляет в ответ «Я ищу в категории X. Если вы имели в виду что-то другое — уточните»);
- если `confidence < 0.4` — fallback в multi-bucket (§9.4).

### 3.3 Перепроектирование §9.3 «Facet Matcher» (вместо текущего Resolve Filters)

Контракт:
```ts
function matchFacetsWithLLM(input: {
  user_traits: string[];               // из intent classifier
  user_query_raw: string;              // исходник для лексического разбора
  schema: OptionSchema;                // из category_facets, dedup+aliases
  active_filters: AppliedFilter[];
}): Promise<{
  resolved: AppliedFilter[];           // exact / lexical-equivalent matches
  soft_matches: {                      // confidence 0.6..0.85
    key: string; suggested_value: string; trait: string; confidence: number;
  }[];
  unresolved: {                        // confidence < 0.6 либо нет в схеме
    trait: string; nearest_facet_key?: string; available_values?: string[];
  }[];
  price?: PriceRange;
  sort?: Sort;
}>;
```

**Контракт промпта (системный, не патчевый):**
1. На вход подаётся ВСЯ схема выбранной категории (после dedup и alias-collapse) + список user-traits.
2. LLM обязан для каждого трейта:
   - найти **подходящий facet-key** (по семантике caption_ru), а не угадывать;
   - найти **точное значение** среди доступных, учитывая: морфологию, нормализацию «ё↔е», числовые эквиваленты («двух»=«2»=«двойная»=«две»), порядок слов, билингвальность RU↔KK;
   - если нашёл — `resolved`;
   - если нашёл facet-key, но значение лексически близкое (опечатка, склонение, уменьшительная форма) — `soft_matches` с confidence;
   - если facet-key найден, но значение совершенно другое (графитовый ≠ серый) — `unresolved` с `available_values`;
   - если facet-key не найден — `unresolved` без `nearest_facet_key`.
3. **Запрещено**: добавлять трейт в `query=`. Если matching не удался — это сигнал диалогу, а не патч в URL.
4. **Запрещено**: «угадывать ближайшее» без явного указания confidence.

Удаляется правило из §9.4 «прогонять цвет через `query=` при non-ASCII ключах». Non-ASCII ключи (`cvet__tүs`) не являются проблемой LLM-этапа — он оперирует семантикой, а реальный URL-encoding ключа делает Edge-функция. Если 220volt API принципиально не принимает non-ASCII ключи в query string — это дефект API (B-API-002), регистрируется в §9C, но **не отражается** на алгоритме матчинга.

### 3.4 Изменения в Slot (§13.1)

```ts
interface Slot {
  // ...
  category: { id: number; pagetitle: string; confidence: number };
  resolved_filters: AppliedFilter[];
  soft_matches: SoftMatch[];                    // новое
  unresolved_traits: UnresolvedTrait[];         // новое
  pending_clarification?: {                     // новое
    facet_key: string;
    available_values: string[];
    trait: string;
  };
}
```

### 3.5 Composer (§11) и FSM (§5)

- Если `slot.pending_clarification` присутствует → Composer **обязан** задать уточняющий вопрос с явным списком значений, поиск НЕ выполняется до ответа пользователя.
- Если `slot.soft_matches.length > 0` → Composer добавляет в ответ строку «Точного "{trait}" нет, показал ближайшее: {value}» **до** списка товаров.
- Новое состояние FSM `SLOT_AWAITING_CLARIFICATION` между `SLOT_REFINING` и `SLOT_OPEN`. Переход: получен ответ пользователя → reclassify как `refine_filter` → matcher повторяется.

### 3.6 Multi-bucket (§9.4) — понижение в правах

Раздел переименовывается в **«§9.4 Multi-bucket Fallback»**. Чётко фиксируется: запускается **только** если Category Resolver вернул `confidence < 0.4` или Facet Matcher на выбранной категории дал 0 resolved-фильтров для основного трейта (категориальный токен типа «розетка»). Перестаёт быть дефолтной стратегией.

### 3.7 Golden Tests (§25)

Добавить кейсы:
- **TC-69** «найди чёрные двугнёздные розетки» → Resolver: `Розетки` conf≥0.9 → Matcher: `cvet__tүs="чёрный"`, `kolichestvo_razyemov*="2"` (lexical-equivalent), unresolved=[].
- **TC-70** «графитовые розетки» → Matcher: facet=цвет найден, value=unresolved → Composer задаёт уточнение с available_values, поиск не идёт.
- **TC-71** «двойные розетки белого цвета» → числовой эквивалент `двойная`→`2`, цвет → exact, resolved.length=2.
- **TC-72** «розетка с двумя гнёздами и 16А» → 2 трейта: один числовой, один точный, оба resolved.
- **TC-73** «двухполюсный автомат на 16» → Resolver: `Автоматы` conf≥0.85 → Matcher распознаёт «двухполюсный» как facet `polyusnost`=2, «16» → `nominal_tok`=16А.
- **TC-74** (drift detection) — property-based: для случайной категории матчер на 5 синтетических трейтах, повторное «ё↔е» и числовое преобразование должны давать idempotent resolved.

### 3.8 Латентность (§6.2) — пересчёт бюджета

| Этап | Был | Стало |
|---|---|---|
| 6a — фильтрованный поиск | 2 500 | 2 900 (+400 на Category Resolver LLM) |
| Итого фильтрованный поиск | 5 800 | **6 200** |

Допустимо: уход от ошибок в matching экономит retry-циклы пользователя.

## 4. Что НЕ меняется (важно зафиксировать)

- ACL и Defect Registry (§9B, §9C) из предыдущего цикла остаются — это правильное место для дефектов API, не путать с алгоритмом матчинга.
- Real-time API only — без изменений.
- Multi-bucket НЕ удаляется — становится страховкой для гибридных и неоднозначных запросов.
- Domain Guard (§9.5) остаётся, но применяется на этапе [6a.5] (fallback), а не в основном пути — в основном пути категория уже зафиксирована Resolver'ом.

## 5. Файлы под правку

- `docs/chat-consultant-v2-spec.md` — §6.1, §6.2, новый §9.2a, переписанный §9.3, §9.4 (понижение), §11, §13.1, §25 (5 новых TC).
- Snapshot Swagger (`docs/external/220volt-swagger.json`) — без изменений.
- Открытые вопросы (§28) — закрыть пункты, перекрытые этим решением.

## 6. План действий после approve

1. Внести правки в `docs/chat-consultant-v2-spec.md` шестью атомарными секциями (нумерация выше).
2. Обновить `mem://features/search-pipeline` и `mem://features/search-logic`: зафиксировать «Category Resolver pre-step → Facet Matcher → Strict Search; multi-bucket = fallback».
3. После approve спецификации — отдельной задачей реализация в `supabase/functions/search-products` и в chat-consultant edge function (вне текущего плана; план — только документ).

**Ничего не пишется до вашего «вношу правки».**
