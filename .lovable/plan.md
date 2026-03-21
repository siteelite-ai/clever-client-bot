

# План: Поиск по идентификатору сайта (fallback после артикула)

## Текущая логика (уже работает)

1. `detectArticles` → найден код → `searchByArticle()` → найден товар → short-circuit
2. Если `searchByArticle` = 0 → обычный pipeline (LLM 1 → searchProductsMulti)
3. В `searchProductsMulti` есть Article Fallback (строки 1249-1277): если числовой query дал 0 результатов → повторно `searchByArticle`

## Новая логика (приоритет артикула сохраняется)

```text
Пользователь: "000004341 есть?"
     │
     ▼
detectArticles → "000004341"
     │
     ▼
1) searchByArticle("000004341") ← ПЕРВЫЙ (приоритет)
     │
     ├─ Найден → short-circuit, готово
     │
     └─ 0 результатов
         │
         ▼
    2) searchBySiteId("000004341") ← ВТОРОЙ (fallback)
         │
         ├─ Найден → short-circuit, готово
         │
         └─ 0 → обычный pipeline (LLM 1)
```

Артикул всегда проверяется первым. Site ID — только если артикул не нашел.

## Изменения в `supabase/functions/chat-consultant/index.ts`

### Изменение 1: Новая функция `searchBySiteId` (после `searchByArticle`, ~строка 412)

Аналог `searchByArticle`, но использует параметр `options[identifikator_sayta__sayt_identifikatory][]`.

### Изменение 2: Article-first блок (строки 2079-2085)

Сейчас если `articleProducts.size === 0` — сразу fallback на LLM 1. Добавить промежуточный шаг: попробовать `searchBySiteId` для тех же кодов. Если найдено — short-circuit.

### Изменение 3: Article Fallback в `searchProductsMulti` (строки 1262-1276)

После неуспешного `searchByArticle` fallback — добавить `searchBySiteId` fallback для тех же кодов.

### Изменение 4: Расширить `detectArticles` — паттерн с ведущими нулями

Коды типа `000004341` (9 цифр с нулями) не проходят текущий фильтр 4-8 цифр. Расширить до **4-12 цифр** для строк, начинающихся с `0`.

## Безопасность

- Все аддитивно — существующая логика `searchByArticle` не меняется
- Артикул всегда первый, site ID только при 0 результатов от артикула
- Дополнительная задержка ~200мс только при промахе артикула

