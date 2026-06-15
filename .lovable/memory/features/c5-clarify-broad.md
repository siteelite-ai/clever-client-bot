---
name: C5 Clarify-Before-Search (Broad)
description: Уточняющий вопрос для underspecified-broad каталоговых запросов (например «светодиод 25м²») — short-circuit до поиска
type: feature
---
# C5 — Clarify-Before-Search для размытых каталоговых запросов

## Зачем
Когда классификатор видит `intent='catalog'` + `has_product_name=false` + одно-словную (или пустую) категорию + хотя бы один модификатор-параметр, слепой поиск даёт мусор. Канонический кейс: **«светодиод 25м²»** — это может быть лента, лампа, прожектор, потолочный светильник. Правильный ход — ОДИН точечный вопрос про тип/назначение/мощность, а не «вот 22 случайных товара».

## Архитектура (три gate, data-agnostic)
1. **Gate 1 — Detector** (`_shared/c5-broad-detector.ts`, pure): intent='catalog' + has_product_name=false + !is_replacement + sub_intent ∈ {null,facets,spec} + ≥1 modifier + (no category OR single-word category).
2. **Gate 1.5 — Probe** (Wave C5.1, 2026-06-15, inline в `chat-consultant/index.ts`):
   - `/products?query=<raw>&per_page=1`, timeout 2500мс, читаем `pagination.total`.
   - Порог `C5_PROBE_SKIP_THRESHOLD = 30`.
   - `total = 0` → silent fallback (QFv2/jargon-fallback разберутся).
   - `1 ≤ total ≤ 30` → silent fallback (узкая выборка, clarify создаст трение).
   - `total > 30` или probe error/timeout → Gate 2.
   - Метрики: `c5_broad_probe_total{total,ms}`, `c5_broad_probe_skip{total,reason=empty|narrow}`.
   - Паттерн §4.4 Price-ladder. Защита от false-positive «бренд+спецы» (кейс «дрель makita 18в» 2026-06-15).
3. **Gate 2 — LLM helper** (`_shared/c5-broad-clarify.ts`, Claude Sonnet 4.5, 6с timeout, silent fallback): возвращает `{question, options}` или пустой question → silent fallback.


## Интеграция в `chat-consultant/index.ts`
- Хук между fast-path и PRICE INTENT HANDLING.
- Guards на месте вызова: `!articleShortCircuit`, `!facetsResponse`, `!effectivePriceIntent`, `appSettings.c5_clarify_broad_enabled`, `openrouter_api_key`.
- При успехе: `broadClarifyResponse = { content, quick_replies, meta }`, branchTag в логах = `c5-clarify-broad`. Short-circuit рендера (свой блок в response section), БЕЗ карточек, БЕЗ финальной LLM-генерации. `dialogSlots` НЕ трогаем — следующий ход юзера пройдёт обычным catalog-flow с уже уточнённым параметром в тексте.

## Feature flag
- `app_settings.c5_clarify_broad_enabled boolean default false` (миграция 2026-06-15).
- При OFF — код полностью неактивен.

## Метрики (логи)
- `[Metric] c5_broad_detected_total reason=<…> category="<…>" mods=<N>` — каждый раз когда detector сказал TRUE.
- `[Metric] c5_broad_clarify_emitted_total reason=<…> options=<K> ms=<…>` — когда LLM реально эмитнул вопрос (gate 2 пропустил).
- Разница `detected − emitted` = silent-fallback rate (запросы где LLM решил, что вопрос не нужен).

## Verified live (2026-06-15)
- `«светодиод 25м2»` → category="светодиод", mods=[25м2] → detector TRUE → LLM: «Какой тип светодиодного освещения вам нужен?» + `[Лента, Светильник, Лампа, Прожектор]`. ~5с.

## Anti-patterns (НЕ допускать)
- Whitelist категорий, blacklist слов, хардкод детектов «м²» / «м³».
- Возврат к Plan V7 disambiguation (см. `mem://constraints/disambiguation-disabled`) — C5 это новый short-circuit с другим триггером и без слотов.
- Любая модификация `dialogSlots` в C5 — следующий ход пользователя обычный.

## Файлы
- `supabase/functions/_shared/c5-broad-detector.ts` + `_test.ts` (10 кейсов)
- `supabase/functions/_shared/c5-broad-clarify.ts`
- `supabase/functions/chat-consultant/index.ts` (AppSettings flag + хук в роутере + dispatch-блок)
