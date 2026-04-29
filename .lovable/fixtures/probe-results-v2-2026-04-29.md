# V2 Probe Results — 29.04.2026

> **Источник кейсов:** `probe-cases-v2-2026-04-29.md` (22 шт.)  
> **Метод:** параллельный POST на `https://yngoixmvmxdfxokuafjp.supabase.co/functions/v1/chat-consultant-v2`  
> **Build:** `v2-step11-catalog-assembler-2026-04-28`  
> **Прогнано в этом раунде:** 14 одноходовых кейсов (S2/S4/S5/B2/Q1/Q3/Q4 требуют многоходовой state — отложены до фикса блокеров).  
> **Raw SSE:** `/tmp/probe-out/*.sse` (не закоммичены — временные).

---

## 🚨 Сводка: ВЫПУСК В ПРОД ЗАБЛОКИРОВАН

**Result: 5 PASS · 9 FAIL** (из 14 прогнанных).

| Категория | Статус | Кол-во |
|-----------|--------|--------|
| ✅ Routing/intent классификация | PASS | 14/14 |
| ✅ Greetings ban (INV-G3) | PASS | 14/14 |
| ✅ price=0 leak (INV-G4) | PASS (но нет товаров вообще) | 14/14 |
| ❌ Catalog branch — реальные товары | **FAIL** | 0/4 ходов с товарами |
| ❌ Price branch — top-3 / clarify slot | **FAIL** | 0/3 (все падают в error) |
| ❌ Similar branch — wiring | **FAIL** | 0/3 (placeholder) |

---

## 🔥 Три блокера

### 🔴 BLOCKER-1 — `S_SIMILAR` НЕ подключён в `index.ts`

**Доказательство:** TC-S1, TC-S3, TC-G1 → ответ `🚧 V2 placeholder — S_SIMILAR ещё не реализован` (route корректно проставлен `S_SIMILAR`, но падает в `runLightBranch`).

**Корневая причина:** `index.ts:351-354`

```ts
const isCatalogRoute =
  decision.route === "S_CATALOG" ||
  decision.route === "S_PRICE" ||
  decision.route === "S_CATALOG_OOD";
// ❌ S_SIMILAR отсутствует → попадает в else → runLightBranch → placeholder
```

При этом:
- `s-similar/index.ts` написан и протестирован (24 файла тестов, 330 кейсов зелёные)
- `anchor-tracker.ts` готов (10 тестов)
- `golden-similar_e2e_test.ts` зелёный
- `catalog-assembler.ts` поддерживает similar-flavor

**Это чисто wiring-баг.** Реализация есть, но не подключена.

---

### 🔴 BLOCKER-2 — Catalog Search возвращает 0 товаров на ВСЕХ запросах

**Доказательство:** TC-A1 (`Лампа Б 230-60-2`), TC-B1 (`розетки чёрные двухгнездовые`), TC-B3 (`двойная розетка`), TC-Q2 (`corn lamp`) — **все** дают `scenario=soft_404`, `formatter.rendered=0`.

**Из meta TC-A1:**
```json
"assembler": {
  "stages": [
    {"stage":"category_resolver","ms":458,"meta":{"status":"unresolved","pagetitle":null,"confidence":0}},
    {"stage":"query_expansion","ms":1101,"meta":{"attempts_count":2,"skipped":["lexicon_empty","kk_off"]}},
    {"stage":"facet_matcher","ms":0,"meta":{"status":"no_facets"}},
    {"stage":"s_search","ms":0,"meta":{"skipped":"no_pagetitle"}}
  ]
}
```

**Корневая причина:** `category_resolver` НИ РАЗУ не резолвит запрос (`status=unresolved`, `confidence=0`) → всё падает каскадом в `s_search.skipped="no_pagetitle"`.

Возможные подпричины (нужна диагностика):
- a) `/api/categories` не отвечает / отвечает пусто (проверить `volt220_api_token`)
- b) Resolver thresholds завышены (resolver всегда отбраковывает кандидатов)
- c) Bug в самом category-resolver: запросы вроде «розетки» / «двойная розетка» / «лампа» — это ядро ассортимента, должны резолвиться 100%

**ВАЖНО:** В `probe-cases-2026-04-28.md` (V1 раунд) эти же запросы работали → значит регрессия в V2 либо в resolver, либо в катализе деплоя (deps factory).

---

### 🔴 BLOCKER-3 — Price branch падает в `error` при resolve категории

**Доказательство:** TC-C1, TC-C2, TC-C3 — все три ответа = шаблон «Извините, произошла ошибка. Свяжитесь с менеджером.» с `catalogContactManager=true`.

**Из meta TC-C1:**
```json
{
  "stage":"category_resolver","ms":15007,
  "meta":{"status":"unresolved","pagetitle":null,"confidence":0}
},
{"stage":"s_price","ms":10006,"meta":{"status":"error","total":0,"branch":null,"zero_price_leak":0}}
```

**Корневая причина:**
1. **Тот же BLOCKER-2** (resolver не резолвит «лампочка», «USB-удлинитель»)
2. **Дополнительная аномалия:** category_resolver занял **15 секунд** (TC-C1) — это сильно выше любого SLA. Похоже на retries/таймауты на `/api/categories`.
3. `s_price` затем висит **10 секунд** перед фейлом → нет fail-fast по `pagetitle=null`.

