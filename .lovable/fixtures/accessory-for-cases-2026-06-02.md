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
