

# План: единый фильтр zero-price товаров на всех ветках выдачи

## Что обнаружил

Фильтр «не показывать товары с ценой 0» (под заказ) сейчас стоит только в **двух местах**:

1. `executeSearch` (строка 3250) — `pricedProducts = uniqueProducts.filter(p => p.price > 0)`
2. `handlePriceIntent` (строки 1742, 1785) — для price-intent ветки

Но в коде есть **минимум 8 веток**, которые отдают товары напрямую от API через `searchProductsByCandidate` / `searchProductsMulti`, минуя `executeSearch`. Там фильтра НЕТ:

- `slot` (3911–3913) — `foundProducts` от slot resolution
- `matcher_no_modifiers` (4090) — `exactCategoryHits` / `matcherProducts`
- `matcher_server` (4165) — `filteredProducts`
- `bucket-N` (4353) — `serverFiltered`
- `alt-bucket` (4401) — `altServer`
- `relaxed` (4434) — `bestRelaxed`
- `text_fallback` (4458) — `textFallback`
- `replacement-*` ветки (4630, 4823, 4857) — `bestRelaxed` / `altServer` в replacement-флоу

Это значит, что в большинстве реальных запросов («чёрная двухместная розетка», «розетки INSPIRIA», категорийные запросы) фильтр не работает — товары «под заказ» (price=0) просачиваются в выдачу.

## Решение — системное, в одном месте

### 1. Расширить `pickDisplayWithTotal` фильтрацией zero-price

Helper и так стоит на ВСЕХ 13 точках выдачи (это и был смысл прошлого консилиума — единый контракт). Добавляем в него фильтр перед обрезкой:

```ts
function pickDisplayWithTotal<T extends { price?: number }>(
  all: T[],
  limit: number = DISPLAY_LIMIT
): { displayed: T[]; total: number; filteredZeroPrice: number } {
  const input = all || [];
  const priced = input.filter(p => (p?.price ?? 0) > 0);
  // Soft fallback: если ВСЁ нулевое (редкий случай), возвращаем оригинал, чтобы не отдать пустоту
  const working = priced.length > 0 ? priced : input;
  const total = working.length;
  const displayed = working.slice(0, limit);
  return { displayed, total, filteredZeroPrice: input.length - priced.length };
}
```

### 2. Обновить лог во всех 13 точках вызова

Сейчас лог такой:
```
[Chat] DisplayLimit: collected=153 displayed=15 branch=matcher
```
Станет:
```
[Chat] DisplayLimit: collected=153 displayed=15 branch=matcher zeroFiltered=7
```
Видно в любой ветке, сколько «под заказ» отфильтровано.

### 3. Убрать дублирование в `executeSearch` (3250–3252)

Там уже есть тот же фильтр — после того, как helper сам начнёт фильтровать, дублирующая строка станет no-op, но оставим её на случай, если `executeSearch` где-то возвращает результат напрямую без `pickDisplayWithTotal`. Проверю и при необходимости удалю.

### 4. `handlePriceIntent` — оставляем как есть

Там фильтр уже работает корректно для своей ветки (price-intent), и логика чуть отличается (сортировка по цене). Не трогаем.

## Почему это безопасно

1. **Helper уже на всех 13 точках выдачи** — добавление фильтра внутри него автоматически закрывает все ветки одной правкой.
2. **Soft fallback** (если ВСЁ нулевое — отдаём оригинал) защищает от регресса в редких узких категориях, где может вообще не быть товаров с ценой. Лучше показать «под заказ», чем пустоту.
3. **`totalCollected` теперь будет считать только «реальные» товары** — пользователь увидит «Подобрано 146» вместо «153» (если 7 были нулевые). Это честно: 7 «под заказ» мы всё равно бы не показали.
4. **Не трогаем** suppress-query, роутер, `handlePriceIntent`, slot-state, replacement-логику — только helper.

## Технические детали

**Файл:** `supabase/functions/chat-consultant/index.ts`

- Изменить `pickDisplayWithTotal` (строки 135–139): добавить фильтр `price > 0` + soft fallback + `filteredZeroPrice` в return.
- Обновить 13 строк-вызовов helper'а: добавить `_r.filteredZeroPrice` в шаблон лога.
- Проверить и при необходимости упростить `executeSearch` 3249–3252 (дублирующий фильтр).

**Регресс после деплоя:**
1. «Розетки INSPIRIA» → в логах появится `zeroFiltered=N`, `collected` уменьшится на N, в выдаче нет товаров с ценой 0 (проверить в `[products...]` payload).
2. Узкая категория, где ВСЕ товары под заказ → soft fallback срабатывает, выдача не пустая, в логе `collected=N zeroFiltered=N` (и `working===input`).
3. «Чёрная двухместная розетка» → проверить, что zero-price не просачивается через bucket-N / matcher_server.

