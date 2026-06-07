// chat-consultant-v2 / catalog/facet-filter.ts
//
// Тонкий re-export шим: единый источник правды для blacklist'а живёт в
// supabase/functions/_shared/facet-blacklist.ts (общий с V1, см. план патча
// 2026-06-07 — устранение рассинхрона V1/V2).
//
// Сохраняем существующие имена экспортов, чтобы не править все импорты в V2.

export {
  FACET_BLACKLIST_KEYS,
  isBlacklistedFacetKey,
  filterRawOptions,
} from '../../_shared/facet-blacklist.ts';
