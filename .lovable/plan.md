
# План: Accessory-for pattern (V1)

## Цель

Корректно отвечать на запросы вида «какие [Y] подходят к [X]» / «лампочки для [X]» / «диск к [X]» — показывать товары категории Y, а не якорь X. Решение системное: новая семантика в классификаторе + отдельная ветка в роутере, без патча pagetitle short-circuit.

## Объём (этапы 1+2 одним PR)

### Этап 1 — Расширение классификатора

**Файл:** `supabase/functions/_shared/classifier-prompt.ts`

Добавить:
1. Новое значение `sub_intent = "accessory_for"`.
2. Новое поле в JSON-контракте: `anchor_product: string | null` — товар-якорь, к которому подбираем.
3. Правило детекции (data-agnostic, без списков категорий):
   - Маркеры: предлоги «к / для / под / в комплект к / совместим с / подходит к / подходящий к / подходящие к» + следом существительное-товар (или его развёрнутое название).
   - Структура: `[target_noun] + <маркер> + [anchor_phrase]` ИЛИ `<маркер> + [anchor_phrase]` если target_noun взят из истории (короткий follow-up — Этап 3, сейчас НЕ покрываем).
4. Семантика заполнения при `sub_intent="accessory_for"`:
   - `has_product_name = false` (цель — категория, не карточка)
   - `product_name = null`
   - `product_category = target_noun` (то, что подбираем — «рамки», «лампочки», «диск»)
   - `anchor_product = anchor_phrase` (всё, что сказано про якорь, копией)
   - `search_modifiers` — собираются МЕХАНИЧЕСКИ из target-фрагмента (без anchor-фрагмента) по существующему правилу.
5. Регрессия в `classifier-prompt_test.ts`: 6-8 фикстур (рамки к розетке, лампа к люстре, диск к болгарке, картридж к принтеру, кронштейн под телевизор, провод для УШМ, насадка к перфоратору, негативы — «розетка для кухни» НЕ accessory_for).

### Этап 2 — Новая ветка `s-accessory-for` в V1 роутере

**Файл:** `supabase/functions/chat-consultant/index.ts`

1. **Guard перед pagetitle short-circuit** (~L6869): если `classification.sub_intent === 'accessory_for'` — пропускаем весь NAME-FIRST блок (не показываем якорь как товар).
2. **Новая подветка** перед основным catalog-пайплайном:
   a. **Resolve якорь:** `searchByPagetitle(anchor_product, …, 1)` → `anchorProduct`. Если 0 — silent fallback в обычный catalog-поиск по `product_category` (поведение как сегодня для категорий).
   b. **Извлечь сигналы совместимости** из `anchorProduct.options[]`: коллекция (`kollekciya`), бренд (`brend`), серия. Whitelist ключей фиксируем как константу.
   c. **Поиск target_category** через существующий QFv2-путь с инъекцией `options[<key>][]` из шага (b). Порядок попыток (cascade):
      1. category + коллекция якоря
      2. category + бренд якоря (если коллекция не дала результата)
      3. category без фильтров якоря + Soft-Suggest о бренде якоря
   d. **Soft-404 для accessory-for:** свой текст «не нашёл [target] совместимых с [anchor_product]; вот ближайшие [target] бренда [anchor_brand]» (если хотя бы шаг 3 что-то дал).
3. **Логирование:** `branchTag='accessory-for'`, в Steps пишем `anchor_id`, `anchor_collection`, `anchor_brand`, какие фильтры пробовали и сколько на каждом шаге.
4. **Деривация:** рендер карточек идёт через тот же `buildDeterministicShortCircuitContent` (правило deterministic product render).
5. **disallowCrosssell=true** для accessory-for ветки — пользователь УЖЕ в режиме «подбираю аксессуар», навешивать ещё кросс-сел бессмысленно.

### Тестирование

1. Юнит-тесты классификатора (см. Этап 1).
2. Интеграционный fixture-test для роутера (моки `searchByPagetitle` + QFv2).
3. Регрессионный прогон существующих golden-tests чтобы убедиться: pagetitle short-circuit для обычных запросов («Розетка USB Тип С+С NLST» БЕЗ «к чему-то») не сломан.

