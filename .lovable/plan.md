
## Контекст

В V1 (`chat-consultant`) уже есть очень быстрый short-circuit по артикулу:

1. `detectArticles(userMessage)` — regex-детектор кодов в сообщении (артикул, site-id, чисто числовой код).
2. Если что-то найдено — параллельно вызывается `searchByArticle(art)` → API `/products?article=…&per_page=5` с таймаутом 8 c и ретраем.
3. При попадании выставляется `articleShortCircuit = true`, **полностью пропускается LLM-классификация и категорийный pipeline**, ответ собирается на Flash-модели (не Pro).

Это и даёт ощущение «как поиск по сайту»: один HTTP-запрос → готовая карточка.

Catalog API поддерживает аналогичный точный поиск по имени — параметр **`pagetitle`** (EXACT product name, см. memory `architecture/catalog-api-quirks`). Сейчас V1 им не пользуется: при запросе вида «Лампа ESS LEDBulb 9W E27 6500K» бот идёт через Micro-LLM классификатор → category resolver → фасеты → strict search, и только в конце находит товар.

Цель — сделать **title-first short-circuit** ровно по той же схеме, что и article-first, и поставить его сразу **после** article-first (артикул всегда точнее).

## Изменения

Только один файл: `supabase/functions/chat-consultant/index.ts`.
V2 (`chat-consultant-v2`) **не трогаем** — V1 заморожена по совсем другим причинам, но конкретно эта правка вписывается в её существующую архитектуру short-circuit'ов и логически принадлежит V1 (V2 переписывается по спецификации отдельно).

### 1. Новая функция `searchByPagetitle(title, apiToken)`

Полный аналог `searchByArticle`:

- `URLSearchParams` с `pagetitle=<title>` и `per_page=5`.
- Через тот же `fetchCatalogWithRetry(..., 'TitleSearch', 8000)` — таймаут + 1 ретрай.
- Парсит `data.results`, фильтрует `price > 0` (HARD BAN на price=0 из core).
- Логи `[TitleSearch] …`.

### 2. Новая функция `extractCandidateTitle(message, classification)`

Детектор «похоже на точное название товара». В отличие от артикулов, regex здесь не работает — название это естественный язык. Поэтому источник кандидата — **уже существующий Micro-LLM классификатор** (`classifyProductName`), который и так возвращает поле `product_name` когда `has_product_name === true`.

Логика:
- Если `classification.has_product_name === true` И `classification.product_name` длиной ≥ 6 символов И содержит хотя бы одну букву И хотя бы одну цифру/латиницу (типичные признаки модели: «A60», «LED», «9W», «E27», «GX53», «IP44») → возвращаем `product_name` как кандидата.
- Иначе — `null`, идём дальше по обычному pipeline.

Это отсекает «найди лампы для школы» (нет цифр/латиницы → не кандидат) и пропускает «Лампа ESS LEDBulb 9W E27 6500K» (есть и буквы, и цифры, и латиница).

### 3. Встраивание в pipeline

В блок `chat()` после article-first (строки ~4585) и **перед** обычным title-first via Micro-LLM (строки ~4587+), но с одной перестановкой: классификатор всё равно нужно вызвать ДО title-fast-path, потому что он даёт нам кандидата. Поэтому порядок становится:

```text
1. article-first (regex → /products?article=)            ← как сейчас
2. classifyProductName(...)                              ← двигаем ВЫШЕ из текущей позиции
3. title-first (extractCandidateTitle → /products?pagetitle=)  ← НОВОЕ
4. остальной pipeline (slot resolution, category, фасеты, strict search)
```

При попадании title-first:
- `foundProducts = results`
- новый флаг `titleShortCircuit = true`
- `responseModel = 'google/gemini-2.5-flash'`, `responseModelReason = 'title-shortcircuit'` (как article)
- `if (titleShortCircuit || articleShortCircuit) { /* skip slot/category/strict-search */ }`

### 4. Защита от ложных срабатываний

- Минимум 1 результат — если `pagetitle=…` вернул пусто, **не делаем** второй фоллбек, а просто продолжаем обычный pipeline. Никаких поломок: при промахе мы платим один лишний HTTP-запрос (~ те же 8 c таймаута, обычно сильно меньше) и идём как раньше.
- Если в результатах больше 5 — это, скорее всего, не точное попадание (pagetitle EXACT-матчит, но API может вернуть substring). На этот случай добавим post-filter: оставляем только товары, где `product.pagetitle.toLowerCase() === candidate.toLowerCase()` ИЛИ `product.pagetitle.toLowerCase().includes(candidate.toLowerCase())` И длина candidate ≥ 60% длины pagetitle. Если после фильтра 0 — short-circuit не срабатывает.
- price=0 уже отфильтровано на шаге 1 (внутри `searchByPagetitle`).

## Что НЕ меняем

- Article-first остаётся как есть (он точнее и надёжнее, идёт первым).
- Существующий «title-first via Micro-LLM classifier» (slot resolution, category disambiguation) остаётся — он покрывает случаи, когда название неточное или это категорийный запрос. Новый fast-path просто выходит раньше, если уверен.
- V2 не трогаем (memory: «V1 FROZEN» относится к спорным правкам спецификации; этот short-circuit — улучшение существующей V1-архитектуры, идентичное article-first).
- Никаких миграций БД, никаких новых секретов, никаких изменений во фронте/виджете.

## Тест-план (после деплоя)

1. **Точное название с моделью** — «Лампа ESS LEDBulb 9W E27 6500K 230V 1CT» → должен сработать title-shortcircuit, в логах `[TitleSearch] Found N`, ответ < 3 c на Flash.
2. **Категорийный запрос** — «найди лампы для школы» → title-fast-path НЕ срабатывает (нет цифр/латиницы), идёт обычный pipeline.
3. **Артикул** — «92900190008» → article-first срабатывает раньше, title-first не вызывается.
4. **Промах по названию** — «Лампа Несуществующая Модель X999» → title-fast-path вернул 0, идём в обычный pipeline без поломок.
5. **Регрессия** — «розетки белые на 2 места» → обычный pipeline отрабатывает как раньше.

## Технические детали (для разработчика)

- Файл: `supabase/functions/chat-consultant/index.ts`.
- Новые функции добавляем рядом с `searchByArticle` (~ строка 896).
- Встраивание — в `chat()` около строки 4585, с перестановкой `classifyProductName` выше короткого замыкания.
- Использовать существующий `fetchCatalogWithRetry`, `VOLT220_API_URL`, типы `Product`.
- Логи в том же стиле: `[TitleSearch]`, `[Chat] Title-first SUCCESS …`.
- Флаг `titleShortCircuit` объявить рядом с `articleShortCircuit`, использовать в той же ветке пропуска LLM 1.

## Готов реализовать после approve

После одобрения переключусь в build-mode и сделаю одну правку в `index.ts` + задеплою `chat-consultant`. Ничего больше деплоить не нужно.
