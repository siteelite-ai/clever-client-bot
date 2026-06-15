---
name: Replacement Anchor Ladder — Parallel
description: Wave B3 — D1 latency fix. LVL1/2/3 запускаются параллельно, выбор по приоритету, общий бюджет 20с
type: feature
---

## Проблема (D1)
Последовательная лестница LVL1→LVL2→LVL3 в replacement-ветке давала до 46с:
- LVL1 pagetitle (быстро, но часто miss для маркировок типа «ДКУ-LED-03-100W»)
- LVL2 fuzzy ?query (медленный, иногда таймаутит)
- LVL3 Category Resolver (LLM-match категорий + ?category=) — самый дорогой

Каждый шаг выполнялся ТОЛЬКО при miss предыдущего → накопление latency.

## Решение (Wave B3, 2026-06-15)
`supabase/functions/chat-consultant/index.ts` ~9697-9790:

1. **Параллельный запуск** LVL1+LVL2+LVL3 через 3 IIFE-промиса.
2. **Race с timeout 20с** (`LADDER_BUDGET_MS`). При срабатывании — silent fallthrough на classifier-modifiers path.
3. **Приоритет** LVL1 > LVL2 > LVL3 при выборе из успешных результатов.
4. **Профайл каждого уровня**: ms + статус (`hit`/`miss`/`failed`). LVL3 разбит на catalog/llm/total ms.
5. Лог сводки: `LADDER picked=LVL{1,2,3} ... (parallel total=Xms)` либо `EXHAUSTED`/`TIMEOUT`.

## Поведение
- Best case: latency = max(LVL1, LVL2, LVL3) ≈ latency LVL3.
- Worst case: 20с hard-cap вместо 46с накопления.
- Семантика выбора не меняется (LVL1 всё ещё победит над LVL2/LVL3 если оба успешны).
