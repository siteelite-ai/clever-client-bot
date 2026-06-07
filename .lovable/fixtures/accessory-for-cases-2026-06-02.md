# Accessory-for fixtures (V1, 2026-06-02)

Класс запросов: «какие [Y] подходят к [X]» — пользователь подбирает товары категории Y, совместимые с конкретным товаром-якорем X.

Эти фикстуры используются для:
- Регрессии classifier-prompt (Этап 1).
- Интеграционного теста новой ветки `s-accessory-for` в роутере V1 (Этап 2).
- Ручной QA после деплоя.

Формат: запрос пользователя → ожидаемый JSON classifier'а → ожидаемый branchTag в логах + критерий приёмки.

---

## Позитивные кейсы (sub_intent="accessory_for")

### 1. Рамки к розетке (основной кейс из инцидента)

**Запрос:** `какие рамки подходят к этой розетке: Розетка USB Тип С+C 15 Вт 5 В, белый NLST /863139/`

**Classifier:**
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
  "is_replacement": false
}
```

**Router:** `branchTag='accessory-for'`. Cascade: коллекция Niloe Step (=A) → если 0, **Family-Guard probe** target schema → `kollekciya__kollekciya` есть и в anchor.options, и в target schema рамок → brand-fallback Legrand БЛОКИРОВАН → `accessory-for-incompatible-collection` с честным intro + top-3 рамок для ориентира + предложение менеджера.

**Acceptance:** НЕТ карточек рамок Legrand под видом «совместимых». Intro явно говорит про разные посадочные размеры серий. `family_guard.blocked_brand_fallback=true`, `shared_keys` содержит как минимум `kollekciya__kollekciya`.

---

### 2. Лампы к люстре с явным брендом

**Запрос:** `лампочки для люстры Eglo 87654`

**Classifier:**
```json
{
  "sub_intent": "accessory_for",
  "product_category": "лампочки",
  "anchor_product": "люстра Eglo 87654"
}
```

**Acceptance:** карточки категории «лампочки», предпочтительно бренда Eglo или цоколя, соответствующего якорю.

---

### 3. Диск к болгарке с моделью

**Запрос:** `диск к болгарке Bosch GWS 750`

**Classifier:**
```json
{
  "sub_intent": "accessory_for",
  "product_category": "диск",
  "anchor_product": "болгарка Bosch GWS 750"
}
```

---

### 4. Картридж к принтеру с моделью

**Запрос:** `какой картридж подходит к принтеру HP LaserJet P1102`

**Classifier:**
```json
{
  "sub_intent": "accessory_for",
  "product_category": "картридж",
  "anchor_product": "принтер HP LaserJet P1102"
}
```

---

### 5. Кронштейн под телевизор

**Запрос:** `кронштейн под телевизор Samsung UE55TU8000`

**Classifier:**
```json
{
  "sub_intent": "accessory_for",
  "product_category": "кронштейн",
  "anchor_product": "телевизор Samsung UE55TU8000"
}
```

---

### 6. Насадка к перфоратору (артикул)

**Запрос:** `насадка к перфоратору Makita HR2470, артикул 12345`

**Classifier:**
```json
{
  "sub_intent": "accessory_for",
  "product_category": "насадка",
  "anchor_product": "перфоратор Makita HR2470, артикул 12345"
}
```

---

### 7. Указательное местоимение перед якорем

**Запрос:** `провода для этого УЗО Schneider Electric IID K 25A 30мА`

**Classifier:**
```json
{
  "sub_intent": "accessory_for",
  "product_category": "провода",
  "anchor_product": "УЗО Schneider Electric IID K 25A 30мА"
}
```

Местоимение «этого» НЕ попадает в anchor_product.

---

## Негативные кейсы (НЕ accessory_for)

### 8. Категория без конкретного якоря

**Запрос:** `диск для болгарки`

**Classifier:** обычный catalog
```json
{
  "sub_intent": null,
  "product_category": "диск",
  "search_modifiers": ["для", "болгарки"],
  "anchor_product": null
}
```

«болгарки» — не конкретный якорь (нет бренда/модели/артикула, ≤4 слов). Это обычный фильтр.

---

### 9. Запрос на замену (replacement приоритетнее)

**Запрос:** `подбери аналог к розетке NLST /863139/`

**Classifier:**
```json
{
  "intent": "catalog",
  "sub_intent": null,
  "is_replacement": true,
  "has_product_name": true,
  "product_name": "розетке NLST /863139/",
  "anchor_product": null
}
```

«аналог» = replacement, маршрутизация в существующую replacement-ветку.

---

### 10. Spec про якорь, без подбора аксессуара

**Запрос:** `какая мощность у розетки USB NLST /863139/`

**Classifier:**
```json
{
  "sub_intent": "spec",
  "has_product_name": true,
  "product_name": "розетки USB NLST /863139/",
  "compute": {"attribute": "мощность", "multiplier": null},
  "anchor_product": null
}
```

---

### 11. Категория без якоря и без маркера совместимости

**Запрос:** `рамки Legrand белые`

**Classifier:**
```json
{
  "sub_intent": null,
  "product_category": "рамки",
  "search_modifiers": ["Legrand", "белые"],
  "anchor_product": null
}
```

Обычный catalog по категории + модификаторам.

---

## Источник данных

- Кейс №1 — реальный production-инцидент (RequestLogs `/logs`, 2026-06-02).
- Кейсы №2-7 — конструируются по типовым продуктам каталога 220volt, но в данном файле допустимо: фикстуры лежат вне spec'а (mem://constraints/spec-data-agnostic).
- Кейсы №8-11 — anti-pattern guards для предотвращения регрессий в смежных ветках.

---

## Кейсы partition-axis фильтра (2026-06-07)

Data-agnostic ось совместимости: ключ K из `anchor.options[]` принимается за ось ⇔
(1) у probe target-категории K присутствует, (2) |unique values_ru| ≤ max(8, 0.3*probe.length),
(3) значение анкера V_a встречается в probe по этому K. Иначе skip (silent fallback в brand→all).

### 12. Лампа к светильнику с цоколем GX53 в имени модели

**Запрос:** `Какая лампа подходит к этому светильнику: Светильник NGX-R1-001-GX53 белый 71 277 Navigator`

**Classifier:**
```json
{
  "sub_intent": "accessory_for",
  "anchor_product": "Светильник NGX-R1-001-GX53 белый 71 277 Navigator",
  "product_category": "лампа",
  "search_modifiers": [],
  "critical_modifiers": []
}
```

**Branch:** anchor.options содержит `tsokol_*=GX53`. Probe ламп: ось `tsokol_*` имеет
≤ 6 уникальных значений (E14, E27, GU10, GX53, G9, G4), GX53 присутствует → ось выбрана.
`compat-all` (или `compat-strongest`) возвращает только GX53-лампы.

**Acceptance:**
- `meta.compat.axes_selected` содержит элемент `{key: "tsokol_*", anchor_value: "GX53"}`.
- `meta.compat.hit === true`.
- `attemptLabel` ∈ `{"compat-all", "compat-strongest"}`.
- Все карточки в выдаче — лампы с цоколем GX53.

### 13. Negative: цвет анкера НЕ становится осью совместимости

**Тот же запрос (Кейс 12).** Анкер белый; probe ламп содержит десятки разных значений
по `cvet_*` (тёплый/холодный/нейтральный/RGB/...) → |values| > threshold → ось отброшена.

**Acceptance:**
- `meta.compat.keys_considered` содержит `cvet_*` (или его реальное имя).
- `meta.compat.axes_selected` НЕ содержит `cvet_*`.
- Выдача не схлопывается в 0 из-за личного цветового предпочтения по якорю.

### Регрессия Кейса 1 (рамки к розетке NLST)

partition-axis шаг исключает `kollekciya__*` и `brend__*` явно — collection-attempt
и brand-fallback живут в существующем каскаде. Family-Guard остаётся первым гейтом
после probe → при NLST отсутствующем в значениях коллекций рамок → `blockedByFamily=true`
→ partition-axis шаг не выполняется (он внутри `if (!blockedByFamily)`) → результат =
`accessory-for-incompatible-collection`, как раньше.

### 14. Источник истины compat-осей: facet-schema, а не probe

**Запрос:** "Какая лампа подходит к этому светильнику: Светильник NGX-R1-001-GX53 белый 71 277 Navigator"

**Дефект до фикса (2026-06-07):** partition-axis по probe выбирал мусорные оси
(`opisaniefayla=Сертификат соответствия`, `populyarnyy=1`), а реальную ось
`tip_cokolya=GX53` отбрасывал с `anchor-value-absent`, потому что в случайных 25
пробных лампах GX53 не оказалось.

**Фикс:**
1. PRIMARY-источник compat-осей = `getCategoryOptionsSchema(resolvedTargetCategory)`
   (live `/api/categories/options`, кэш 30мин, stale-on-error, legacy fallback).
   Meta-поля (`opisaniefayla`, `populyarnyy`, `kodnomenklatury`, `fayl`,
   `poiskovyy_zapros`, `novinka`, `ogranichennyy_prosmotr` и т.п.) в schema не
   попадают — фильтруются автоматически без denylist.
2. FALLBACK-источник = partition-axis по probe (когда schema пустая/недоступна).
3. Проверка `anchor-value-absent` УБРАНА из обоих источников — probe слишком мал
   для авторитетных выводов о значениях. Если фильтр даст 0 — это честный
   family-mismatch, обрабатывается каскадом ниже (brand-fallback → all).

**Acceptance:**
- `meta.compat.source === "facet-schema"` (для категорий, где facets endpoint жив).
- `meta.compat.axes_selected` содержит `tip_cokolya__*` с `anchor_value === "GX53"`.
- `meta.compat.axes_selected` НЕ содержит `opisaniefayla`, `populyarnyy`,
  `kodnomenklatury`, `fayl`, `poiskovyy_zapros`.
- Все карточки — реальные GX53-лампы.

### 15. Silent fallback на partition-axis при недоступности facets endpoint

**Условие:** `getCategoryOptionsSchema` бросает / возвращает пустую schema.

**Acceptance:**
- `meta.compat.source === "partition-axis"`.
- Поведение совпадает с Кейсом 12/13 (без `anchor-value-absent` cut'а).
- Лог содержит `facet-schema fetch error: ... — fallback to partition-axis`.
