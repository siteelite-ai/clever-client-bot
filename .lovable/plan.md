

# План: Использовать search_modifiers классификатора вместо сырого текста

## Суть

Микро-LLM классификатор **уже работает** на каждый ответ пользователя и возвращает `search_modifiers` — чистые характеристики без мусора ("давай", "думаю что", "ну покажи"). Но при резолве product_search слота мы передаём **сырой** `userMessage` как `refinementText`, а `search_modifiers` выбрасываем.

Фикс: передавать `classification.search_modifiers` вместо `userMessage` в `resolveFiltersWithLLM`.

## Пример

```text
Пользователь: "думаю, что электрическую, и давай на 2 гнезда"

Сейчас:
  refinementText = "думаю, что электрическую, и давай на 2 гнезда"
  → resolveFiltersWithLLM(["думаю, что электрическую, и давай на 2 гнезда"])
  → LLM путается с мусором

После фикса:
  classification.search_modifiers = ["электрическая", "2 гнезда"]
  → resolveFiltersWithLLM(["электрическая", "2 гнезда"])
  → tip="электрическая", kolichestvo_razyemov="2" ✓
```

## Изменения

**Файл:** `supabase/functions/chat-consultant/index.ts`

### 1. resolveSlotRefinement (~строка 1106): принимать classification.search_modifiers

Добавить параметр или использовать уже переданный `classificationResult`. Вместо `refinementText: userMessage.trim()` возвращать:

```typescript
refinementText: userMessage.trim(),
refinementModifiers: classificationResult?.search_modifiers?.length 
  ? classificationResult.search_modifiers 
  : [userMessage.trim()],  // fallback на сырой текст
```

### 2. Главный pipeline (~строка 3202): передавать modifiers в resolveFiltersWithLLM

```typescript
// Было:
await resolveFiltersWithLLM(schemaProducts, [sp.refinementText], appSettings);

// Станет:
const modifiersToResolve = sp.refinementModifiers || [sp.refinementText];
await resolveFiltersWithLLM(schemaProducts, modifiersToResolve, appSettings);
```

Это **уже** массив чистых модификаторов — каждый резолвится отдельно, точнее и быстрее.

## Объём
~5 строк изменений в 2 местах одного файла. Никаких новых LLM-вызовов — используем уже существующий результат классификатора.

## Что НЕ трогаем
- classifyProductName — без изменений (уже возвращает search_modifiers)
- resolveFiltersWithLLM — без изменений
- Остальные ветки pipeline — без изменений

