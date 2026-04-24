## Цель

Прицельно улучшить три промпта для **Gemini 2.5 Flash** (Classify, AI Candidates, FilterLLM, CategoryMatcher) и **полностью сохранить** текущую архитектуру веток, slot-сужение, ценовые сценарии, brands-ветку, replacement и article-first короткие замыкания.

Никаких архитектурных изменений. Никаких удалений рабочей логики. Только промпты + точечные фиксы факт-ошибок, которые ты выявила.

---

## Что я перепроверил по коду (не по памяти)

`supabase/functions/chat-consultant/index.ts`, всего 5856 строк. Прошёл по всем веткам.

### Текущая маршрутизация интента (НЕ меняем)

Строки ~3754–4965, единый порядок диспетчеризации внутри handler:

1. **Slots (refinement)** — `resolveSlotRefinement` (стр. 3863). Если есть pending `product_search` или `price_extreme` slot и сообщение — короткое уточнение → идём в slot-ветку, минуя всё остальное. Хранится `resolved_filters` (JSON), `unresolved_query`, `base_category`, `plural_category`. Накопительно мерджится при каждом ответе.
2. **Article-first** (стр. 3795–3839) — `detectArticles` ловит токены любого вида (буквы+цифры+точки+дефис, ≥4 симв.), сразу `searchByArticle` → `articleShortCircuit=true`. Если 0 — fallback на site ID.
3. **Micro-LLM Classify** (стр. 3847) — `classifyProductName`, дефолт `gemini-2.5-flash-lite`. Возвращает `intent` ∈ {catalog, brands, info, general}, `has_product_name`, `product_name`, `price_intent`, `product_category`, `is_replacement`, `search_modifiers`, `critical_modifiers`.
4. **Price-intent ветка** (стр. 3989–4031) — `processPriceIntent` со списком синонимов. Может: вернуть товар, попросить уточнить (создаёт `price_extreme` slot), либо упасть в обычный pipeline.
5. **Title-first** (стр. 4063–4087) — если `has_product_name=true` и НЕ replacement → прямой `searchProductsByCandidate(query=product_name)`. При >0 — короткое замыкание.
6. **Category-first** (стр. 4090–4544) — если есть `product_category` без `product_name` без price-intent:
   - **CategoryMatcher путь**: `matchCategoriesWithLLM` маппит запрос в точные `category.pagetitle` каталога, дальше параллельно `?category=` + query-fallback + `getUnionCategoryOptionsSchema` (полная схема, не сэмпл) + `resolveFiltersWithLLM` с этой схемой → server-side option-фильтрация + cascading relax non-critical фильтров.
   - **Bucket-fallback**: если matcher пусто/таймаут — старый bucket-путь (категории по факту найденных товаров, prioritizeBuckets, тот же FilterLLM, та же relax-логика).
7. **Replacement** (стр. 4546–4960) — отдельный pipeline: ищем оригинал → берём его `category.pagetitle` → matcher или bucket → исключаем оригинал → возвращаем аналоги. Поддерживает re-create slot.
8. **AI Candidates → searchProductsMulti** (стр. 5079+) — общий fallback, если все короткие замыкания не сработали:
   - `intent=catalog`: multi-кандидаты + price-sort если активен `effectivePriceIntent` + rerank.
   - `intent=brands`: если бренд указан — обычный поиск; если нет — широкий поиск + `extractBrandsFromProducts` → `brandsContext`.
   - `intent=info|general`: пропускаем поиск.

### Sузение через slot (НЕ меняем)

После любой ветки если `foundProducts.length > 7` — создаётся `product_search` slot c `plural_category`, `resolved_filters` (JSON), `unresolved_query`. На следующем коротком ответе `resolveSlotRefinement` берёт `refinement` (текст пользователя), отдаёт его FilterLLM с **полной схемой реальной категории** (`getCategoryOptionsSchema`, кэш 30 мин по 5×200 товаров) → новые фильтры мерджатся со старыми → повторный `?category=...&options[...]=...` → снова pickDisplayWithTotal. Это и есть тот цикл «характеристики только из реально доступных товаров категории», который ты описала. Он уже работает.

### Цены (НЕ трогаем)

- `price_intent: 'most_expensive' | 'cheapest'` извлекается Classify-микроLLM по текущему сообщению.
- Дальше `processPriceIntent` собирает синонимы категории, ищет multi-vector, локально сортирует, ловит max/min.
- В fallback-ветке (стр. 5132): если `effectivePriceIntent` активен — `foundProducts.sort` по цене **до** rerank, и в системный промпт уходит явная инструкция «покажи первый как самый …».
- `price_extreme` slot хранит `price_dir` и категорию через ходы.

