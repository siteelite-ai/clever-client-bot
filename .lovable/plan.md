# M1 — Аудит V3 (2026-06-29)

Цель аудита: разделить весь код `chat-consultant-v3/index.ts` (3307 строк) на две группы — **«мышление LLM»** (надо удалить, перенести в промпт) и **«контракт системы»** (надо оставить, это не догадки про намерение).

Принцип разделения (от пользователя): мышление = в нейронке. Серверный код = только то, без чего нельзя гарантировать инвариант контракта (anti-hallucination, price=0, бюджет клиента, корректное логирование).

## Карта index.ts

| Блок | Строки | Что делает | Категория | Решение |
|---|---|---|---|---|
| Bootstrap (imports, CORS, settings, dispatch) | 1–192 | SSE-кодер, runTool, summarisers, loadSettings | **контракт** | оставить |
| `normalizeForMatch` / `normalizeCodeLike` | 194–201 | строковая утилита | утилита | оставить (нужна для facts-leak гарда) |
| `isRiskyCategoricalFacet` | 203–207 | словарь "forma/tip/cvet…" — список жанров фасета | **мышление** | **удалить** |
| `stemRu` + `tokenMatchesEvidenceByStem` + `valueIsEvidenced` | 209–262 | стеммер + лексическое доказательство | **мышление** (только для compound-гарда) | **удалить** |
| `ACKNOWLEDGEMENT_TOKENS` + `extractEchoLabel` + `stripKnownValues` + `buildNoIntersectionText` | 267–344 | сервер пишет фразу за LLM | **мышление** (хуже — за LLM пишет UI-текст) | **удалить** |
| `topFacetOptions` + `facetValueEquals` + `traitValuesForFacet` | 309–357 | вспомогательные для гардов ниже | **мышление** | **удалить вместе с гардами** |
| `guardedOutcomeForSearch` | 359–480 | главный compound-constraint guard | **мышление** (это и есть "5 системных фиксов") | **удалить** |
| `detectNumericTruncationInOptions` | 486–522 | "ты сказал 2.5, передал 2" | пограничное — **механика**, не догадка про смысл | **оставить как валидатор tool-input** (но вернуть LLM как `bad_input` без подстановки фразы) |
| `classifyOptionsSource` (user_explicit / inferred) | 528–546 | угадывает, откуда взялась опция | **мышление** | **удалить** |
| `promiseRealityCheck` | 553–604 | сверяет числа в первом пузыре с карточками | **мышление** (LLM не должен обещать до тула — это правило промпта) | **удалить** |
| `detectPriceDirection` + `extractBudgetCap` + `findAnchorInCache` + price-rewrites | 607–~1100 | переписывает product_ids под "дешевле/дороже/самый" | **мышление** (есть `sort_cheapest`/`sort_expensive` + by_article якорь) | **удалить guard, оставить только `extractBudgetCap` как safety-валидатор max_price в render** |
| `ReplacementAxis`, `filterReplacementCompatibleIds`, `isAnalogPortableToken`, family-exclude | ~1100–1290 | пост-фильтр аналогов по осям | **мышление** (replacement_anchoring в промпте уже описан) | **удалить** |
| `extractCodeConstraints` + `INTENT_STOPWORDS` + `semanticTokensFromQuery` | 1274–1340 | feed для compound-гарда | **мышление** | **удалить вместе с guardedOutcomeForSearch** |
| `relaxToolArgsFromDialogueChoice` + `relaxToolArgsFromUserIntent` | строки выше 2300 | "клиент сказал «просто» → выкидываем modifier" | **мышление** | **удалить, заменить инвариантом в промпте** |
| `trySplitFallback` + sticky options | 1358–1410 | разбивка осей при 0 | **мышление** | **удалить — LLM сам сделает второй tool-call** |
| `compactDiscoverCategoryForLlm` + `toolResultForLlm` + `emitSideEffects` | 1418–1528 | компактирование данных для LLM, маскировка side-effects | **контракт** (защита от facts-leak: html_block не уходит в LLM) | **оставить** |
| `callOpenRouter` + per-phase timeouts | 1530–~1800 | транспорт | **контракт** | **оставить** |
| Anchor tracker / family-exclude state | разбросано | трекинг якоря из истории | **мышление** | **удалить** |
| Category Whitelist Guard | 2239–2275 | если LLM передал category, которой не было в discover — подменить | **мышление** (это всё про "угадать намерение"; лучше — discover_category возвращает чёткий список, и в промпте инвариант) | **удалить, перенести в tool description** |
| Render-time facts-leak / Anti-hallucination | где-то после 2400 | блок текста с URL/ценой, если render не сделан | **контракт** (anti-hallucination invariant §1) | **оставить** |
| Budget Cap Hard Post-Filter | 2523+ | срезает товары дороже потолка из render | **контракт** (бюджет = жёсткий инвариант от клиента, §price_anchoring C) | **оставить как safety, не основной механизм** |
| Главный turn-loop, persistence в `chat_request_logs` | вокруг | оркестрация | **контракт** | **оставить** |

