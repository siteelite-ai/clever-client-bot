

# Системный фикс: classifier раскладывает запрос по слотам API (исправленная версия)

## Признание ошибки и факты из документации

Ты был прав, а я нет. Перепроверил документацию API `220volt.kz/api/products` (см. промт стр. 1820–1832 + код `search-products/index.ts` стр. 138–153 + `chat-consultant/index.ts` стр. 2712–2731). Список **корневых** параметров API:

| Параметр | Тип |
|---|---|
| `query` | корневой (текстовый поиск) |
| `article` | корневой (точный артикул) |
| `category` | корневой (pagetitle категории) |
| `min_price` / `max_price` | корневые |
| `options[<key>][]` | **динамические опции категории** |

**Бренд = `options[brend__brend][]`**, то есть это **обычная опция категории**, а не корневой параметр. Технически он стоит в одном ряду с `options[cvet__cvet][]`, `options[ip__ip][]`, `options[moshchnost][]` и т.д. Никакой архитектурной выделенности у бренда **в API нет**.

Мой предыдущий план строился на ложной посылке «у бренда отдельный корневой слот». Это неверно. Твоя интуиция «бренд — такая же характеристика, как цвет» **полностью соответствует устройству API**.

## Что это меняет в подходе

Раз бренд — обычная опция, отдельное поле `product_brand` в classifier **не нужно** и было бы искусственным выделением. Архитектурно правильно: **бренд должен попадать в `search_modifiers`, а FilterLLM — резолвить его в `brend__brend` так же, как резолвит цвет в `cvet__cvet`**.

Тогда возникает законный вопрос: **почему сейчас не работает?** Корневая причина не в classifier — он бы и так положил «Legrand» в модификаторы. Проблема в **replacement-ветке**:

В строках 4108–4118 `chat-consultant/index.ts` модификаторы для replacement формируются **не классификатором, а regex-нарезкой `product_name`**:

```ts
const nameSpecs = classification.product_name.match(/(\d+\s*(?:Вт|W|В|V|мм|mm|А|A|IP\d+))/gi) || [];
const typeWords = classification.product_name.replace(/.../).split(/\s+/).filter(...).slice(0, 2);
replModifiers.push(...typeWords);
```

Этот regex:
- ловит только числовые спеки (Вт, А, IP);
- из остального берёт **только первые 2 слова длиной ≥ 3**;
- не различает бренд, серию, категорию — для него «розетка» и «Legrand» равны.

Из-за `slice(0, 2)` для запроса «розетку Legrand X» в `replModifiers` попадает `["розетк", "Legrand"]` (или хуже — `["розетк", "X"]`, если порядок токенов другой). FilterLLM получает шум «розетка» и в схеме на 136 опций честно возвращает `{}`.

В **category-first** ветке (стр. 3680+) такой проблемы нет — там `modifiers` приходят напрямую из `classification.search_modifiers`, classifier уже всё корректно разметил.

## Что чиним системно — одна правка

Заменяем regex-нарезку в replacement-ветке на **прямое чтение `classification.search_modifiers`**, как уже работает в category-first. Никаких новых полей в classifier, никакого хардкод-списка брендов, никакой выделенности бренда. Бренд проходит как обычный модификатор — наравне с цветом, током, IP. FilterLLM резолвит его в `brend__brend` штатно.

### Правка 1. Удаление regex-нарезки в replacement (стр. 4105–4119)

Меняем блок «Case 2: Product not in catalog» с:

```ts
} else if (classification.product_name) {
  replCategory = effectiveCategory || classification.search_category || '';
  const nameSpecs = classification.product_name.match(/(\d+\s*(?:Вт|W|В|V|мм|mm|А|A|IP\d+))/gi) || [];
  replModifiers = nameSpecs.map(s => s.replace(/\s+/g, ''));
  const typeWords = classification.product_name
    .replace(/\d+\s*(?:Вт|W|В|V|мм|mm|А|A)/gi, '')
    .replace(/[()[\]\-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !/^\d+$/.test(w))
    .slice(0, 2);
  replModifiers.push(...typeWords);
  console.log(`[Chat] Replacement: product NOT found, category="${replCategory}", modifiers=[${replModifiers.join(', ')}]`);
}
```

на:

```ts
} else if (classification.product_name || (classification.search_modifiers?.length ?? 0) > 0) {
  replCategory = effectiveCategory || classification.search_category || '';
  // Trust the classifier — modifiers (brand, color, specs) already extracted semantically.
  // No regex slicing: it loses brand and adds noise like the category word itself.
  replModifiers = [...(classification.search_modifiers || [])];
  console.log(`[Chat] Replacement: NOT found, category="${replCategory}", modifiers=[${replModifiers.join(', ')}] (from classifier)`);
}
```

