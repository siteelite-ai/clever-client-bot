

# Архитектурный аудит: Почему replacement не нашёл замены

## Корневая причина

**`ReferenceError: MAX_BUCKETS_TO_CHECK is not defined`** в replacement-блоке (строка 3665).

Константа объявлена `const MAX_BUCKETS_TO_CHECK = 3` **внутри** блока category-first (строка 3435), внутри `if (rawProducts.length > 0 && modifiers.length > 0)`. JS/TS `const` имеет block-scope — она **невидима** в replacement-блоке (строка 3582+), который является отдельным top-level `if`.

### Что произошло в тесте "ДКУ-LED-03-100W ... предложи замену"

```text
1. Name-first ✅ нашёл товар "Светильник ДКУ-LED-03-100W" за 2.8с
2. Replacement-блок запустился:
   - originalProduct = найденный товар ✅
   - replCategory = "Светильники" ✅
   - replModifiers = [серый, холодный белый, 100, 220, 67, ...] ✅
   - 2 параллельных API → 85 уникальных товаров ✅
   - replCatDist = {"Светильники": 85} ✅
3. ❌ replSortedBuckets.slice(0, MAX_BUCKETS_TO_CHECK) → ReferenceError
4. Try/catch верхнего уровня поймал → залогировал как "Micro-LLM classify error" (вводит в заблуждение)
5. Replacement цепочка ОБОРВАНА — STAGE 2 не запустился
6. AI получил только 1 товар (оригинал), без замен
```

**Ложное сообщение "Micro-LLM classify error"** — это catch-all на уровне всего AI-pipeline ловит любую ошибку и приписывает её classifier'у. Реальный classifier отработал успешно (видно в логах: `Classify SUCCESS via primary(openrouter)`).

## Почему "Article-first / Category-first / Name-first работают параллельно" — это миф

В текущей архитектуре они работают **последовательно** через if-else if цепочку:

```text
1. Article detection (regex) → если найден артикул → article search
2. Если не найден → Micro-LLM classify
3. has_product_name → title-first (name-first)
4. else effectiveCategory → category-first
5. is_replacement → отдельный replacement-блок (после, не вместо)
```

В тесте сработали последовательно: article-first (0 results) → site-id fallback (0) → classify → title-first (1 result, short-circuit) → **replacement-блок поверх найденного товара**. Это правильное поведение, но replacement упал.

## План фиксов (минимальный)

### Фикс №1 (критичный): Поднять `MAX_BUCKETS_TO_CHECK` в module scope

Перенести `const MAX_BUCKETS_TO_CHECK = 3;` из строки 3435 (внутри category-first блока) **в начало файла** (рядом с другими константами) или объявить на уровне функции `serve`/handler. Тогда обе ветки (category-first и replacement) увидят её.

### Фикс №2 (диагностика): Уточнить логирование catch-блока

Сейчас catch на верхнем уровне приписывает любую ошибку Micro-LLM. Нужно изменить сообщение на что-то типа `[Chat] Pipeline error (fallback to LLM 1): ${err}` чтобы не путать диагностику в будущем.

### Фикс №3 (защита): Try/catch вокруг replacement-блока

Обернуть replacement-блок (3582-конец) в свой try/catch с логом `[Chat] Replacement pipeline error: ...`. Если replacement упадёт — оригинальный товар всё равно отдастся пользователю с пометкой "не удалось найти замены автоматически".

## Что НЕ трогаем

- Логику category-first / name-first / article-first — она работает корректно
- Bucket-matching алгоритм — он правильный, просто не выполнился из-за ReferenceError
- Промпт classifier — name-first отработал идеально (`has_product_name=true`, `name="ДКУ-LED-03-100W (ЭТФ)"`)
- Title-first short-circuit — работает за 2.8с

## Риски

| Компонент | Риск |
|-----------|------|
| Category-first | Нулевой — переменная просто перемещается выше |
| Name-first | Нулевой — не использует MAX_BUCKETS |
| Replacement | Улучшается — перестанет падать |
| Slot-based | Нулевой |
| Latency | Нулевой |

## Ожидаемый результат после фикса

Запрос "ДКУ-LED-03-100W ... предложи замену":
1. Title-first находит оригинал ✅
2. Replacement: 85 товаров → 1 бакет "Светильники" → resolveFiltersWithLLM по [серый, холодный белый, 100Вт, 220В, IP67]
3. STAGE 2: API с category="Светильники" + резолвленные фильтры → 5-15 похожих светильников
4. AI получает оригинал + замены → корректный ответ "вот такие близкие аналоги"

## Объём
~5 строк: переместить константу + улучшить лог + try/catch обёртка + деплой.

