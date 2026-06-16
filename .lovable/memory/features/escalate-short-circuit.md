---
name: Escalate Short-Circuit (QFv2)
description: При unresolved-модификаторах без overlap с bootstrap captions/values пропускаем prefetch+escalate (экономия 6-14с). Data-agnostic.
type: feature
---

**Файл:** `supabase/functions/chat-consultant/index.ts` ~line 8851
**Тесты:** `escalate-shortcircuit_test.ts` (7 кейсов)
**Step в логах:** `qfv2-escalate-skip` с `meta.reason='no_bootstrap_overlap'`

**Правило:**
Перед запуском escalate-блока (full schema fetch + повторный resolveFiltersWithLLM) проверяем, что хотя бы один unresolved-модификатор имеет substring-пересечение (case-insensitive) с captions или values bootstrap-схемы pool'а. Если ни одного нет — модификатор контекстный («квартиры», «для», «дома»), его в schema категории тоже не будет — escalate бесполезен.

**Условия short-circuit:**
- `schemaSource === 'bootstrap'` (single-pass не сработал)
- `resolverUnresolved.length > 0`
- `!hasAnyBootstrapOverlap(resolverUnresolved, bootstrapSchema)`
- модификаторы длиной < 2 chars игнорируются (фильтрация шума типа «А», «и»)

**Что НЕ делаем:**
- Не отменяем prefetch (он запущен параллельно раньше — может пригодиться следующему запросу через cache).
- Не трогаем bootstrap merge.
- Не используем словари — только substring-сопоставление с live данными.

**Экономия:** в кейсе «автомат 25А для квартиры» — было escalate-timeout 6s + escalate-miss 7.6s = ~13.6s; теперь один qfv2-escalate-skip ~0ms.

**Связано с:**
- mem://constraints/volna-a-timeouts — продолжение оптимизации QFv2 budget.
- mem://features/qfv2-single-pass-schema — escalate срабатывает только при schemaSource='bootstrap'.
