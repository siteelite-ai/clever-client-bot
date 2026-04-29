# V2 End-to-End Probe Cases — 29.04.2026

> **НЕ ЧАСТЬ СПЕЦИФИКАЦИИ** (Core Memory §0). Источник кейсов: спека §9 (User Journeys A–G) + §4.6 (similar-ветка) + observed quirks из `probe-cases-2026-04-28.md`. Цель — валидировать V2 end-to-end на ЖИВОМ Catalog API через `chat-consultant-v2` edge function перед переключением `active_pipeline=v2` в проде.
>
> **Метод запуска:** `supabase--curl_edge_functions` против deployed V2 (preview). Каждый кейс — отдельный POST с пустой историей или предзаданным state.
>
> **Формат отчёта (F.3):** `.lovable/fixtures/probe-results-v2-2026-04-29.md` — по каждому кейсу: PASS/FAIL + raw SSE + проверка инвариантов.

---

## Глобальные инварианты (проверяются на КАЖДОМ кейсе)

| ID | Инвариант | Источник |
|----|-----------|----------|
| INV-G1 | `zero_price_leak` метрика == 0 | Core Memory + §4.4 |
| INV-G2 | Карточки товаров ровно по BNF §17.3 (bullet block, pagetitle, sub-bullets) | §17.3 |
| INV-G3 | Нет приветствий («Здравствуйте», «Добрый день») | Core Memory ABSOLUTE BAN |
| INV-G4 | Нет объяснений «что не хватило в фасете» (только soft-fallback tail line §4.8.1) | Core Memory |
| INV-G5 | `auto_narrowing_attempts_total` == 0 | Core Memory |
| INV-G6 | Backslash escaping в названиях запрещён | Core Memory + §17.3 |
| INV-G7 | Cross-sell для similar-ветки НЕ выводится (INV-S2) | §4.6.5 |

---

## Catalog branch (§9.1–9.3, §9.7)

### TC-A1 — Точечный SKU (§9.1)
- **input.message:** `Лампа Б 230-60-2`
- **input.state:** `{}`
- **expect.intent:** `catalog`, `has_sku=true`
- **expect.response:** одна карточка по BNF (если SKU существует) ИЛИ honest-not-found (если нет)
- **expect.latency_p50:** < 2.5s
- **expect.metrics:** `sku_lookup_total += 1`

### TC-A2 — SKU не найден (§9.1 negative)
- **input.message:** `Артикул XYZ-NOT-EXIST-12345`
- **expect.scenario:** `error` ИЛИ `soft_404` без галлюцинации товара
- **expect.contactManager:** true (§5.6.1 path B, scenario ∈ {error, all_zero_price})

### TC-B1 — Категория с дизамбигом (§9.2)
- **input.message:** `розетки чёрные двухгнездовые`
- **expect.intent:** `catalog`, no SKU
- **expect.slot_creation:** `category_disambiguation` ИЛИ прямой результат если категория однозначна
- **expect.no_self_narrowing:** не должен сам выбирать подкатегорию

### TC-B2 — Slot consume (§9.2 шаг 2)
- **input.state:** `{slot: 'category_disambiguation', options: [...]}`
- **input.message:** `бытовые`
- **expect:** slot consumed, query очищен от слова "бытовые", результаты пришли

### TC-B3 — Multi-word category (CASE-3 quirk)
- **input.message:** `двойная розетка`
- **expect:** Category Resolver НЕ выдумывает «Розетки и выключатели» — берёт только то, что вернул `/api/categories`

## Price branch (§9.3 + §4.4)

### TC-C1 — cheapest, large category → price_clarify slot
- **input.message:** `найди самую дешёвую лампочку`
- **expect.routing:** s3-router → s-price (НЕ s-search) — Core Memory
- **expect.probe.total:** > 50
- **expect.action:** `clarify` (price_clarify slot из топ-5 facets)
- **expect.streak:** не меняется (Core Memory: clarify ≠ empty)

### TC-C2 — cheapest, small category → top-3
- **input.message:** `самый дешёвый USB-удлинитель` (probe ожидаемо 7-50)
- **expect.action:** top-3 + счётчик «ещё N»
- **expect.no_zero_price:** ни одна карточка с price=0

### TC-C3 — cheapest, tiny category → show all
- **input.message:** `самый дешёвый ИБП на 10000 ВА`
- **expect.probe.total:** ≤ 7
- **expect.action:** показать все

## Knowledge branch (§9.4)

### TC-D1 — pure knowledge query
- **input.message:** `какая у вас гарантия на электроинструмент`
- **expect.intent:** `knowledge`
- **expect.no_catalog_call:** true
- **expect.source:** hybrid search (FTS + vector) → 1-3 chunks

### TC-D2 — knowledge без релевантных чанков
- **input.message:** `как работает квантовая запутанность`
- **expect:** honest «не знаю» ИЛИ out_of_domain (§9.5)

## Out-of-domain (§9.5)

