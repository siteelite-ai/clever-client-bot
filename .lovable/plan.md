

# План: распространить полную схему опций на bucket-N ветку (без хардкода в промте)

## Корень проблемы (по логам запроса «Есть черная двухместная розетка?»)

Новая логика (`getUnionCategoryOptionsSchema` → `prebuiltSchema`) реализована только в двух местах:
- CategoryMatcher-ветка (стр. 3870–3874)
- Replacement-ветка (стр. 4327)

Реальный запрос пошёл по **третьей ветке — bucket-N** (стр. 4040–4145), потому что CategoryMatcher не дал точного матча. В bucket-N `resolveFiltersWithLLM` вызывается **без** `prebuiltSchema`:
- стр. 4045 — главный цикл по сортированным bucket'ам
- стр. 4123 — alt-bucket fallback

В результате схема для FilterLLM строится из 24 товаров «Розеток силовых», в ней нет ключа `kolichestvo_razyemov` («двухместная» физически некуда матчить), а потом ещё и нет ни одной чёрной двойной розетки → бот честно отвечает «нет», хотя в каталоге они есть (см. формированные позже [Search] результаты по `query=розетка чёрная` — там 22 шт.).

## Решение: распространить полную схему на bucket-N ветку

Никакого хардкода в системный промт FilterLLM (ты права — это анти-паттерн, синонимов тысячи). Только то, что ты сама описала: **«нашли категорию → берём её опции целиком → LLM матчит модификаторы по ним»**. Для bucket-N «категория» = pagetitle самого bucket'а.

### Изменения

**Файл `supabase/functions/chat-consultant/index.ts`:**

1. **Главный цикл bucket-N (стр. ~4040–4067).** Перед каждым вызовом `resolveFiltersWithLLM(bucketProducts, modifiers, ...)` подгружать `getCategoryOptionsSchema(catName, apiToken)` и передавать как `prebuiltSchema`. Кэш TTL=30 мин уже есть — холодный запрос только при первом обращении к категории.

2. **Alt-bucket fallback (стр. 4123).** То же самое: `getCategoryOptionsSchema(altCat, ...)` → передать как `prebuiltSchema`. Имя категории = pagetitle bucket'а, его и кэшируем.

3. **Микро-оптимизация: параллельная загрузка схем для top-N bucket'ов.** Цикл сейчас итерирует sortedBuckets (макс 3–5 первых). Перед циклом — `Promise.all` загрузить схемы для этих N pagetitles одним батчем, дальше из локальной мапы. Не блокируем sequential.

4. **STAGE 2 (стр. 4093–4099).** Без изменений: использует уже резолвленные фильтры. После фикса (1) `kolichestvo_razyemov` будет в схеме → LLM сматчит «двухместная» → API получит `cvet__tүsі=чёрный + kolichestvo_razyemov=2 + category=<bucket>` → точная выдача.

5. **Suppress-query логика (стр. 4088–4091, 4129–4131).** Уже корректна — оставляем.

### Что НЕ трогаем

- Системный промт FilterLLM — никаких хардкод-синонимов, никаких примеров. Только схема + общий алгоритм матчинга, как сейчас.
- CategoryMatcher-ветка, Replacement-ветка, classifier — там фикс уже есть.
- `getCategoryOptionsSchema`, `getUnionCategoryOptionsSchema` — без изменений.
- Виджет, embed, knowledge base.

## Открытый вопрос (решу в default-mode)

Почему CategoryMatcher не выбрал ветку для «розетки»? По логам видно `[Chat] Category-first WINNER: "Розетки силовые"` — это уже bucket-N. В CategoryMatcher-ветке (стр. 3850+) лога `[Chat] CategoryMatcher merged ...` нет. Значит matchCategoriesWithLLM либо не нашёл pagetitle-совпадений, либо ветка вообще не запустилась для этого запроса. Проверю условие входа в CategoryMatcher и при необходимости — почему «розетка» не матчится с реальными pagetitle. **Это отдельный вопрос; этот план чинит bucket-N независимо от того, починим ли вход в CategoryMatcher.**

## Регрессионный тест

| # | Запрос | Ожидание |
|---|---|---|
| 1 | «Есть черная двухместная розетка?» (сломанный кейс) | Лог: `[CategoryOptionsSchema] "Розетки": N keys, M values (from K products, cached)`. В схеме ключ `kolichestvo_razyemov` со значениями 1/2/3. LLM: `cvet__tүsі=чёрный, kolichestvo_razyemov=2`. STAGE 2: точная серверная выдача чёрных двойных розеток. Бот **не** говорит «нет» |
| 2 | «белая розетка IEK» | resolved={cvet:белый, brend:IEK}. Без регрессий |
| 3 | «лампочка E27 18 ватт» | Без регрессий |
| 4 | «розетка с защитой от детей» | Если в схеме есть ключ защитных шторок — резолвится; если нет — unresolved, бот говорит «такой опции нет» (честно) |
| 5 | Replacement-ветка | Без регрессий (там фикс уже есть с прошлого раза) |
| 6 | Холодный кэш по «Розетки» — первый запрос | +1 запрос схемы (~100–500ms). Повторные 30 мин — мгновенно |

После деплоя — повтор «Есть черная двухместная розетка?». В логах ожидаю:
- `[Chat] Category-first WINNER: "Розетки силовые"` (или "Розетки скрытой установки" — не важно)
- `[CategoryOptionsSchema] "<bucket>": ~15 keys, ~80 values (from ~250 products, cached)`
- `[FilterLLM] Using prebuilt category schema (15 keys)`
- `[FilterLLM] Resolved: {cvet__tүsі:"чёрный//қара", kolichestvo_razyemov:"2"}`
- `[Chat] Category-first server-filtered: N>0 products` → реальные чёрные двойные розетки

