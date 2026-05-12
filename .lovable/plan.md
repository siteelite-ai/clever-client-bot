## Итог разведки по двум кейсам

Тесты проходят — но они проверяют **совсем не тот сценарий**, который ломается у вас на проде. Ниже разбор обоих логов с конкретными строчками.

---

### Кейс 1 — `72ad0196` («самые дешёвые белые двойные розетки»)

Классификатор:

```json
{ "intent":"catalog", "price_intent":"cheapest",
  "product_category":"розетки",
  "critical_modifiers":["белые","двойные"] }
```

steps: `classify → final-deterministic(reason=pass2-shortcircuit), total=25`. Выдача — «Крышки ЮЛИГ».

**Где это решается в коде:** `index.ts:6207-6254`

```ts
6207: if (effectivePriceIntent && appSettings.volt220_api_token) {
...
6244:   if (mods.length > 0) {
6246:     const enrichedQuery = `${priceQuery} ${mods.join(' ')}`.trim();
6248:     const priceResult = await handlePriceIntent([enrichedQuery], effectivePriceIntent, ...);
```

То есть как только `price_intent !== null`:
- Поток уходит в **price-ветку РАНЬШЕ**, чем QFv2 (QFv2 живёт ниже, на `6437+`, под `if (appSettings.query_first_enabled ...)`).
- Внутри price-ветки **нет ни probe-pool'а, ни bootstrap-схемы фасетов, ни `resolveFiltersWithLLM`**. Модификаторы тупо склеиваются в `query=`.
- `handlePriceIntent` (`2503-2580`) шлёт `?query="розетки самые дешевые белые двойные"&min_price=1`. Каталог ищет фразу буквально → 0.
- `priceResult.action='not_found'` → `articleShortCircuit` остаётся `false` → пайплайн валится в jargon-fallback, который опускает запрос до `розетка` и берёт первое попавшееся (Крышки).

**Почему тесты молчат:** в репо есть `s-price_test.ts` для V2, есть `shortcircuit_urls_test.ts` для V1. V2-тесты проверяют s3-router → s-price (там probe-then-fetch + facets через `matchFacets`). V1-тесты на price-ветку в этом виде нет вообще — она была упрощена 2026-05-02 (см. core-memory) до «один запрос query+min_price=1» и больше не проверяется на сценарии «модификаторы должны лететь через `options[]`».

---

### Кейс 2 — `f20fc782` («розетки коллекции гармония»)

Классификатор:

```json
{ "intent":"catalog", "price_intent": null,
  "product_category":"розетки",
  "critical_modifiers":["коллекции","гармония"] }
```

steps: `classify → final-deterministic(reason=pass2-shortcircuit), total=15`. Выдача — Светоприбор-розетки, никакой коллекции «Гармония».

Здесь price-ветка **не запустилась** (нет `price_intent`) — поток ушёл в QFv2. Это то, что вы и хотите. Но результат всё равно мусорный. Смотрим, почему:

**Где это решается:** `index.ts:6437-6664` (QFv2)

1. `noun = "розетка"` (extractor, `6440-6450`).
2. `enrichedQuery = "розетка коллекции гармония"`, pool=100 (`6470-6475`).
3. **Bootstrap schema из pool** (`6493-6520`) — здесь и зарыта проблема. Catalog по `?query=` возвращает Светоприбор-розетки (full-text по pagetitle); в `Product.options[]` этих товаров **нет ключа «коллекция: Гармония»** — это коллекция Schneider Electric, а не Светоприбор. То есть в bootstrap-схеме факта «коллекция = Гармония» просто нет.
4. `resolveFiltersWithLLM(pool, ["коллекции","гармония"], schema, ...)` (`6529-6537`) → `resolved={}`, `unresolvedDetails=[]` (LLM не находит в схеме ни ключа, ни значения).
5. Падаем в `else` ветку `6603`: ни `resolved`, ни `unresolvedDetails` → выполняется хвост `displayList = applyNounFilter(pool); branchTag='qfv2_pool_no_modifiers'` (`6573-6574`).
6. На `6657` `totalCollectedBranch='qfv2_pool_no_modifiers'`, `articleShortCircuit=true`.
7. **EARLY JARGON FALLBACK** на `7967-8011` ловит `branch=qfv2_pool_no_modifiers + criticalMods.length>0`. Он ДОЛЖЕН был сработать. Если в вашем логе `total=15`, варианта два:
   - либо jargon-fallback нашёл по альтернативе и сделал `totalCollectedBranch='jargon-fallback-early'` (но тогда branch в `chat_request_logs` был бы `jargon-fallback`, а у вас в логе `branch=null` — значит этот блок упал silently / не запустился);
   - либо `branch=null` потому что `logSetBranch('jargon-fallback')` (`7977`) вызывается, но падает дальше в `tryJargonFallback` с альтернативами, которые тоже дают «розетка» → возвращаются те же Светоприбор-блоки. В итоге early jargon-fallback оборачивает мусор в новый мусор, а pipeline это считает «нашли».

В любом случае, **корневая причина**: схема фасетов строится **из тех товаров, которые вернул `?query=коллекция гармония`**, а не из категории «Розетки» целиком. Если узкое значение фасета не попало в pool — резолвер его никогда не увидит.

