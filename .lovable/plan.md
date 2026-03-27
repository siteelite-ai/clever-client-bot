

# Аудит плана: упрощение поиска по названию

Проверка проводится ролями из AUDIT_PROMPT.md, релевантными данному изменению.

---

## Role 1: RAG Quality Auditor — Качество поиска

**Вердикт: ОДОБРЕНО с оговоркой**

План правильный: убрать scoring (threshold 30) и сделать title-first как article-first. Сейчас scoring отсекает валидные результаты — товар "Кабель КГ 4*2,5" набирает ~25 баллов из-за малого числа токенов и не проходит порог.

**Оговорка**: Полное удаление scoring создает риск false-positive. Запрос "лампа" вернет десятки товаров и сработает short-circuit, хотя это общий запрос, а не название. Нужен минимальный фильтр — не по score, а по длине очищенного запроса. Если `cleanedQuery` содержит >= 3 значимых слова ИЛИ содержит технические спеки (числа с единицами) — это похоже на название. Иначе — пропускать в LLM pipeline.

**Рекомендация**: вместо `cleanedQuery.length >= 6` использовать проверку: `extractTokens(cleanedQuery).length >= 3 || extractSpecs(cleanedQuery).length >= 1`. Это отсекает "лампа" (1 токен) но пропускает "Кабель КГ 4*2,5" (3 токена + спека).

---

## Role 4: Edge Functions Stability Auditor — Стабильность и латентность

**Вердикт: ОДОБРЕНО**

Упрощение однозначно улучшает стабильность:
- Убираем `shortenQuery` → минус 1 API-вызов (было 2 параллельных, станет 1)
- Убираем `scoreProductMatch`, `hasGoodMatch`, `rerankProducts` из hot path → меньше CPU на edge function
- При успешном title-first экономим 5-10 секунд (LLM 1 + searchProductsMulti)

Чек-лист п. "< 10 секунд при нормальной нагрузке" — с упрощенным title-first большинство запросов по названию уложатся в 3-5 секунд.

**Примечание**: `rerankProducts` стоит оставить как утилиту — она полезна для сортировки результатов после LLM-pipeline (когда title-first не сработал). Убрать из title-first блока, но не удалять функцию.

---

## Role 2: Sales Logic Auditor — Продающая логика

**Вердикт: ОДОБРЕНО**

Быстрый ответ = лучшая конверсия. Сейчас 10-15 секунд ожидания — пользователь уходит. С упрощенным pipeline 3-5 секунд — в рамках допустимого.

Критически важно: при title-first short-circuit уже работает правильная инструкция (строка 2176-2177: "ТОВАР НАЙДЕН ПО НАЗВАНИЮ"), которая включает cross-sell. Не трогаем.

---

## Role 3: Prompt Security Auditor — Безопасность

**Вердикт: НЕТ ЗАМЕЧАНИЙ**

Изменения не затрагивают system prompt, sanitization или injection-защиту. `cleanQueryForDirectSearch` уже фильтрует мусорные слова, а `sanitizeUserInput` (строка 1855) работает до всех поисков.

---

## Role 5: Chat Conversion Auditor — Конверсия

**Вердикт: ОДОБРЕНО**

Путь "вопрос → товар" сокращается с 3 шагов (запрос → ожидание 15с → ответ "не найдено") до 1 шага (запрос → ответ 3с). Улучшение конверсионной воронки.

---

## Итоговые рекомендации всех ролей

### Что одобрено без изменений:
1. Убрать `hasGoodMatch` и threshold из title-first блока
2. Один API-вызов вместо двух параллельных (убрать `shortenQuery` из title-first)
3. Результаты > 0 → сразу short-circuit

### Что нужно доработать в плане:

1. **Фильтр "это название, а не общий запрос"** — заменить `cleanedQuery.length >= 6` на проверку количества токенов (>= 3) или наличия технических спек. Без этого общие запросы ("лампа", "кабель") будут неправомерно попадать в fast-track и возвращать случайные товары.

2. **Сохранить `rerankProducts`** — не удалять функцию, а убрать из title-first блока. Она нужна в LLM-pipeline для сортировки результатов `searchProductsMulti`.

3. **Сохранить `scoreProductMatch`** — аналогично, убрать из title-first, но оставить для reranking в основном pipeline.

### Обновленный title-first блок (псевдокод):

```text
if (!articleShortCircuit) {
  cleanedQuery = cleanQueryForDirectSearch(userMessage)
  tokens = extractTokens(cleanedQuery)
  specs = extractSpecs(cleanedQuery)
  
  // Это похоже на название товара, а не общий вопрос?
  if (tokens.length >= 3 || specs.length >= 1) {
    results = searchAPI(query: cleanedQuery, per_page: 15)
    if (results.length > 0) {
      foundProducts = results.slice(0, 10)
      articleShortCircuit = true  // skip LLM 1
    }
  }
  // Иначе: обычный LLM pipeline
}
```

### Файл для изменения:
- `supabase/functions/chat-consultant/index.ts` — блок строк 1921-1977

### Риски:
- **Низкий**: общие запросы проходят в fast-track при слабом фильтре — решается проверкой токенов
- **Нулевой**: article-first и site-id не затрагиваются
- **Нулевой**: LLM pipeline остается как fallback

