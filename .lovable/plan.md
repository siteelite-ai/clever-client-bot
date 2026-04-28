# Итоговый план: архитектурная чистка спеки + Query Expansion

Архитектор согласен с твоим требованием. Применяю принцип **data-agnostic spec**: спека описывает законы (контракты, инварианты, алгоритмы), а не состояние каталога 220volt. Любая иллюстрация с реальной категорией/товаром/трейтом = whitelist = запрещено.

---

## Архитектурное правило (новое, в Core памяти)

**Демаркация «пример vs контракт»:**

| Тип артефакта в спеке | Зависит от состояния каталога 220volt? | Вердикт |
|---|---|---|
| «Если запросить категорию X, вернётся Y товаров» | да | **запрещено** — whitelist |
| «Карточка-аналог для лампы E27 выглядит так: …» | да | **запрещено** — whitelist |
| Cross-sell-абзац «к лампам берут диммеры» | да | **запрещено** — domain hallucination |
| JSON-схема tool-call'а с типами полей | нет | разрешено — контракт типизации |
| Граничное условие «`options:[]`» | нет | разрешено — контракт обработки |
| Regex-правило `\b<token>\b` на абстрактном `token` | нет | разрешено — спека парсера |
| Test case `state→action→assert` на синтетических моках | нет | разрешено — контракт поведения |

**Критерий одной строкой:** если артефакт перестанет быть валидным после ребрендинга/смены ассортимента 220volt — он whitelist, его нельзя держать в спеке.

---

## Что чищу в спеке (`.lovable/specs/chat-consultant-v2-spec.md`)

| Раздел | Действие |
|---|---|
| §4.5, §9.2/9.3, §9.7 «Сценарий B/C» | Убрать `«Розетки»`, `«Розетки бытовые»`, любые названия категорий/товаров. Оставить структуру алгоритма с плейсхолдерами `<category_pagetitle>`, `<facet_key>`, `<trait_value>`. |
| §9.2a Category Resolver | Полностью переписать как контракт: `pagetitle ∈ {live /api/categories snapshot, TTL 24h}`. Любой `pagetitle` вне snapshot'а → reject + `category_hallucination_total++`. Никаких translit-эвристик, никаких примеров. |
| §11.5 Cross-sell | Убрать иллюстративный абзац про «E27 + диммеры». Оставить инварианты CS1–CS5 + контракт «1–3 предложения, без SKU/цен/брендов/ссылок/CTA, не та же категория». Вместо примера — отрицательный контракт (что **нельзя** содержать). |
| §17.3, §17.7 формат карточки | Заменить готовый markdown с конкретным товаром на BNF-нотацию с плейсхолдерами: `**[product.pagetitle](product.url)**` → `Цена: *<price>* ₸` → `Бренд: <brand?>` → `Наличие: <stock_summary?>`. Условные поля помечены `?`. Для §17.7 (similar) добавлен обязательный подпункт `Совпадает с исходной: <list of critical traits>`. |
| §25 Test cases | Переписать в формате `state → input → expected pipeline trace`. Никаких реальных запросов «дай лампу»/«двойная розетка». Только синтетика: `mock /api/categories returns [{pagetitle:"CatA"}]`, `user query → trait T1`, `expect: tool_call(catalog_search, query=T1, category="CatA")`, `expect: assert(query_attempts.length≤4)`. |
| §22 метрики | Добавить новые метрики Query Expansion (см. ниже). Без иллюстративных значений. |

---

## Что чищу в `.lovable/plan.md`

Сейчас там нарратив cross-sell/similar с примером «лампа A60 9Вт E27 Schneider — 1 290 ₸» и «Под такие лампы E27 часто берут диммеры…». Удаляю оба. Заменяю на BNF-формат карточки и контракт cross-sell-абзаца (см. ниже).

Также удаляю весь нарратив 5 кейсов (кукуруза/груша/двойная/SKU/Corner) — это R&D-артефакт. Остаётся только итог: реализовать Category Invariant + Query Expansion + Multi-Attempt + Word-Boundary Filter.

---

## Технические правки спеки (data-agnostic язык)

### §9.2a Category Resolver — контракт
- **C1.** `pagetitle` категории берётся **только** из живого `GET /api/categories` (кэш 24ч).
- **C2.** Любой `pagetitle`, отсутствующий в актуальном snapshot'е → reject, метрика `category_hallucination_total++`.
- **C3.** Запрещено: translit, ручные таблицы, склейка из навигации, эвристики.

### §9.2b Query Expansion Resolver (бывший Lexicon Resolver)
Контракт:
```
QueryAttempt = { tokens: string[], source: enum, confidence: float, rationale: string }
QueryExpansionOutput = { query_attempts: QueryAttempt[], expanded_traits: string[], applied_aliases: AppliedAlias[] }

source ∈ { as_is_ru, lexicon_canonical, en_translation, kk_translation }
```
Порядок попыток (жёсткий):
1. `as_is_ru` — всегда первая, если в реплике есть RU-слова кроме служебных.
2. `lexicon_canonical` — если в lexicon есть запись с `confidence ≥ 0.9`.
3. `en_translation` — только для трейтов, помеченных Intent-LLM как «бытовое название товара». Перевод выполняется в том же Intent-вызове через расширенную tool-схему, без отдельного round-trip.
4. `kk_translation` — отключена по умолчанию (`app_settings.query_expansion.kk_enabled=false`), включается по метрике `query_expansion_rescue_kk_potential_total`.

