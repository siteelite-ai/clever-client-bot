## Консилиум по сессии 2c4c6864

Привлечены 3 роли из AUDIT_PROMPT.md + архитектор. Все говорят прямо.

---

### Edge Functions Stability Auditor (роль 4) — что сейчас сломано

Изучил `supabase/functions/chat-consultant/index.ts` (строки 5260–5440, 7085–8020) и `_shared/classifier-prompt.ts`.

**Дефект 1 — двойной классификатор.** В short-circuit ветке после успешного `pagetitle`/`name-query` мы вторым вызовом дёргаем Claude (`generateSearchCandidates`) только ради `compute={attribute, multiplier}`. +3-4с латентности и нестабильно: на длинных product_name Claude иногда возвращает `compute=null`, и расчёт молча теряется (сессия 09:14).

**Дефект 2 — sub_intent ломает поиск.** Классификатор на «Щит … 75*124*57мм IP20 **есть в наличии?**» ставит `has_product_name=false` и сваливает всё в `critical_modifiers=["2-4 модуля 75*124*57мм IP20"]` (сессии 08:19/08:29/08:42 → branch=jargon-fallback, 15 шумных карточек вместо одной точной). Разговорная обёртка про наличие искажает определение product_name.

**Дефект 3 — sub_intent intro прибит к одной ветке.** `buildIntroBySubIntent` живёт прямо внутри `buildDeterministicShortCircuitContent` (строки 4477–4498). Branches типа QFv2-soft / jargon-fallback-early используют тот же helper — это OK; но если catalog-ветка с Pass 2 проходит мимо — intro теряется. Сейчас условие `shouldUseDeterministicProductRender` это покрыло, но логика рассыпана и ломается при каждом следующем рефакторе.

### Sales Logic Auditor (роль 2) — что видит клиент

«Сколько весить 5 шт» → карточка без веса. Это провал по checklist: «При запросе характеристик — даёт ссылку на товар» — ссылку даёт, **но на сам вопрос не отвечает**. С точки зрения продаж это хуже, чем «не нашёл»: клиент чувствует, что бот его не слышит.

«Есть в наличии?» иногда даёт 15 карточек вместо 1 — это размывание воронки (роль 5: «Путь от вопроса до товара ≤ 2-3 сообщения» нарушен).

### Архитектор — корневая причина

`sub_intent` сейчас протекает в **поисковую** часть pipeline и одновременно слабо влияет на **ответную**. Должно быть строго наоборот:

```
ПОИСК (ствол) — sub_intent НЕ ВЛИЯЕТ ВООБЩЕ
classify → pagetitle → name-query → QFv2 → jargon-fallback → soft-404
                                                                 ↓
                                                          foundProducts
                                                                 ↓
ОТВЕТ (надстройка) — единый sink, читает sub_intent и compute
                  ↓
          buildAnswer(products, subIntent, compute?)
                  ↓
   availability → "Да, есть в наличии: <карточка>"
   price        → "Стоит X ₸: <карточка>"
   location     → "Доступен в <города>: <карточка>"
   spec+compute → LLM считает "<value> × N = <итог>: <карточка>"
   spec без compute → "По характеристикам: <карточка>" (детерминистично)
   null         → "Подобрал: <карточка>"
```

---

## План внедрения (4 шага, по правилу «step-by-step + confirm»)

### Шаг 1. Classifier-prompt: разделение поиска и намерения

`supabase/functions/_shared/classifier-prompt.ts`:
- Добавить в схему поле `compute: {attribute: string, multiplier: number|null} | null` рядом с `sub_intent` (классификатор уже Claude Sonnet 4.5 — справится одним вызовом).
- Явное правило: разговорные обёртки (`есть в наличии?`, `сколько стоит?`, `где забрать?`, `сколько весит?`) — это **только** `sub_intent`/`compute`. Они НЕ влияют на `has_product_name`, НЕ попадают в `product_name`, НЕ становятся `critical_modifiers`. Алгоритм: сначала срезать «хвост-вопрос» → классифицировать оставшееся как товар → метку sub_intent поставить отдельно.
- Самопроверка для LLM: «если убрать слова про наличие/цену/место/характеристику — получится валидное название товара или фильтр? Если да → используй то, что осталось».

### Шаг 2. Удалить двойной вызов Claude в short-circuit

`chat-consultant/index.ts` строки 7087–7115:
- Убрать regex-gate `looksLikeSpecQuery` и второй вызов `generateSearchCandidates`.
- `compute` читается напрямую из `classification.compute` (заполненного в шаге 1).
- Удалить `ComputeRequest` extraction из `generateSearchCandidates` (или оставить как fallback, но не вызывать ради него).

### Шаг 3. Единый форматтер ответа

Вынести из `buildDeterministicShortCircuitContent` (строки 4464–4505) функцию `buildIntroBySubIntent(subIntent, products, fallbackReason, effectivePriceIntent)` в отдельный helper. Все ветки (article/siteid/pagetitle/name-query/qfv2/jargon-fallback/pass2) вызывают её через одну точку.

Правило: если `sub_intent='spec' && compute` — детерминистичный рендер выключен (как сейчас), идём в LLM с `buildComputeInstructionBlock`. Если `sub_intent='spec' && !compute` — детерминистичный рендер включён с intro «Вот товар, по характеристикам:» (а не молчаливое «Подобрал товары»).

### Шаг 4. Регрессионная проверка

Прогнать через `supabase--curl_edge_functions` ровно 4 запроса и сверить branch+intro+products в `chat_request_logs`:
1. `Щит … 75*124*57мм IP20 есть в наличии?` → branch=pagetitle ИЛИ name-query, 1 товар, intro=«Да, есть в наличии:»
2. `сколько будет весить 5 Корпус метал ЩРв-12з-3 …` → branch=pagetitle/name-query, intro содержит вычисленный вес × 5
3. `найди лампы-кукурузы` → branch=jargon-fallback, intro=«Подобрал товары…»
4. `сколько стоит автомат IEK ВА47-29 16А` → sub_intent=price, intro=«Вот актуальная цена:»

Каждый шаг — отдельный коммит + deploy + проверка логов перед переходом к следующему.

---

## Технические детали (для разработчика)

| Файл | Изменение |
|---|---|
| `_shared/classifier-prompt.ts` | +поле `compute` в JSON-схеме, +правило про срезание хвоста-вопроса |
| `chat-consultant/index.ts:1230-1265` | расширить `ClassificationResult.compute`, парсить из основного классификатора |
| `chat-consultant/index.ts:7087-7115` | удалить `looksLikeSpecQuery` + второй `generateSearchCandidates`; `computeField = classification?.compute` |
| `chat-consultant/index.ts:4464-4498` | вынести intro-логику в `buildIntroBySubIntent`, экспортировать |
| `chat-consultant/index.ts:7980` | условие отключения детерминистичного рендера: `hasComputeRequest` (без изменений) |
| `mem://features/spec-query` | обновить: compute теперь в основном classifier, второй вызов удалён |

Подтверди — стартую с **Шага 1**.