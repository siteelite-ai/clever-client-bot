---
name: Brand-Aware QFv2
description: Wave B1 — пост-pool brand-filter через bootstrap + honest brand-note в детерминистичном рендере, когда запрошенного бренда нет в каталоге
type: feature
---

# Brand-Aware QFv2 (Wave B1, 2026-06-15)

## Проблема
V1 micro-classifier НЕ возвращает поле `brand` — бренд лежит в `critical_modifiers`/`search_modifiers` как обычный токен. QFv2 pool fetch игнорировал бренд → запрос «дрель makita 18в» → noun-pool возвращал любые дрели → top-3 Вихрь/Ресанта → пользователь видел «makita», получал Вихрь без объяснения.

## Решение (data-agnostic, без словарей брендов)

### Шаг A: пост-pool narrowing
После сборки bootstrap schema проверяем ось `brend__brend`:
1. Если ни один модификатор не совпадает с brand-value, но есть «looks-like-brand» модификатор (regex `^[A-Za-z][A-Za-z\-]{3,}$`) → ставим `qfBrandUnavailable = { brand, availableBrands: top5 }`.
2. Если совпадает — фильтруем pool по brend__brend (case-insensitive, точное равенство либо префикс).

Источник истины — ТОЛЬКО живой pool. Никаких внешних brand-словарей.

### Шаг B: honest brand-note в детерминистичном рендере
`buildDeterministicShortCircuitContent` принимает `brandUnavailable?: { brand, availableBrands }`. При наличии заменяет стандартный intro на:

> Прямого аналога **{brand}** в нашем каталоге не нашёл. Похожие позиции от других брендов в нашем каталоге ({availableBrands}):

Карточки top-3 рендерятся как обычно. Хвост «подобрано ещё N» сохраняется.

## Метрики
- `qfv2-brand-narrow` — успешный narrow по бренду в pool
- `qfv2-brand-missing` — бренд запрошен, в pool нет → brand-note
- `qfv2-brand-dropped-empty` (зарезервировано) — brand-drop retry дал пусто

## Проверенные кейсы (2026-06-15)
- `дрель makita 18в` → Makita нет в каталоге → honest note + 3 альтернативы (Вихрь/Ресанта)
- `перфоратор bosch sds-plus 800вт` → Bosch нет → honest note + альтернативы

## Что НЕ закрыто этой волной
- Качество noun-pool для широких категорий (перфоратор + sds-plus + bosch → pool затесались буры/каналы). Это отдельная задача: усилить noun-filter / резать category-mismatch в bootstrap.
