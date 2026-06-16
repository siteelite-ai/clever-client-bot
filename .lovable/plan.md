
# План: системный фикс кейса «автомат 25А для квартиры»

Цель — устранить два корневых дефекта без нарушения существующих core-правил (mechanical classifier, data-agnostic, no self-narrowing, no semantic dictionaries).

## Дефекты, которые лечим

1. **Долгий escalate (~18.5с)** при unresolved-модификаторах, которых **нет ни в одном facet** bootstrap (контекстные слова: «квартиры», «дома», «красивый»).
2. **Узкая выдача без альтернатив**: при `final < 5 && unresolved.length > 0` бот молча отдаёт 1 товар, не предлагая пользователю уточнить ключевые характеристики.

Кейс «automat 25A для квартиры» = композиция обоих.

---

## Шаг 1 — Диагностика noun-фильтра (без кода)

**Что:** дернуть live catalog API теми же параметрами, что V1 на финальном hop:
```
GET /products?query=выключатель&options[nominalynyy_tok][]=25&per_page=30
```
Записать 30 `pagetitle` + `category.pagetitle`. Посчитать, сколько содержат стем `выключател`.

**Зачем:** понять — noun-фильтр (30→3) валидно отсеял УЗО/дифавтоматы или это баг рассинхронизации `classifier.product_category="автоматический выключатель"` vs `noun-extractor="выключатель"`.

**Решение по результатам:**
- Если 27 отсеянных — реально другие категории → noun-фильтр работает корректно, идём к Шагу 2.
- Если среди 27 есть «Автоматический выключатель IEK ВА47…» — открываем отдельный тикет на noun-extractor (Шаг 3a).

**Артефакт:** короткий отчёт в чате, без правок кода.

---

## Шаг 2 — Escalate short-circuit (Волна 1)

**Файл:** `supabase/functions/chat-consultant/index.ts`, блок escalate ~строки 8910–8945.

**Что добавить (до запуска `schema-merged` и `escalate-miss`):**
```
hasAnyChance = unresolvedModifiers.some(mod =>
  bootstrapSchema.captions.some(cap => 
    cap.toLowerCase().includes(mod.toLowerCase()) ||
    bucketValues(cap).some(v => v.toLowerCase().includes(mod.toLowerCase()))
  )
)
if (!hasAnyChance) {
  logAddStep({ step: 'qfv2-escalate-skip', meta: { reason: 'no_bootstrap_overlap', unresolved } })
  // пропускаем schema-merged + escalate-miss
}
```

**Гарантии:**
- Data-agnostic: проверка против live bootstrap, без словарей.
- Не ломает резолвер: если хоть один модификатор имеет шанс (подстрока в caption или value) — escalate работает как сейчас.
- Экономия 13–18с на запросах с контекстными словами.

**Тесты:**
- Unit для функции overlap-checker (3 кейса: full match, partial substring, zero overlap).
- Smoke на 5 запросах из `.lovable/fixtures/qa-23-cases-2026-06-15.md`, где есть unresolved.

**Метрика:** новый шаг `qfv2-escalate-skip` в логах, защита от регрессии — счётчик `escalate_skipped_total`.

**Память:** добавить в `mem://constraints/volna-a-timeouts` или новый файл `mem://features/escalate-short-circuit`.

---

## Шаг 3 — Soft-Suggest при узкой выдаче (Волна 2, под флагом)

**Триггер:** `branchTag='qfv2_win' && finalProducts.length < 5 && unresolvedModifiers.length > 0`.

**Что делать:**
1. Из bootstrap взять ТОП-3 фасета с наибольшим cardinality (исключая уже resolved + уже известные blacklist в `_shared/facet-blacklist.ts`).
2. Сформировать **текстовый followup** через Claude Sonnet 4.5 в constrained prompt:
   > «Подобрал N товаров. Чтобы сузить выбор — уточните: {caption1} (значения), {caption2} (значения), {caption3} (значения)».
3. Отдать как `data: {followup: {...}}` события — той же SSE-механикой, что и cross-sell.

**Гарантии:**
- НЕ сужает воронку — товары уже показаны.
- НЕ нарушает «no what's-missing» — это не объяснение пустого результата, а offer-to-refine при непустом.
- Под флагом `app_settings.soft_suggest_enabled` (уже существует, mem://features/query-first-branch).
- Anti-hallucination: значения берутся ТОЛЬКО из bootstrap, post-validated.

**Тесты:**
- Unit: при `finalProducts.length >= 5` → suggest не вызывается.
- Unit: при `unresolved.length === 0` → suggest не вызывается.
- E2E: «автомат 25А для квартиры» → 1 карточка + followup с фасетами «Количество полюсов», «Характеристика срабатывания», «Номинальное напряжение».

**Память:** обновить `mem://features/query-first-branch` — описать триггер Soft-Suggest для qfv2_win.

---

## Шаг 4 — Опциональное расследование (зависит от Шага 1)

Если Шаг 1 выявил рассинхронизацию classifier ↔ noun-extractor:
- Обсудить, добавлять ли fallback на full `product_category` при noun-filter=0 (вместо текущего «non-strict → весь pool»).
- НЕ делать без подтверждения.

---

## Технические детали

### Файлы
- `supabase/functions/chat-consultant/index.ts` — Шаги 2, 3.
- `supabase/functions/_shared/facet-blacklist.ts` — Шаг 3 (использование, не правка).
- Новые тесты: `chat-consultant/escalate-shortcircuit_test.ts`, `chat-consultant/soft-suggest-qfv2_test.ts`.

### Флаги
- `query_first_enabled` — уже true, не трогаем.
- `soft_suggest_enabled` — Шаг 3 включается только при true.

### Метрики (логи `chat_request_logs.steps`)
- `qfv2-escalate-skip` — Шаг 2.
- `qfv2-soft-suggest-shown` / `qfv2-soft-suggest-skipped` — Шаг 3.

### Что НЕ делаем
- Словари контекстных слов (запрещено classifier MECHANICAL).
- Авто-фильтр «квартира → 1P, C, 230V» (запрещено no self-narrowing).
- Правки hard-ban price=0 (работает корректно).
- Правки noun-filter без Шага 1.

---

## Последовательность и точки подтверждения

1. **Шаг 1** (диагностика, ~5 мин) → жду подтверждение «идём дальше» + интерпретацию результата.
2. **Шаг 2** (~30 строк + тесты, deploy) → жду «протестировано».
3. **Шаг 3** (Soft-Suggest под флагом, deploy с флагом=false) → жду «включаем флаг».
4. **Шаг 4** (опционально) — только если Шаг 1 показал баг.

Начинаем с Шага 1?
