# План: Инвентаризация → Карта зависимостей → 4 волны фиксов

> Консилиум: **Architect** (карта зависимостей), **RAG Quality** (поиск/факеты/jargon), **Sales Logic** (clarify/cross-sell/CTA), **Edge Stability** (таймауты QFv2/replacement-matcher), **Conversion** (Soft-404 → escalation), **Replacement** (traits/brand-exclude), **Compute/Spec** (мощность/единица/lux), **Classifier** (split, has_product_name, critical_modifiers), **QA** (фикстуры/регресс), **Observability** (метрики дефектов).

---

## Фаза 0 — Инвентаризация (read-only, без правок кода)

Цель: единый артефакт `.lovable/fixtures/defects-inventory-2026-06-15.md` со всеми 24+ кейсами, реальными Steps/Final из логов, и привязкой к коду.

Действия:
1. Собрать все ранее присланные кейсы (24 из скриншотов + 4 новых: NBT-CR2025, лампа кукуруза, ВВГ 3*1,5, люстра 25м²) в единую таблицу.
2. Для каждого кейса зафиксировать:
   - input query
   - classifier output (factual из логов, не гипотеза)
   - branch path (qfv2/price/replacement/spec/jargon)
   - где упало (step с total=0 или error/timeout)
   - ожидание vs факт
3. Для кейсов без логов — пометить `LOGS_NEEDED`, запросить у пользователя или прогнать через `supabase--curl_edge_functions` самим.

Артефакт: таблица `| # | query | branch | failure_step | root_cause_hypothesis | confidence (logs/guess) |`.

---

## Фаза 1 — Карта зависимостей (Architect)

Цель: понять, какие фиксы конфликтуют, какие безопасно параллелить.

Узлы графа (модули):
```text
classifier (s2)
  ├─→ has_product_name flag ──→ pagetitle → name-query → qfv2-bridge
  ├─→ critical_modifiers ─────→ skips name-query (см. лампа кукуруза)
  ├─→ search_modifiers split ─→ split-mode (мульти-интент)
  └─→ compute/sub_intent ─────→ s-spec branch

qfv2 (query-first v2)
  ├─→ noun extractor (Claude 4.5, 8s timeout)
  ├─→ pool fetch (10s timeout × 2 = 20s)  ← BOTTLENECK
  ├─→ jargon-fallback (Claude 4.5)        ← регрессия «кукуруза»
  ├─→ pool-rescue / honest-empty / soft-404
  └─→ filter-llm (noun anchor)

replacement (s-replacement)
  ├─→ traits matcher (10s timeout)        ← timeout в кейсе люстра 25м²
  ├─→ brand exclude
  └─→ original leak guard

price branch (s-price)
  └─→ min_price=1 cheapest                 ← регрессия per_page=1 vs 10

s-catalog-composer
  ├─→ deterministic render
  ├─→ price=0 guard                        ← leak в QFv2 (CHINT)
  └─→ soft-404 contacts
```

Конфликты:
- `classifier.critical_modifiers` правка ↔ `qfv2-bridge` синтез modifiers (общий tokeniser) — править последовательно.
- `qfv2 timeout` ↔ `jargon-fallback` — оба меняют поведение при `pool=0` retry. Сначала timeout cap, потом jargon.
- `replacement timeout` ↔ `s-spec` — независимы, можно параллельно.

---

## Фаза 2 — Волны фиксов

### 🌊 Волна A — Critical, low-risk (день 1)

| # | Фикс | Файл | Риск |
|---|---|---|---|
| A1 | price=0 leak в QFv2 final render | `s-catalog-composer.ts` + qfv2 branch | низкий |
| A2 | QFv2 pool timeout cap: 10s → 4s, retry 10s → 3s | `chat-consultant-v2/index.ts` qfv2-pool | низкий |
| A3 | replacement-matcher timeout cap: 10s → 6s + graceful fallback на top-N anchor категории | `chat-consultant/replacement-*` | средний |
| A4 | Soft-404 streak → contactManager (проверить, что contacts реально приходят, а не обрезаются стримом) | composer | низкий |

