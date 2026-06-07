# Jargon-fallback в qfv2_honest_empty_partial

## Проблема

Запрос «есть лампа кукуруза?» уходит в Soft-404 «дропнут фасет Форма колбы», хотя в каталоге есть corn-лампы. Корень: ветка `qfv2_honest_empty_partial` (V1, `supabase/functions/chat-consultant/index.ts:8348-8360`) сдаётся сразу же, как только `resolveFiltersWithLLM` вернул хотя бы один `unresolvedDetails`, и НЕ пробует `tryJargonFallback`. Все остальные точки Soft-404 уже защищены jargon-fallback'ом (early, post-search, unfulfilled-split в `qfv2_win`).

## Что меняем

ОДНА вставка внутри блока `if (resolverUnresolvedDetails.length > 0)` (строка 8348), ДО присваивания `qfv2HonestEmptyContext` и `branchTag='qfv2_honest_empty_partial'`. Никаких изменений вне этого if'а.

Логика вставки (идентична паттерну `unfulfilled-split` со строки 8425, чтобы не вводить новые подходы):

1. Динамический импорт `tryJargonFallback` из `_shared/jargon-fallback.ts`.
2. Вызов с `originalQuery = userMessage || noun`, `searchFn = (alt) => searchProductsByCandidate({ query: alt, ... }, ..., 10)`, тем же `openrouterKey` и `log`-callback'ом.
3. Sanitize результата (`price>0`, top-N через существующий `pickDisplayWithTotal`).
4. Если `jr.products.length > 0`:
   - `displayList = sanitized`, `branchTag = 'qfv2_jargon_recovery'`, метрика `logAddStep('qfv2-jargon-recovery', ...)`.
   - `totalCollectedBranch = 'jargon-fallback'` (тот же тег, что и downstream — попадёт в существующий deterministic-render-путь).
   - `qfv2HonestEmptyContext` НЕ ставится → downstream Soft-404 jargon не перезапустится (гейт на 10303 продолжает работать).
5. Если пусто или исключение — `try/catch` глотает, выполнение проваливается в существующий honest-empty-partial (текущее поведение).

## Гарантии безопасности по веткам

| Ветка | Затронуто |
|---|---|
| `qfv2_win` / `qfv2_unfulfilled_split` (8378-8476) | нет — другая условная ветка |
| `qfv2_pool_rescue` (8485) | нет |
| `qfv2_honest_empty` (final=0 с полностью resolved filters, 8491) | нет — другая ветка else |
| `qfv2-bridge` (has_product_name → QFv2) | косвенно: точно тот же кейс, что чинит патч |
| `accessory-for` (cascade collection→compat→brand→all) | нет — другой роутер |
| Early jargon-fallback (10034) | нет |
| Downstream jargon-fallback (10294-10394) | нет: гейт `!qfv2HonestEmptyContext` сохраняется; при нашем успехе context не ставится → но `foundProducts.length>0` → блок 10303 в любом случае не запустит повторный jargon (там условие `foundProducts==0`) |
| Soft-404 (10394+) | нет — при успехе у нас есть карточки, в Soft-404 не заходим |
| Article / pagetitle / name-query / price / similar / replacement | нет — другие top-level пути |
| Compute (spec_query) | нет — `compute` отключает deterministic-render отдельно |
| V2 (`chat-consultant-v2`) | физически другой файл, не трогается |

При исключении внутри `tryJargonFallback` или его searchFn — silent catch → старое поведение honest-empty-partial. Регресс невозможен.

## Метрики и тест-кейс

- `logAddStep({ step: 'qfv2-jargon-recovery', total: N, meta: { noun, originalQuery, matchedAlternative, dropped_facet } })` при успехе.
- `logAddStep({ step: 'qfv2-jargon-recovery-skip', meta: { reason: 'empty'|'error', noun } })` при неудаче.
- Кейс в `.lovable/fixtures/`: «есть лампа кукуруза?» → `branchTag='qfv2_jargon_recovery'`, ≥1 corn-лампа, нет Soft-404.
- Регрессионный кейс: «ВВГнг 3х2.5» (bridge → resolved → не должен попадать в jargon, проверяем что `qfv2_win` остаётся `qfv2_win`).

## Технические детали

Файлы:
- `supabase/functions/chat-consultant/index.ts` — вставка ~25-30 строк в блок строки 8348.
- `.lovable/fixtures/qfv2-jargon-cases-2026-06-07.md` — новый файл с двумя кейсами (corn + regression).
- `mem://index.md` Core: добавить упоминание `qfv2_jargon_recovery` рядом с `qfv2_honest_empty_partial`.

НЕ трогаем: classifier, has_product_name bridge, resolveFiltersWithLLM, jargon-fallback.ts (используется as-is), composer, soft-404 промпт.

## Принят критерий

На кейсе «есть лампа кукуруза?» в логах:
- `step: 'qfv2-jargon-recovery'` с `total ≥ 1`;
- `branchTag = 'qfv2_jargon_recovery'`;
- Финальный ответ — карточки corn-ламп через deterministic render, БЕЗ Soft-404 «Форма колбы».

На кейсе «ВВГнг 3х2.5» — `branchTag` остаётся `qfv2_win` (никакого jargon не вызывается, т.к. resolved filters непусты).