Это всё работает и ничего не трогаем.

### Brands-ветка (уточнение, что ты спрашивала)

Стр. 5075–5104. Когда Classify сказал `intent='brands'`:
- Если в кандидатах есть конкретный `brand` (например «у вас Bosch есть?») — ищем как обычный catalog-поиск с brand filter (топ-8).
- Если бренда нет («какие бренды представлены?», «какие производители розеток?») — широкий поиск (50 товаров) по query/категории, потом `extractBrandsFromProducts` собирает уникальные бренды из `options['brend__brend']` или `vendor`, и формируется `brandsContext` со списком брендов, который уходит в финальный системный промпт.

То есть бренды НЕ ищутся «в названиях» — они вытягиваются из option `brend__brend` найденных товаров. Сейчас это работает, ничего не меняем.

---

## Что меняем

Только промпты + сводный лог. Никаких изменений в роутинге, slot-логике, ценах, brands, replacement, article-first.

### Изменение 1. Classify (Micro-LLM) — стр. 861–960

Промпт уже хорошо разделяет catalog/brands/info/general и заполняет `search_modifiers` + `critical_modifiers` + `price_intent`. Меняю минимально, без few-shot, чтобы Flash-Lite/Flash работал стабильнее:

- Убираю фразу про «бренды ВСЕГДА латиницей» где она есть в Classify (если попадётся) — **бренды сохраняем как написал пользователь, нормализацию делает уже шаг extractBrandsFromProducts/API**. Это твоя поправка.
- Вносим явное правило: **`intent='catalog'` для ЛЮБОГО упоминания товара/категории/артикула**. Если есть `product_category` — `intent` всегда `catalog` (это уже захардкожено пост-обработкой на стр. 1044, перепроверим что Flash-Lite не путается).
- В `search_modifiers` явно добавить «любой описывающий признак, отличающий товар от других в категории: цвет, материал, количество элементов, размер, мощность, степень защиты, тип монтажа, серия, страна» — формулировка через принцип, БЕЗ конкретных пар «чёрный → tsvet».

### Изменение 2. AI Candidates extractionPrompt — стр. 2063–2206

Уже частично переработан (мы только что туда внесли блок «🔧 ФИЛЬТРЫ ПО ХАРАКТЕРИСТИКАМ»). Доделываю:

- **Артикул**: фразу «числовой код 4–8 цифр» меняем на «токен, похожий на артикул: непрерывная последовательность букв и/или цифр, может содержать точки и дефисы, длиной от 4 символов» — твоя поправка про буквенно-цифровые артикулы. Примеры остаются как есть.
- **Бренд**: убираю формулировку «бренды ВСЕГДА латиницей». Заменяю на: «brand = название бренда в той форме, как пользователь его написал; нормализация регистра/раскладки выполняется на серверной стороне, не подменяй кириллицу на латиницу самостоятельно».
- **category-параметр**: оставляем «не используй» (это уже корректно — параметр category в этой ветке управляется через CategoryMatcher, не через AI Candidates), но без капса «КРИТИЧЕСКИ» — просто инвариантом.
- **Принцип «любой описательный признак → option_filters»**: уже сделано, оставляем.
- Удаляю эмодзи и повторяющиеся «КРИТИЧЕСКИ ВАЖНО» где они дублируют инвариант — снижаем шум для Flash.
- **Followup-блок** (обработка уточняющих ответов) — оставляем, это рабочий кейс.
- **Ценовые сравнения «дешевле/дороже»** — оставляем, работает.

Сама архитектура промпта `extract_search_intent` (tool-call schema) НЕ меняется — это контракт, на котором держится `searchProductsMulti`.

### Изменение 3. FilterLLM resolveFiltersWithLLM — стр. 2689–2710

Текущий промпт уже правильный по структуре (схема как источник истины + строгий запрет hallucination). Добавляем один абзац «семантический маппинг признака → характеристики», без примеров с конкретными цветами:

- Принцип: «модификатор пользователя может быть выражен прилагательным, существительным, числительным, единицей измерения. Сначала определи, какое физическое свойство товара описывает модификатор. Затем найди характеристику в схеме, описывающую то же физическое свойство (по смыслу caption и по природе значений). Только после этого выбирай конкретное значение».
- Добавить инвариант: «Числительное-прилагательное (одинарный/двойной/тройной/четверной) описывает количество — ищи ключ с количественной семантикой». Без перечисления конкретных русских форм — Flash сам справится с морфологией.
- Сохраняем строгий запрет на «ближайшее значение». Сохраняем `semanticNumericFit` safety net (это код, не промпт).