Метрики после волны: `zero_price_leak=0`, p95(qfv2)<8s, `repl_matcher_timeout_10s=0`.

### 🌊 Волна B — Classifier hygiene (день 2)

| # | Фикс | Файл |
|---|---|---|
| B1 | `has_product_name=true` для буквенно-цифровых маркировок («ВА 47-29 GENERICA», «ВВГ 3*1,5») | `_shared/classifier-prompt.ts` |
| B2 | Маркировки/серии в blacklist факета `brend__brend` («КГ», «ВА», «ВВГнг») | `_shared/facet-blacklist.ts` |
| B3 | `critical_modifiers` должны включать численные характеристики (16A, 7W, 100W, 3*1.5) и форм-фактор (downlight, кукуруза, таблетка) | `classifier-prompt.ts` |
| B4 | Split-mode только при явных коннекторах («и» между разными категориями), не внутри маркировки «3*1,5» | `_shared/unfulfilled-split.ts` |

Регресс: golden-фикстуры для каждой правки (`classifier-prompt_test.ts`).

### 🌊 Волна C — Branch logic (день 3-4)

| # | Фикс | Файл |
|---|---|---|
| C1 | **Price Branch**: вернуть `per_page=10` (регрессия 2026-05-02), убедиться, что `min_price=1` отдаёт ASC top-10 | `s-price.ts` |
| C2 | **Jargon-fallback**: canonical «кукуруза→corn lamp» должен работать; вернуть unit-test из mem://features/jargon-fallback | `_shared/jargon-fallback.ts` |
| C3 | **QFv2 enrichMods**: не дробить «3*1,5» на [3,1,5] — препроцессинг сохраняет маркировку как атом | `chat-consultant-v2/index.ts` qfv2-bridge |
| C4 | **Replacement traits**: учитывать численные (ампераж, мощность), исключать original (артикул=anchor), исключать тот же бренд при «аналог дешевле бренда X» | `chat-consultant/replacement-traits.ts` |
| C5 | **Clarify-before-search** для underspecified-broad («светодиодное освещение 25м²») — 1 уточняющий вопрос перед replacement-matcher | `s3-router.ts` |

### 🌊 Волна D — Compute/Spec расширения (день 5)

| # | Фикс | Файл |
|---|---|---|
| D1 | spec_query: «единица измерения» («за штуку/упаковку») — читать из `Product.options[].unit` карточки, не уводить в QFv2 | `s-spec` branch |
| D2 | spec_query: мощность→сечение кабеля (3kW→2.5mm²) | `compute` handler |
| D3 | spec_query: lux × area → количество ламп / поток | `compute` handler |
| D4 | Category confusion «прожектор vs фонарь» — lexicon-resolver правило | `lexicon-resolver.ts` |

---

## Фаза 3 — Регрессия и приёмка

1. Прогнать **все** 28 кейсов через `supabase--curl_edge_functions` после каждой волны.
2. Зафиксировать результаты в `.lovable/fixtures/defects-results-2026-06-15.md` (pass/fail/partial).
3. Critical-метрики (должны быть 0 после волны A+C):
   - `zero_price_leak_total`
   - `repl_matcher_timeout_10s_total`
   - `qfv2_pool_timeout_total`
   - `clarification_zero_result_total`
   - `auto_narrowing_attempts_total`

---

## Что мне нужно от тебя перед стартом

1. **Подтверди порядок волн** (A → B → C → D) или скажи, что важнее (например, B перед A, если classifier-регрессии ломают больше).
2. **Кейсы без логов** — пришлёшь сама, или я сам прогоню через curl и соберу Steps?
3. **Memory-апдейт после каждой волны** (да/нет) — чтобы зафиксировать новые правила и не откатить их следующей итерацией.

Технические детали для разработчика:
- Все правки в `chat-consultant` (V1 active) и `_shared/`. V2 НЕ трогаем в этой итерации (см. mem://architecture/v2-pipeline-switch).
- Каждая волна = отдельный коммит с тестами.
- Никаких изменений в spec без явного запроса (mem://core: spec data-agnostic).
