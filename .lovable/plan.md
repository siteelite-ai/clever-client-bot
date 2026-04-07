

# План: Fuzzy-валидация ключей от FilterLLM

## Проблема (из логов)

LLM вернул: `"cvet__tүsі (Цвет)": "чёрный"`
Реальный ключ в optionIndex: `"cvet__tүsі"`

LLM добавил caption в скобках к ключу. `optionIndex.has("cvet__tүsі (Цвет)")` → false → ключ отклонён → цвет потерян → AND-фильтр нашёл только по полюсам → 1 нерелевантный товар.

Pipeline сам по себе работает правильно — classify, plural, API, resolveFilters — всё отработало. Баг только в валидации ключей на строке 2230.

## Решение

В блоке валидации (строки 2228-2236) добавить нормализацию ключа — если точного совпадения нет, попробовать:
1. Убрать всё после ` (` — то есть `key.split(' (')[0].trim()`
2. Если после очистки ключ найден в optionIndex — принять его

**Файл**: `supabase/functions/chat-consultant/index.ts`, строки 2228-2236

**Было** (~8 строк):
```typescript
const validated: Record<string, string> = {};
for (const [key, value] of Object.entries(filters)) {
  if (optionIndex.has(key) && typeof value === 'string') {
    validated[key] = value;
  } else {
    console.log(`[FilterLLM] Rejected unknown key: "${key}"`);
  }
}
```

**Станет** (~12 строк):
```typescript
const validated: Record<string, string> = {};
for (const [rawKey, value] of Object.entries(filters)) {
  if (typeof value !== 'string') continue;
  // Try exact match first, then strip caption suffix like " (Цвет)"
  let resolvedKey = rawKey;
  if (!optionIndex.has(resolvedKey)) {
    const stripped = resolvedKey.split(' (')[0].trim();
    if (optionIndex.has(stripped)) {
      resolvedKey = stripped;
    }
  }
  if (optionIndex.has(resolvedKey)) {
    validated[resolvedKey] = value;
    console.log(`[FilterLLM] Resolved: "${resolvedKey}" = "${value}"`);
  } else {
    console.log(`[FilterLLM] Rejected unknown key: "${rawKey}"`);
  }
}
```

## Объём

~4 строки добавить в один файл. Редеплой edge function.

## Что НЕ трогаем

- Промпт FilterLLM — работает правильно, нашёл и цвет, и полюса
- Pipeline category-first — полностью корректный
- AND-фильтр — работает
- Classify, plural — работают

