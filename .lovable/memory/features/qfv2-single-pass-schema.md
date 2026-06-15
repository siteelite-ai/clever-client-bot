---
name: QFv2 Single-Pass Schema
description: Один filter-llm вызов вместо двух (bootstrap + escalate) — экономит ~8с на проджекторах/лампах
type: feature
---

**Проблема (до 2026-06-15):** QFv2 делал ДВА последовательных Claude filter-llm вызова:
1. bootstrap-схема из pool (топ-100 товаров) → filter-llm #1 (~10с) → unresolved=[нишевые мод-ры]
2. escalate: `getCategoryOptionsSchema(dominantCat)` → filter-llm #2 (~9с) на полной схеме

Итог: ~19с только на facet-matching. Total для «прожектор уличный 50вт IP65» = 30с.

**Решение (2026-06-15, Single-Pass):**
1. **Prefetch full schema** параллельно с filter-llm (`getCategoryOptionsSchema(dominantCat)` стартует сразу после bootstrap-loop, без await).
2. **Merge** prefetched + bootstrap ДО filter-llm (race с timeout 5с). Full schema win'ит на conflict (более полные value-наборы → лучше для honest-empty alternativeValues).
3. **Один filter-llm** против merged-схемы. Escalate-блок гейтится `schemaSource === 'bootstrap'` — срабатывает ТОЛЬКО если prefetch упал/timeout (graceful degrade).
4. **Parallel noun-extractor**: kickoff в параллель с classify (noun зависит только от userMessage). Экономит min(noun, classify) ≈ 3с.

**Замер projector-кейса:** 30.1с → 21.9с (-27%). qfv2-noun=0мс (уже разрезолвлен к моменту QFv2), qfv2-schema-merged=414мс, qfv2-filter-llm=11.5с (один вызов).

**Не достигли 15с** потому что classify(3.5с) + filter-llm(11.5с) = 15с минимум только на двух последовательных Claude-вызовах. Дальнейшее ускорение требует смены модели facet-matcher'a (запрещено per Core: Claude нужен против галлюцинаций) или кэширования resolved-filters по `(noun, sorted-mods, dominantCat)`.

**Контракт сохранён:** при prefetch-fail/timeout → schemaSource='bootstrap' → escalate-блок работает как раньше. Никаких regression-рисков для редких категорий.

**Связанные шаги в логе:** `qfv2-schema-prefetch`, `qfv2-schema-merged`, `qfv2-schema-merged-skip` (reason=timeout|empty), `qfv2-filter-llm`, `qfv2-escalate-*` (только при schemaSource=bootstrap).
