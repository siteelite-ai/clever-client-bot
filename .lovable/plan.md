

# План: Убрать лишнюю логику из `extractModifiersFromProduct`

## Суть

Две вещи в текущем коде — ошибочны:
1. Фильтрация `NOISE` (`нет`, `да`) — отбрасывает потенциально важные значения характеристик
2. Обогащение единицами (`100` → `100Вт`, `67` → `IP67`) — может помешать LLM сопоставить значение со схемой, где записано просто `"100"` или `"67"`

## Файл: `supabase/functions/chat-consultant/index.ts`, строки 707-765

### Изменения

1. **Удалить `NOISE` set** (строка 711) и проверку `if (NOISE.has(...)) continue` (строка 741)
2. **Удалить `unitRules`** (строки 726-731) и весь блок обогащения (строки 746-753)
3. **Для голых чисел** — передавать как есть, без `continue` и без форматирования
4. **Оставить**: trim, split('//')[0], компактификацию `"100 Вт"` → `"100Вт"` (строка 756), лимит 8

### Результат функции после изменений

```typescript
function extractModifiersFromProduct(product: Product): string[] {
  const mods: string[] = [];
  if (!product.options) return mods;

  const importantPatterns = [/* те же 9 паттернов */];

  for (const opt of product.options) {
    const keyLower = opt.key.toLowerCase();
    const captionLower = opt.caption.toLowerCase();
    if (!importantPatterns.some(p => p.test(keyLower) || p.test(captionLower))) continue;

    const cleanValue = opt.value.split('//')[0].trim();
    if (!cleanValue) continue; // только пустые строки пропускаем

    // Компактим только "число пробел единица" → "числоединица"
    const finalValue = cleanValue.replace(/^(\d+)\s+(Вт|В|мм|мм²|кг|м|А)$/i, '$1$2');
    mods.push(finalValue);
    if (mods.length >= 8) break;
  }

  console.log(`[ReplacementMods] ...`);
  return mods;
}
```

### Деплой
После изменения — деплой edge function `chat-consultant`.

## Объём
Одна функция, ~10 строк удалить, ~0 строк добавить.

