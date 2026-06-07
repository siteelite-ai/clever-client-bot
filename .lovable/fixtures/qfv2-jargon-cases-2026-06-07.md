# QFv2 Jargon-Recovery fixtures (V1, 2026-06-07)

Класс кейсов: ветка `qfv2_honest_empty_partial` теперь сначала пробует
`tryJargonFallback` (mem://features/jargon-fallback) и только при его пустом
ответе уходит в honest-empty. Патч инжектирован в
`supabase/functions/chat-consultant/index.ts` внутри блока
`if (resolverUnresolvedDetails.length > 0)`.

---

## 1. «есть лампа кукуруза?» — production-инцидент (recovery)

**Classifier:**
```json
{
  "intent": "catalog",
  "sub_intent": "availability",
  "has_product_name": true,
  "product_name": "лампа кукуруза",
  "product_category": "лампа",
  "search_modifiers": [],
  "critical_modifiers": []
}
```

**Pipeline до патча:**
- `pagetitle`/`name-query` → 0.
- `has_product_name → QFv2 bridge` синтезирует `modifiers=["кукуруза"]`.
- QFv2 pool по `"лампа кукуруза"` → 0 → retry `"лампа"` → 100, bootstrap собирает
  schema из этих 100 ламп.
- `resolveFiltersWithLLM` пытается уложить «кукуруза» в `forma_kolby__kolbanyң_pіshіnі`,
  но в bootstrap-выборке только `["свеча","груша"]` → `unresolvedDetails=[…]`.
- Раньше: `qfv2_honest_empty_partial` → Soft-404 «Форма колбы».

**Pipeline после патча:**
- В блоке `resolverUnresolvedDetails.length > 0`:
  1. `tryJargonFallback({ originalQuery: "есть лампа кукуруза?", … })`
     → Claude Sonnet 4.5 предлагает alternatives типа `["corn lamp", "лампа-початок"]`.
  2. `searchProductsByCandidate("corn lamp", …)` → ≥1 товар.
  3. `branchTag = 'qfv2_jargon_recovery'`, `totalCollectedBranch = 'jargon-fallback'`
     (перезаписывается на `'qfv2_jargon_recovery'` на строке 8549; роли не играет —
     детерминистичный рендер срабатывает по `articleShortCircuit=true`).
- Карточки corn-ламп через `buildDeterministicShortCircuitContent`.

**Acceptance:**
- В логах `step: 'qfv2-jargon-recovery'` с `total ≥ 1` и
  `meta.matchedAlternative` непустой.
- `branchTag = 'qfv2_jargon_recovery'`.
- Финальный ответ — карточки ламп (corn / лампа-початок), БЕЗ Soft-404.
- Никаких упоминаний «Форма колбы» / «дропнут фасет».

---

## 2. «ВВГнг 3х2.5» — регрессия bridge → qfv2_win (нет jargon)

**Classifier:**
```json
{
  "intent": "catalog",
  "sub_intent": null,
  "has_product_name": true,
  "product_name": "ВВГнг 3х2.5",
  "product_category": "кабель",
  "search_modifiers": [],
  "critical_modifiers": []
}
```

**Pipeline (не меняется):**
- bridge синтезирует `modifiers=["ВВГнг", "3х2.5"]`.
- pool по `"кабель ВВГнг 3х2.5"` → пусто → retry → 100 кабелей, bootstrap.
- `resolveFiltersWithLLM` распознаёт оба модификатора → `resolvedFilters` непустой,
  `unresolvedDetails=[]`.
- Ветка `if (resolverUnresolvedDetails.length > 0)` НЕ выполняется → jargon-recovery
  НЕ запускается → final fetch → `qfv2_win`.

**Acceptance:**
- `branchTag` остаётся `qfv2_win` (или `qfv2_pool_rescue` / `qfv2_honest_empty` в
  зависимости от результата фильтрации — но НЕ `qfv2_jargon_recovery`).
- В логах НЕТ step `qfv2-jargon-recovery` / `qfv2-jargon-recovery-skip`.

---

## 3. Жаргон без альтернатив (graceful fallback)

Гипотетический запрос вида «есть тыква-фара?»: jargon-LLM возвращает пустой
`alternatives` (или каждый alt → 0 товаров).

**Acceptance:**
- `step: 'qfv2-jargon-recovery-skip'` с `meta.reason = 'empty'`.
- `branchTag = 'qfv2_honest_empty_partial'` (старое поведение сохраняется).
- Soft-404 с честным контекстом `attemptedFacets` и предложением менеджера.

---

## Источник данных

- Кейс №1 — реальный production-инцидент (RequestLogs `/logs`, 2026-06-07).
- Кейс №2 — anti-regression guard для has_product_name bridge.
- Кейс №3 — конструктивный happy-path для silent fallback при пустом jargon.