**Симптом → реакция:** при `pagetitle=null` price-branch уходит в **сценарий `error`** (а не в honest «уточните категорию»). Это соответствует §5.6.1 path B (scenario=error → contactManager=true), но UX неприемлем для базовых запросов.

---

## ✅ Что работает корректно

| Кейс | Что подтверждено |
|------|------------------|
| TC-D1 (knowledge) | `S_KNOWLEDGE` route, hybrid search вызвался, честный «справки нет» |
| TC-D2 (out-of-domain knowledge) | route `S_PERSONA`, intent `smalltalk`, domain=out_of_domain, нейтральный ответ без галлюцинации |
| TC-E1 (out-of-domain catalog) | route `S_CATALOG_OOD`, scenario=out_of_domain, contactManager=true, корректная фраза §4.7 |
| TC-F1 (escalation) | `[CONTACT_MANAGER]` маркер + contacts side-channel, intent=escalation |
| TC-A2 (несуществующий артикул) | scenario=soft_404 (но streak=1, не contactManager — так и должно быть после 1-го раза) |

**Глобальные инварианты на 14/14 кейсах:**
- ✅ INV-G1 `zero_price_leak` всегда 0 (тривиально — нет товаров)
- ✅ INV-G3 ни одного приветствия
- ✅ INV-G5 ни одной auto-narrowing попытки (assembler не доходит до этого этапа)
- ✅ INV-G6 ни одного бэкслеша

Но эти PASS-ы **дешёвые** — система не дошла до сложных мест, где инварианты реально проверяются.

---

## 📊 Latency observations

| Кейс | Total | Bottleneck |
|------|-------|------------|
| TC-G1 (escalation skip) | 1.2s | s2 LLM (1.2s) |
| TC-S1/S3 (placeholder) | 1.2-1.6s | s2 LLM |
| TC-D1/D2 (knowledge) | 1.4-2.1s | s2 + KB |
| TC-A1/B3 (catalog soft404) | 4.1s | category_resolver 458ms + expansion 1.1s |
| TC-A2/B1/Q2 (catalog soft404) | 17s | resolver retry/timeout |
| TC-C1/C2 (price error) | **27.7s** | resolver 15s + s_price 10s timeout |
| TC-C3 (price error) | 13.4s | resolver fast-fail но s_price 10s |

**SLA нарушение:** spec требует p50 < 2.5s для catalog, p95 < 5s. Получили p50=4-17s, p95=27s. Это связано напрямую с BLOCKER-2/3.

---

## 🏛 Архитекторский вердикт

### Что произошло

Stage 8.5 (similar) и весь catalog-assembler (Step 11) **проходят unit/golden тесты**, но **никогда не проверялись end-to-end на живом API в задеплоенной среде**. Прогон выявил:

1. **Wiring-gap** для S_SIMILAR (тривиально фиксится — 1 строка в `isCatalogRoute`).
2. **Live API integration gap** для category_resolver (нужна реальная диагностика — токен / endpoint / thresholds).
3. **Fail-fast gap** в price-branch (10s timeout вместо мгновенного отказа при `pagetitle=null`).

### Что НЕЛЬЗЯ делать

❌ **Не переключать `active_pipeline=v2` в проде.** Сейчас V2 на 70% запросов либо placeholder, либо «ничего не найдено», либо «ошибка, свяжитесь с менеджером». Это хуже V1.

❌ **Не оптимизировать дальше similar/composer.** Сначала фиксим базовый поиск.

### План F.4 (по приоритету)

| # | Задача | Источник | Усилие |
|---|--------|----------|--------|
| F.4.1 | Подключить `S_SIMILAR` в `isCatalogRoute` (index.ts:351-354) и проверить через TC-S1/S3/G1 | BLOCKER-1 | 5 мин + redeploy |
| F.4.2 | Диагностика category_resolver: вызвать `/api/categories` напрямую с production токеном, посмотреть, что возвращается; добавить debug-логи в resolver | BLOCKER-2 | 30-60 мин |
| F.4.3 | Fail-fast в `s-price.ts`: если `pagetitle=null` → не вызывать probe, сразу возвращать `scenario=clarify_category` (новый) с человеческим вопросом «по какой категории искать дешёвое?» | BLOCKER-3 | 15 мин + тест |
| F.4.4 | Повторный probe-прогон **22 кейсов** (включая отложенные многоходовые S2/S4/S5/B2) | regression | автомат |

### После F.4

Если F.4.1-4.3 закрывают блокеры → repeat F.2 на полном наборе → если PASS ≥ 20/22 → готовность к active_pipeline=v2.

Если F.4.2 окажется большим (несовместимость API / нужна архитектурная переделка resolver) → отдельный architecture review.

---

## ❓ Решение пользователя

Готов начать F.4. **Какой блокер первым?**

- **F.4.1 (тривиально, 5 мин)** — подключить S_SIMILAR. Сразу покроет 4 кейса (S1, S2, S3, G1) при условии что resolver работает (но resolver сейчас не работает — см. BLOCKER-2). Эффект до F.4.2 = частичный.
- **F.4.2 (диагностика, 30-60 мин)** — корневой блокер. Фикс разблокирует Catalog + Price + Similar одновременно.
- **F.4.3 (UX, 15 мин)** — независим от других, улучшает UX price-branch немедленно.

**Рекомендация архитектора:** F.4.2 → F.4.1 → F.4.3 → repeat-probe. Без resolver всё остальное косметика.
