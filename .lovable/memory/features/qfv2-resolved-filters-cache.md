---
name: QFv2 Resolved-Filters Cache
description: Кэш resolved-filters в chat_cache_v2 по (noun, sorted-mods, dominantCat) TTL 1ч — пропускает prefetch+merge+filter-llm+escalate при повторных запросах
type: feature
---

## Проблема

После Single-Pass Schema (см. mem://features/qfv2-single-pass-schema) QFv2 для прожекторов/ламп держит ~22с, из которых ~11с занимает `resolveFiltersWithLLM` (Claude Sonnet 4.5 против merged-schema). При повторных запросах с тем же типом товара, теми же модификаторами и той же доминирующей категорией результат filter-LLM детерминистичен — нет смысла дёргать модель повторно.

## Решение

Cache resolved-filters в `chat_cache_v2`:

- **Key**: `qfv2:resolved:<noun_lc>::<sorted_mods_joined_lc>::<dominantCat_lc>`
- **Value**: `{ resolvedFilters, resolverUnresolved, resolverUnresolvedDetails, cachedAt }`
- **TTL**: 1 час
- **Storage**: `chat_cache_v2` (UNIQUE index на `cache_key` → atomic upsert)
- **Write**: fire-and-forget после successful `resolveFiltersWithLLM`. Также перезаписываем после escalate-win (более полный результат).

## Flow

1. `noun` + `modifiers` + `dominantCat0` известны после bootstrap.
2. `loadCachedResolvedFilters(key)` — синхронный SELECT.
3. **HIT** (`schemaSource='cached'`):
   - Skip prefetch full schema.
   - Skip merge (3.6).
   - Skip filter-llm (4) — `resolvedFilters` берутся из cache.
   - Skip escalate (4.5) — гейтится `schemaSource === 'bootstrap'`.
   - Прямо к final search.
4. **MISS**: обычный flow → после filter-llm `storeCachedResolvedFiltersAsync(key, value)`.

## Performance

| Сценарий | До | После |
|---|---|---|
| Cold (first query) | ~22с | ~22с (cache write fire-and-forget) |
| Warm (cache hit) | ~22с | ~10-12с (-9..-11с) |

Запрос «прожектор уличный 50вт IP65» в течение часа: первый ~22с, второй ~11с.

## Логи / метрики

- `qfv2-resolved-filters-cache-hit` / `qfv2-resolved-filters-cache-miss` (logAddStep)
- Console: `[QueryFirstV2] resolved-filters CACHE HIT key=... elapsed=XXms`

## Safety

- Silent fail на любой ошибке Supabase (cache никогда не блокирует основной flow).
- Cache key включает dominantCat → разные категории для одного noun не пересекаются.
- TTL 1ч короче, чем дрейф каталога (новые фасеты у вендора появляются медленнее).
- Cache write только после successful LLM call — failed LLM не отравляет cache.
