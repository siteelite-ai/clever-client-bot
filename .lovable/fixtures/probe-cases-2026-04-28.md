# R&D Probe Cases — 28.04.2026

> **НЕ ЧАСТЬ СПЕЦИФИКАЦИИ.** Это результат live-тестирования API. Используется для онбординга, мокирования тестов и ручной отладки. Опираться на конкретные значения как на whitelist в production-коде запрещено (§0, D1).

## CASE-1: Бытовое название «кукуруза» (EN: corn)

- `?query=кукуруза` → total=0
- `?query=кукуруза&category=Светотехника` → total=0
- `?query=corn` → total=25 (но включает «Corner» — substring match)
- `?query=corn&category=Светотехника` → total=0 (категория слишком верхнеуровневая)
- Реальная категория товаров CORN: «Лампы» (подкатегория Светотехники)
- **Вывод:** RU-запрос не работает для этого товара; EN-перевод критичен; нужен word-boundary filter для «corn» vs «Corner».

## CASE-2: Бытовое название «груша» (EN: pear)

- `?query=груша` → total=279 (реальные A60-лампы)
- `?query=pear` → total=0
- `?query=A60` → total=114
- **Вывод:** RU как раз работает; EN-перевод вреден; lexicon-canonical (A60) сужает.

## CASE-3: Категория с multi-word pagetitle

- `?query=двойная розетка` → total=325 (реальные)
- `?category=Розетки` → total=2353
- `?category=Розетки и выключатели` → total=0 (такой pagetitle НЕ существует)
- **Вывод:** pagetitle берётся ТОЛЬКО из /api/categories. Нельзя додумывать.

## CASE-4: SKU lookup

- `?article=a043418` → total=1 (работает идеально)

## CASE-5: Substring matching

- `?query=corn` → первый результат: «Corner Светильник» (price=0) — substring match
- Реальные CORN-лампы начинаются со 2-го результата
- **Вывод:** нужен word-boundary post-filter `\bcorn\b` + price>0 filter.

## CASE-6: Несуществующая категория

- `?category=НетТакойКатегории` → total=0
- **Вывод:** API возвращает пустой результат без ошибки. Invariant C1 предотвращает.

## API Envelope (актуально на 28.04.2026)

```json
{
  "success": true,
  "data": {
    "results": [...],
    "pagination": { "total": N, "page": 1, "per_page": 50 }
  }
}
```
