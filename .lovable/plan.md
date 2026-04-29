
## Контекст

Запрос «найди черные двухгнёздые розетки» → «ничего не найдено». Логи показали:
- Category Resolver = 14 387 ms (бюджет §6.2 — 400 ms).
- Facet Matcher упал по timeout 50 ms с `category_unavailable` (унаследованный AbortSignal).
- Модификаторы `черные`, `двухгнездые` ушли в `unmatched`, поиск вернул пустоту.

Сравнение с `docs/chat-consultant-v2-spec.md` (канон) показывает: **текущий `facet-matcher.ts` не реализует §9.3 спецификации**. Это корневая причина, остальное — следствия.

## Расхождения «как есть vs §§ спеки»

| § спеки | Что предписано | Что в коде | Вердикт |
|---|---|---|---|
| §6.1 шаг 6a.3, §9.3 | Facet Matcher = **LLM** (`matchFacetsWithLLM`) с контрактом `{resolved, soft_matches, unresolved, price?, sort?}`. Промпт описывает принципы морфологии RU/KK, ё/е, числовой нормализации, билингвальности — конкретные пары вычисляются LLM из живой `schema.values[]`. | `catalog/facet-matcher.ts` — детерминированный exact-match с `normalizeForMatch`. Нет `soft_matches`, нет `unresolved`, нет LLM-вызова. | **Нарушение §9.3** |
| §6.1 шаг 6a.2.5, §9.2b алгоритм п.1 | Lexicon Resolve — отдельный детерминированный шаг ≤3 ms, выполняет морфонормализацию (`norm(t) = lowercase(NFKC(t)).replace(/ё/g,'е').trim()`). | Морфонормализация ё→е добавлена не в Lexicon-этап, а патчем внутрь `facet-matcher.ts`. Самостоятельного Lexicon-резолва нет. | **Нарушение §9.2b** (защитный патч в чужом слое) |
| §6.2 | Category Resolver p50 = 400 ms. | По логам — 14 387 ms. | Перформанс-инцидент, нужна диагностика |
| §9.3 контракт «Поведение при unresolved» | Если `unresolved.length > 0` с `nearest_facet_key` — `SLOT_AWAITING_CLARIFICATION`, поиск **не выполняется**, Composer задаёт уточнение со списком `available_values`. | На `category_unavailable` / `no_matches` пайплайн молча отдаёт «ничего не найдено». | **Нарушение §9.3** |
| §9.2c MA4 + §9C.2 | Если все попытки 0 — Recovery-then-degrade, не Soft 404. | Нет вызова Recovery-ветки на `category_unavailable`. | **Нарушение §9.2c** |

## План работ