**Почему тесты молчат:** тесты QFv2 (мы видим следы в `_shared`, в V2 есть `golden-similar_e2e_test.ts`, `catalog-assembler_test.ts` и др.) сделаны на кейсах, где модификатор ЕСТЬ в каталоге как facet (цвет/тип монтажа/мощность). Узкие значения брендовых коллекций (Schneider «Гармония», Legrand «Etika») в фикстурах не покрыты — поэтому pass.

---

## Итог: одна и та же системная дыра, два проявления

| Кейс | price_intent | Ушёл в | Где упал |
|---|---|---|---|
| 72ad0196 | cheapest | price-branch (6207) | модификаторы клеятся в query=, фасетов нет |
| f20fc782 | null | QFv2 (6437) | bootstrap-схема из pool без нужного значения |

Системная проблема одна: **схема фасетов строится из неправильного источника**.

- В price-ветке источника **нет вообще** — её надо привести к QFv2-схеме (probe → bootstrap → resolve → options[] → handlePriceIntent с extraParams).
- В QFv2 источник есть, но он завязан на pool по `?query=`, который не содержит узких коллекций. Нужно при `pool=N товаров без целевого фасета` идти за схемой второй раз — через `?category=<noun>` (более широкий пул) или через `/categories/options` для категории «Розетки», и резолвить уже на полной схеме.

---

## План изменений (двумя независимыми этапами)

### Этап 1. Price-ветка использует тот же путь, что QFv2

Файл: `supabase/functions/chat-consultant/index.ts:6244-6254`.

Заменить «mods → glue в query» на:

```
1. noun = effectiveCategory (или extractCategoryNoun если нужно)
2. probePool = searchProductsByCandidate(query=noun, perPage=100)
3. bootstrapSchema = extract из probePool.options[] (тот же код, что в QFv2 6493-6520 — выносим в helper, без копипаста)
4. {resolved, unresolvedDetails} = resolveFiltersWithLLM(probePool, mods, schema, criticalMods, schema, 'full', noun)
5. extraParams = Object.entries(resolved).flatMap(...) → [['options[<aliasKey>][]', value], ...] через getAliasKeysFor
6. handlePriceIntent([noun], priceIntent, token, extraParams)
7. Если total=0 → honest-empty с attemptedFacets (как в QFv2 honest-empty)
```

В steps появятся два новых шага: `price-probe` и `price-resolve`. `branch='price-shortcircuit'` будет проставлять `logSetBranch`.

Защита от регрессии: если modifiers пусто — оставить старый сценарий A (bootstrap + clarify) и не ломать его.

### Этап 2. QFv2: вторая попытка резолва на расширенной схеме

Файл: `index.ts:6603` (текущая ветка `else` где `resolved={}` && `unresolvedDetails=[]`).

Перед тем как рисовать pool, делаем **второй заход**:

```
если resolved=={} и unresolvedDetails==[] и criticalMods.length>0:
  попробовать получить «широкую» схему фасетов
    приоритет 1: getCategoryOptionsSchema(noun) — если такая категория существует в /categories
    приоритет 2: probe на {query=noun, perPage=200} с другой выборкой (sort by random / different page)
  если в этой расширенной схеме есть ключ "kollektsiya" со значением «Гармония» (нечёткое сравнение) — резолвим и идём в final search
  если всё равно ноль → honest-empty с attemptedFacets={caption:"Коллекция", value:"Гармония", alternativeValues:[…]}
```

То есть текущий `qfv2_pool_no_modifiers` перестаёт быть «молча показать pool», а становится «либо расширили схему и нашли, либо честно сказали что нет». Это ровно та же философия, что уже зашита для honest-empty (см. core memory про QFv2 honest-empty).

### Этап 3. Тесты, которые поймали бы оба кейса

Добавить в `.lovable/fixtures/`:

1. **price + critical_mods**: «самые дешёвые белые двойные розетки» → ожидание: `branch ∈ {price-shortcircuit, price-honest-empty}`, в выдаче либо реально белые двойные розетки отсортированные по цене ASC, либо честный honest-empty с альтернативами цвета/мест.
2. **brand-collection**: «розетки коллекции Гармония» → ожидание: `branch=qfv2_win` с реальными розетками Schneider Atlas Гармония, либо `qfv2_honest_empty` с альтернативами по фасету «Коллекция».

И один e2e-тест на `chat-consultant`, который дёргает edge-функцию и проверяет, что НИКОГДА не приходит «Крышка ЮЛИГ» в ответ на запрос «розетки …».

---

## Что НЕ меняем

- `handlePriceIntent` сам — он корректный (sort через min_price=1, last-page для most_expensive), нужно только правильно его кормить.
- QFv2 для случаев, где модификатор реально в pool (90% запросов).
- V2 пайплайн — у него своя s-price, отдельно.

---

## После approve

Иду строго по этапам, после каждого жду «ок»:

1. **Этап 1** — вынести bootstrap+resolve в общий helper, переписать `6244-6254` на полный путь, добавить логирование шагов `price-probe`, `price-resolve`.
2. **Этап 2** — расширить QFv2 второй попыткой резолва на широкой схеме.
3. **Этап 3** — фикстуры + e2e.

Никаких заплат. Если на этапе 1 окажется, что `extractFacetSchemaFromProducts` уже есть в `_shared` (V2 им пользуется) — переиспользуем, дублировать не будем.
