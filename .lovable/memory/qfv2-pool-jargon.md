---
name: QFv2 Pool-Level Jargon Fallback
description: При pool=0 в QFv2 вызываем tryJargonFallback ДО Soft-404; canonical-кейс «лампа кукуруза» теперь работает в pool-фазе
type: feature
---
**Введено: 2026-06-15, Волна C2.**

Раньше jargon-fallback вызывался только в QFv2 на двух поздних точках:
- `qfv2_honest_empty_partial` (resolverUnresolvedDetails не пусты)
- `unfulfilled-split` probe (resolvedOriginals + droppedOriginals оба ≥1)

Canonical-кейс «лампа кукуруза на цоколь е27» падал в pool=0 ДО ресолвера и шёл прямо в Soft-404 — регрессия mem://features/jargon-fallback.

**Фикс:** новый branch `qfv2_pool_jargon` сразу после `qfv2-pool-empty`:
1. `tryJargonFallback({ originalQuery: userMessage, searchFn: searchProductsByCandidate(perPage=100, timeout=4s) })`
2. Если sanitized (price>0) ≥1 → `pool = sanitized` → продолжаем нормальный bootstrap + filter-LLM + display.
3. Если пусто/исключение → silent fallback на legacy Category Resolver (без изменения поведения).

Лог-шаги: `qfv2-pool-jargon` (success) или `qfv2-pool-jargon-skip {reason: empty|error}`.

См. также: mem://features/qfv2-jargon-recovery (поздняя точка, в partial-honest-empty).
