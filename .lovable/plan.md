## Diagnostic-Only итерация — что и зачем

**Цель:** убрать единственный краш, который ломает UX, и собрать **точные** данные о facets/cvet-дублях. Никаких функциональных изменений в логике дедупа, кэширования и FilterLLM. Минимум blast radius.

После деплоя смотрим логи на 3-5 реальных запросах, потом отдельной итерацией делаем точечный фикс по фактам.

---

## Изменения (1 файл: `supabase/functions/chat-consultant/index.ts`)

### 1. Null-safe в `scoreProductMatch` + try/catch вокруг `rerankProducts`

**Зачем:** убрать `TypeError: Cannot read properties of undefined (reading 'toLowerCase')`, из-за которого пользователь видит пустой ответ.

**Что делаем:**
- В `scoreProductMatch` (~строка 2326): защитить все `.toLowerCase()` на полях продукта:
  - `(o?.value ?? '').toLowerCase()` вместо `o.value.toLowerCase()`
  - `(product.vendor ?? '').toLowerCase()`
  - `(brandOption?.value ?? '').split('//')[0].trim().toLowerCase()`
  - `(product.pagetitle ?? '').toLowerCase()` (на всякий)
- Обернуть тело `rerankProducts` в try/catch:
  - В catch: `console.error('[RankerCrash]', { req_id, error: e.message, stack: e.stack, product_count: products.length })` 
  - Возвращать `products` (входной массив) как есть. **Никакого silent fallback** — ошибка всегда уезжает в логи с уровнем `error`.
- То же самое в `hasGoodMatch` (тот же баг может вылезти там).

### 2. `req_id` для корреляции запросов

**Зачем:** сейчас в логах нельзя проследить один запрос end-to-end. После добавления — можно фильтровать в Supabase logs по `req_id=xxxx`.

**Что делаем:**
- В самом начале `serve(async (req) => { ... })`: `const reqId = crypto.randomUUID().slice(0, 8);`
- Добавить в **ключевые** существующие логи (не во все, чтобы не раздуть): `[Chat]`, `[Search]`, `[FilterLLM]`, `[CategoryOptionsSchema]`, `[Rerank]`, `[OptionAliases]`. Формат: `[Chat req=a1b2c3d4] Processing: "..."`.
- Передавать `reqId` параметром в `getCategoryOptionsSchema`, `resolveFiltersWithLLM`, `rerankProducts`, `executeSearch`. Дефолт `'?'` чтобы старые вызовы (если есть) не упали.

### 3. Diagnostic-логи для facets-деградации

**Зачем:** понять — это 220volt API стабильно отдаёт 0 values, или это парсинг сломан, или это конкретные категории.

**Что делаем:**
- В `getCategoryOptionsSchema` после построения схемы, перед `return`:
  ```ts
  const totalValues = Array.from(schema.values()).reduce((s, info) => s + info.values.size, 0);
  const keysWithZero = Array.from(schema.values()).filter(i => i.values.size === 0).length;
  console.log(`[FacetsHealth req=${reqId}] cat="${pagetitle}" keys=${schema.size} keys_with_zero_values=${keysWithZero} total_values=${totalValues} products=${productCount} source=${source}`);
  ```
  где `source` = `"facets-api"` или `"legacy-sampling"`.
- В `getCategoryOptionsSchemaLegacy` тот же лог с `source="legacy-sampling"`.
- **Не меняем** TTL и логику кэширования. Только наблюдаем.

### 4. Diagnostic-логи для дедупа cvet/garantii/stepeny

**Зачем:** увидеть **точные** ключи всех семейств дублей перед патчем. Сейчас мы видим только ИТОГ (78 keys в union), а не **какие** ключи остались несклеенными.

**Что делаем:** в начале `dedupeSchemaInPlace`, до группировки:
```ts
const KNOWN_DUP_FAMILIES = ['cvet', 'garantiynyy', 'garantiynyi', 'stepeny_zaschity', 'srok_slughby'];
for (const family of KNOWN_DUP_FAMILIES) {
  const matching = Array.from(schema.keys()).filter(k => k.startsWith(family));
  if (matching.length >= 2) {
    console.log(`[DedupDebug req=${reqId}] ${contextLabel}: family="${family}" found ${matching.length} keys: ${JSON.stringify(matching)}`);
    // Plus first 3 captions для проверки нормализации:
    for (const k of matching.slice(0, 3)) {
      const info = schema.get(k)!;
      console.log(`[DedupDebug req=${reqId}]   "${k}" caption="${info.caption}" valuesCount=${info.values.size}`);
    }
  }
}
```
И **в конце** `dedupeSchemaInPlace`, после слияния — ещё раз перебрать те же families и логировать, что осталось:
```ts
console.log(`[DedupDebug req=${reqId}] ${contextLabel}: AFTER dedupe family="${family}" remaining: ${JSON.stringify(remaining)}`);
```

Без изменения самой логики дедупа — только наблюдение.

### 5. Acceptance criteria для проверки после деплоя

После деплоя прогнать **3 запроса**:

| Тест | Что проверяем в логах |
|---|---|
| `найди черные двухместные розетки` | (a) нет `[RankerCrash]`; (b) `[FacetsHealth]` показывает `total_values=?` (узнаем правду); (c) `[DedupDebug]` показывает РЕАЛЬНЫЕ cvet-ключи `BEFORE/AFTER` |
| `розетка с usb` | то же + `[FilterLLM]` для `kolichestvo_usb_portov...` |
| `выключатель Schneider Electric` | то же + проверка, что бренд резолвится |

**Главный вопрос, на который ответит этот деплой:** «Почему `cvet__tүs` и `cvet__tүsі` не слились — они в разных префиксах, или captions разные, или force-merge не отрабатывает?» Без точного ответа любой следующий патч — гадание.

---

## Что НЕ трогаем в этой итерации

- ❌ Логика дедупа `dedupeSchemaInPlace` — не меняем.
- ❌ TTL и логика кэша facets — не меняем (риск шторма обсудим в следующей итерации).
- ❌ `optionAliasesRegistry` (race condition) — не трогаем, потому что фикс требует прокидывания scope через 5 функций. Сделаем когда будем чинить дедуп.
- ❌ FilterLLM, классификатор, knowledge-base, GeoIP — не трогаем.
- ❌ `chat-consultant` контракт (request/response) — не меняется. Клиент не нужно править.

## Риски этой итерации

- 🟢 **Минимальные.** Все изменения либо защитные (null-safe, try/catch), либо чисто логи. Ни одна логика не меняется.
- 🟡 Объём логов вырастет ~на 15-20%. Не критично, Supabase logs справится.
- 🟢 Откат: revert одного коммита.

## Следующая итерация (после анализа логов)

Когда увидим реальные данные, сделаем **прицельный** план: либо чинить дедуп (если cvet-keys в разных prefix), либо чинить парсер facets (если 220volt отдаёт values, но мы их не читаем), либо договариваться с 220volt API. Без этих данных — гадание.

---

Подтвердите — иду делать?