### Фикстуры

**Файл:** `.lovable/fixtures/accessory-for-cases-2026-06-02.md` — 8-10 кейсов с ожидаемыми classifier-выходами и branchTag.

### Memory

После приёма — обновить `mem://index.md` (Core + новая запись `mem://features/accessory-for`).

## Что НЕ входит

- Этап 3 (slot-state для коротких follow-up «а рамки?» после показа розетки). Отдельным PR.
- Зеркаление в V2 (`chat-consultant-v2`). Согласно Core Memory, V1 — активный prod, V2 — параллельная edge function; если решим перенести — отдельным PR.
- Семантическое определение «что считать совместимостью» сверх коллекции/бренда якоря. Если в каталоге для пары категорий нужна более тонкая связка (например, «лампа E27 к патрону E27») — это будущий Этап 4.

## Технические детали

### Точки правки

```text
supabase/functions/_shared/classifier-prompt.ts          (+~40 строк, новое поле + правило)
supabase/functions/_shared/classifier-prompt_test.ts     (+6-8 кейсов)
supabase/functions/chat-consultant/index.ts              (~L6869 guard, ~L7593 новая ветка ~150 строк)
.lovable/fixtures/accessory-for-cases-2026-06-02.md      (новый)
mem://index.md, mem://features/accessory-for             (после приёма)
```

### Контракт нового classifier-выхода (пример)

```json
{
  "intent": "catalog",
  "sub_intent": "accessory_for",
  "has_product_name": false,
  "product_name": null,
  "product_category": "рамки",
  "anchor_product": "Розетка USB Тип С+C 15 Вт 5 В, белый NLST /863139/",
  "search_modifiers": [],
  "critical_modifiers": [],
  "is_replacement": false,
  "price_intent": null,
  "compute": null,
  "compare": null
}
```

### Псевдокод ветки s-accessory-for

```text
if classification.sub_intent == 'accessory_for' and classification.anchor_product:
    anchor = searchByPagetitle(classification.anchor_product, limit=1)
    if not anchor:
        fall through to obычный catalog (по product_category)
    else:
        signals = extractAnchorSignals(anchor.options)  # {collection, brand, series}
        attempts = [
            {category: target, options: {collection: signals.collection}},
            {category: target, options: {brand: signals.brand}},
            {category: target, options: {}},  # last resort + soft-suggest о бренде
        ]
        for attempt in attempts:
            products = qfv2Search(attempt)
            if products: 
                render(products, branchTag='accessory-for', disallowCrosssell=true)
                return
        renderAccessoryForSoft404(target, anchor)
```

### Риски

- Классификатор может ошибочно ставить `accessory_for` на запросы типа «диск для болгарки» когда пользователь имел в виду конкретную модель диска без якоря. **Митигация:** правило «anchor_phrase должна содержать ≥1 признак конкретики — бренд/маркировку/слово «эта/эту/этой/такой» или быть длиннее 4 слов». Иначе — обычный catalog по «диск для болгарки».
- Якорь может не найтись в каталоге (опечатка / снят с продажи). **Митигация:** silent fallback в обычный catalog-поиск по target_category.
- При смене модели классификатора (Claude → Gemini) семантика поля может «поплыть». **Митигация:** unit-тесты с фикстурами + явная проверка на наличие маркеров в промпте.

## Acceptance criteria

1. Запрос «какие рамки подходят к этой розетке: Розетка USB Тип С+С NLST /863139/» → показаны рамки коллекции Niloe Step бренда Legrand (если есть), иначе рамки Legrand, иначе все рамки + явный текст «не нашёл совместимых, показываю общий список».
2. Запрос «Розетка USB Тип С+С NLST /863139/» БЕЗ accessory-маркеров → как сейчас, pagetitle short-circuit, карточка розетки.
3. Все существующие unit/integration тесты зелёные.
4. Steps в логах содержат branchTag='accessory-for' и diag по якорю и фильтрам.
