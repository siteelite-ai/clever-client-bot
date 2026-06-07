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

## Compat-axes pipeline (patch 2026-06-07)

Эти кейсы покрывают новый детерминированный compat-блок ветки `accessory_for`:
schema-driven выбор осей совместимости + канонизация значения anchor против
target-категории. Подробности — в `supabase/functions/chat-consultant/index.ts`
рядом с `compatMeta`.

### 14. Лампа GX53 к точечному светильнику (production-инцидент)

**Запрос:** `Какая лампа подходит к этому светильнику: Светильник NGX-R1-001-GX53 белый 71 277 Navigator`

**Classifier:**
```json
{
  "sub_intent": "accessory_for",
  "product_category": "лампа",
  "anchor_product": "Светильник NGX-R1-001-GX53 белый 71 277 Navigator",
  "search_modifiers": [],
  "critical_modifiers": []
}
```

**Pipeline:**
- anchor.options содержит `{key: "tip_cokolya_…", value_ru: "gx 53"}` (написание из 220volt API).
- target_category "лампа" → resolvedTargetCategory = "Лампы" (категория, проверить актуальное pagetitle в каталоге).
- live schema лампы содержит `tip_cokolya_…: ["E27", "E14", "GX53", "G4", "G9", "R7s", ...]`.
- Канонизация: `normCanon("gx 53") === normCanon("GX53") === "gx53"` → canonical = `"GX53"`.
- `"GX53"` встречается в pagetitle анкера → приоритет 1.
- API: `?category=Лампы&options[tip_cokolya_…][]=GX53&per_page=20` → товары лампы GX53.

**Acceptance:**
- `meta.compat.axes_selected[0].key` начинается с `tip_cokolya`;
- `meta.compat.axes_selected[0].anchor_value_canonical === "GX53"`;
- `meta.compat.hit.key` тот же; `meta.attempt === "compat"`;
- Среди карточек ни одной лампы без цоколя GX53 / другого цоколя под видом «совместимой»;
- `meta.compat.axes_selected` НЕ содержит `opisaniefayla*`, `populyarnyy*`, `kodnomenklatury`, `fayl`, `novinka*`, `garantiynyy*`.

---

### 15. Blacklist режет техническую метаинформацию

**Анкер с options:** `kodnomenklatury="ABC-123"`, `populyarnyy="1"`, `opisaniefayla="..."`, `tip_cokolya_…="GX53"`.

**Schema target:** содержит те же ключи (часто и в bootstrap, и в live).

**Acceptance:**
- `meta.compat.axes_skipped` содержит записи `{key:"kodnomenklatury", reason:"blacklisted"}`, `{key:"populyarnyy…", reason:"blacklisted"}`, `{key:"opisaniefayla…", reason:"blacklisted"}`;
- `meta.compat.axes_selected` содержит ТОЛЬКО `tip_cokolya_…`.

---

### 16. Канонизация "gx 53" → "GX53"

**Probe-схема target-категории:** `tip_cokolya_…: ["E27", "GX53", "E14"]`.
**Анкер:** `tip_cokolya_…` = `"gx 53"` (с пробелом, как часто отдаёт API).

**Acceptance:**
- `meta.compat.axes_selected` содержит `{key:"tip_cokolya_…", anchor_value_raw:"gx 53", anchor_value_canonical:"GX53"}`;
- Финальный URL содержит `options[tip_cokolya_…][]=GX53`, а НЕ `gx 53`.
- Если бы в schema не было ни одного варианта, нормализующегося в `gx53`, ось ушла бы в `axes_skipped` с `reason:"anchor-value-no-canonical-match"`.

---

### 17. Регрессия Кейса 1: рамки NLST → Legrand остаются `incompatible-collection`

Запрос и classifier — как в кейсе 1. Anchor — розетка коллекции Niloe Step, target — рамки.

**Pipeline:**
- collection-attempt `options[kollekciya__kollekciya][]=Niloe Step` → 0.
- probe + schema (live или bootstrap) → значения `kollekciya__kollekciya` для рамок не содержат `Niloe Step`.
- Family-guard блокирует переход в brand-fallback ПЕРЕД compat-блоком.
- Compat-блок НЕ запускается (`blockedByFamily=true`).

**Acceptance:**
- `responseModelReason === "accessory-for-incompatible-collection"`;
- `meta.family_guard.blocked_brand_fallback === true`;
- `meta.compat.hit === null`, `meta.compat.axes_selected.length === 0`;
- Никаких Legrand-карточек.

---

## Источник данных

- Кейс №1 — реальный production-инцидент (RequestLogs `/logs`, 2026-06-02).
- Кейс №14 — реальный production-инцидент (RequestLogs `/logs`, 2026-06-07).
- Кейсы №2-7, 15-16 — конструируются по типовым продуктам каталога 220volt, фикстуры вне spec'а (mem://constraints/spec-data-agnostic).
- Кейсы №8-11, 17 — anti-pattern guards для предотвращения регрессий в смежных ветках.