### §9.2c Strict Search Multi-Attempt (новый)
```
for attempt in query_attempts:
  raw     = catalog.search(query=attempt.tokens, category=resolved_pagetitle, options=facets)
  bounded = wordBoundaryFilter(raw, attempt.tokens)
  priced  = priceFilter(bounded, price > 0)
  if priced.total > 0:
    metric: query_expansion_strategy_used_total{source=attempt.source}++
    return priced
metric: query_expansion_all_attempts_failed_total++
→ recovery-then-degrade (§9C.2) → Soft 404 (§17.6)
```

### Word-boundary post-filter (часть §9.2c)
Для каждого `token ∈ attempt.tokens` хотя бы одно из полей `pagetitle | article | content` должно содержать `token` как отдельное слово (`\b<token>\b`, флаги `iu`). Иначе товар отбрасывается, `query_word_boundary_filtered_total{token}++`.

Исключение: для коротких токенов (<3 символов) и числовых паттернов word-boundary применяется только к `pagetitle`+`article`.

### §17.3 / §17.7 формат (BNF)
```
Card ::=
  - **[<product.pagetitle>](<product.url>)**
    [- Цена: *<formatted_price>* ₸                  ; required, price>0]
    [- Бренд: <product.brand>                       ; if present]
    [- Наличие: <stock_summary>                     ; if present]
    [- Совпадает с исходной: <critical_traits_csv>  ; only in §17.7 similar block]
```
Условные подпункты опускаются полностью при отсутствии данных (никаких «—»/«н/д»).

### §11.5 Cross-sell — контракт без иллюстрации
Сохраняются инварианты CS1–CS5. Иллюстративный абзац удалён. Промт Composer'а (отдельный файл, не спека) описывает контракт **отрицательно**: «1–3 предложения о смежных категориях. Запрещено: упоминать SKU, цены (`₸`), бренды, склады, ту же категорию что в выдаче, ссылки, фразы CTA. Не выдумывай рекомендации из pre-trained знаний — опирайся на факт смежности категорий каталога».

### §22 новые метрики
```
query_expansion_strategy_used_total{source}     counter
query_expansion_attempts_per_turn               histogram (1..4)
query_expansion_rescue_total{from,to}           counter
query_expansion_all_attempts_failed_total       counter
query_word_boundary_filtered_total{token}       counter
category_hallucination_total                    counter
```

### CI-чекер (расширение ADR 28.11)
Ежедневная задача: для каждого `pagetitle` в `categories_cache` дёргать `?category={pt}&per_page=1`, валидировать `data.results.length>0`. Дрейф → алерт + автоматический PR с обновлением кэша. Спека НЕ содержит конкретных pagetitle — чекер берёт их из живого snapshot'а.

---

## Куда уходят «грязные» примеры

Создаю `.lovable/fixtures/` (вне спеки):
- `api-snapshots/categories-2026-04-28.json` — slim-снапшот живых категорий для разработки.
- `api-snapshots/probe-cases-2026-04-28.md` — нарратив 5 кейсов прогона (кукуруза/груша/двойная/SKU/Corner) как R&D-документация. **Не часть спеки.** Используется только для регрессионных тестов и онбординга.

Жёсткое правило (в Core памяти): спека = законы, fixtures = состояние. Смешивать запрещено.

---

## Изменения в памяти

**`mem://index.md` Core (добавить):**
- «Spec = data-agnostic. ZERO примеров с реальными категориями/товарами/трейтами 220volt. Иллюстрации = whitelist = запрещены. Контракты (типы, JSON-схемы, BNF, regex-правила, test-state-машины) — разрешены. Грязные примеры → `.lovable/fixtures/` вне спеки.»
- Заменить строку Search pipeline на: «Category Resolver (live /api/categories only) → Query Expansion (multi-attempt: as_is_ru → lexicon → en_translation → kk_off) → Facet Matcher → Strict Search Multi-Attempt with word-boundary post-filter → Recovery-then-degrade → Soft 404».

**`mem://features/search-pipeline`:** переписать с учётом Query Expansion и word-boundary filter, без примеров запросов.

---

## Файлы, которые меняются

1. `.lovable/specs/chat-consultant-v2-spec.md` — большая чистка + новые §9.2a/b/c, обновлённые §17.3/17.7/§22/§25.
2. `.lovable/plan.md` — переписать в data-agnostic виде.
3. `mem://index.md` — Core обновлён.
4. `mem://features/search-pipeline` — переписан.
5. `.lovable/fixtures/` (новая папка) — снапшоты + R&D-кейсы вне спеки.

**Реализация в `supabase/functions/chat-consultant/index.ts` — отдельным следующим шагом** после твоего approval спеки. Сейчас правлю только документы.

---

## Что НЕ делаю

- Не удаляю Lexicon — он остаётся как стратегия `lexicon_canonical` внутри Query Expansion.
- Не включаю KK-перевод по умолчанию (флаг, метрика-триггер).
- Не добавляю отдельный LLM-call для перевода — расширяю существующий Intent-tool.
- Не трогаю код функций до твоего approval.

---

## Риски и митигация

- **Риск:** новый разработчик/LLM-агент без примеров плохо читают абстрактный BNF.
  **Митигация:** `.lovable/fixtures/` с явной пометкой «не часть спеки, только для мокирования». Test-suite §25 даёт executable-контракт.
- **Риск:** при первой реализации Query Expansion будет соблазн захардкодить «известные хорошие» пары (груша→A60). 
  **Митигация:** Lexicon — единственное легитимное место для таких пар, c полем `confidence` и аудит-логом `applied_aliases`.
