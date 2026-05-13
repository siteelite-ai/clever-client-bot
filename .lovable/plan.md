## Цель

Сделать выборку `/related` точнее, пробрасывая фильтры самого anchor-товара (цена, опции — vendor, color и т.п.). При пустом результате — мягко ослаблять фильтры. Это работает и в `generateRelatedFollowup` (фраза), и в `acceptRelatedOffer` (карточки).

## Изменения

### 1. `supabase/functions/_shared/related-followup.ts`

**a) Расширить `RelatedQueryParams`:**
```ts
export interface RelatedQueryParams {
  page?: number;
  perPage?: number;
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  options?: Record<string, string[]>;   // NEW: {vendor: ['IEK'], color: ['белый']}
}
```

**b) Расширить `RelatedAnchor`** (нужно для построения фильтров):
```ts
export interface RelatedAnchor {
  id: number;
  pagetitle?: string;
  price?: number;                                       // NEW
  category?: { id: number; pagetitle?: string };
  options?: Array<{ key: string; value_ru?: string }>;  // NEW (как в Product.options)
}
```

**c) Хелпер `buildAnchorFilters(anchors, allowKeys)`** — собирает фильтры из anchor-ов:
- `minPrice = floor(median(prices) * 0.5)`, `maxPrice = ceil(median * 1.5)` — если у всех anchor-ов есть цена
- `options[k]` = пересечение значений по ключам из `allowKeys` (по умолчанию `['vendor','color']`), берётся только если у ВСЕХ anchor-ов значение совпадает (иначе ключ пропускается — иначе схлопнем выдачу)
- ключи опций конфигурируются через config (см. ниже)

**d) `fetchRelatedRaw` URL-builder в index.ts** должен поддержать `options[k][]=v` (см. п.3).

**e) Прогрессивное ослабление в `fetchWithRelaxation(anchors, baseParams, allowKeys)`** — единая утилита, используется и в generate, и в accept:

```text
attempt 1: per_page=100 + price band + options{vendor,color}
attempt 2: drop options.vendor                 (если был)
attempt 3: drop options.color                  (если был)
attempt 4: drop minPrice/maxPrice              (если были)
attempt 5: per_page=100, без фильтров          (текущее поведение)
```

После каждого attempt: если merged.length ≥ MIN_POOL (=10) → возвращаем. Между попытками логируем что отвалилось.

**f) `generateRelatedFollowup`:**
- использует `fetchWithRelaxation` вместо прямого `fetchRelatedForAnchors({perPage:50})`
- порог `topCategories.length < 2` снижается до `< 1` (если осталась 1 валидная категория — фразу всё равно строим: «С этим часто берут **коробки монтажные**.»). Это решает текущий баг с пустым followup.

**g) `acceptRelatedOffer`:**
- при `strictCategories && preferredCategories.length===1` сначала пробует `category=<cat>` + price + options (через `fetchWithRelaxation`)
- общий путь — также через `fetchWithRelaxation`

### 2. `supabase/functions/chat-consultant/index.ts`

**a) `buildRelatedUrl`** — добавить сериализацию `options[<key>][]=<value>`:
```ts
if (params.options) {
  for (const [k, vals] of Object.entries(params.options))
    for (const v of vals) qs.append(`options[${k}][]`, v);
}
```

**b) `followupAnchors`** — пробрасывать `price` и `options` из `foundProducts`:
```ts
picked.push({
  id: p.id,
  pagetitle: p.pagetitle,
  price: p.price,
  category: ...,
  options: p.options,  // как есть, shape совпадает
});
```

**c) `acceptRelatedOffer` callsite (5878)** — тоже передать расширенные anchors. Сейчас там `anchors: anchorIds.map(id => ({id}))` — нужно подтянуть price/options либо из cached anchors slot, либо одним батч-fetch'ем `/products?article=...` (по сохранённым ID). Простейшее: сохранять расширенные anchor snapshot в slot `cross_sell_offer.anchors` (рядом с `anchor_ids`).

### 3. Config

Добавить в `_shared/related-followup.ts` константы (или принимать через deps, чтобы не плодить новых файлов):
```ts
const RELATED_FILTER_OPTION_KEYS = ['vendor', 'color'];   // какие опции пробрасывать
const RELATED_PRICE_BAND_PCT = 0.5;                       // ±50%
const RELATED_MIN_POOL = 10;                              // когда останавливаемся
const RELATED_PER_PAGE = 100;                             // широкий пул
```

### 4. Логирование

В каждом attempt логируем: `[Related] attempt=<n> filters={price:[..], options:{..}} pool=<merged> kept=<afterPriceFilter>`. По логам можно будет настроить набор `RELATED_FILTER_OPTION_KEYS`.

## Тесты

В `supabase/functions/_shared/related-followup_test.ts` (если есть, иначе создать):
- buildAnchorFilters: median price ±50%, intersection options
- fetchWithRelaxation: моки fetchRelatedRaw, проверяем порядок ослабления
- generateRelatedFollowup: при 1 уцелевшей категории фраза формируется (порог `<2` → `<1`)

## Memory update

После проверки: добавить в `mem://features/related-cross-sell` (новый файл) — описание фильтров и progressive relaxation. Обновить Core memory строкой про `/related` фильтры.

## Шаги (с подтверждением)

1. **Шаг 1.** Расширение типов + `buildAnchorFilters` + `fetchWithRelaxation` + интеграция в `generateRelatedFollowup`. Снижение порога категорий до `<1`. Тесты.
2. **Шаг 2.** Поддержка `options[][]` в `buildRelatedUrl`. Проброс `price/options` в `followupAnchors`. Сохранение расширенных anchors в slot. Использование в `acceptRelatedOffer`.
3. **Шаг 3.** Прогон через прод-кейс «розетка ВЕГА → коробки», верификация по логам, обновление памяти.

После каждого шага останавливаюсь и жду подтверждения.