### Изменение 4. CategoryMatcher — стр. 297–315

Текущий промпт уже хороший: 7 правил, явное «не угадывай», возврат пустого массива при отсутствии. Изменения минимальные:

- Правило 2 (исключение аксессуаров) сохраняем как принцип, но добавляем общую формулировку: «исключай категории, чьи товары — это компонент/деталь/аксессуар к запрашиваемому, а не самостоятельный экземпляр запрашиваемого товара». Без хардкод-списка «рамки, коробки, заглушки».

### Изменение 5. Сводный лог фильтров

После `parsed` в AI Candidates (~стр. 2310) — уже добавлено `[AI Candidates] Filters extracted: {...} (model=...)`. Оставляем.

### Изменение 6. Модель AI Candidates

Уже захардкожено `'google/gemini-2.5-flash'` в вызове `generateSearchCandidates` на стр. 4989. Не трогаем — это финальное состояние.

---

## Что НЕ трогаем (явно)

- **Маршрутизация веток** (порядок: slot → article → classify → price-intent → title-first → category-first → replacement → AI Candidates fallback). Полностью сохраняется.
- **slot-логика** (`resolveSlotRefinement`, мерж `resolved_filters`, `unresolved_query`, `getCategoryOptionsSchema` с реальной схемой категории, повторный API-запрос). Полностью сохраняется.
- **Price-сценарии** (max_price/min_price, processPriceIntent, синонимы, локальная сортировка, fallback price-sort перед rerank, price_extreme slot). Полностью сохраняется.
- **Brands-ветка** (extractBrandsFromProducts из option `brend__brend`/vendor найденных товаров). Полностью сохраняется.
- **Replacement-ветка** (matcher → bucket → исключение оригинала → re-create slot). Полностью сохраняется.
- **Cascading relax non-critical фильтров**. Сохраняется.
- **Domain Guard, telecom penalty, suppress-query, broadCandidates, English fallback, rerank**. Сохраняется.
- **JSON-схема `extract_search_intent`** как контракт. Сохраняется.

---

## Файлы

`supabase/functions/chat-consultant/index.ts`:
- стр. 297–315 — CategoryMatcher промпт (минимальная правка правила 2).
- стр. 883–964 — Classify промпт (бренды как у пользователя; принцип-формулировка для search_modifiers).
- стр. 2063–2206 — AI Candidates extractionPrompt (артикул как токен; бренды как у пользователя; убрать дублирующие «КРИТИЧЕСКИ»; сохранить followup и ценовые правила).
- стр. 2689–2710 — FilterLLM systemPrompt (добавить абзац про семантический маппинг признак→характеристика).

Деплой `chat-consultant` после правок — автоматический.

---

## Регресс после деплоя (что я проверю по логам)

| Сценарий | Ожидание |
|---|---|
| «чёрная двухместная розетка» | CategoryMatcher → 2 категории розеток, FilterLLM ловит цвет=чёрный + количество_постов=2, в выдаче только подходящие |
| «16093 есть?» (числовой артикул) | article-first попадает по числовому шаблону, прямой `searchByArticle` |
| «09-0201-002» (буквенно-цифровой артикул) | article-first ловит токен, прямой `searchByArticle` |
| «у вас Legrand есть?» | Classify intent=brands, hasSpecificBrand=true → searchProductsMulti с brand=Legrand |
| «какие бренды розеток у вас?» | Classify intent=brands, brand=null → широкий поиск 50 → extractBrandsFromProducts → brandsContext |
| «дрель Bosch» (бренд кириллицей у пользователя «дрель бош») | brand сохранён как написал пользователь; API нормализует |
| «самая дорогая бензопила» | price_intent=most_expensive → processPriceIntent → max-price, либо clarify+slot |
| «а подешевле?» (после показа товара за 15 000) | AI Candidates ловит max_price=14 999 + восстанавливает категорию из истории |
| «розетки» → бот показал 30+ → «белые» | product_search slot resolves refinement через FilterLLM с реальной схемой категории, мердж фильтров, повторный API-запрос |
| «розетки» (без модификаторов) | category-first matcher, без option_filters, выдача из найденных категорий |

Если хоть один сценарий из этого списка регрессирует — откатываем правку конкретного промпта, остальные оставляем.