
# Step C: Honest-Split Fallback (intersection_empty → two-axis render)

## Цель
Когда `search_catalog by_filter` с ≥2 разными фасетами возвращает `total=0`, не сдаваться, а честно сказать «такого сочетания нет» и показать **два параллельных блока** — по одной оси каждый.

Закрывает кейс «кукуруза + E27» и любой другой «X для Y».

## Архитектура

Серверный страж в `chat-consultant-v3/index.ts`, сразу после уже существующего Step 2 (inferred-filter fallback), но ДО Step 6c (fresh pool tracking).

```text
search_catalog by_filter (≥2 axes) → total=0
        │
        ▼
[Step C guard]
   ├─ извлечь axes = Object.entries(options)  (например: Тип=[LED CORN], Цоколь=[E27])
   ├─ если axes.length < 2 → пропустить (это не пересечение)
   ├─ параллельно: для каждой axis сделать search_catalog по одной оси (тот же category, per_page=5)
   │       axisA: options = {Тип:[LED CORN]}
   │       axisB: options = {Цоколь:[E27]}
   ├─ если оба total=0 → пропустить (полный miss, дальше Step 7 в будущем)
   ├─ если ≥1 ось дала total>0:
   │       inject в tool reply:
   │         {
   │           total: 0,
   │           _intersection_empty: true,
   │           _split_axes: [
   │             { axis: "Тип", value: "LED CORN", ids: [...], total: N },
   │             { axis: "Цоколь", value: "E27", ids: [...], total: M }
   │           ],
   │           _server_hint: "Точного сочетания нет. Скажи это честно и вызови
   │                          render_products ОДИН раз с двумя группами:
   │                          сначала ids оси A, потом ids оси B. В тексте перед
   │                          render_products предложи пользователю выбрать,
   │                          какой осью пожертвовать."
   │         }
   └─ записать step `v3_guard_split_fallback` с метой axes, totals, ms
```

## Изменения в коде

### 1. `supabase/functions/chat-consultant-v3/index.ts`

**Новая функция-хелпер** (рядом с другими guards, ~line 575):
```ts
async function trySplitFallback(
  origArgs: Record<string, unknown>,
  ctx: { catalogToken: string; cache: ProductCache },
): Promise<null | { axes: Array<{ axis: string; value: string; ids: string[]; total: number }>; ms: number }>
```
- Проверяет `mode === "by_filter"` и `Object.keys(options).length >= 2`.
- Для каждой оси делает `executeSearchCatalog` с `options = {[axis]: values}`, `per_page = 5`, тот же `category`, без `query`.
- Параллельно через `Promise.all`.
- Возвращает массив только тех осей, где `total > 0`.
- Кладёт найденные товары в общий `ProductCache` (executeSearchCatalog это делает сам).

**Интеграция** (в основном цикле, после строки 1185, до Step 6c):
```ts
// ── Step C: Honest-split fallback for empty intersection
if (
  tc.name === "search_catalog" &&
  result.ok &&
  (result as { total: number }).total === 0 &&
  !inferredFallback &&  // не дублируем работу Step 2
  tc.args.mode === "by_filter" &&
  tc.args.options && Object.keys(tc.args.options).length >= 2
) {
  const split = await trySplitFallback(tc.args, ctx);
  if (split && split.axes.length >= 1) {
    splitFallbackResult = split;  // сохраняем для inject ниже
    send({ type: "tool_event", tool: "search_catalog", phase: "result",
           duration_ms: split.ms,
           summary: `split: ${split.axes.map(a => `${a.axis}=${a.total}`).join(", ")}` });
    steps.push({ step: "v3_guard_split_fallback", ms: now(),
                 meta: { axes: split.axes.map(a => ({...a, ids: a.ids.length})) }});
  }
}
```

**Inject в `replyObj`** (около строки 1253, рядом с другими `_server_*` хинтами):
```ts
if (splitFallbackResult) {
  replyObj._intersection_empty = true;
  replyObj._split_axes = splitFallbackResult.axes;
  replyObj._server_hint =
    "Точного сочетания фильтров в каталоге нет (total=0). НЕ извиняйся и НЕ эскалируй. " +
    "Сделай короткий текст: «Точного сочетания нет, но есть отдельно X и отдельно Y — что ближе?», " +
    "затем ОДИН вызов render_products с product_ids = объединением ids всех осей из _split_axes " +
    "(до 8 шт, сначала по 4 из каждой оси).";
}
```
И сбросить `splitFallbackResult = null` в начале каждой итерации шагов.

**Также добавить ids из split в `freshSearch`**, чтобы render-guard (6a) тоже мог их подставить, если LLM забудет:
```ts
if (splitFallbackResult) {
  const allIds = splitFallbackResult.axes.flatMap(a => a.ids).slice(0, 8);
  if (allIds.length > 0) freshSearch = { tool: "search_catalog_split", ids: allIds,
                                          total: splitFallbackResult.axes.reduce((s,a)=>s+a.total,0) };
}
```

### 2. `supabase/functions/_shared/v3-tools/schemas.ts`

Добавить hard_rule 14:
> **14. Intersection-empty honesty.** Если tool_result содержит `_intersection_empty: true` и `_split_axes`, НЕ эскалируй и НЕ говори «нет в каталоге» сухо. Сделай короткое признание + предложение выбрать ось, и вызови `render_products` с объединёнными ids из `_split_axes`. Используй ровно эти ids — не выдумывай новые.

## Что НЕ меняем
- API `search_catalog`, `render_products`, формат SSE-событий — без изменений.
- Существующие стражи 2, 6a–e — без изменений, Step C встаёт между ними.
- БД, миграции — не нужны.

## Тестирование

1. **Регресс-кейс «кукуруза+E27»** (`6d94c0c0...`): новый прогон через `curl_edge_functions`, ожидаем `v3_guard_split_fallback` в `steps`, `final_products_count > 0`, два блока в render.
2. **C02–C23 батч**: убедиться что для уже работающих кейсов ничего не сломалось (split срабатывает только на `total=0` с ≥2 фасетами).
3. **Negative-кейс**: запрос с одним фасетом → split НЕ должен сработать.

## Файлы

- `supabase/functions/chat-consultant-v3/index.ts` — новая функция `trySplitFallback` + интеграция в цикл (~40 строк).
- `supabase/functions/_shared/v3-tools/schemas.ts` — hard_rule 14 (1 пункт).
- `.lovable/memory/features/expert-v3-render-escalate-guard.md` — дописать секцию Step C.

## Риски
- **Доп. латентность**: +1 параллельный батч search_catalog (~500–1500 мс) только когда `total=0`. На успешных запросах оверхед = 0.
- **Шум для LLM**: hard_rule 14 короткое, не ломает существующие правила 10–13.
- **Двойной счёт со Step 2**: защищаемся через `!inferredFallback` — Step C запускается только если Step 2 не сработал.