### TC-E1 — явно вне домена
- **input.message:** `автомобильные шины зимние`
- **expect.no_api_call:** true
- **expect.contactManager:** true (path B: scenario=out_of_domain)

## Escalation (§9.6)

### TC-F1 — direct request
- **input.message:** `ничего не понимаю, дайте менеджера`
- **expect.intent:** `escalation`, `trigger='direct_request'`
- **expect.contains:** `[CONTACT_MANAGER]`

## Replacement (§9.7)

### TC-G1 — «уже не выпускается»
- **input.message:** `Б 230-60-2 уже не выпускается, что вместо?`
- **expect.is_replacement:** true
- **expect.routing:** §9.7 Replacement (НЕ §4.4 price logic) — Core Memory
- **expect.response:** карточка-замена + 1-2 предложения почему

---

## Similar branch (§4.6 + INV-S1..S4)

### TC-S1 — INTENT_SKU path (§4.6.2 path 1)
- **input.message:** `похожие на Б 230-60-2`
- **input.state:** `{}` (без anchor)
- **expect.anchor_resolution:** anchor_sku ← intent.sku_candidate
- **expect.tool_calls:** ровно 1 × `classify_traits` (INV-S1)
- **expect.disallowCrosssell:** true (INV-S2)
- **expect.no_crosssell_text:** в ответе НЕТ cross-sell абзаца

### TC-S2 — LAST_SHOWN path (§4.6.2 path 2)
- **input.state:** `{last_shown_product_sku: 'a043418'}` (после TC-A1 успешного)
- **input.message:** `похожие`
- **expect.anchor_resolution:** anchor_sku ← state.last_shown_product_sku
- **expect.recommendationContext:** строка «Подобрал по характеристикам: …» в начале ответа

### TC-S3 — CLARIFY_ANCHOR path (§4.6.2 path 3 + INV-S3)
- **input.state:** `{}` (без anchor, без last_shown)
- **input.message:** `похожие`
- **expect.action:** `clarify_anchor` — один вопрос «на что именно похожие?»
- **expect.no_slot_creation:** slot-state НЕ меняется (INV-S3)

### TC-S4 — Anchor lifecycle WRITE
- **Шаг 1:** TC-A1 (1 товар, scenario=normal)
- **expect after step 1:** `state.last_shown_product_sku === '<article из TC-A1>'`
- **Шаг 2:** запрос «розетки» (>1 товара)
- **expect after step 2:** `state.last_shown_product_sku === null` (RESET по anchor-tracker)

### TC-S5 — Anchor lifecycle PRESERVE через lightweight ход
- **Шаг 1:** TC-A1 → anchor выставлен
- **Шаг 2:** `как у вас с гарантией?` (knowledge, lightweight)
- **expect:** anchor СОХРАНЁН после knowledge-хода
- **Шаг 3:** `похожие` → должен использовать anchor из шага 1

---

## Catalog API quirks regression (из CASE-1..6)

### TC-Q1 — non-ASCII facet key (§9.2c recovery-then-degrade)
- **input.message:** `розетки белые двухгнездовые`
- **expect:** если facet возвращает total=0 (broken non-ASCII key) → recovery до пустого фасета, НЕ degraded silently
- **expect.metric:** `recovery_attempts_total += 1`

### TC-Q2 — Substring leak (CASE-5: «corn» vs «Corner»)
- **input.message:** `corn lamp` ИЛИ `кукуруза лампа`
- **expect.word_boundary:** «Corner Светильник» отфильтрован
- **expect.metric:** `query_word_boundary_filtered_total > 0`

### TC-Q3 — Product.name=null fallback
- **input:** любой запрос, где API вернёт товар с `name=null`
- **expect:** карточка использует `pagetitle` (Core Memory)
- **expect.no_crash:** ветка не падает

### TC-Q4 — price=0 hard-ban (double-filter)
- **input:** запрос, где топ результатов содержит price=0 товары
- **expect:** ни одной карточки с price=0 в финальном ответе
- **expect.metric:** `zero_price_leak === 0`

---

## Сводка покрытия

| Branch | Кейсов | §-источник |
|--------|--------|------------|
| Catalog (SKU/category) | 5 (A1, A2, B1, B2, B3) | §9.1–9.2 |
| Price | 3 (C1, C2, C3) | §9.3 + §4.4 |
| Knowledge | 2 (D1, D2) | §9.4 |
| Out-of-domain | 1 (E1) | §9.5 |
| Escalation | 1 (F1) | §9.6 |
| Replacement | 1 (G1) | §9.7 |
| Similar | 5 (S1–S5) | §4.6 |
| API quirks regression | 4 (Q1–Q4) | observed |
| **ИТОГО** | **22 кейса** | |

---

## Готовность к F.2

После approval этого списка → переходим к F.2:
1. Убедиться, что `chat-consultant-v2` deployed в preview.
2. Прогнать 22 POST через `supabase--curl_edge_functions`, собрать raw SSE.
3. Записать результаты в `probe-results-v2-2026-04-29.md`.
