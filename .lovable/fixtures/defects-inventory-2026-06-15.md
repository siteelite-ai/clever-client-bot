# Defects Inventory — 2026-06-15

Source: скриншоты QA + логи `session_vornn28qt_1781081091822`.
Confidence: `LOGS` = есть Steps/Final, `SCREEN` = только текст ответа, `GUESS` = вывод по симптому.

| # | Query | Branch (actual) | Failure step | Root-cause hypothesis | Conf | Wave |
|---|---|---|---|---|---|---|
| 1 | Автомат ВА 47-29 16А GENERICA, аналог ≤1000тг | replacement → qfv2 fallback | `replacement-matcher timeout 10s` + `has_product_name=false` | B1 (маркировка не определена как product_name) + A3 (timeout cap) + C4 (brand-exclude/price-cap в traits) | LOGS | B+A+C |
| 2 | Хочу заменить люстру → светодиод в гостиной 25м² | replacement | `repl_matcher_timeout_10s` (exception) | A3 timeout cap + C5 clarify-before-search для underspecified-broad + D3 lux/area→lamps | LOGS | A+C+D |
| 3 | Кабель ВВГ 3*1,5 покажи все позиции | qfv2-bridge | `qfv2-pool total=0` (enrichMods=[ввг,3,1]) затем LLM «1 позиция» (галлюцинация цены) | C3 (маркировка «3*1,5» дробится) + B1 (has_product_name для ВВГ-маркировки) + детерминистичный рендер не сработал | LOGS | B+C |
| 4 | Лампа кукуруза на цоколь Е27 | qfv2 | `qfv2-pool 10s timeout` ×2, jargon-fallback НЕ вызван | C2 (canonical кукуруза→corn регрессия) + A2 (timeout cap 10→4s) | LOGS | A+C |
| 5 | NBT-CR2025-BP5 цена за шт/упаковку? | s-spec → qfv2 fallback | `qfv2-pool empty` → LLM уводит в Soft-404 вместо чтения unit из карточки | D1 (spec_query «единица измерения» из Product.options) | LOGS | D |
| 6 | Прожектор на улицу | replacement/qfv2 | (session идёт) | D4 lexicon прожектор vs фонарь | SCREEN | D |
| 7–24 | QA скриншоты (24 кейса) | mixed | без Steps | требуется прогон через curl или присылка логов | SCREEN/GUESS | TBD |

## Подтверждённые дефекты (LOGS)

### D1: `repl_matcher_timeout_10s` — 2 кейса
Hard 10s timeout без graceful fallback. Должен: cap 6s + fallback на anchor-категорию top-N.

### D2: `qfv2-pool 10s × 2 = 20s` — кейс «лампа кукуруза»
Двойной timeout сжигает 20с, jargon-fallback не вызывается (пустой pool ≠ пустой final). Должен: cap 4s + retry 3s, ИЛИ переход в jargon-fallback при pool=0 повторе.

### D3: Маркировка «3*1,5» → `[3, 1, 5]` в enrichMods
`qfv2-bridge` синтезирует modifiers tokeniser'ом, который ломает «3*1,5». Должен: regex-preserve `\d+[xх*×]\d+([,.]\d+)?`.

### D4: `has_product_name=false` для «ВА 47-29 GENERICA», «ВВГ 3*1,5»
Classifier не распознаёт буквенно-цифровые маркировки как product_name → не идём в pagetitle/name-query сразу. Должен: правило в `classifier-prompt.ts` — маркировка вида `[A-ZА-Я]{2,}[-\s]?\d` = product_name.

### D5: Цена-галлюцинация в кейсе ВВГ 3*1,5
Final LLM сочинил карточку «462 ₸ за метр, бренд: ВВГ» при `qfv2-pool-empty total=0`. Должен: детерминистичный рендер ДОЛЖЕН отрабатывать при `foundProducts.length===0` → Soft-404, БЕЗ стрима LLM с карточками.

### D6: jargon-fallback «кукуруза» не сработал
По mem://features/jargon-fallback должно быть canonical. В логах кейса «лампа кукуруза» шаг `qfv2-jargon-recovery` отсутствует, сразу `soft-404`. Регрессия.

### D7: `qfv2-pool-empty` ведёт LLM в Soft-404 с уточнением вместо jargon-fallback
Кейс NBT-CR2025: bot выдал «по запросу не подобралось… хотите уточнить...» — это противоречит правилу `articleShortCircuit` + spec_query (должен был остаться в s-spec и ответить про единицу).

## Карта зависимостей (модули → дефекты)

```text
classifier-prompt.ts        → D4 (has_product_name), B3 (critical_modifiers)
_shared/facet-blacklist.ts  → B2 (марки в brand)
qfv2-bridge tokeniser       → D3 (маркировка-атом)
chat-consultant/index.ts    → A2 (qfv2 pool timeout), C2 (jargon-fallback wiring)
replacement-traits.ts       → A3 (timeout), C4 (brand/numeric/original-leak)
s-catalog-composer.ts       → A1 (price=0 leak), D5 (детерминистичный рендер при empty)
s3-router.ts                → C5 (clarify-before-search), D4 (lexicon прожектор/фонарь)
spec branch                 → D1 (unit из карточки), D2 (power→section), D3 (lux/area)
```

## Открытые вопросы (нужны для старта Волны A)

1. Порядок волн: A → B → C → D, или сместить B вперёд (classifier-регрессии триггерят все остальные ветки)?
2. Кейсы 7–24 без логов: прислать самой / прогнать самим через `supabase--curl_edge_functions`?
3. Memory-апдейт после каждой волны (фиксировать новые правила) — да/нет?
