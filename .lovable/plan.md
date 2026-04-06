

# План: Исправить category-first — приоритизация запросов и value-first фильтрация

## Диагноз (подтверждено логами)

Два бага работают вместе:

**Баг 1 — Cap=3 отсекает запросы с модификаторами.** `Set` заполняется сначала базовыми синонимами, потом комбинациями с модификаторами. При Cap=3 в API уходят только `"розетка двухместная"`, `"2-местная розетка"`, `"розетка двойная"` — все БЕЗ слова «черная». Запросы типа `"черная розетка двухместная"` не попадают.

**Баг 2 — `discoverOptionKeys` не резолвит модификаторы.** Логи: `Could not resolve: "черная=черная"` и `Could not resolve: "гармония=Гармония"`. Функция ищет слово «черная» в **caption'ах** опций (`"Цвет//Түс"`). «черная» ≠ «цвет» → score < 20 → отброшено. А «Гармония» есть как **value** у опции `"Коллекция//Коллекция"` с ключом `kollekciya__kollekciya` — но функция туда не заглядывает при caption-mismatch.

## Изменения (1 файл: `chat-consultant/index.ts`)

### 1. Приоритизация запросов с модификаторами (строки 2962-2973)

Сейчас: `Set` ← базовые синонимы первыми, модификаторные комбинации последними.  
Надо: модификаторные комбинации ПЕРВЫМИ, базовые синонимы потом (как fallback).

```
// Сначала комбинации modifier+category (самые специфичные)
const allQueries: string[] = [];
if (modifiers.length > 0) {
  const modStr = modifiers.join(' ');
  for (const v of categoryVariants) {
    allQueries.push(`${v} ${modStr}`);
    allQueries.push(`${modStr} ${v}`);
  }
}
// Потом базовые синонимы (fallback)
for (const v of categoryVariants) {
  if (!allQueries.includes(v)) allQueries.push(v);
}
// Дедупликация
const uniqueQueries = [...new Set(allQueries)];
```

### 2. Увеличить Cap с 3 до 6 для category-first (строка 2222)

Category-first генерирует и базовые, и модификаторные запросы — 3 слишком мало. Увеличиваем до 6, чтобы в Pass 1 попали и специфичные, и базовые запросы.

### 3. Value-first fallback в `discoverOptionKeys` (строки 2009-2083)

Текущая логика: матчит `humanKey` (например «черная») с `caption` опций. Если score < 20 — отброс.

Добавить: если caption-match не сработал, проверить `humanValue` по **значениям** всех опций. Если «черная» найдена как value у опции с caption «Цвет» → использовать этот API-ключ.

```
// После основного цикла, если bestMatch не найден:
if (!bestMatch) {
  for (const [apiKey, info] of optionIndex.entries()) {
    for (const val of info.values) {
      const cleanVal = val.split('//')[0].trim().toLowerCase();
      if (cleanVal === normalizedValue || cleanVal.includes(normalizedValue) || normalizedValue.includes(cleanVal)) {
        bestMatch = { apiKey, matchedValue: val.split('//')[0].trim(), score: 50 };
        break;
      }
    }
    if (bestMatch) break;
  }
}
```

Это покроет: «черная» → найдёт в values опции «Цвет» → ключ `cvet__tүs`. «Гармония» → найдёт в values опции «Коллекция» → ключ `kollekciya__kollekciya`.

## Что НЕ трогаем

- Промпт классификатора — работает правильно
- generateCategorySynonyms — работает правильно
- Title-first, price-intent, replacement ветки
- Основной LLM pipeline

## Объём: ~30 строк изменений, 0 удалений

## Ожидаемый результат

**«черная двухместная розетка»:**
- Pass 1: первые 6 запросов включают `"розетка двухместная черная"` → API находит черные розетки
- Pass 2: `discoverOptionKeys` резолвит «черная» → `cvet__tүs=черная` → API фильтрует по цвету
- Результат: 5-10 черных двухместных розеток

**«розетки из коллекции Гармония»:**
- Pass 1: первые запросы `"розетка Гармония"` → API может найти по тексту
- Pass 2: `discoverOptionKeys` резолвит «Гармония» → `kollekciya__kollekciya=Гармония` → точная фильтрация
- Результат: все розетки серии Гармония

