## Контекст

Сейчас в V1 (`chat-consultant/index.ts`) есть два связанных, но сломанных/отсутствующих сценария:

**B. «Замена по характеристикам»** (`is_replacement=true`, `has_product_name=true`).
- Ветка ЕСТЬ (строки 8267–8430, `Replacement matcher`), но в логе из последнего сообщения сработал `pass2-shortcircuit` и отрендерился сам исходный товар с `price=0` — нарушение HARD BAN.
- Корни (3 шт.):
  1. `articleShortCircuit` поставился где-то выше по common-pipeline (не в name-first — он guard'нут на 6511), и `replacementMeta` не сформировался → `originalProduct=null` → фильтр исключения оригинала (8408) — no-op.
  2. После replacement-matcher нет double-фильтра `price=0`.
  3. Из классификатора **не извлекается price-cap из фразы замены** («не дороже 1000 тг») — `price_intent` живёт отдельно и до replacement-ветки не доносится.

**A. «Характеристики раздела»** (нет такой ветки вообще).
Запросы типа «найди светильники по таким-то характеристикам», «какие IP бывают у уличных светильников» сейчас уходят в обычный catalog-flow → высыпается выдача товаров. Пользователю нужно: показать СПИСОК доступных характеристик/значений раздела (+ мини-сэмпл товаров), чтобы он уточнил.

## Цель

1. Починить ветку B — чтобы она реально работала как «similar по anchor с учётом price-cap», БЕЗ показа исходного товара и БЕЗ `price=0`.
2. Добавить ветку A — `sub_intent='facets'` (или `compute.attribute` для одиночной характеристики), которая возвращает facet-summary раздела вместо карточек.

Никаких словарей синонимов, никакого хардкода категорий — всё через LLM + live catalog API (соответствует core-правилам spec data-agnostic).

## Изменения

### 1. Классификатор (`classifier-prompt.ts` + парсер)
Расширяем JSON-схему ответа (data-agnostic, без примеров категорий):
- `sub_intent`: добавить значение `'facets'` — «пользователь спрашивает про характеристики/опции раздела, без интереса к конкретному товару».
- `price_intent` **должен заполняться и при `is_replacement=true`** (сейчас классификатор это пропускает по дефолту). Добавить в инструкции: «если в запросе на замену есть ценовая граница — обязательно заполняй `price_intent`».
- `is_replacement=true` уже триггерит ветку B; новых полей не нужно.

Самопроверка контракта остаётся: `len(modifiers) == N_input − N_cat − N_wrap` (см. mem://classifier/token-preservation).

### 2. Роутер (`chat-consultant/index.ts`)

Добавить **раннюю проверку sub_intent='facets'** в s3-роутере (до name-first, до replacement, до catalog-flow):

```text
if (classification.sub_intent === 'facets' && effectiveCategory) {
  → branch s-facets  (см. п.3)
  return
}
```

Гард `is_replacement` уже корректно выключает name-first (6511) — оставляем.

### 3. Новая ветка `runFacetsSummary` (новый файл `_shared/facets-summary.ts`)
Алгоритм:
1. Category Resolver → exact `pagetitle` категории (через `matchCategoriesWithLLM`, уже есть).
2. Параллельно: `/categories/options` (live → bootstrap fallback из probe) + `/products?category=<X>&per_page=3` (мини-сэмпл).
3. Фильтр facet-ключей через `FACET_BLACKLIST_KEYS` (уже есть в v2, переэкспортировать в `_shared/`).
4. Композер: bullet-блок по ТОП-5 facet'ам (`caption_ru` + 3-5 наиболее частых `value_ru`), затем «Хотите, подберу с конкретными значениями?». Карточки товаров **не показываем** (или 1-2 как пример, по флагу).
5. Сохраняем `dialog_slots.facets_offer = {category, schema}` — следующее сообщение пользователя с конкретными значениями уходит уже в обычный catalog-flow с уже резолвнутой категорией.

### 4. Фикс ветки B (replacement по характеристикам)
Локально в блоке 8267–8430:
- (a) **Перенести assignment `replacementMeta`** ДО любого short-circuit, чтобы фильтр исключения оригинала (8408) всегда имел `originalId`. Если `originalProduct=null` после `searchByPagetitle/article` — делаем явный `searchByPagetitle(classification.product_name)` РАЗ, забираем `originalProduct` и продолжаем; иначе ветка считает себя «случай 2» (товара нет в каталоге).
- (b) **Добавить `excludeZeroPrice`** двойным фильтром перед `pickDisplayWithTotal` (8411): `rFinal = rFinal.filter(p => (p.price ?? 0) > 0)`. Метрика `zero_price_leak` остаётся 0.
- (c) **Прокинуть `price_intent.cap`** в `searchProductsByCandidate` через `max_price` во всех вызовах внутри блока (8327, 8333, 8364, 8385) — это закроет «не дороже 1000 тг».
- (d) **Запретить отдачу самого товара через articleShortCircuit без replacement-обработки**: добавить guard «если `is_replacement && articleShortCircuit && !replacementMeta` → НЕ рендерить, передать управление в replacement-блок». Сейчас именно эта ситуация привела к показу price=0 ДКУ-LED-03-100W.

### 5. Детерминистичный рендер
- Ветка A (`s-facets`) **не** идёт через `buildDeterministicShortCircuitContent` (там нет продуктов) — собственный шаблон facet-bullet.
- Ветка B продолжает идти через детерминистичный рендер (как сейчас), плюс `replacementMeta.original` подставляется в intro («Вместо «{originalName}» подобрал похожие, не дороже {cap} ₸:»).

### 6. Тесты (Deno)
Новые файлы:
- `_shared/facets-summary_test.ts` — bootstrap+live schema, blacklist, фильтр price=0 в сэмпле, top-N выбор.
- `chat-consultant/replacement-zero-price_test.ts` — фикс (b): на синтетическом pool с `price=0` ни одна карточка не утекает.
- `chat-consultant/replacement-price-cap_test.ts` — фикс (c): при price_intent.cap=1000 все вызовы `searchProductsByCandidate` получают `max_price=1000`.
- `chat-consultant/router-facets-intent_test.ts` — sub_intent='facets' уходит в новую ветку до name-first.

### 7. Памятки
Добавить mem://features/facets-summary и mem://features/replacement-fix-2026-05-18; обновить Core-строку про replacement.

## Что НЕ трогаем
- V2 (`chat-consultant-v2`) — там уже есть s-similar/s-search; перенос идей сделаем отдельным шагом после стабилизации V1.
- Frontend / widget / SSE-транспорт.
- Compute (spec_query) — остаётся как сейчас (отдельная надстройка для одиночной характеристики ОДНОГО товара).
- Cross-sell, jargon-fallback, QFv2 — не задеваем.

## Порядок реализации (по одному шагу с подтверждением)
1. Расширить классификатор (`sub_intent='facets'` + price_intent при replacement) + тесты.
2. Фикс B — три подпункта (a/b/c/d) одной правкой + 2 теста.
3. Новая ветка A (`facets-summary.ts` + роутер + тест).
4. Памятки + проверка curl-replay двух сценариев из примера.

Жду «ок шаг 1», действую только по нему.