## Итог по категориям

**Контракт (оставляем):** ~600–800 строк.
- Транспорт (SSE, OpenRouter call, timeouts).
- Tool dispatch + ProductCache.
- `toolResultForLlm` (маскирование html_block, чисел в карточках от LLM).
- Anti-hallucination text-facts-leak guard (post-render проверка URL/цен в тексте).
- HARD BAN price=0 (уже в `executeSearchCatalog` + render).
- Budget cap hard-filter (safety, не «мышление»).
- Numeric truncation как tool-input валидатор → возвращает `ok:false bad_input "вы написали 2.5, передали 2"`, LLM сам исправляет.
- Логирование `chat_request_logs.steps[]`.

**Мышление (удаляем):** ~1500–1700 строк.
- Все compound-constraint / semantic-token / intent-stopword / evidence-stem гарды.
- Price-direction rewriting (LLM использует sort_* + by_article).
- ReplacementAxis post-filter (LLM ведёт ось в промпте через `<replacement_anchoring>`).
- Relax-from-user-intent (заменяется правилом в промпте: «не наследуй modifier между ходами, если клиент не повторил»).
- Split fallback (LLM сам делает второй tool-call).
- No-intersection text builder (LLM формулирует сам).
- Category whitelist guard (переносим в tool description).
- Anchor tracker (LLM держит контекст сам — он у него в history).
- Promise-reality check (правило промпта: не обещай числами до тула).

После чистки `index.ts` ужмётся с **3307 → ~1300 строк**.

## Что усиляем в промпте (`schemas.ts`)

Промпт сейчас (406 строк) — уже принципиально хороший: data-agnostic, секционированный (`<role>`, `<tone>`, `<dialog_protocol>`, `<reasoning_approach>`, `<jargon_translation_ladder>`, `<price_anchoring>`, `<replacement_anchoring>`). Менять структуру не надо. Нужно **прицельно добавить 3 инварианта**, которые сейчас держатся серверными гардами:

1. **History-relax инвариант** (заменяет `relaxToolArgsFromUserIntent`):
   > Между ходами не наследуй modifier из предыдущего хода, если клиент его НЕ повторил. Триггер сброса — слова вроде «просто/только/без/любую/всё равно какую» в текущей реплике.

2. **Promise-after-tool инвариант** (заменяет `promiseRealityCheck`):
   > В первом пузыре до тула называй только тип, цоколь, форму, IP и т.п. — но не конкретное числовое значение, которого ты ещё не подтвердил тулом. Числа — после ответа `search_catalog`.

3. **Compound-honesty инвариант** (заменяет `guardedOutcomeForSearch`):
   > Если клиент назвал несколько признаков (тип + код/значение), и `search_catalog` по их сочетанию вернул 0 — не показывай результат по одному из них как «вот что нашёл». Сделай второй `search_catalog` по каждому признаку отдельно, и финальным пузырём честно: «по сочетанию нет; по A есть; по B есть отдельно».

## Что обновится в спеке

Копия `.lovable/specs/expert-orchestrator-v3.v2-2026-06-29.md`:
- §1 принципы: добавить «**LLM-first thinking**: серверный код не угадывает намерение. Серверный код = только anti-hallucination, price=0 ban, budget cap, numeric integrity, transport».
- §3 Tool catalog: оставить как есть.
- §4 State Machine: упростить — убрать упоминания серверных гардов.
- §6 Промпт-контракт: вписать три новых инварианта.
- §7 Логирование: удалить метрики гардов (`v3_guard_*`); оставить только `v3_turn_*`, `v3_tool_call`, `v3_render`, `v3_hallucinated_url_total`, `v3_zero_price_leak_total`, `v3_budget_violation_total`.

## Master-список кейсов (для M3)

Берётся из текущего сообщения пользователя (25 кейсов), фиксируется в `.lovable/fixtures/qa-25-cases-2026-06-29.md`.

## Решения по открытым вопросам (от пользователя, 2026-06-29)

- **Numeric truncation** — **УДАЛИТЬ**. LLM передаёт значение как сказал клиент (2.5 → "2.5"), запятая/точка — забота API. Никаких серверных правок tool-input.
- **Budget cap hard-filter** — **ОСТАВИТЬ** как safety (явный контракт от клиента).
- **price=0** — **ОСТАВИТЬ** как жёсткий контракт (уже в `render.ts` и `search-catalog.ts`).
- **Family-exclude** — гибрид: сервер исключает **только сам якорный SKU** (однозначный контракт «аналог ≠ этот же товар», экономит токены LLM). Решение «исключать ли всю серию» — инвариант в промпте `<replacement_anchoring>`: другой бренд/серия предпочтительны, но модели той же серии допустимы, если ближе по характеристикам.
- **Category whitelist** — переношу в tool description `search_catalog` («`category_in` — только из `leaf_categories` последнего `discover_category` этого хода»).
