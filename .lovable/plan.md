

# План: Исправить маппинг категории "автомат" → "Автоматические выключатели"

## Проблема

`toPluralCategory("автомат")` возвращает "Автоматы", и API находит категорию "Автоматы защиты двигателя" (пускатели для моторов). Пользователь же ищет автоматические выключатели (circuit breakers) — это совершенно другая категория "Автоматические выключатели".

Лог:
```
Category-first: plural="Автоматы"
Category-first: category="Автоматы" → 50 products
Category-buckets: {"Автоматы защиты двигателя":50}  ← НЕПРАВИЛЬНАЯ КАТЕГОРИЯ
```

## Решение

Добавить таблицу алиасов категорий (category aliases) перед вызовом `toPluralCategory`. Если пользовательское слово имеет неоднозначное соответствие, алиас направит в правильную категорию.

### Файл: `supabase/functions/chat-consultant/index.ts`

**1. Добавить маппинг алиасов** (рядом с `toPluralCategory`, ~строка 2280):

```typescript
const CATEGORY_ALIASES: Record<string, string> = {
  'автомат': 'Автоматические выключатели',
  'автоматы': 'Автоматические выключатели',
  'автоматический выключатель': 'Автоматические выключатели',
  'узо': 'УЗО',
  'дифавтомат': 'Дифавтоматы',
  'дифференциальный автомат': 'Дифавтоматы',
};
```

**2. Использовать алиас перед `toPluralCategory`** (строка ~3284-3286):

Вместо:
```typescript
const pluralCategory = toPluralCategory(effectiveCategory);
```

Сделать:
```typescript
const aliasedCategory = CATEGORY_ALIASES[effectiveCategory.toLowerCase()] || null;
const pluralCategory = aliasedCategory || toPluralCategory(effectiveCategory);
```

Тот же паттерн применить в replacement-блоке (~строка 3475).

**3. Деплой** edge function `chat-consultant`.

## Почему это системное решение

- Алиасы решают проблему неоднозначных коротких слов раз и навсегда
- Таблицу легко расширять по мере обнаружения новых случаев
- Не затрагивает другие пути поиска (article-first, title-first, replacement)
- `toPluralCategory` остаётся без изменений — алиас просто обходит его, когда знает точный ответ

## Объём
~15 строк кода + деплой.

