

# План реализации: Оптимизация контекста LLM 2

## Файл: `supabase/functions/chat-consultant/index.ts`

### Изменение 1: Snap к таблицам в `extractRelevantExcerpt` (строки 1903-1911)

Заменить блок snap-to-boundary на улучшенный, который сначала ищет `|---` (заголовок Markdown-таблицы), и только если не находит — fallback на `\n\n`.

### Изменение 2: Активировать `extractRelevantExcerpt` в сборке контекста (строки 2064-2078)

Заменить вставку полного `r.content` на:
- Динамический бюджет: 6000 символов для записей >100K, 4000 для остальных
- Общий лимит `KB_TOTAL_BUDGET = 15000` символов на весь `knowledgeContext`
- Вызов `extractRelevantExcerpt(r.content, userMessage, budget)` для каждой записи

### Изменение 3: Условное включение БЗ по интенту (строка 2547)

Перед строкой 2547 добавить логику:
```
const shouldIncludeKnowledge = 
  extractedIntent.intent === 'info' || 
  extractedIntent.intent === 'general' ||
  foundProducts.length === 0;
```
На строке 2547 заменить `${knowledgeContext}` на `${shouldIncludeKnowledge ? knowledgeContext : ''}`.

### Изменение 4: Обрезка истории (строка 2556)

Заменить `...messages` на trimmed-версию: последние 8 сообщений, assistant-ответы >500 символов обрезаются до 500 + `...`.

### Изменение 5: Диагностические логи (после строки 2551)

Добавить разбивку по компонентам: knowledge, products, contacts, history — отдельно.

---

## Ожидаемый результат

- System prompt: 256K → 20-50K символов
- Время ответа: 10-20 сек → 2-5 сек
- Стоимость: ~$0.025 → ~$0.004 за запрос

