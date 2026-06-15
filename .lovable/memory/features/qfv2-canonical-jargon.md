---
name: QFv2 Canonical-Jargon Priority over Split-Render
description: При unfulfilled-split candidate сначала пробуем whole-query jargon-fallback; если канонический термин даёт ≥1 товара — рендерим его как qfv2_jargon_recovery, пропуская split.
type: feature
---
# Wave B2 (2026-06-15)

**Проблема (D6):** «лампа кукуруза» → pool=«лампа Е27 (не кукурузные)» + dropped=[«кукуруза»] →
qfv2_unfulfilled_split рендерил две секции вместо одного канонического corn-lamp результата.

**Решение:** Перед split-probe (line ~8976) вызываем `tryJargonFallback` на ВСЁМ исходном запросе.
- Если LLM находит canonical alternative (corn lamp) и API возвращает ≥1 sanitized — ставим
  `displayList = sanitizedWhole`, `branchTag = 'qfv2_jargon_recovery'`, `canonicalJargonWon = true`,
  пропускаем split-логику.
- Иначе silent fallback на существующий split-flow.

**Метрика:** `qfv2-jargon-recovery-canonical` (preempted split).

**Data-agnostic:** ни одного хардкода категории/бренда. Решает сама jargon-LLM.

**Anti-hallucination:** sanitized по `price > 0`, products идут через `buildDeterministicShortCircuitContent`.