Все шаги изолированы внутри `chat-consultant-v2`. V1 не трогается (mem://v2-pipeline-switch).

### Шаг 1. Откат защитных добавок не из спеки

- Удалить `replace(/ё/g, 'е')` и комментарий-обоснование из `catalog/facet-matcher.ts` (`normalizeForMatch`).
- Удалить регрессионные тесты Test 13-15 из `catalog/facet-matcher_test.ts` — они тестировали чужой слой.
- Логи `[v2.catalog.facet_matcher.input/result]` оставить (наблюдаемость не противоречит спеке, нужна для §22).

Обоснование: §9.2b алгоритм п.1 явно фиксирует, где живёт ё→е (Lexicon-этап, не Facet Matcher). §9.3 запрещает «зашивать в промпт перечисления конкретных синонимов/числовых эквивалентов»; та же логика применима к коду.

### Шаг 2. Отдельный Lexicon Resolve (§6.1 шаг 6a.2.5, §9.2b)

Новый файл `chat-consultant-v2/lexicon-resolver.ts` с экспортом `resolveLexicon(input) → {expanded_traits, query_attempts, applied_aliases}`.

Внутри:
- `norm(t) = lowercase(NFKC(t)).replace(/ё/g,'е').trim()` ровно по §9.2b алгоритм п.1.
- Если `app_settings.lexicon_json.entries = []` — возвращает `{query_attempts: [{source:'as_is_ru', tokens: extractRuTokens(query), confidence:1, rationale:'baseline'}]}` (инвариант L5/QE5).
- В рамках этого шага реальный lexicon наполнять не надо — он bootstrap-only по §9.2b-lex.

Подключить вызов в orchestrator между Category Resolver и Facet Matcher (порядок §6.1).

### Шаг 3. LLM-Facet-Matcher (§9.3) — основной шаг

Переписать `catalog/facet-matcher.ts`:

1. Сигнатура и контракт **строго** по §9.3:
   ```ts
   matchFacetsWithLLM(input: {
     user_traits: string[];
     user_query_raw: string;
     schema: OptionSchema;        // после dedup §9B
     active_filters: AppliedFilter[];
   }): Promise<{
     resolved: AppliedFilter[];
     soft_matches: SoftMatch[];
     unresolved: UnresolvedTrait[];
     price?: PriceRange;
     sort?: Sort;
   }>
   ```
2. Промпт собирается из принципов §9.3 п.2.2 (морфология RU/KK, ё↔е, числовая нормализация, билингвальность, составные конструкции). **Без перечислений конкретных пар** — это запрет §9.3 п.3.5.
3. На вход LLM подаётся ВСЯ `schema.values[]` категории (после alias-collapse §9B, который у нас уже работает в `collapseOptions()` — переиспользовать).
4. Модель: OpenRouter Gemini Flash (бюджет §6.2 = 600 ms; Flash, не Flash Lite — §9.3 требует semantic reasoning).
5. Запреты §9.3 п.3 кодируются как post-validation: значения вне `schema.values[]` → reject + метрика `facet_matcher_hallucination_total`; `confidence` без `reason` → reject.
6. Fallback при таймауте/ошибке LLM: вернуть `unresolved` со всеми трейтами, статус `category_unavailable` сохранить как сигнал для §9C.2.

### Шаг 4. Подключить unresolved-поведение (§9.3 таблица «Поведение при unresolved»)

В `s-search.ts` / `orchestrator.ts`:
- `unresolved` с `nearest_facet_key` → выставить `slot.pending_clarification`, **не делать** API-запрос, передать в Composer уточняющий вопрос со списком `available_values` (§5 `SLOT_AWAITING_CLARIFICATION`).
- `unresolved` без `nearest_facet_key` → продолжить поиск с `resolved`-фильтрами; Composer добавит «Не нашёл в характеристиках "{trait}"…».
- `soft_matches` → применить как фильтр; Composer добавит «Точного "{trait}" нет, показал ближайшее…».

### Шаг 5. Диагностика 14-секундного Resolver'а (отдельный коммит)

Добавить timing-логи внутри `category-resolver.ts`:
- `[v2.catalog.resolver.timing] {http_categories_ms, llm_ms, parse_ms, total_ms}`.

Это **только наблюдаемость**, не оптимизация. После выкатки повторить запрос пару раз: если стабильно >1s — отдельный план (возможные направления, не входят в этот скоуп: подумать про cache-warm `categories_flat`, переход с Flash на Flash Lite per §6.2). Без данных оптимизировать нельзя.

### Шаг 6. Тесты (§25 Golden Test Suite, релевантные TC)

- Удалить Test 13-15 (см. Шаг 1).
- Новые unit-тесты `facet-matcher_test.ts` с моком LLM-вызова — покрывают TC из §25.6 / §25.7 / §25.11:
  - resolved: точное значение из schema → `resolved` непустой;
  - morphology: трейт «двухгнездые» при `values=["1","2","3"]` → `resolved` со значением "2" (LLM делает работу, мы не хардкодим маппинг);
  - bilingual: ru-трейт при kk-only значении → `resolved` или `soft_matches`;
  - hallucination: LLM вернул значение вне schema → reject + метрика;
  - timeout: LLM не ответил → все трейты в `unresolved`, статус сохраняется.
- E2E-тест в `orchestrator_test.ts` для регрессии «черные двухгнёздые розетки» через мокированный LLM — проверка, что unresolved-ветка отрабатывает корректно при реальной schema «Розетки».

## Что НЕ входит

- Не наполняем `lexicon_json` — он bootstrap-only через cron (§9.2b-lex).
- Не оптимизируем сам Resolver на этом этапе — сначала измерить (Шаг 5).
- Не меняем `s-price`, `s-similar`, `knowledge` — это вне корневой причины.
- Не трогаем V1 (`chat-consultant`).

## Технические детали

**Файлы**

| Действие | Путь |
|---|---|
| Edit | `supabase/functions/chat-consultant-v2/catalog/facet-matcher.ts` (переписать на LLM) |
| Edit | `supabase/functions/chat-consultant-v2/catalog/facet-matcher_test.ts` (удалить 13-15, добавить LLM-моки) |
| New | `supabase/functions/chat-consultant-v2/lexicon-resolver.ts` |
| New | `supabase/functions/chat-consultant-v2/lexicon-resolver_test.ts` |
| Edit | `supabase/functions/chat-consultant-v2/orchestrator.ts` (вставить Lexicon Resolve между Category Resolver и Facet Matcher; провести unresolved/soft_matches до Composer) |
| Edit | `supabase/functions/chat-consultant-v2/s-search.ts` (поведение unresolved §9.3) |
| Edit | `supabase/functions/chat-consultant-v2/s-catalog-composer.ts` (унифицированные строки про soft_matches и unresolved-без-nearest) |
| Edit | `supabase/functions/chat-consultant-v2/category-resolver.ts` (timing-лог) |
| Update | `mem://features/search-pipeline` (зафиксировать переход Facet Matcher на LLM по §9.3) |

**Контракты**

`SoftMatch`, `UnresolvedTrait`, `OptionSchema` — взять буквально из §9.3 спеки. Не выдумывать поля.

**LLM**

Только OpenRouter Gemini Flash (Core memory: «Exclusively use OpenRouter»). Модель и промпт — в `config.ts`, чтобы менять без правки логики.

**Бюджеты §6.2** (после фикса): Lexicon ≤3 ms, LLM Facet Matcher ≤600 ms p50, Strict API Search ≤1500 ms — итог фильтрованного поиска ≤5800 ms.

**Метрики §22.2 (расширение)**: `facet_matcher_hallucination_total`, `facet_matcher_unresolved_with_clarification_total`, `facet_matcher_soft_match_applied_total`, `category_resolver_latency_ms` (histogram).

## Порядок выполнения

Шаги 1 → 2 → 3 → 4 → 6 одним заходом (это связные изменения одного контракта). Шаг 5 — отдельным маленьким коммитом перед остальным, чтобы получить замер «до».

После выкатки — повторить запрос «найди черные двухгнёздые розетки» из виджета и проверить логи. Ожидаемое поведение: facet-matcher увидел schema «Розетки», LLM замапил «черные» → `Цвет=Чёрный` и «двухгнёздые» → `Количество разъёмов=2`, `/products` вернул товары. Если LLM не справился — `unresolved` с `nearest_facet_key`, Composer задаёт уточняющий вопрос со списком значений.