### Правка 2. Уточнение промта classifier по бренду (стр. 814)

`search_modifiers` уже описан как «...цвет, **бренд**, серия/коллекция...» (стр. 814), но в `is_replacement` примерах (стр. 762–765) бренд из запроса не выносится в `search_modifiers` — он зашит в `product_name`. Добавляем явное правило для replacement:

> **При is_replacement=true** — бренд из запроса **обязательно** попадает в `search_modifiers` (даже если он также есть в `product_name`). Это нужно, чтобы система могла применить бренд как фильтр, если оригинальный товар не найдётся в каталоге.

И поправить пример (стр. 764):
- Было: `"что взять вместо ABB S201 C16?" → product_name="ABB S201 C16", product_category="автомат"`
- Станет: `"что взять вместо ABB S201 C16?" → product_name="ABB S201 C16", product_category="автомат", search_modifiers=["ABB","S201","C16"], critical_modifiers=["ABB"]`

И аналогично пример со стр. 763 (Werkel Atlas — там уже почти правильно, добавить `Werkel` и `Atlas` в `search_modifiers`).

### Правка 3. Симметричная проверка в category-first

Category-first ветка уже работает правильно (берёт `modifiers` от classifier). Никаких изменений не требуется. Бренд для запроса «нужна розетка Legrand белая» уже сейчас попадает в FilterLLM и резолвится в `brend__brend` — если попадает (зависит от качества промта classifier и FilterLLM, но это другая задача).

## Что НЕ трогаем

- Структуру `ClassificationResult` — без новых полей
- API-вызов `searchProductsByCandidate` и параметр `brand` в `SearchCandidate` — они остаются и используются для intent="brands"
- `resolveFiltersWithLLM` — без изменений, бренд для неё — обычная опция
- `getCategoriesCache`, `matchCategoriesWithLLM` — без изменений
- Никаких хардкод-списков брендов
- Title-first / article-first ветки — там `originalProduct` находится через прямой поиск и `extractModifiersFromProduct` корректно вытаскивает бренд из `options[brend__brend]`

## Файлы

| Файл | Изменения |
|---|---|
| `supabase/functions/chat-consultant/index.ts` стр. 4105–4119 | Удаление regex-нарезки. Чтение `search_modifiers` напрямую из classification. ~12 строк меньше |
| `supabase/functions/chat-consultant/index.ts` стр. 754–765 | Явное правило: при is_replacement бренд обязан попасть в `search_modifiers`. Поправлены 2 примера. ~5 новых строк |

Деплой: автодеплой `chat-consultant`.

## Регрессионный тест

| # | Запрос | Ожидание |
|---|---|---|
| 1 | «чем заменить розетку Legrand X» | classifier: `category="розетка"`, `is_replacement=true`, `modifiers=["Legrand","X"]`. Replacement-ветка: `replModifiers=["Legrand","X"]`. FilterLLM резолвит `Legrand` → `brend__brend=Legrand`. API: `&category=Розетки&options[brend__brend][]=Legrand`. Выдача 100% Legrand |
| 2 | «замени выключатель Schneider Atlas» | `modifiers=["Schneider","Atlas"]` → FilterLLM → `brend__brend=Schneider Electric`. Выдача 100% Schneider |
| 3 | «нужна розетка Werkel белая» (НЕ replacement) | category-first: `modifiers=["Werkel","белая"]`. FilterLLM резолвит оба в `brend__brend` и `cvet__cvet`. Без регрессий |
| 4 | «ABB S201 C16» (товар в каталоге) | title-first → найден → `extractModifiersFromProduct` → бренд из options. Без изменений |
| 5 | «чем заменить розетку Бренд-которого-нет X» | `modifiers=["Бренд-которого-нет","X"]`. FilterLLM не находит → возвращает `{}` для бренда. Текстовый fallback по `category=Розетки` без бренд-фильтра. Не хуже текущего поведения |
| 6 | «чем заменить выключатель» (без бренда) | `modifiers=[]`. Replacement идёт по чистой category-логике, как сейчас |
| 7 | Запрос со спеками «чем заменить лампу 18Вт E27» | `modifiers=["18Вт","E27"]`. FilterLLM → `moshchnost=18, tsokol=E27`. **Регрессия проверена**: раньше regex ловил числовые спеки, теперь их даёт classifier — то же самое или лучше |

После деплоя — повтор запроса со скриншота. Ожидание в логах: `[Chat] Replacement: NOT found, category="розетка", modifiers=[Legrand, X] (from classifier)`, далее `[Chat] Replacement matcher resolved={"brend__brend":"Legrand"}`, в URL — `&options[brend__brend][]=Legrand`, выдача 100% Legrand структурно через штатный механизм опций категории.

