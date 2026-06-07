// _shared/facet-blacklist.ts
//
// Единый источник правды для blacklist'а технических/служебных facet-ключей,
// прилетающих из 220volt API (/categories/options и per-item Product.options).
//
// Используется:
//   • chat-consultant-v2/catalog/facet-filter.ts → re-export.
//   • chat-consultant (V1) — внутри accessory-for compat-блока и
//     EXCLUDED_OPTION_PREFIXES (V1 legacy superset включает эти ключи).
//
// Контракт: ручной список, никаких regex-эвристик. Расширение — только
// через явное согласование (memory-rule).

/**
 * 8 ключей: техническая метаинформация / служебные ID / казахские дубли / медиа.
 *
 * Группа A — служебные ID и метаинформация:
 *   1. kodnomenklatury
 *   2. identifikator_sayta__sayt_identifikatory
 *   3. soputstvuyuschiytovar
 *   4. tovar_internet_magazina
 *   5. poiskovyy_zapros
 *
 * Группа B — казахские дубли (бот отвечает на русском):
 *   6. naimenovanie_na_kazahskom_yazyke
 *   7. opisanie_na_kazahskom_yazyke
 *
 * Группа C — медиа:
 *   8. fayl
 */
export const FACET_BLACKLIST_KEYS: ReadonlySet<string> = new Set([
  'kodnomenklatury',
  'identifikator_sayta__sayt_identifikatory',
  'soputstvuyuschiytovar',
  'tovar_internet_magazina',
  'poiskovyy_zapros',
  'naimenovanie_na_kazahskom_yazyke',
  'opisanie_na_kazahskom_yazyke',
  'fayl',
]);

export function isBlacklistedFacetKey(key: unknown): boolean {
  if (typeof key !== 'string' || key.length === 0) return true;
  return FACET_BLACKLIST_KEYS.has(key);
}

export function filterRawOptions<T extends { key?: unknown }>(options: T[]): T[] {
  if (!Array.isArray(options)) return [];
  return options.filter((o) => !isBlacklistedFacetKey(o?.key));
}
