# План: Wave C5.1 — Probe-then-Clarify в C5 (устранение false-positive)

## Контекст
C5-регрессия (2026-06-15) выявила false-positive: «дрель makita 18в» триггерит clarify, хотя бренд+вольтаж заданы.
Корень — Gate 2 (LLM) решает «слишком широко?» вслепую, без знания `probe.total`.

## Системное решение
Probe-then-Clarify (паттерн §4.4 Price-ladder / QFv2 pool-rescue): между Gate 1 (detector) и Gate 2 (LLM) добавить probe `/products?query=<raw>&per_page=1`, читать `pagination.total`. Если ≤ N_SKIP — silent fallback на обычный pipeline.

## Шаги (выполняю последовательно, без подтверждений)

1. **Добавить probe в C5-хук** (`chat-consultant/index.ts` ~7388-7416):
   - inline-fetch через существующий `fetchCatalogWithRetry`, URL `${VOLT220_API_URL}?query=<userMessage>&per_page=1`, timeout 2500мс.
   - Парс `data.pagination.total`.
   - Константа `C5_PROBE_SKIP_THRESHOLD = 30` (объявить локально перед хуком).
   - Логика:
     - `probe.total = 0` → silent fallback (далее QFv2/jargon разберутся).
     - `1 ≤ probe.total ≤ 30` → silent fallback (узкая выборка, clarify не нужен).
     - `probe.total > 30` или probe timeout/error → продолжаем в Gate 2 (текущее поведение).
   - Метрики: `c5_broad_probe_total{total=N,ms=M}`, `c5_broad_probe_skip{total=N,reason=narrow|empty}`.

2. **Deploy** `chat-consultant`.

3. **Regression-прогон** 8 кейсов:
   - C5-1 светодиод 25м² → должен остаться clarify
   - C5-2 лампа для дома → должен остаться clarify
   - C5-3 лампа е27 led 9вт → silent fallback (как сейчас)
   - C5-4 дрель makita 18в → **NEW: probe-skip silent fallback** (целевое исправление)
   - C5-5 кабель 100м → должен остаться clarify
   - C5-6 ВВГнг 3х2.5 → has_product_name bridge (как сейчас)
   - C5-7 розетка с заземлением 16а → проверить (вероятно clarify)
   - C5-8 перфоратор bosch sds-plus 800вт → probe-skip silent fallback (бренд+спецы)

4. **Обновить память** `mem://features/c5-clarify-broad`:
   - Добавить раздел «Probe-step» с порогом и метриками.
   - Обновить Anti-patterns: запретить хардкод-листы брендов как альтернативу.
   - Verified live добавить C5-4 / C5-8 case.

5. **Обновить `mem://index.md` Core** — одна строка про probe-skip в C5.

## Инварианты (НЕ нарушать)
- Data-agnostic (никаких whitelist'ов).
- Не self-narrowing (probe = только счётчик total, фильтров не применяем).
- Не блокирует QFv2/jargon/replacement при probe.total=0.
- `dialogSlots` не трогаем.
- Silent fallback на любую ошибку.
- Совместимо со всеми текущими ветками (см. mem://index.md Core).
